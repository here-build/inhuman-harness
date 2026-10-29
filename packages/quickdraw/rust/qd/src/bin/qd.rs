//! Terminal owner. The Node worker still owns the session.
//!
//! stdin and stdout are length-prefixed frames to the host, not the tty.
//! The tty is `/dev/tty`. The first thing written there is the alternate
//! screen and one default-theme frame. Grammars load after that write.
//!
//! Focus reporting, mouse tracking, bracketed paste, kitty keyboard, theme
//! report, and the alternate screen are emulator state. The kernel does not
//! clear them when this process dies, and a signal handler cannot run
//! [`Terminal`]'s destructor. That destructor is the normal quit: theme-report
//! off, then [`exit_bytes`], then the cooked termios, then the stderr hold.
//! The host writes `shutdown` and waits (`rust-present.ts`). `SIGTERM` means
//! that wait expired, or the process is crashing. The handler writes the same
//! static bytes from a published fd and `_exit`s.

use std::cell::UnsafeCell;
use std::io::{self, Read, Write};
use std::mem::MaybeUninit;
use std::os::fd::{AsFd, AsRawFd, BorrowedFd};
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};

use qd::capabilities::THEME_REPORT_DISABLE;
use qd::paint_replica::{PaintReplica, ReplicaNote};
use qd::present::{exit_bytes, present_env_from, Down, Present, PresentOpts, Up};
use qd::stderr_hold::StderrHold;
use qd::syntax;

const FRAME_CAP: u32 = 32 * 1024 * 1024;

/// Published for the handler. The bytes it writes are [`exit_bytes`] and
/// [`THEME_REPORT_DISABLE`], which are static. Only the fd and the cooked
/// termios are runtime state.
struct PublishedRestore {
    claimed: AtomicBool,
    fd: AtomicI32,
    original: UnsafeCell<MaybeUninit<libc::termios>>,
}

// SAFETY: `original` is written on the starting thread before `fd` is
// Release-stored and before the handler is installed. Nothing writes it
// after that. `claim_published` reads it only after an Acquire load of `fd`,
// and only on the claim winner. A signal may run on any thread.
unsafe impl Sync for PublishedRestore {}

static RESTORE: PublishedRestore = PublishedRestore {
    claimed: AtomicBool::new(false),
    fd: AtomicI32::new(-1),
    original: UnsafeCell::new(MaybeUninit::uninit()),
};

static ARMED: AtomicBool = AtomicBool::new(false);

enum Claim {
    Wrote,
    Already,
    Unarmed,
}

fn signal_handler(handler: extern "C" fn(i32)) -> usize {
    // `sighandler_t` is `usize`. The pointer cast is the typed step.
    handler as *const () as usize
}

extern "C" fn on_signal(signal: i32) {
    if matches!(claim_published(), Claim::Wrote) {
        // SAFETY: the reset is already written. `_exit` skips destructors.
        // Returning would resume a process whose modes are already off, still
        // in the foreground. The status is the conventional 128+signal.
        unsafe { libc::_exit(128 + signal) }
    }
}

/// One writer of the published reset. Signal-safe: `write`, `fcntl`, and
/// `tcsetattr` only. [`Claim::Unarmed`] means this process has not published
/// a tty, so the caller still owns the cooked termios.
fn claim_published() -> Claim {
    let fd = RESTORE.fd.load(Ordering::Acquire);
    if fd < 0 {
        return Claim::Unarmed;
    }
    if RESTORE.claimed.swap(true, Ordering::AcqRel) {
        return Claim::Already;
    }
    // SAFETY: this call won `claimed`, so it is the only reader. `fd`'s
    // Acquire load synchronizes with the Release store in [`Terminal::arm`],
    // which is after `original` was initialized.
    let original = unsafe { (*RESTORE.original.get()).assume_init_ref() };
    apply_reset(fd, original);
    Claim::Wrote
}

fn apply_reset(fd: i32, original: &libc::termios) {
    clear_nonblock(fd);
    write_all_raw(fd, THEME_REPORT_DISABLE.as_bytes());
    write_all_raw(fd, exit_bytes().as_bytes());
    tcsetattr_retry(fd, original);
}

fn clear_nonblock(fd: i32) {
    // SAFETY: `fd` is the opened tty. F_GETFL / F_SETFL change only its flags.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 {
        return;
    }
    let _ = unsafe { libc::fcntl(fd, libc::F_SETFL, flags & !libc::O_NONBLOCK) };
}

fn write_all_raw(fd: i32, mut bytes: &[u8]) {
    while !bytes.is_empty() {
        // SAFETY: `fd` is the opened tty. `bytes` is the published reset.
        // A negative return is -1 and writes none of this slice.
        let n = unsafe { libc::write(fd, bytes.as_ptr().cast(), bytes.len()) };
        let Ok(n) = usize::try_from(n) else {
            if last_errno() == libc::EINTR {
                continue;
            }
            break;
        };
        if n == 0 || n > bytes.len() {
            break;
        }
        bytes = &bytes[n..];
    }
}

fn tcsetattr_retry(fd: i32, original: &libc::termios) {
    for _ in 0..8 {
        // SAFETY: `original` is the termios captured at enter. `fd` is that tty.
        let rc = unsafe { libc::tcsetattr(fd, libc::TCSANOW, original) };
        if rc == 0 || last_errno() != libc::EINTR {
            break;
        }
    }
}

fn last_errno() -> i32 {
    // SAFETY: errno is per-thread. The pointer is valid for this thread for
    // the duration of the dereference, including inside the signal handler.
    #[cfg(target_os = "macos")]
    unsafe {
        *libc::__error()
    }
    #[cfg(target_os = "linux")]
    unsafe {
        *libc::__errno_location()
    }
}

fn install_handler(signal: i32, handler: usize) -> io::Result<()> {
    // SAFETY: `zeroed` is storage only. `sigfillset` initializes `sa_mask`
    // before `sigaction` reads it, so the handler is not reentered. On Linux
    // `sa_restorer` stays null and the kernel supplies the restorer.
    let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
    action.sa_sigaction = handler;
    action.sa_flags = 0;
    if unsafe { libc::sigfillset(std::ptr::addr_of_mut!(action.sa_mask)) } != 0 {
        return Err(io::Error::last_os_error());
    }
    if unsafe { libc::sigaction(signal, &action, std::ptr::null_mut()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// A tty `read` can end inside a multibyte scalar. Those bytes stay here
/// until the next read completes them. An illegal sequence is dropped.
#[derive(Default)]
struct Utf8Tail {
    bytes: [u8; 3],
    len: usize,
}

impl Utf8Tail {
    fn take_valid(&mut self, chunk: &[u8]) -> String {
        let mut buf = Vec::with_capacity(self.len + chunk.len());
        buf.extend_from_slice(&self.bytes[..self.len]);
        buf.extend_from_slice(chunk);
        self.len = 0;
        let mut out = String::new();
        let mut rest = buf.as_slice();
        loop {
            match std::str::from_utf8(rest) {
                Ok(text) => {
                    out.push_str(text);
                    break;
                }
                Err(error) => {
                    let up_to = error.valid_up_to();
                    // `valid_up_to` is a char boundary, so this slice is UTF-8.
                    out.push_str(
                        std::str::from_utf8(&rest[..up_to]).expect("valid_up_to is utf-8"),
                    );
                    let after = &rest[up_to..];
                    match error.error_len() {
                        None if after.len() <= self.bytes.len() => {
                            self.bytes[..after.len()].copy_from_slice(after);
                            self.len = after.len();
                            break;
                        }
                        None => break,
                        Some(skip) => rest = &after[skip..],
                    }
                }
            }
        }
        out
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(code) => code,
        Err(error) => {
            let _ = writeln!(io::stderr(), "qd: {error}");
            ExitCode::from(1)
        }
    }
}

/// Ctrl+V. Bracketed paste does not need this. An empty read falls through
/// to the last selection inside present.
fn read_system_clipboard() -> Option<String> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let out = std::process::Command::new("pbpaste").output().ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8(out.stdout).ok()
}

fn dump_stdio() -> io::Result<ExitCode> {
    let mut raw = String::new();
    io::stdin().read_to_string(&mut raw)?;
    match qd::dump(&raw) {
        Ok(dump) => {
            let mut out = io::stdout();
            out.write_all(dump.json().as_bytes())?;
            out.write_all(b"\n")?;
            Ok(ExitCode::SUCCESS)
        }
        Err(error) => {
            writeln!(io::stderr(), "{error}")?;
            Ok(ExitCode::from(1))
        }
    }
}

fn run() -> io::Result<ExitCode> {
    if std::env::args().nth(1).as_deref() == Some("dump") {
        return dump_stdio();
    }
    let mut terminal = Terminal::open()?;
    let (cols, rows) = winsize(terminal.tty.as_fd()).unwrap_or((80, 24));
    let mut tty_tail = Utf8Tail::default();
    let mut present = Present::boot(PresentOpts {
        cols,
        rows,
        tty: true,
        env: present_env_from(|key| std::env::var(key).ok()),
        layout_table: qd::decode::layout_table(std::env::var("QD_NO_LAYOUT_TABLE").ok().as_deref()),
        ..PresentOpts::default()
    });
    present.set_clipboard_read(read_system_clipboard);
    let mut replica = PaintReplica::new();
    // resetAt is unix seconds. A clock from process start paints it as days since 1970.
    write_tty(
        terminal.tty.as_fd(),
        &present
            .paint_if_needed(qd::layout_chrome::unix_now_ms())
            .bytes,
    )?;

    let down = io::stdin();
    let mut up = io::stdout();
    set_nonblock(terminal.tty.as_fd())?;
    set_nonblock(down.as_fd())?;
    let mut pending = Vec::new();
    let mut scratch = [0u8; 8192];
    let mut saw_paint = false;
    let mut grammars = false;
    let mut framed_cols = present.cols();
    loop {
        let now = qd::layout_chrome::unix_now_ms();
        if let Some((cols, rows)) = winsize(terminal.tty.as_fd()) {
            present.push_resize(cols, rows);
        }
        let wait = live_wait(present.live_hz());
        poll_set(
            terminal.tty.as_fd(),
            down.as_fd(),
            terminal.stderr_hold.read_fd(),
            wait,
        )?;
        terminal.stderr_hold.drain()?;
        let n = read_fd(terminal.tty.as_fd(), &mut scratch)?;
        if n > 0 {
            let text = tty_tail.take_valid(&scratch[..n]);
            if !text.is_empty() {
                let pushed = present.push_input(&text, now);
                if !pushed.immediate.is_empty() {
                    write_tty(terminal.tty.as_fd(), &pushed.immediate)?;
                }
                present.feed_probe(&text, now);
            }
        }
        loop {
            let n = read_fd(down.as_fd(), &mut scratch)?;
            if n == 0 {
                break;
            }
            pending.extend_from_slice(&scratch[..n]);
        }
        let mut need_publish = false;
        while let Some(frame) = pop_frame(&mut pending)? {
            let result = handle_down(&frame, &mut present, &mut replica, &terminal)?;
            match result {
                DownResult::Shutdown => {
                    restore(&mut terminal, &mut present)?;
                    return Ok(ExitCode::SUCCESS);
                }
                DownResult::Paint => {
                    saw_paint = true;
                    need_publish = true;
                }
                DownResult::Phase => need_publish = true,
                DownResult::Ignore => {}
            }
        }
        if need_publish {
            publish(&mut present, &mut replica);
        }
        for message in present.take_posted() {
            write_frame(&mut up, message_json(&message).as_bytes())?;
        }
        if present.quit_count() > 0 {
            write_frame(&mut up, br#"{"kind":"quit"}"#)?;
            restore(&mut terminal, &mut present)?;
            return Ok(ExitCode::SUCCESS);
        }
        // Place stretches the column. A speech rail keeps the cell width from the last frame, so the clock stays on the old edge until the tape is framed at the new cols.
        if saw_paint && present.cols() != framed_cols {
            publish(&mut present, &mut replica);
            framed_cols = present.cols();
        }
        let paint = present.paint_if_needed(now);
        if !paint.bytes.is_empty() {
            write_tty(terminal.tty.as_fd(), &paint.bytes)?;
        }
        if saw_paint && !grammars {
            grammars = true;
            if syntax::warm() {
                replica.note_syntax_warm();
                publish(&mut present, &mut replica);
            }
        }
    }
}

enum DownResult {
    Shutdown,
    Paint,
    Phase,
    Ignore,
}

fn handle_down(
    frame: &[u8],
    present: &mut Present,
    replica: &mut PaintReplica,
    terminal: &Terminal,
) -> io::Result<DownResult> {
    let text = std::str::from_utf8(frame)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    match top_kind(text) {
        Some("shutdown") => return Ok(DownResult::Shutdown),
        Some("title") => {
            if let Some(title) = json_string_field(text, "text") {
                terminal.set_title(&title)?;
            }
            return Ok(DownResult::Ignore);
        }
        Some("phase") => {
            // Not a snapshot. Ignore keeps grammar load behind the first paint.
            if let Some(phase) = json_string_field(text, "text") {
                replica.set_phase(&phase);
                return Ok(DownResult::Phase);
            }
            return Ok(DownResult::Ignore);
        }
        Some("paint_init") | Some("paint_patch") => {
            replica.set_phase("");
        }
        _ => return Ok(DownResult::Ignore),
    }
    let init = top_kind(text) == Some("paint_init");
    if replica.apply(frame).is_err() {
        let reason = json_string("paint apply failed");
        write_frame(
            &mut io::stdout(),
            format!(r#"{{"kind":"failed","reason":{reason}}}"#).as_bytes(),
        )?;
        return Ok(DownResult::Shutdown);
    }
    replica.note_replica(if init {
        ReplicaNote::Init
    } else {
        ReplicaNote::Patch
    });
    if init {
        present.push_down(vec![Down::PaintInit]);
    }
    Ok(DownResult::Paint)
}

fn publish(present: &mut Present, replica: &mut PaintReplica) {
    let width = i64::from(present.cols());
    let rows = i64::from(present.rows());
    if let Ok(node) = replica.frame(width) {
        if let Some(face) = replica.composer_face() {
            present.set_composer(face);
        }
        present.set_retained_scene(node);
        present.set_seat_rim(replica.seat_rim());
        present.set_agents_plaque(replica.agents_plaque());
        present.set_agents_preview(replica.agents_preview_open());
        present.set_preview_overlay(replica.preview_overlay(width, rows));
    }
}

fn restore(terminal: &mut Terminal, present: &mut Present) -> io::Result<()> {
    let _ = present.stop();
    terminal.finish();
    terminal.stderr_hold.release()
}

fn live_wait(hz: u32) -> i32 {
    if hz == 0 {
        return 50;
    }
    let ms = 1000 / u64::from(hz.max(1));
    i32::try_from(ms).unwrap_or(50).clamp(8, 250)
}

fn message_json(message: &Up) -> String {
    qd::up_json(message)
}

fn json_string(text: &str) -> String {
    let mut out = String::from("\"");
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            other if other.is_control() => out.push_str(&format!("\\u{:04x}", u32::from(other))),
            other => out.push(other),
        }
    }
    out.push('"');
    out
}

fn top_kind(text: &str) -> Option<&str> {
    let idx = text.find("\"kind\"")?;
    let rest = text[idx + 6..].trim_start().strip_prefix(':')?.trim_start();
    let rest = rest.strip_prefix('"')?;
    let end = rest.find('"')?;
    Some(&rest[..end])
}

fn json_string_field(text: &str, field: &str) -> Option<String> {
    let needle = format!("\"{field}\"");
    let idx = text.find(&needle)?;
    let rest = text[idx + needle.len()..]
        .trim_start()
        .strip_prefix(':')?
        .trim_start();
    let rest = rest.strip_prefix('"')?;
    let mut out = String::new();
    let mut chars = rest.chars();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            match chars.next() {
                Some('n') => out.push('\n'),
                Some('r') => out.push('\r'),
                Some('t') => out.push('\t'),
                Some(other) => out.push(other),
                None => break,
            }
            continue;
        }
        if ch == '"' {
            break;
        }
        out.push(ch);
    }
    Some(out)
}

fn pop_frame(pending: &mut Vec<u8>) -> io::Result<Option<Vec<u8>>> {
    if pending.len() < 4 {
        return Ok(None);
    }
    let len = u32::from_le_bytes([pending[0], pending[1], pending[2], pending[3]]);
    if len > FRAME_CAP {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "frame too large",
        ));
    }
    let total = 4 + len as usize;
    if pending.len() < total {
        return Ok(None);
    }
    let frame = pending[4..total].to_vec();
    pending.drain(..total);
    Ok(Some(frame))
}

fn write_frame(out: &mut impl Write, payload: &[u8]) -> io::Result<()> {
    let len = u32::try_from(payload.len()).unwrap_or(FRAME_CAP);
    out.write_all(&len.to_le_bytes())?;
    out.write_all(payload)?;
    out.flush()
}

fn write_tty(tty: BorrowedFd<'_>, bytes: &str) -> io::Result<()> {
    let fd = tty.as_raw_fd();
    let mut rest = bytes.as_bytes();
    while !rest.is_empty() {
        // SAFETY: `fd` is the opened tty. `rest` is the paint still to send.
        // A negative return is -1. The descriptor is nonblocking, so a full
        // pty buffer is EAGAIN and this waits for POLLOUT.
        let n = unsafe { libc::write(fd, rest.as_ptr().cast(), rest.len()) };
        if n < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            if error.kind() == io::ErrorKind::WouldBlock {
                wait_tty_out(fd)?;
                continue;
            }
            return Err(error);
        }
        let Ok(n) = usize::try_from(n) else {
            return Err(io::Error::new(io::ErrorKind::WriteZero, "tty write"));
        };
        if n == 0 || n > rest.len() {
            return Err(io::Error::new(io::ErrorKind::WriteZero, "tty write"));
        }
        rest = &rest[n..];
    }
    Ok(())
}

fn wait_tty_out(fd: i32) -> io::Result<()> {
    let mut pollfd = libc::pollfd {
        fd,
        events: libc::POLLOUT,
        revents: 0,
    };
    loop {
        // SAFETY: `pollfd` is one live descriptor, the opened tty.
        let rc = unsafe { libc::poll(&mut pollfd, 1, 50) };
        if rc < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        return Ok(());
    }
}

fn read_fd(fd: BorrowedFd<'_>, buf: &mut [u8]) -> io::Result<usize> {
    // SAFETY: `fd` is the tty or the down pipe this process owns. `buf` is a
    // live writable slice. A negative return is an errno, not a byte count.
    let n = unsafe { libc::read(fd.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len()) };
    if n < 0 {
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::WouldBlock {
            return Ok(0);
        }
        return Err(error);
    }
    usize::try_from(n).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "tty read"))
}

fn set_nonblock(fd: BorrowedFd<'_>) -> io::Result<()> {
    // SAFETY: `fd` is owned by this process. F_GETFL / F_SETFL only change
    // that descriptor's status flags.
    let fd = fd.as_raw_fd();
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    let rc = unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) };
    if rc < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn poll_set(
    tty: BorrowedFd<'_>,
    down: BorrowedFd<'_>,
    stderr_pipe: Option<BorrowedFd<'_>>,
    timeout_ms: i32,
) -> io::Result<()> {
    let mut fds = [
        libc::pollfd {
            fd: tty.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        },
        libc::pollfd {
            fd: down.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        },
        libc::pollfd {
            fd: stderr_pipe.map(|fd| fd.as_raw_fd()).unwrap_or(-1),
            events: libc::POLLIN,
            revents: 0,
        },
    ];
    let count = if stderr_pipe.is_some() { 3 } else { 2 };
    // SAFETY: the tty and the down pipe are owned. The third slot is the
    // stderr hold's read end, or it is omitted. A negative return is EINTR
    // or a real errno.
    let rc = unsafe { libc::poll(fds.as_mut_ptr(), count, timeout_ms) };
    if rc < 0 {
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::Interrupted {
            return Ok(());
        }
        return Err(error);
    }
    Ok(())
}

fn winsize(fd: BorrowedFd<'_>) -> Option<(u16, u16)> {
    let fd = fd.as_raw_fd();
    let mut size = libc::winsize {
        ws_row: 0,
        ws_col: 0,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    // SAFETY: `fd` is the open `/dev/tty` this process owns. `size` is a
    // valid out-pointer for TIOCGWINSZ and is fully initialized.
    let rc = unsafe { libc::ioctl(fd, libc::TIOCGWINSZ, &mut size) };
    if rc != 0 || size.ws_col == 0 || size.ws_row == 0 {
        return None;
    }
    Some((size.ws_col, size.ws_row))
}

/// The open tty. Drop writes the reset, restores cooked termios, then
/// releases the stderr hold so held lines land on the primary screen.
struct Terminal {
    tty: std::fs::File,
    original: libc::termios,
    stderr_hold: StderrHold,
    restored: bool,
}

impl Terminal {
    fn open() -> io::Result<Self> {
        if ARMED.load(Ordering::Acquire) {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "terminal session already open",
            ));
        }
        let tty = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open("/dev/tty")?;
        let original = read_termios(tty.as_fd())?;
        let stderr_hold = StderrHold::install()?;
        // The value exists before raw mode, so a failure here still restores.
        let mut session = Self {
            tty,
            original,
            stderr_hold,
            restored: false,
        };
        set_raw(session.tty.as_fd(), &session.original)?;
        session.arm()?;
        Ok(session)
    }

    fn arm(&mut self) -> io::Result<()> {
        if ARMED.swap(true, Ordering::AcqRel) {
            // Another session owns the published slot. Restore this fd
            // locally and do not claim theirs.
            self.restored = true;
            apply_reset(self.tty.as_raw_fd(), &self.original);
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "terminal session already open",
            ));
        }
        // SAFETY: the handler is not installed yet, so nothing else reads
        // `original`. This write happens-before the `fd` Release store.
        unsafe {
            (*RESTORE.original.get()).write(self.original);
        }
        RESTORE.fd.store(self.tty.as_raw_fd(), Ordering::Release);
        let installed = install_handler(libc::SIGTERM, signal_handler(on_signal))
            .and_then(|_| install_handler(libc::SIGINT, signal_handler(on_signal)))
            .and_then(|_| install_handler(libc::SIGHUP, signal_handler(on_signal)))
            // A closed host pipe must not kill the process before the reset write.
            .and_then(|_| install_handler(libc::SIGPIPE, libc::SIG_IGN));
        if let Err(error) = installed {
            // The slot stays published. Drop claims it and writes the reset.
            return Err(error);
        }
        Ok(())
    }

    fn finish(&mut self) {
        if self.restored {
            return;
        }
        self.restored = true;
        if matches!(claim_published(), Claim::Unarmed) {
            apply_reset(self.tty.as_raw_fd(), &self.original);
        }
    }

    fn set_title(&self, title: &str) -> io::Result<()> {
        let mut payload = String::from("\u{1b}]0;");
        for ch in title.chars() {
            if ch.is_control() {
                continue;
            }
            payload.push(ch);
        }
        payload.push('\u{7}');
        write_tty(self.tty.as_fd(), &payload)
    }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        self.finish();
        let _ = self.stderr_hold.release();
    }
}

fn read_termios(fd: BorrowedFd<'_>) -> io::Result<libc::termios> {
    let fd = fd.as_raw_fd();
    // SAFETY: `zeroed` is only an out-buffer. No field is read until
    // `tcgetattr` returns 0 and has written `original`.
    let mut original = unsafe { std::mem::zeroed::<libc::termios>() };
    // SAFETY: `fd` is the open tty. `original` is the out-pointer tcgetattr
    // fills before any later use of those bytes.
    let rc = unsafe { libc::tcgetattr(fd, &mut original) };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(original)
}

fn set_raw(fd: BorrowedFd<'_>, original: &libc::termios) -> io::Result<()> {
    let fd = fd.as_raw_fd();
    let mut raw = *original;
    // SAFETY: `raw` was copied from a termios `read_termios` just returned.
    unsafe { libc::cfmakeraw(&mut raw) };
    // SAFETY: `raw` is that `cfmakeraw` result. `fd` is the same tty.
    // `TCSANOW` applies it before the next read.
    let rc = unsafe { libc::tcsetattr(fd, libc::TCSANOW, &raw) };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
