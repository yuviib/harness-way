//! Incremental, chunk-boundary-safe SSE event parser.
//!
//! The upstream `subscriptions/listen` connection is a long-lived HTTP
//! response read via the Streams API, so chunk boundaries never line up with
//! event boundaries -- an event, a field, or even a single line terminator
//! can legitimately be split across two `push` calls. This parser buffers
//! partial state between calls rather than assuming a chunk contains whole
//! lines or whole events.
//!
//! Callers are expected to feed valid UTF-8 text per chunk (e.g. via a
//! streaming-safe decoder such as JS `TextDecoder` in stream mode, which
//! never splits a multi-byte character across chunks). Splitting *within* a
//! UTF-8 character is out of scope here; splitting anywhere else -- mid
//! field name, mid value, mid line terminator, mid blank-line boundary -- is
//! exactly what this module exists to handle correctly.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SseEvent {
    pub id: Option<String>,
    pub event: Option<String>,
    pub data: String,
}

#[derive(Default)]
struct PendingEvent {
    id: Option<String>,
    event: Option<String>,
    data_lines: Vec<String>,
    touched: bool,
}

impl PendingEvent {
    fn dispatch(&mut self) -> Option<SseEvent> {
        if !self.touched {
            return None;
        }
        let data = self.data_lines.join("\n");
        let evt = SseEvent {
            id: self.id.take(),
            event: self.event.take(),
            data,
        };
        self.data_lines.clear();
        self.touched = false;
        Some(evt)
    }
}

pub struct SseParser {
    raw: String,
    pending: PendingEvent,
}

impl Default for SseParser {
    fn default() -> Self {
        Self::new()
    }
}

impl SseParser {
    pub fn new() -> Self {
        SseParser {
            raw: String::new(),
            pending: PendingEvent::default(),
        }
    }

    /// Feed a chunk of raw text from the upstream stream. Returns any
    /// complete events the new chunk finished. Safe to call with chunks
    /// split at any boundary, including mid-line-terminator.
    pub fn push(&mut self, chunk: &str) -> Vec<SseEvent> {
        self.raw.push_str(chunk);
        let lines = extract_lines(&mut self.raw, false);
        self.process_lines(lines)
    }

    /// Signal end of stream: flushes a trailing lone-`\r` terminator that
    /// was being held back in case a `\n` was about to follow it. Does NOT
    /// dispatch a partially-accumulated event with no trailing blank line --
    /// per SSE semantics an event is only complete on an explicit blank
    /// line, and a stream ending mid-event is a real, distinguishable
    /// truncation, not a silently-completed event.
    pub fn flush(&mut self) -> Vec<SseEvent> {
        let lines = extract_lines(&mut self.raw, true);
        self.process_lines(lines)
    }

    fn process_lines(&mut self, lines: Vec<String>) -> Vec<SseEvent> {
        let mut events = Vec::new();
        for line in lines {
            if line.is_empty() {
                if let Some(evt) = self.pending.dispatch() {
                    events.push(evt);
                }
                continue;
            }
            if line.starts_with(':') {
                continue; // comment / keep-alive line, e.g. the origin's own ": \r\n" pings
            }
            let (field, value) = match line.find(':') {
                Some(idx) => {
                    let field = &line[..idx];
                    let value = line[idx + 1..]
                        .strip_prefix(' ')
                        .unwrap_or(&line[idx + 1..]);
                    (field, value)
                }
                None => (line.as_str(), ""),
            };
            self.pending.touched = true;
            match field {
                "event" => self.pending.event = Some(value.to_string()),
                "id" => self.pending.id = Some(value.to_string()),
                "data" => self.pending.data_lines.push(value.to_string()),
                _ => {} // "retry" and unrecognized fields are ignored, per spec
            }
        }
        events
    }
}

/// Splits as many complete lines as currently possible out of `buf`,
/// draining them from the front. A line terminator is `\n`, `\r\n`, or a
/// lone `\r`. The one case that requires holding back is a `\r` sitting at
/// the very end of the buffer with nothing after it yet: that could be a
/// bare old-Mac-style terminator, or it could be the first half of a `\r\n`
/// whose `\n` hasn't arrived in a chunk yet. We can't tell which until either
/// more data arrives or the caller tells us the stream is done (`flush`).
fn extract_lines(buf: &mut String, flush: bool) -> Vec<String> {
    let mut lines = Vec::new();
    loop {
        if let Some(nl_pos) = buf.find('\n') {
            let end = if nl_pos > 0 && buf.as_bytes()[nl_pos - 1] == b'\r' {
                nl_pos - 1
            } else {
                nl_pos
            };
            let line = buf[..end].to_string();
            buf.drain(..=nl_pos);
            lines.push(line);
            continue;
        }
        if let Some(cr_pos) = buf.find('\r') {
            let more_after_cr = cr_pos + 1 < buf.len();
            if more_after_cr || flush {
                let line = buf[..cr_pos].to_string();
                buf.drain(..=cr_pos);
                lines.push(line);
                continue;
            }
            // \r is the last byte buffered and we're not flushing yet --
            // hold it back, the next push might bring the \n that pairs with it.
        }
        break;
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_event_single_push() {
        let mut p = SseParser::new();
        let events = p.push("event: update\ndata: hello\n\n");
        assert_eq!(
            events,
            vec![SseEvent {
                id: None,
                event: Some("update".to_string()),
                data: "hello".to_string(),
            }]
        );
    }

    #[test]
    fn multiple_events_one_push() {
        let mut p = SseParser::new();
        let events = p.push("data: one\n\ndata: two\n\n");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].data, "one");
        assert_eq!(events[1].data, "two");
    }

    #[test]
    fn multi_line_data_joined_with_newline() {
        let mut p = SseParser::new();
        let events = p.push("data: line one\ndata: line two\n\n");
        assert_eq!(events[0].data, "line one\nline two");
    }

    #[test]
    fn id_field_captured() {
        let mut p = SseParser::new();
        let events = p.push("id: 42\nevent: ping\ndata: {}\n\n");
        assert_eq!(events[0].id, Some("42".to_string()));
    }

    #[test]
    fn comment_lines_ignored_and_dont_produce_events() {
        let mut p = SseParser::new();
        let events = p.push(": keep-alive\n\ndata: real\n\n");
        // the comment's blank-line-free standalone ':' line produces nothing on
        // its own; only the real event after it should come through
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data, "real");
    }

    #[test]
    fn bare_field_with_no_colon_has_empty_value() {
        let mut p = SseParser::new();
        let events = p.push("data\n\n");
        assert_eq!(events[0].data, "");
    }

    #[test]
    fn split_mid_field_name() {
        let mut p = SseParser::new();
        assert!(p.push("dat").is_empty());
        let events = p.push("a: hello\n\n");
        assert_eq!(events[0].data, "hello");
    }

    #[test]
    fn split_mid_value() {
        let mut p = SseParser::new();
        assert!(p.push("data: hel").is_empty());
        let events = p.push("lo\n\n");
        assert_eq!(events[0].data, "hello");
    }

    #[test]
    fn split_exactly_between_the_two_newlines_of_the_blank_line() {
        let mut p = SseParser::new();
        assert!(p.push("data: hello\n").is_empty());
        let events = p.push("\n");
        assert_eq!(events[0].data, "hello");
    }

    #[test]
    fn split_exactly_between_cr_and_lf_of_a_crlf_terminator() {
        let mut p = SseParser::new();
        // "data: hello\r" arrives, then "\n\r\n" -- the \r at the end of the
        // first chunk must NOT be emitted as a line on its own; it has to be
        // held back until we know whether \n follows.
        assert!(p.push("data: hello\r").is_empty());
        let events = p.push("\n\r\n");
        assert_eq!(events[0].data, "hello");
    }

    #[test]
    fn crlf_line_endings_throughout() {
        let mut p = SseParser::new();
        let events = p.push("event: e\r\ndata: d\r\n\r\n");
        assert_eq!(
            events[0],
            SseEvent {
                id: None,
                event: Some("e".to_string()),
                data: "d".to_string(),
            }
        );
    }

    #[test]
    fn lone_cr_line_endings() {
        let mut p = SseParser::new();
        // A trailing lone `\r` is held back as ambiguous (it might be the
        // start of a `\r\n`) until more data resolves it -- so this needs a
        // second line after the blank one to force that resolution within a
        // single push, the same way real streamed data would.
        let events = p.push("data: d\r\rdata: next\r\r");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data, "d");
    }

    #[test]
    fn partial_event_with_no_trailing_blank_line_is_not_dispatched_until_flush_is_told_stream_ended(
    ) {
        let mut p = SseParser::new();
        let events = p.push("data: incomplete");
        assert!(events.is_empty());
        // flush() only finalizes buffered line-terminator ambiguity, it does
        // NOT synthesize a dispatch for an event with no blank line -- a
        // truncated event should be visibly absent, not silently completed.
        let flushed = p.flush();
        assert!(flushed.is_empty());
    }

    #[test]
    fn keep_alive_comments_interleaved_with_events_dont_corrupt_state() {
        let mut p = SseParser::new();
        let events = p.push("data: one\n\n: ping\n: ping\ndata: two\n\n");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].data, "one");
        assert_eq!(events[1].data, "two");
    }
}
