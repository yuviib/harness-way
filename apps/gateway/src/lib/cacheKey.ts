// Content-addressing key derivation for Capability 2's discrete tool-call
// cache. Two hashes matter here, for two different purposes, both computed
// with the same BLAKE3 wasm export (see wasmEngine.ts) but never confused
// with each other:
//   - requestHash: identifies "this exact tool call" (origin + tool name +
//     arguments) -- the index key a repeat caller's identical request maps
//     to. Computed here, over canonicalJson's output.
//   - resultHash: identifies the actual cached bytes, content-addressed --
//     computed by the caller (routes/relay.ts) directly over the origin's
//     raw response body via blake3Hex, not by anything in this file. Two
//     different requestHashes can legitimately map to the same resultHash
//     (two different tool calls that happen to produce identical output);
//     that's real content-addressing working as intended, not a bug.
import { blake3Hex } from "./wasmEngine";

// `JSON.stringify` on an object preserves insertion order, not a canonical
// order -- so a caller sending `{"resourceId":"42","scope":"a"}` and one
// sending the same two fields in the other order would otherwise hash to
// two different requestHashes despite being the identical request. That
// would silently defeat cache sharing between two independent callers who
// happen to build their JSON slightly differently (a real, likely scenario
// -- different HTTP client libraries, different object literal orderings in
// different agents' source) rather than a hypothetical edge case. Recursive
// so nested `arguments` objects are covered too, not just the top level.
// Arrays are NOT reordered -- element order is semantically meaningful
// (e.g. a tool call with positional arguments), unlike object key order.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    // Object.entries drops keys whose value is `undefined` implicitly via
    // JSON.stringify elsewhere in this codebase; made explicit here so
    // `{a: undefined}` and `{}` -- which JSON.stringify already treats as
    // equivalent -- canonicalize to the identical string, not one with a
    // stray `"a":undefined` that JSON.stringify(undefined) would otherwise
    // produce as literal `undefined` (invalid JSON) if handled naively.
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const body = entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",");
  return `{${body}}`;
}

export interface ToolCallRequest {
  originUrl: string;
  tool: string;
  arguments: Record<string, unknown>;
}

// The requestHash's own input is itself scoped to originUrl/tool/arguments
// only -- NOT to the caller-supplied `scope` string (see routes/relay.ts).
// Scope isolation is enforced one layer up, by routing to a
// scope-dedicated ContextIndex Durable Object instance (one SQLite database
// per scope), not by folding scope into this hash. Folding it in here
// would work too, but would make scope isolation an accident of hashing
// rather than a structural guarantee backed by real DO instance
// separation -- see ContextIndex.ts's own comment on this choice.
export function buildRequestHash(req: ToolCallRequest): string {
  return blake3Hex(canonicalJson({ originUrl: req.originUrl, tool: req.tool, arguments: req.arguments }));
}
