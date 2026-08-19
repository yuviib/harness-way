//! Content hashing for Capability 2 (shared content-addressed cache).
//!
//! BLAKE3 specifically, not a general-purpose or keyed digest: it's fast
//! enough to hash every discrete tool-call request and response on the hot
//! path without a measurable tax, and -- unlike MD5/SHA-1 -- has no known
//! collision weakness a cache built on "identical hash implies identical
//! content" would need to worry about. The `blake3` crate's default
//! (non-`no_std`) build auto-selects a portable-Rust implementation for
//! `wasm32-unknown-unknown` (no C toolchain / SIMD assembly involved,
//! confirmed by this crate's own `wasm-pack build` succeeding on a machine
//! with no MSVC Build Tools -- see hash.rs's test module and the Week 1
//! toolchain notes in PLAN.md), so this needs no wasm-specific feature
//! flags or workarounds, unlike some of this crate's other dependencies.

/// Hex-encoded BLAKE3-256 digest of `data`. Always exactly 64 lowercase hex
/// characters (32 bytes), independent of input length, including the empty
/// slice -- there is no "no hash" case, only "the hash of nothing".
pub fn hash_hex(data: &[u8]) -> String {
    blake3::hash(data).to_hex().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_input_matches_the_published_blake3_test_vector() {
        // The official BLAKE3 test vectors (upstream project's own
        // test_vectors.json, input length 0) publish this exact digest for
        // hashing zero bytes -- asserted here as a known value, not derived
        // from this crate's own output, specifically so a future dependency
        // bump that silently changed the algorithm would be caught.
        assert_eq!(
            hash_hex(b""),
            "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262"
        );
    }

    #[test]
    fn hash_is_always_64_lowercase_hex_characters() {
        for input in [&b""[..], b"a", b"the quick brown fox", &[0u8; 10_000]] {
            let digest = hash_hex(input);
            assert_eq!(digest.len(), 64, "input len {}", input.len());
            assert!(digest.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        }
    }

    #[test]
    fn identical_input_hashes_identically() {
        let a = hash_hex(b"{\"tool\":\"resource_lookup\",\"arguments\":{\"resourceId\":\"42\"}}");
        let b = hash_hex(b"{\"tool\":\"resource_lookup\",\"arguments\":{\"resourceId\":\"42\"}}");
        assert_eq!(a, b);
    }

    #[test]
    fn a_single_byte_difference_produces_a_wholly_different_hash() {
        // Not just "different" -- avalanche behavior means no small, easily
        // -confused-with-a-bug similarity between the two outputs either.
        let a = hash_hex(b"resourceId:42");
        let b = hash_hex(b"resourceId:43");
        assert_ne!(a, b);
        let shared_prefix = a.bytes().zip(b.bytes()).take_while(|(x, y)| x == y).count();
        assert!(shared_prefix < 4, "unexpectedly similar hashes: {a} vs {b}");
    }

    #[test]
    fn content_addressing_holds_key_order_sensitive() {
        // hash_hex itself is a pure byte hash with no JSON awareness -- this
        // documents (not "fixes") that two byte-distinct-but-semantically-
        // equivalent JSON encodings hash differently. Canonicalization
        // (sorting object keys before hashing) is a caller responsibility,
        // implemented and tested at the call site in the gateway
        // (src/lib/cacheKey.ts), not here.
        let a = hash_hex(br#"{"a":1,"b":2}"#);
        let b = hash_hex(br#"{"b":2,"a":1}"#);
        assert_ne!(a, b);
    }
}
