//! fd 2 is held only when it is a terminal. The parent does not dup its own
//! stderr and does not call `set_var`.

use std::io::{self, Read, Write};
use std::os::fd::RawFd;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use qd::stderr_hold::StderrHold;

#[test]
fn a_piped_stderr_stays_live() {
    if std::env::var("QD_STDERR_PIPE_CHILD").ok().as_deref() == Some("1") {
        let hold = StderrHold::install().expect("install");
        assert!(hold.read_fd().is_none());
        writeln!(io::stderr(), "live").unwrap();
        return;
    }
    let exe = std::env::current_exe().expect("test exe");
    let mut child = Command::new(exe)
        .env("QD_STDERR_PIPE_CHILD", "1")
        .arg("a_piped_stderr_stays_live")
        .arg("--exact")
        .stderr(Stdio::piped())
        .stdout(Stdio::null())
        .stdin(Stdio::null())
        .spawn()
        .expect("spawn");
    let mut err = child.stderr.take().expect("stderr");
    let status = child.wait().expect("wait");
    let mut text = String::new();
    err.read_to_string(&mut text).expect("read stderr");
    assert!(status.success(), "{text}");
    assert!(text.contains("live"), "{text}");
}

#[test]
fn a_tty_stderr_is_held_until_release() {
    if std::env::var("QD_STDERR_PTY_CHILD").ok().as_deref() == Some("1") {
        let slave: RawFd = std::env::var("QD_STDERR_SLAVE")
            .expect("slave")
            .parse()
            .expect("slave fd");
        // SAFETY: `slave` is the pty slave the parent opened and left open
        // across spawn. dup2 puts it on fd 2 only.
        if unsafe { libc::dup2(slave, 2) } < 0 {
            panic!("{}", io::Error::last_os_error());
        }
        let mut hold = StderrHold::install().expect("install");
        assert!(hold.read_fd().is_some());
        writeln!(io::stderr(), "during").unwrap();
        let _ = io::stderr().flush();
        std::thread::sleep(Duration::from_millis(200));
        hold.release().expect("release");
        std::thread::sleep(Duration::from_millis(50));
        let frame = 4u32.to_le_bytes();
        let payload = b"frame";
        let mut out = io::stdout();
        out.write_all(&frame).unwrap();
        out.write_all(payload).unwrap();
        out.flush().unwrap();
        return;
    }
    let mut master: RawFd = -1;
    let mut slave: RawFd = -1;
    // SAFETY: openpty writes two new fds. On failure the test skips.
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
        return;
    }
    let flags = unsafe { libc::fcntl(slave, libc::F_GETFD) };
    if flags >= 0 {
        unsafe {
            libc::fcntl(slave, libc::F_SETFD, flags & !libc::FD_CLOEXEC);
        }
    }
    let master_flags = unsafe { libc::fcntl(master, libc::F_GETFL) };
    if master_flags >= 0 {
        unsafe {
            libc::fcntl(master, libc::F_SETFL, master_flags | libc::O_NONBLOCK);
        }
    }
    let exe = std::env::current_exe().expect("test exe");
    let mut child = Command::new(exe)
        .env("QD_STDERR_PTY_CHILD", "1")
        .env("QD_STDERR_SLAVE", slave.to_string())
        .arg("a_tty_stderr_is_held_until_release")
        .arg("--exact")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .spawn()
        .expect("spawn");
    let early = read_fd_for(master, Duration::from_millis(120));
    assert!(
        !String::from_utf8_lossy(&early).contains("during"),
        "held bytes reached the tty: {}",
        String::from_utf8_lossy(&early)
    );
    let status = child.wait().expect("wait");
    let mut stdout = String::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut stdout)
        .unwrap();
    assert!(status.success(), "{stdout}");
    let late = read_fd_for(master, Duration::from_millis(200));
    let late_text = String::from_utf8_lossy(&late);
    assert!(late_text.contains("during"), "{late_text}");
    assert!(!late_text.contains("frame"), "{late_text}");
    assert!(stdout
        .as_bytes()
        .windows(5)
        .any(|window| window == b"frame"));
    unsafe {
        libc::close(master);
        libc::close(slave);
    }
}

fn read_fd_for(fd: RawFd, budget: Duration) -> Vec<u8> {
    let start = Instant::now();
    let mut out = Vec::new();
    let mut scratch = [0u8; 256];
    while start.elapsed() < budget {
        let n = unsafe { libc::read(fd, scratch.as_mut_ptr().cast(), scratch.len()) };
        if n > 0 {
            out.extend_from_slice(&scratch[..n as usize]);
            continue;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    out
}
