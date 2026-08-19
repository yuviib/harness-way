import wasmModule from "../wasm/mcp_relay_engine_bg.wasm";
// @ts-expect-error -- wasm-bindgen's generated _bg.js has no .d.ts of its own;
// the real type surface is re-exported (typed) from wasm/mcp_relay_engine.d.ts.
import * as bindgen from "../wasm/mcp_relay_engine_bg.js";

// wasm-pack's `--target bundler` glue (wasm/mcp_relay_engine.js) assumes
// webpack's wasm-loader semantics: `import * as wasm from "*.wasm"` yielding
// an already-instantiated exports object. Cloudflare Workers' bundler
// instead resolves a `.wasm` import to a raw, uninstantiated
// `WebAssembly.Module` (confirmed against Cloudflare's own docs, not
// assumed) -- so the generated entry point fails at top level with
// "wasm.__wbindgen_start is not a function" the moment it's imported.
//
// The fix is to instantiate the module ourselves, against the exact import
// object the compiled binary actually declares. That's verified directly
// here (not guessed) via `WebAssembly.Module.imports()`: this module has
// exactly one import, `__wbindgen_init_externref_table` from a module
// namespace named after its own glue file, `./mcp_relay_engine_bg.js` --
// which is precisely what `bindgen`'s exports already provide.
const instance = await WebAssembly.instantiate(wasmModule, {
  "./mcp_relay_engine_bg.js": bindgen,
});
bindgen.__wbg_set_wasm(instance.exports);
(instance.exports as { __wbindgen_start: () => void }).__wbindgen_start();

export interface WasmSseParser {
  push(chunk: string): string;
  flush(): string;
}
export const WasmSseParser: new () => WasmSseParser = bindgen.WasmSseParser;

// BLAKE3, hex-encoded -- backs Capability 2's content-addressed cache (see
// src/lib/cacheKey.ts). A plain function export, not a struct: unlike
// WasmSseParser there is no state to hold across calls.
export const blake3Hex: (data: string) => string = bindgen.blake3_hex;
