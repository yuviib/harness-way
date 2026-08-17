//! Bounded, in-memory replay buffer for a single feed.
//!
//! Sequence numbers are assigned by the buffer itself at ingestion time,
//! independent of whatever `id` the upstream may or may not set on an SSE
//! event -- upstream `id` values aren't guaranteed to be present, monotonic,
//! or gap-free, so gap detection can't rely on them. `seq` is the one thing
//! this module guarantees: strictly increasing, one per pushed event,
//! regardless of eviction.

use serde::Serialize;
use std::collections::VecDeque;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BufferedEvent {
    pub seq: u64,
    pub upstream_id: Option<String>,
    pub event: Option<String>,
    pub data: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReplaySince {
    /// Everything retained after the caller's last-seen seq, in order. Empty
    /// if the caller is already fully caught up.
    Events(Vec<BufferedEvent>),
    /// The caller's last-seen seq is older than anything still retained --
    /// there is a real hole. `oldest_available_seq` is where the gap ends,
    /// so the caller can report exactly what it's missing rather than just
    /// "something broke."
    Gap { oldest_available_seq: u64 },
}

pub struct RingBuffer {
    capacity: usize,
    buf: VecDeque<BufferedEvent>,
    next_seq: u64,
}

impl RingBuffer {
    pub fn new(capacity: usize) -> Self {
        assert!(capacity > 0, "RingBuffer capacity must be at least 1");
        RingBuffer {
            capacity,
            buf: VecDeque::with_capacity(capacity),
            next_seq: 1,
        }
    }

    /// Assigns the next monotonic seq, stores the event, evicting the
    /// oldest entry first if already at capacity. Returns the assigned seq
    /// so the caller can log/echo it (e.g. as the delivery-log entry's
    /// seq, or back to the client as its new resume point).
    pub fn push(
        &mut self,
        upstream_id: Option<String>,
        event: Option<String>,
        data: String,
    ) -> u64 {
        let seq = self.next_seq;
        self.next_seq += 1;
        if self.buf.len() == self.capacity {
            self.buf.pop_front();
        }
        self.buf.push_back(BufferedEvent {
            seq,
            upstream_id,
            event,
            data,
        });
        seq
    }

    /// Replay everything after `last_seen_seq`. Pass 0 for "I have no prior
    /// state, give me everything you have" -- that falls out naturally from
    /// seq numbering starting at 1, no special-casing needed.
    pub fn replay_since(&self, last_seen_seq: u64) -> ReplaySince {
        if let Some(oldest) = self.buf.front().map(|e| e.seq) {
            if last_seen_seq + 1 < oldest {
                return ReplaySince::Gap {
                    oldest_available_seq: oldest,
                };
            }
        }
        let events: Vec<BufferedEvent> = self
            .buf
            .iter()
            .filter(|e| e.seq > last_seen_seq)
            .cloned()
            .collect();
        ReplaySince::Events(events)
    }

    pub fn len(&self) -> usize {
        self.buf.len()
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn push_n(rb: &mut RingBuffer, n: u64) {
        for i in 0..n {
            rb.push(None, None, format!("payload-{i}"));
        }
    }

    #[test]
    fn seq_starts_at_one_and_increments() {
        let mut rb = RingBuffer::new(10);
        assert_eq!(rb.push(None, None, "a".into()), 1);
        assert_eq!(rb.push(None, None, "b".into()), 2);
        assert_eq!(rb.push(None, None, "c".into()), 3);
    }

    #[test]
    fn eviction_keeps_len_at_capacity_and_seq_still_increments() {
        let mut rb = RingBuffer::new(3);
        push_n(&mut rb, 5);
        assert_eq!(rb.len(), 3);
        // seq must keep climbing across evictions, not reset or reuse --
        // the next push after 5 prior ones must be seq 6.
        assert_eq!(rb.push(None, None, "next".into()), 6);
        assert_eq!(rb.len(), 3);
    }

    #[test]
    fn replay_since_within_retained_range_returns_correct_subset_in_order() {
        let mut rb = RingBuffer::new(10);
        push_n(&mut rb, 5); // seqs 1..=5
        match rb.replay_since(2) {
            ReplaySince::Events(events) => {
                let seqs: Vec<u64> = events.iter().map(|e| e.seq).collect();
                assert_eq!(seqs, vec![3, 4, 5]);
            }
            ReplaySince::Gap { .. } => panic!("expected events, not a gap"),
        }
    }

    #[test]
    fn replay_since_fresh_client_no_eviction_yet_returns_everything() {
        let mut rb = RingBuffer::new(10);
        push_n(&mut rb, 3);
        match rb.replay_since(0) {
            ReplaySince::Events(events) => assert_eq!(events.len(), 3),
            ReplaySince::Gap { .. } => panic!("expected events, no eviction has happened yet"),
        }
    }

    #[test]
    fn replay_since_caught_up_exactly_returns_empty_not_a_gap() {
        let mut rb = RingBuffer::new(10);
        push_n(&mut rb, 5);
        match rb.replay_since(5) {
            ReplaySince::Events(events) => assert!(events.is_empty()),
            ReplaySince::Gap { .. } => panic!("caller is fully caught up, this must not be a gap"),
        }
    }

    #[test]
    fn fresh_client_after_eviction_sees_gap() {
        let mut rb = RingBuffer::new(3);
        push_n(&mut rb, 5); // seqs 1,2 evicted; 3,4,5 retained
        match rb.replay_since(0) {
            ReplaySince::Gap {
                oldest_available_seq,
            } => assert_eq!(oldest_available_seq, 3),
            ReplaySince::Events(_) => panic!("client asked for everything but seqs 1-2 are gone"),
        }
    }

    #[test]
    fn boundary_last_seen_immediately_before_oldest_retained_is_not_a_gap() {
        let mut rb = RingBuffer::new(3);
        push_n(&mut rb, 5); // oldest retained is seq 3
        match rb.replay_since(2) {
            ReplaySince::Events(events) => {
                let seqs: Vec<u64> = events.iter().map(|e| e.seq).collect();
                assert_eq!(seqs, vec![3, 4, 5]);
            }
            ReplaySince::Gap { .. } => {
                panic!("last_seen_seq=2 is exactly caught up to the eviction boundary, not a gap")
            }
        }
    }

    #[test]
    fn boundary_last_seen_one_before_that_is_a_gap() {
        let mut rb = RingBuffer::new(3);
        push_n(&mut rb, 5); // oldest retained is seq 3
        match rb.replay_since(1) {
            ReplaySince::Gap {
                oldest_available_seq,
            } => assert_eq!(oldest_available_seq, 3),
            ReplaySince::Events(_) => {
                panic!("seq 2 was evicted and never seen by this client -- must be a gap")
            }
        }
    }

    #[test]
    fn last_seen_seq_beyond_newest_returns_empty_gracefully_not_a_panic() {
        let mut rb = RingBuffer::new(10);
        push_n(&mut rb, 3);
        match rb.replay_since(999) {
            ReplaySince::Events(events) => assert!(events.is_empty()),
            ReplaySince::Gap { .. } => {
                panic!("an impossible future seq shouldn't be reported as a gap")
            }
        }
    }

    #[test]
    fn capacity_one_evicts_previous_item_every_push() {
        let mut rb = RingBuffer::new(1);
        push_n(&mut rb, 3);
        assert_eq!(rb.len(), 1);
        match rb.replay_since(0) {
            ReplaySince::Gap {
                oldest_available_seq,
            } => assert_eq!(oldest_available_seq, 3),
            ReplaySince::Events(_) => panic!("seqs 1-2 were evicted"),
        }
    }

    #[test]
    #[should_panic(expected = "capacity must be at least 1")]
    fn zero_capacity_panics_at_construction_not_silently_accepted() {
        RingBuffer::new(0);
    }
}
