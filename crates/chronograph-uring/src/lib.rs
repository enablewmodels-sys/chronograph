//! Completion-based I/O for the listener: multishot accept and provided-buffer receives.
//!
//! The portable path is one socket per acceptor with `SO_REUSEPORT`, which lets the kernel hash a
//! connection to a worker's queue but still costs one `accept` and one `recv` per event. This
//! crate is the other half of that idea: one `multishot accept` keeps delivering connections from
//! a single submission, and one `multishot recv` per connection keeps delivering bytes into
//! kernel-provided buffers, so the steady state submits nothing per event.
//!
//! It is not the default and it is not runtime-verified on a macOS development machine. The
//! kernel can refuse the whole interface — Docker's default seccomp profile, most CI sandboxes and
//! kernels before 5.1 answer `EPERM` or `ENOSYS` — so `available` is a probe and every caller
//! keeps a portable path behind it. `serve` is an implementation of the primitives with a probe
//! test; wiring it behind the HTTP stack is the next step and needs a Linux run to verify.

/// Linux: the real thing. Everywhere else: a stub that reports why.
#[cfg(target_os = "linux")]
mod linux;

#[cfg(target_os = "linux")]
pub use linux::{Batch, Handler, available, serve, unavailable_reason};

/// Bytes the kernel hands over per read on Linux. Present on every platform so a caller can size
/// a fallback buffer without a conditional.
pub const PROVIDED_BUFFER_SIZE: u32 = 16 * 1024;
/// Buffers the kernel owns at once; this is the back-pressure when none are left.
pub const PROVIDED_BUFFERS: u16 = 256;

#[cfg(not(target_os = "linux"))]
mod portable {
    use std::io;

    /// io_uring is a Linux interface. This is the answer on every other platform.
    pub fn available() -> bool {
        false
    }

    /// The reason a caller should log instead of trying.
    pub fn unavailable_reason() -> Option<String> {
        Some("io_uring is a Linux interface; this build keeps the portable listener".to_string())
    }

    /// Refuses on a platform that has no io_uring, rather than pretending to serve.
    pub fn serve() -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "io_uring is a Linux interface",
        ))
    }
}

#[cfg(not(target_os = "linux"))]
pub use portable::{available, serve, unavailable_reason};
