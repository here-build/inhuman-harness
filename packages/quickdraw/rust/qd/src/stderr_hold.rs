//! Hold fd 2 while it is the terminal.
//!
//! A log line written during the alternate screen is discarded on leave-alt.
//! When fd 2 is a tty, this swaps it for a pipe and keeps the bytes. Release
//! writes them back after leave-alt. A pipe or a file stays live: nothing is
//! installed. This module does not touch fd 0 or fd 1.

use std::io::{self, Write};
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd, OwnedFd};

/// Saved tty stderr, or a no-op when fd 2 was not a terminal.
///
/// `saved` and `read_end` own their descriptors. Drop closes whichever
/// `release` has not already taken.
pub struct StderrHold {
    saved: Option<OwnedFd>,
    read_end: Option<OwnedFd>,
    buf: Vec<u8>,
}

impl StderrHold {
    /// Install the pipe when `isatty(2)` is true. Otherwise return a no-op.
    pub fn install() -> io::Result<Self> {
        // SAFETY: isatty only reads the status of fd 2. It does not close it.
        if unsafe { libc::isatty(2) } == 0 {
            return Ok(Self {
                saved: None,
                read_end: None,
                buf: Vec::new(),
            });
        }
        // SAFETY: a non-negative `dup` is a new open fd. This `OwnedFd` is
        // the only owner, so its drop closes it.
        let saved_raw = unsafe { libc::dup(2) };
        if saved_raw < 0 {
            return Err(io::Error::last_os_error());
        }
        let saved = unsafe { OwnedFd::from_raw_fd(saved_raw) };
        let mut ends = [0i32; 2];
        // SAFETY: pipe writes two new fds into `ends`. Each `OwnedFd` below
        // is the only owner of one of them.
        if unsafe { libc::pipe(ends.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let read_end = unsafe { OwnedFd::from_raw_fd(ends[0]) };
        let write_end = unsafe { OwnedFd::from_raw_fd(ends[1]) };
        set_nonblock(read_end.as_fd())?;
        // SAFETY: dup2 replaces fd 2 with the pipe's write end. fd 0 and fd 1
        // are not in this call. The original stderr remains `saved`.
        if unsafe { libc::dup2(write_end.as_raw_fd(), 2) } < 0 {
            return Err(io::Error::last_os_error());
        }
        // Drop the spare write end. fd 2 still refers to the pipe.
        drop(write_end);
        Ok(Self {
            saved: Some(saved),
            read_end: Some(read_end),
            buf: Vec::new(),
        })
    }

    /// Pipe read end, when a hold is installed.
    pub fn read_fd(&self) -> Option<BorrowedFd<'_>> {
        self.read_end.as_ref().map(OwnedFd::as_fd)
    }

    /// Pull whatever the pipe currently has into the hold buffer.
    pub fn drain(&mut self) -> io::Result<()> {
        let Some(fd) = self.read_end.as_ref().map(OwnedFd::as_fd) else {
            return Ok(());
        };
        let mut scratch = [0u8; 512];
        loop {
            // SAFETY: `fd` is the pipe read end this struct owns. `scratch` is
            // a live writable buffer. A negative return is an errno.
            let n =
                unsafe { libc::read(fd.as_raw_fd(), scratch.as_mut_ptr().cast(), scratch.len()) };
            if n < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::WouldBlock {
                    return Ok(());
                }
                return Err(error);
            }
            if n == 0 {
                return Ok(());
            }
            let Ok(n) = usize::try_from(n) else {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "stderr hold read",
                ));
            };
            self.buf.extend_from_slice(&scratch[..n]);
        }
    }

    /// Flush, drain, write the buffer to the saved stderr, and put fd 2 back.
    /// A second call does nothing.
    pub fn release(&mut self) -> io::Result<()> {
        let Some(saved) = self.saved.take() else {
            return Ok(());
        };
        let _ = io::stderr().flush();
        let drained = self.drain();
        let wrote = write_all_fd(saved.as_fd(), &self.buf);
        // SAFETY: `saved` is the original stderr. dup2 puts it back on fd 2.
        // fd 0 and fd 1 are not in this call. Dropping `saved` and `read_end`
        // closes those descriptors and does not close fd 2.
        let restored = unsafe { libc::dup2(saved.as_raw_fd(), 2) };
        drop(saved);
        self.read_end.take();
        self.buf.clear();
        drained?;
        wrote?;
        if restored < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

impl Drop for StderrHold {
    fn drop(&mut self) {
        let _ = self.release();
    }
}

fn set_nonblock(fd: BorrowedFd<'_>) -> io::Result<()> {
    // SAFETY: `fd` is the pipe read end this function just created. F_GETFL
    // and F_SETFL change only that descriptor.
    let raw = fd.as_raw_fd();
    let flags = unsafe { libc::fcntl(raw, libc::F_GETFL) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    let rc = unsafe { libc::fcntl(raw, libc::F_SETFL, flags | libc::O_NONBLOCK) };
    if rc < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn write_all_fd(fd: BorrowedFd<'_>, mut bytes: &[u8]) -> io::Result<()> {
    let raw = fd.as_raw_fd();
    while !bytes.is_empty() {
        // SAFETY: `raw` is the saved stderr. `bytes` is the hold buffer.
        // A negative return is -1 and writes none of this slice.
        let n = unsafe { libc::write(raw, bytes.as_ptr().cast(), bytes.len()) };
        if n < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        let Ok(n) = usize::try_from(n) else {
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "stderr hold write",
            ));
        };
        if n == 0 || n > bytes.len() {
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "stderr hold write",
            ));
        }
        bytes = &bytes[n..];
    }
    Ok(())
}
