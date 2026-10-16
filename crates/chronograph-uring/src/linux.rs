//! The Linux implementation: multishot accept, multishot recv, kernel-provided buffers.
use std::alloc::{Layout, alloc_zeroed, dealloc};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::ptr::NonNull;

use io_uring::types::BufRingEntry;
use io_uring::{IoUring, opcode, types};
use tokio::sync::watch;

pub use crate::{PROVIDED_BUFFERS, PROVIDED_BUFFER_SIZE};

/// The accept operation is the one submission that is not tied to a connection.
const ACCEPT_TOKEN: u64 = u64::MAX;
/// Buffer group id; one group is enough for one listener.
const BGID: u16 = 0;
/// The kernel aligns a buffer ring to the page size and takes that address directly.
const PAGE: usize = 4096;
/// `IORING_CQE_F_BUFFER`: the completion names the provided buffer it used.
const CQE_F_BUFFER: u32 = 1;
/// `IORING_CQE_BUFFER_SHIFT`: where that id starts.
const CQE_BUFFER_SHIFT: u32 = 16;

/// Whether this kernel and sandbox allow an io_uring at all. A refusal is normal, not an error.
pub fn available() -> bool {
    IoUring::new(8).is_ok()
}

/// Why the probe failed, for the single line a caller logs at start-up.
pub fn unavailable_reason() -> Option<String> {
    IoUring::new(8).err().map(|error| error.to_string())
}

/// One received batch: the connection it belongs to and the bytes the kernel filled.
pub struct Batch<'a> {
    pub connection: RawFd,
    pub bytes: &'a [u8],
}

/// What the loop does with a batch: return the bytes to send, or `None` to close the connection.
pub trait Handler {
    fn on_bytes(&mut self, connection: RawFd, bytes: &[u8]) -> Option<Vec<u8>>;
}

/// The provided buffers, and the ring the kernel reads their addresses from.
///
/// The kernel writes into these buffers directly and hands back an id, so a read never allocates.
/// A buffer is handed back to the ring after the handler has looked at it, which is what makes the
/// group reusable; when every entry is out, the next read waits instead of allocating.
struct ProvidedBuffers {
    ring: NonNull<BufRingEntry>,
    entries: u16,
    data: Vec<u8>,
}

impl ProvidedBuffers {
    fn new(entries: u16, size: u32) -> io::Result<Self> {
        let bytes = entries as usize * std::mem::size_of::<BufRingEntry>();
        let layout = Layout::from_size_align(bytes, PAGE).map_err(io::Error::other)?;
        let ring = unsafe { alloc_zeroed(layout) } as *mut BufRingEntry;
        let ring = NonNull::new(ring).ok_or_else(|| io::Error::other("no memory for the ring"))?;
        let data = vec![0u8; entries as usize * size as usize];
        for i in 0..entries as usize {
            let entry = unsafe { &mut *ring.as_ptr().add(i) };
            entry.set_addr(data.as_ptr() as u64 + (i * size as usize) as u64);
            entry.set_len(size);
            entry.set_bid(i as u16);
        }
        // Publishing the tail is what tells the kernel these are available.
        unsafe { std::ptr::write_volatile(BufRingEntry::tail(ring.as_ptr()) as *mut u16, entries) };
        Ok(Self { ring, entries, data })
    }

    fn register(&self, submitter: &io_uring::Submitter) -> io::Result<()> {
        unsafe {
            submitter.register_buf_ring_with_flags(self.ring.as_ptr() as u64, self.entries, BGID, 0)
        }
    }

    /// The slice the kernel filled for a completion that named `id`.
    fn slice(&self, id: u16, len: u32) -> &[u8] {
        let start = id as usize * PROVIDED_BUFFER_SIZE as usize;
        &self.data[start..start + len as usize]
    }

    /// Hand a buffer back so the kernel can use it again.
    fn recycle(&self, id: u16) {
        unsafe {
            let entry = &mut *self.ring.as_ptr().add(id as usize);
            entry.set_bid(id);
            entry.set_addr(self.data.as_ptr() as u64 + (id as usize * PROVIDED_BUFFER_SIZE as usize) as u64);
            entry.set_len(PROVIDED_BUFFER_SIZE);
            let tail = BufRingEntry::tail(self.ring.as_ptr()) as *mut u16;
            let used = std::ptr::read_volatile(tail);
            std::ptr::write_volatile(tail, used.wrapping_add(1));
        }
    }
}

impl Drop for ProvidedBuffers {
    fn drop(&mut self) {
        let bytes = self.entries as usize * std::mem::size_of::<BufRingEntry>();
        if let Ok(layout) = Layout::from_size_align(bytes, PAGE) {
            unsafe { dealloc(self.ring.as_ptr().cast(), layout) };
        }
    }
}

/// Serve `listener` until `stop` is set.
///
/// The caller keeps the listening socket, so a refusal or an error here leaves the portable
/// listener free to take over.
pub fn serve<H: Handler>(
    listener: &OwnedFd,
    mut handler: H,
    stop: watch::Receiver<bool>,
) -> io::Result<()> {
    let mut ring = IoUring::new(256)?;
    let buffers = ProvidedBuffers::new(PROVIDED_BUFFERS, PROVIDED_BUFFER_SIZE)?;
    buffers.register(&ring.submitter())?;
    submit_accept(&mut ring, listener.as_raw_fd())?;

    loop {
        if *stop.borrow() {
            return Ok(());
        }
        ring.submit_and_wait(1)?;
        let mut completions: Vec<(u64, i32, u32)> = Vec::new();
        {
            let mut queue = ring.completion();
            queue.sync();
            for entry in queue {
                completions.push((entry.user_data(), entry.result(), entry.flags()));
            }
        }
        for (token, result, flags) in completions {
            if token == ACCEPT_TOKEN {
                if result < 0 {
                    // A refused connection is not fatal: the accept stays armed.
                    continue;
                }
                submit_receive(&mut ring, result, BGID)?;
                continue;
            }
            let connection = token as RawFd;
            if result <= 0 {
                unsafe { libc::close(connection) };
                continue;
            }
            if let Some(id) = buffer_id(flags) {
                if let Some(response) = handler.on_bytes(connection, buffers.slice(id, result as u32)) {
                    let _ = write_all(connection, &response);
                }
                buffers.recycle(id);
            }
        }
    }
}

/// Which provided buffer a completion used, if it carried one.
fn buffer_id(flags: u32) -> Option<u16> {
    (flags & CQE_F_BUFFER != 0).then_some((flags >> CQE_BUFFER_SHIFT) as u16)
}

fn submit_accept(ring: &mut IoUring, listener: RawFd) -> io::Result<()> {
    let entry = opcode::AcceptMulti::new(types::Fd(listener))
        .build()
        .user_data(ACCEPT_TOKEN);
    unsafe {
        ring.submission()
            .push(&entry)
            .map_err(|_| io::Error::other("submission queue is full"))?;
    }
    ring.submit().map(drop)
}

fn submit_receive(ring: &mut IoUring, connection: RawFd, group: u16) -> io::Result<()> {
    let entry = opcode::RecvMulti::new(types::Fd(connection), group)
        .build()
        .user_data(connection as u64);
    unsafe {
        ring.submission()
            .push(&entry)
            .map_err(|_| io::Error::other("submission queue is full"))?;
    }
    ring.submit().map(drop)
}

/// Write the whole response, so a short write cannot truncate a body.
fn write_all(connection: RawFd, mut bytes: &[u8]) -> io::Result<()> {
    while !bytes.is_empty() {
        let written =
            unsafe { libc::write(connection, bytes.as_ptr() as *const libc::c_void, bytes.len()) };
        if written < 0 {
            return Err(io::Error::last_os_error());
        }
        bytes = &bytes[written as usize..];
    }
    Ok(())
}

/// An owned connection is closed when it is dropped, which is what an error path needs.
fn _close_on_drop(fd: RawFd) -> OwnedFd {
    unsafe { OwnedFd::from_raw_fd(fd) }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Either the ring opens, or the refusal carries a reason. Both pass; a panic does not.
    #[test]
    fn the_probe_reports_a_ring_or_a_reason() {
        match IoUring::new(8) {
            Ok(_) => assert!(available()),
            Err(error) => assert!(
                unavailable_reason().is_some(),
                "a refusal has a reason: {error}"
            ),
        }
    }

    #[test]
    fn a_buffer_id_comes_from_the_completion_flags() {
        assert_eq!(buffer_id(CQE_F_BUFFER | (7 << CQE_BUFFER_SHIFT)), Some(7));
        assert_eq!(buffer_id(0), None);
    }

    /// The ring is built from the machine's own memory and every entry names a real buffer.
    #[test]
    fn the_buffer_ring_describes_real_buffers() {
        let buffers = ProvidedBuffers::new(4, 128).expect("the ring");
        assert_eq!(buffers.data.len(), 512);
        unsafe {
            assert_eq!(
                std::ptr::read_volatile(BufRingEntry::tail(buffers.ring.as_ptr())),
                4
            );
            let first = &*buffers.ring.as_ptr();
            assert_eq!(first.len(), 128);
            assert_eq!(first.addr(), buffers.data.as_ptr() as u64);
            assert_eq!(first.bid(), 0);
        }
    }
}
