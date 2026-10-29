//! The qd binary writes the screen to the tty and frames to stdout.
//! Skip when `openpty` fails. The parent does not call `set_var`.

use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

#[test]
fn the_binary_keeps_the_screen_on_the_tty() {
    let Some(mut pty) = spawn_qd() else { return };
    let screen = read_until(pty.master, b"?1049h", Duration::from_secs(2));
    let screen_text = String::from_utf8_lossy(&screen);
    assert!(
        screen_text.contains("?1049h"),
        "enter bytes missing on the tty: {screen_text:?}"
    );
    let mut stdout = pty.child.stdout.take().expect("stdout");
    let mut stdin = pty.child.stdin.take().expect("stdin");
    set_nonblock(stdout.as_raw_fd());
    let early_out = read_available(&mut stdout);
    assert!(
        !early_out.windows(6).any(|window| window == b"?1049h"),
        "enter bytes leaked onto the frame pipe"
    );
    if let Err(error) = write_frame(
        &mut stdin,
        br#"{"kind":"paint_init","epoch":"e1","snapshot":{"kind":"root","children":[]}}"#,
    ) {
        let mut err = String::new();
        if let Some(mut stderr) = pty.child.stderr.take() {
            let _ = stderr.read_to_string(&mut err);
        }
        panic!("paint_init write failed: {error}; stderr: {err}");
    }
    let _ = write_fd(pty.master, b"a");
    let up = read_until_stdout(
        &mut stdout,
        pty.master,
        b"input_events",
        Duration::from_secs(2),
    );
    assert!(
        up.windows(12).any(|window| window == b"input_events"),
        "key did not return as a frame: {}",
        String::from_utf8_lossy(&up)
    );
    write_frame(&mut stdin, br#"{"kind":"shutdown"}"#).expect("shutdown");
    let left = read_until(pty.master, b"?1049l", Duration::from_secs(2));
    assert_reset(&left);
    let status = wait_child(&mut pty.child, Duration::from_secs(2));
    assert!(status.is_some_and(|status| status.success()), "{status:?}");
    assert_cooked(&pty);
}

#[test]
fn sigterm_clears_focus_reporting_and_leaves_the_alt_screen() {
    let Some(mut pty) = spawn_qd() else { return };
    let entered = read_until(pty.master, b"?1004h", Duration::from_secs(2));
    assert!(
        String::from_utf8_lossy(&entered).contains("?1004h"),
        "focus reporting was never enabled"
    );
    // The host restore path kills with SIGTERM. That does not run destructors
    // unless the child handles it. Default death leaves ?1004h set.
    let pid = i32::try_from(pty.child.id()).expect("pid");
    let rc = unsafe { libc::kill(pid, libc::SIGTERM) };
    assert_eq!(rc, 0, "kill: {}", io::Error::last_os_error());
    let left = read_until(pty.master, b"?1004l", Duration::from_secs(2));
    assert_reset(&left);
    let status = wait_child(&mut pty.child, Duration::from_secs(2));
    let status = status.expect("child did not exit after SIGTERM");
    assert_eq!(status.code(), Some(128 + libc::SIGTERM));
    assert_cooked(&pty);
}

#[test]
fn a_rejected_frame_still_clears_focus_reporting() {
    let Some(mut pty) = spawn_qd() else { return };
    let entered = read_until(pty.master, b"?1004h", Duration::from_secs(2));
    assert!(
        String::from_utf8_lossy(&entered).contains("?1004h"),
        "focus reporting was never enabled"
    );
    let mut stdin = pty.child.stdin.take().expect("stdin");
    // Longer than the binary's frame cap. The length alone is the error.
    stdin.write_all(&u32::MAX.to_le_bytes()).expect("write");
    let _ = stdin.flush();
    let left = read_until(pty.master, b"?1004l", Duration::from_secs(2));
    assert_reset(&left);
    let status = wait_child(&mut pty.child, Duration::from_secs(2));
    assert!(
        status.is_some_and(|status| status.code() == Some(1)),
        "{status:?}"
    );
    assert_cooked(&pty);
}

struct PtyChild {
    master: RawFd,
    slave: RawFd,
    child: Child,
    before: libc::termios,
}

impl Drop for PtyChild {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        // SAFETY: these are the openpty fds this test owns. Closing a
        // descriptor twice is avoided by not closing them anywhere else.
        unsafe {
            libc::close(self.master);
            libc::close(self.slave);
        }
    }
}

fn spawn_qd() -> Option<PtyChild> {
    let mut master: RawFd = -1;
    let mut slave: RawFd = -1;
    // SAFETY: openpty writes two new fds. Failure skips the test.
    let rc = unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if rc != 0 {
        return None;
    }
    let flags = unsafe { libc::fcntl(slave, libc::F_GETFD) };
    if flags >= 0 {
        unsafe { libc::fcntl(slave, libc::F_SETFD, flags & !libc::FD_CLOEXEC) };
    }
    let master_flags = unsafe { libc::fcntl(master, libc::F_GETFL) };
    if master_flags >= 0 {
        unsafe { libc::fcntl(master, libc::F_SETFL, master_flags | libc::O_NONBLOCK) };
    }
    let mut before = unsafe { std::mem::zeroed::<libc::termios>() };
    if unsafe { libc::tcgetattr(slave, &mut before) } != 0 {
        unsafe {
            libc::close(master);
            libc::close(slave);
        }
        return None;
    }
    let slave_fd = slave;
    let child = unsafe {
        Command::new(env!("CARGO_BIN_EXE_qd"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .pre_exec(move || {
                if libc::setsid() < 0 {
                    return Err(io::Error::last_os_error());
                }
                // SAFETY: `slave_fd` is the pty slave inherited from the parent.
                // This makes it the controlling terminal so `/dev/tty` opens it.
                // fd 0 and fd 1 stay the frame pipes.
                if libc::ioctl(slave_fd, libc::TIOCSCTTY as libc::c_ulong, 0) < 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            })
    }
    .spawn()
    .expect("spawn qd");
    Some(PtyChild {
        master,
        slave,
        child,
        before,
    })
}

fn assert_reset(bytes: &[u8]) {
    let text = String::from_utf8_lossy(bytes);
    let theme = text
        .find("?2031l")
        .unwrap_or_else(|| panic!("theme report still on: {text:?}"));
    let focus = text
        .find("?1004l")
        .unwrap_or_else(|| panic!("focus reporting still on: {text:?}"));
    let alt = text
        .find("?1049l")
        .unwrap_or_else(|| panic!("alt screen still up: {text:?}"));
    assert!(
        theme < focus && focus < alt,
        "theme off, then focus off, then leave-alt: {text:?}"
    );
    assert!(
        text.contains("?2004l"),
        "bracketed paste still on: {text:?}"
    );
    assert!(
        text.contains("]22;default"),
        "pointer shape not restored: {text:?}"
    );
}

fn assert_cooked(pty: &PtyChild) {
    let mut after = unsafe { std::mem::zeroed::<libc::termios>() };
    // A slave getattr after the session leader exits is EIO on this OS.
    // When it still answers, the cooked flags must be back.
    if unsafe { libc::tcgetattr(pty.slave, &mut after) } == 0 {
        assert_eq!(
            pty.before.c_lflag, after.c_lflag,
            "termios lflag was not restored"
        );
    }
}

fn wait_child(child: &mut Child, budget: Duration) -> Option<ExitStatus> {
    let start = Instant::now();
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            return Some(status);
        }
        if start.elapsed() > budget {
            let _ = child.kill();
            return child.wait().ok();
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn read_until(fd: RawFd, needle: &[u8], budget: Duration) -> Vec<u8> {
    let start = Instant::now();
    let mut out = Vec::new();
    while start.elapsed() < budget {
        let more = read_for(fd, Duration::from_millis(20));
        out.extend_from_slice(&more);
        if out.windows(needle.len()).any(|window| window == needle) {
            break;
        }
    }
    out
}

fn read_for(fd: RawFd, budget: Duration) -> Vec<u8> {
    let start = Instant::now();
    let mut out = Vec::new();
    let mut scratch = [0u8; 1024];
    while start.elapsed() < budget {
        let n = unsafe { libc::read(fd, scratch.as_mut_ptr().cast(), scratch.len()) };
        if n > 0 {
            out.extend_from_slice(&scratch[..n as usize]);
            continue;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    out
}

fn set_nonblock(fd: RawFd) {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags >= 0 {
        unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) };
    }
}

fn read_available(reader: &mut impl Read) -> Vec<u8> {
    let mut out = Vec::new();
    let mut scratch = [0u8; 256];
    if let Ok(n) = reader.read(&mut scratch) {
        out.extend_from_slice(&scratch[..n]);
    }
    out
}

fn read_until_stdout(
    reader: &mut impl Read,
    master: RawFd,
    needle: &[u8],
    budget: Duration,
) -> Vec<u8> {
    let start = Instant::now();
    let mut out = Vec::new();
    let mut scratch = [0u8; 1024];
    while start.elapsed() < budget {
        // Drain the screen so a full pty buffer cannot stall the process.
        let _ = read_for(master, Duration::from_millis(5));
        match reader.read(&mut scratch) {
            Ok(0) => break,
            Ok(n) => {
                out.extend_from_slice(&scratch[..n]);
                if out.windows(needle.len()).any(|window| window == needle) {
                    break;
                }
            }
            Err(_) => std::thread::sleep(Duration::from_millis(5)),
        }
    }
    out
}

fn write_frame(stdin: &mut impl Write, payload: &[u8]) -> io::Result<()> {
    let len = (payload.len() as u32).to_le_bytes();
    stdin.write_all(&len)?;
    stdin.write_all(payload)?;
    stdin.flush()
}

fn write_fd(fd: RawFd, bytes: &[u8]) -> io::Result<()> {
    let n = unsafe { libc::write(fd, bytes.as_ptr().cast(), bytes.len()) };
    if n < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
