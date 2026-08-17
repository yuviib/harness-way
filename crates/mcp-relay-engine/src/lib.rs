mod ring_buffer;
mod sse_framing;

pub use ring_buffer::{BufferedEvent, ReplaySince, RingBuffer};
pub use sse_framing::{SseEvent, SseParser};

use wasm_bindgen::prelude::*;

/// Stateful incremental SSE parser exposed to JS, holding partial-line and
/// partial-event state across calls via the wasm instance. A real upstream
/// connection's chunk boundaries never line up with event boundaries, so the
/// caller must feed every chunk from one connection into the *same*
/// `WasmSseParser` instance -- constructing a fresh one per chunk would
/// silently discard exactly the buffered state that makes chunk-boundary
/// safety work at all.
#[wasm_bindgen]
pub struct WasmSseParser {
    inner: SseParser,
}

#[wasm_bindgen]
impl WasmSseParser {
    #[wasm_bindgen(constructor)]
    pub fn new() -> WasmSseParser {
        WasmSseParser {
            inner: SseParser::new(),
        }
    }

    /// Feed a chunk of raw text; returns any newly-completed events as a
    /// JSON array string (possibly empty).
    pub fn push(&mut self, chunk: &str) -> String {
        let events = self.inner.push(chunk);
        serde_json::to_string(&events).unwrap_or_else(|_| "[]".to_string())
    }

    /// Signal end of stream: resolves a trailing ambiguous line-terminator
    /// if one was held back, but does not synthesize a dispatch for an
    /// event with no closing blank line. Returns any events that resolves,
    /// as a JSON array string (possibly empty).
    pub fn flush(&mut self) -> String {
        let events = self.inner.flush();
        serde_json::to_string(&events).unwrap_or_else(|_| "[]".to_string())
    }
}

impl Default for WasmSseParser {
    fn default() -> Self {
        Self::new()
    }
}
