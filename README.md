# Web AI Demo

A tour of the different ways to run AI models directly in the browser.

Planned stops on the tour:

- [Chrome Prompt API](https://developer.chrome.com/docs/ai/prompt-api)
- [web-llm](https://github.com/mlc-ai/web-llm)
- [Hugging Face Transformers.js](https://huggingface.co/docs/transformers.js)
- [LiteRT.js](https://ai.google.dev/edge/litert/web)
- [wllama](https://github.com/ngxson/wllama)

Everything runs locally in the browser. No backend, no build step, and no data
of any kind is collected or transmitted — the diagnostics these pages produce
stay on your device.

## Spikes

Before the unified demo, each runtime gets a throwaway page under
[`public/spikes/`](public/spikes/): latest version of the library, the smallest
model it offers, no shared abstraction. Each answers one question — does this
load and generate on this device, today — and captures the verbatim error when it
doesn't.

```sh
npm run dev     # then open http://localhost:4710/public/spikes/
```

The spikes deliberately share no provider code with each other. When one fails,
the failure is the runtime's and not an abstraction's.

## Models

Every picker in this repo — the spikes and the unified demo — follows one policy:
Gemma 4 where the runtime can run it, never Gemma 3 or earlier (licence), the
latest Qwen that has a browser-sized variant, at least one model that fits an
iPhone, and language models only. [MODELS.md](MODELS.md) has the rules, the
per-runtime selections with byte-exact sizes, and the two GGUF naming traps that
make a broken list look like a small one.

## Development

```sh
nvm use
npm ci
npm run dev     # http://localhost:4710/public/
```

`npm run dev` sends no COOP/COEP headers, which matches the GitHub Pages target:
`crossOriginIsolated` is false, `SharedArrayBuffer` is unavailable, and any runtime
that wants CPU threads falls back to single-threaded. That fallback is the honest
default, so it is the one the plain dev server reproduces.

```sh
npm run dev:isolated   # http://localhost:4711/public/ — with COOP/COEP
```

The isolated server sets `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`, which turns `SharedArrayBuffer` on and
lets the threaded WASM builds actually use threads. Running a spike under both is
how you get the single-thread-versus-multi-thread comparison from one sitting. It is
on a separate port deliberately — same-origin caches and service workers otherwise
carry state between the two modes and muddy the measurement.

### One URL trap, and why it is fixed in the page rather than the server

Every page here uses plain relative links, and `public/spikes/index.html` is a
directory index — so its links depend on the browser thinking it is _in_
`spikes/`. GitHub Pages redirects `/spikes` to `/spikes/` and that holds. `serve`
answers `/spikes` with a 200 and no redirect, so the base becomes `public/` and
all five links plus both stylesheets resolve one directory up.

Fixing that in `serve.json` does not work, and it is worth recording why so nobody
tries again:

- `cleanUrls: false` stops serve rewriting the directory to `index.html` at all,
  so `/spikes/` renders a **file listing** instead of the page.
- `trailingSlash: true` fixes the index but rewrites spike pages to
  `/spikes/wllama/`, which moves _their_ base — so `./spike.css` and `./wllama.js`
  both 404 and the page loads unstyled and dead.

So `index.html` normalises its own URL in a small inline script in `<head>`, and
links point at directories (`./`, `../`) rather than `index.html`, which lands in
one hop in both environments. If you touch either, check both the index **and** a
spike page, on `/public/spikes` _and_ `/public/spikes/`.

`require-corp` works here because the CDN assets we load send
`cross-origin-resource-policy: cross-origin` (verified on jsDelivr for both the
wllama and web-llm bundles). If a subresource ever fails to load under it, the
fallback is `credentialless` rather than dropping the headers.

Checks and formatting:

```sh
npm run check   # lint + prettier, no writes
npm run format  # lint --fix + prettier --write
```

## Deployment

Pushes to `main` publish `public/` to GitHub Pages via
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).

## License

[MIT](LICENSE.txt)
