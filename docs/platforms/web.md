# Web / SPA playbook

Easiest target class: the source ships to the browser. Hardest part is usually the bundler, not the app.

## 1. Capture first, read second

Chrome DevTools → Network → reload + interact → **Save all as HAR**. This is your ground truth and the
raw material for `03-api-surface.yaml`.

Also grab: Sources tree (Chrome reconstructs the original file tree when sourcemaps exist), Application
tab (localStorage, sessionStorage, IndexedDB, cookies, Cache Storage, service worker), and
`window.__NEXT_DATA__` / `__NUXT__` / `__APOLLO_STATE__` / `__INITIAL_STATE__` for the SSR hydration
payload.

## 2. Identify the framework

| Signal | Framework |
|---|---|
| `data-reactroot`, `__REACT_DEVTOOLS_GLOBAL_HOOK__` | React |
| `window.__NEXT_DATA__`, `/_next/static/` | Next.js |
| `__NUXT__`, `/_nuxt/` | Nuxt |
| `__VUE_DEVTOOLS_GLOBAL_HOOK__`, `data-v-*` | Vue |
| `ng-version`, `ngOnInit` | Angular |
| `webpackChunk`, `webpackJsonp`, `self.webpackChunk_N_E` | Webpack |
| `runtime~`, `chunk.js`, `main.*.js` | code-split bundle |
| `__sveltekit_*` | SvelteKit |

## 3. Recover readable source

Best case — sourcemaps are published:

```bash
npx shuji bundle.js.map -o out/          # reconstruct originals from the map
npx sourcemapper --input bundle.js.map --output out/
# or: https://spaceraccoon.github.io/webpack-exploder/
```

No sourcemaps — unpack and deobfuscate:

```bash
npx webcrack bundle.js -o out/                    # deobfuscate + unpack webpack/browserify
npx bundle-breaker -c path/to/bundle ./out        # debundle → one file per module
npx bundle-breaker -cd path/to/bundle ./out       # + deobfuscate
```

`bundle-breaker` also emits a **module dependency graph** — excellent for finding the entry point, the
router, and the network layer fast
[1](https://gist.github.com/0xdevalias/d8b743efb82c0e9406fc69da0d6c6581),
[2](https://github.com/j4k0xb/webcrack), [3](https://github.com/awphi/bundle-breaker).

Plain minified (no obfuscation): `npx prettier --write bundle.js` may be enough.

## 4. Find the interesting parts

Global search (DevTools `Ctrl+Shift+F`, or `grep -r` on the debundled tree):

```
https?://[a-z0-9.\-]+/api      # endpoints
api[_-]?key|secret|token|Authorization
fetch\(|axios|XMLHttpRequest|new Request\(
localStorage|indexedDB|sessionStorage
router|routes?\s*=|path:\s*['"]      # route table
reducers?|createStore|pinia|provide\(
```

Useful devtools moves [4](https://www.quora.com/How-can-I-reverse-engineer-a-website-built-on-HTML-CSS-JS):

- **Pretty print** in Sources for minified files
- **Event Listener Breakpoints** to find handlers without reading the bundle
- **XHR/fetch breakpoint** on a URL substring — stops at the exact call site
- **Local overrides** to patch a file in place and reload

## 5. Network layer is the prize

Rather than reading UI code, hook the network:

```js
// paste in console before the app loads
const _fetch = window.fetch;
window.fetch = (...a) => { console.log('FETCH', a); return _fetch(...a); };
```

Or intercept at the proxy level (mitmproxy script) to log/rewrite requests. This gives you the real API
surface regardless of bundling or obfuscation.

## 6. Verify by replay

```bash
curl -i -H 'Authorization: Bearer <token>' 'https://api.example.com/v2/feed?limit=20'
```

Remove headers one at a time to learn which are actually required versus merely sent. Watch for CSRF
tokens, signed requests (HMAC/timestamp), request IDs, and rate limits.

**Use a throwaway test account and self-impose rate limits.** Don't hammer a service you don't own.

## 7. Edge cases specific to web

- Deep-link / refresh behaviour (does the server render the route?)
- Auth persistence across reload and across tabs
- Multi-tab state conflicts over the same store
- Offline / service-worker cache behaviour
- Back/forward and history manipulation
- Different viewports and the responsive breakpoints

## 8. WebAssembly

If core logic is in `.wasm`: `wasm2wat` / `wasm-decompile` (wabt) for a readable form, or Ghidra with the
WASM plugin. Usually it's cheaper to treat the wasm as a black box and characterise it by input/output at
the JS boundary — hook the wrapper functions.
