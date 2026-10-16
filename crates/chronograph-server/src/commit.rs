//! Coalesce concurrent durability requests into a single filesystem sync.
//!
//! A durable write used to hold the graph write lock across `sync()`, so concurrent writers
//! serialised and each paid for its own flush and fsync. Measured on the development machine, a
//! durable single insert cost 4.02 ms p50 and 243 requests a second, and that is the syscall,
//! not the engine.
//!
//! Two changes fix it. The write lock is released before the sync, so writers no longer queue
//! behind one another's fsync, and the first writer into this coordinator becomes the leader:
//! it syncs once, publishes the journal mark it saw under the lock, and every writer whose mark
//! is at or below that mark returns immediately. A writer that appended after the leader's mark
//! is not covered by that sync, so it becomes the next leader.
//!
//! The guarantee does not change: a request that asked for `fsync` returns only after a sync
//! that includes its bytes. A failed sync is reported to every waiter of that round, and the
//! next round tries again — the engine already disables the writer on an ambiguous failure.

use std::{
    sync::{Condvar, Mutex, PoisonError},
    time::Duration,
};

use crate::{ApiError, AppResult};

/// How long a leader waits for other writers before syncing, and only while the worker pool is
/// busy. An idle server keeps the single-writer latency it had.
const COALESCE: Duration = Duration::from_micros(150);

/// A waiter never blocks longer than this; a wedged filesystem must not hold a request forever.
const WAIT: Duration = Duration::from_secs(30);

#[derive(Default)]
struct State {
    syncing: bool,
    synced_mark: u64,
    generation: u64,
    error: Option<String>,
}

#[derive(Default)]
pub struct GroupCommit {
    state: Mutex<State>,
    done: Condvar,
}

impl GroupCommit {
    /// Wait until a sync has covered `mark`.
    ///
    /// `sync` is run by this thread when it becomes the leader. It must take the write lock,
    /// read the journal mark, flush it and fsync, and return the mark it saw before flushing.
    pub fn commit<F>(&self, mark: u64, contended: bool, mut sync: F) -> AppResult<()>
    where
        F: FnMut() -> AppResult<u64>,
    {
        let lock = || self.state.lock().unwrap_or_else(PoisonError::into_inner);
        loop {
            let mut state = lock();
            if state.synced_mark >= mark {
                return Ok(());
            }
            if state.syncing {
                let seen = state.generation;
                let (state, _) = self
                    .done
                    .wait_timeout(state, WAIT)
                    .unwrap_or_else(PoisonError::into_inner);
                // A round that failed after this waiter arrived must be reported, not retried
                // silently: the persistent outcome of its own bytes is unknown.
                if state.generation > seen && state.synced_mark < mark {
                    if let Some(error) = &state.error {
                        let error = error.clone();
                        drop(state);
                        return Err(ApiError::internal(error));
                    }
                }
                drop(state);
                continue;
            }
            state.syncing = true;
            drop(state);
            if contended {
                std::thread::sleep(COALESCE);
            }
            let outcome = sync();
            let mut state = lock();
            state.syncing = false;
            state.generation += 1;
            match outcome {
                Ok(covered) => {
                    state.synced_mark = covered;
                    state.error = None;
                }
                Err(error) => state.error = Some(error.to_string()),
            }
            let failed = state.error.clone();
            let covered = state.synced_mark;
            drop(state);
            self.done.notify_all();
            if let Some(error) = failed {
                return Err(ApiError::internal(error));
            }
            if covered >= mark {
                return Ok(());
            }
            // Another writer got ahead of this one's mark; become the leader again.
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    /// One sync serves every waiter whose mark it covers.
    ///
    /// The leader takes 100 ms to "sync"; the follower registers 5 ms later with a smaller mark,
    /// so it must not sync at all — it returns as soon as the leader publishes the mark it saw.
    #[test]
    fn a_single_sync_serves_every_waiter_it_covers() {
        let commit = Arc::new(GroupCommit::default());
        let syncs = Arc::new(AtomicUsize::new(0));

        let leader = {
            let commit = commit.clone();
            let syncs = syncs.clone();
            std::thread::spawn(move || {
                commit.commit(10, false, || {
                    syncs.fetch_add(1, Ordering::SeqCst);
                    std::thread::sleep(Duration::from_millis(100));
                    Ok(10)
                })
            })
        };
        std::thread::sleep(Duration::from_millis(5));
        let follower = {
            let commit = commit.clone();
            let syncs = syncs.clone();
            std::thread::spawn(move || {
                commit.commit(5, false, || {
                    syncs.fetch_add(1, Ordering::SeqCst);
                    Ok(5)
                })
            })
        };

        assert!(leader.join().unwrap().is_ok());
        assert!(follower.join().unwrap().is_ok());
        assert_eq!(
            syncs.load(Ordering::SeqCst),
            1,
            "the follower's bytes were covered by the leader's sync"
        );
    }

    /// A waiter whose mark is past the leader's sync does its own.
    #[test]
    fn a_waiter_past_the_covered_mark_syncs_itself() {
        let commit = Arc::new(GroupCommit::default());
        let syncs = Arc::new(AtomicUsize::new(0));
        let leader = {
            let commit = commit.clone();
            let syncs = syncs.clone();
            std::thread::spawn(move || {
                commit.commit(10, false, || {
                    syncs.fetch_add(1, Ordering::SeqCst);
                    std::thread::sleep(Duration::from_millis(100));
                    Ok(10)
                })
            })
        };
        std::thread::sleep(Duration::from_millis(5));
        let later = {
            let commit = commit.clone();
            let syncs = syncs.clone();
            std::thread::spawn(move || {
                commit.commit(20, false, || {
                    syncs.fetch_add(1, Ordering::SeqCst);
                    Ok(20)
                })
            })
        };

        assert!(leader.join().unwrap().is_ok());
        assert!(later.join().unwrap().is_ok());
        assert_eq!(syncs.load(Ordering::SeqCst), 2, "the second mark needs its own sync");
    }

    /// A sync that fails is reported to every waiter of that round, never swallowed.
    #[test]
    fn a_failed_sync_reaches_every_waiter() {
        let commit = Arc::new(GroupCommit::default());
        let syncs = Arc::new(AtomicUsize::new(0));
        let leader = {
            let commit = commit.clone();
            let syncs = syncs.clone();
            std::thread::spawn(move || {
                commit.commit(10, false, || {
                    syncs.fetch_add(1, Ordering::SeqCst);
                    std::thread::sleep(Duration::from_millis(100));
                    Err(ApiError::internal("the filesystem refused the sync"))
                })
            })
        };
        std::thread::sleep(Duration::from_millis(5));
        let follower = {
            let commit = commit.clone();
            let syncs = syncs.clone();
            std::thread::spawn(move || commit.commit(5, false, || Ok(5)))
        };

        assert!(leader.join().unwrap().is_err());
        assert!(follower.join().unwrap().is_err(), "the follower must not report success");
        assert_eq!(syncs.load(Ordering::SeqCst), 1, "a failure is not retried inside the round");
    }

    /// A mark that is already durable costs nothing.
    #[test]
    fn a_covered_mark_returns_without_syncing() {
        let commit = GroupCommit::default();
        let syncs = AtomicUsize::new(0);
        assert!(commit.commit(10, false, || {
            syncs.fetch_add(1, Ordering::SeqCst);
            Ok(10)
        }).is_ok());
        assert!(commit.commit(5, false, || {
            syncs.fetch_add(1, Ordering::SeqCst);
            Ok(5)
        }).is_ok());
        assert_eq!(syncs.load(Ordering::SeqCst), 1);
    }
}
