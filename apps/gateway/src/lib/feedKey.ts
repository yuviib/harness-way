// One DO per (origin, category) pair -- the feed key IS the multiplexing
// boundary: every downstream subscriber to the same origin+category ends up
// routed to the same DO instance and therefore the same single upstream
// connection. JSON-encoding the pair (rather than naive string concatenation
// with a separator) matters: a delimiter like "::" can legally appear inside
// a URL's query string, so two DIFFERENT (originUrl, category) pairs could
// otherwise collide onto the same key and get routed to the same DO -- a
// real cross-subscription data leak, not just a correctness nit. JSON array
// serialization of two strings can't collide this way.
//
// Shared between routes/subscribe.ts (routing) and do/FeedRelay.ts
// (delivery-log tagging) so both derive the same key from the same
// origin+category -- reimplementing this in two places would risk them
// silently drifting apart.
export function buildFeedKey(originUrl: string, category: string): string {
  return JSON.stringify([originUrl, category]);
}
