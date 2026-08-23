# Web AI Demo

A tour of the different ways to run AI models directly in the browser.

The five stops on the tour:

- [Chrome Prompt API](https://developer.chrome.com/docs/ai/prompt-api)
- [web-llm](https://github.com/mlc-ai/web-llm)
- [Hugging Face Transformers.js](https://huggingface.co/docs/transformers.js)
- [LiteRT-LM](https://developers.google.com/edge/litert-lm/js)
- [wllama](https://github.com/ngxson/wllama)

Note the fourth one: **LiteRT-LM** (`@litert-lm/core`), not LiteRT.js
(`@litertjs/core`). The latter runs general `.tflite` models and its own docs send
LLM users elsewhere; MediaPipe's LLM Inference API is the older third name for the
same path and is now maintenance-only. Three names, one of them ours to get right.

Everything runs locally in the browser. No backend, no build step, and no data
of any kind is collected or transmitted — the diagnostics these pages produce
stay on your device.

## The demo

One page, five runtimes, a chooser between them. It is a single static page with
no build step: React and all five libraries come from a CDN via one import map.

```sh
npm run dev     # http://localhost:4710/public/
```

What it does beyond "type a prompt, get an answer":

- **Not loaded / loading / loaded**, with a progress bar, an Unload that says what
  it actually frees, and a Stop that uses whichever of five different cancellation
  mechanisms the runtime provides.
- **A context control per runtime, and honest labels on the ones that have none.**
  These five disagree completely here: wllama and LiteRT-LM take a number at load,
  web-llm can override what the model was compiled with, Chrome tells you its
  window only after a session exists and never lets you set it, and Transformers.js
  neither takes nor reports one. Same for the reply cap, which is per-turn on
  three, load-time on LiteRT-LM, and simply absent on Chrome.
- **JSON output, and whether anything is enforcing it.** Three of the five can
  constrain the grammar; two can only be asked politely. The page says which, and
  then shows whether the reply actually parsed — so the difference is visible
  rather than theoretical.
- **Diagnostics**: a device probe, a timestamped log, per-turn timings, and one
  Copy button. Everything stays local; the clipboard is the whole delivery
  mechanism.
- **A crash black box.** The failure worth studying here kills the tab outright,
  taking its own evidence with it, so breadcrumbs and a state snapshot go to
  `localStorage` as you go and a died-last-time banner appears on reopening.

### How it is put together

The load-bearing decision is that **choosing a runtime must not download it.**

- [`public/app/providers/descriptors.js`](public/app/providers/descriptors.js)
  imports nothing. It holds everything the UI needs to render and compare all
  five — capabilities, constraints, model lists, the per-runtime caveats. It is
  the comparison table as data, and every field is either measured by a spike or
  read off the library's published type definitions.
- Each `providers/<id>.js` is the adapter that actually imports its library, behind
  a dynamic import that fires only when you press Load. So five CDN bundles are
  never fetched to draw five cards.
- [`public/app/hooks/useRuntime.js`](public/app/hooks/useRuntime.js) is the session
  controller — the spike harness's logic, minus the DOM.
- [`public/lib/`](public/lib/) is the shared apparatus both surfaces use: the
  device probe, the crashbox wiring, and the degeneracy metric. It lives in one
  place so a number means the same thing in the demo and in a spike. No provider
  code goes here.

Switching runtimes tears the outgoing one down rather than abandoning it, which is
not politeness: an abandoned wllama instance keeps its wasm heap and its GPU
buffers, and that is what hard-killed an iPhone tab on 2026-08-23.

### Verified on desktop Chrome

All five drive end to end on Chrome 151 / Apple silicon — load, generate, JSON
mode, unload, and a switch while loaded. Measured 2026-08-23:

| Runtime           | Model                     | Result                                                                                |
| ----------------- | ------------------------- | ------------------------------------------------------------------------------------- |
| Chrome Prompt API | Gemini Nano (built in)    | `session.contextWindow` = **9216** on this machine. `responseConstraint` → valid JSON |
| web-llm           | SmolLM2-135M `q0f16`      | prefill 838 tok/s, decode 290 tok/s. `json_object` + schema → valid JSON              |
| wllama            | LFM2.5-350M `Q4_K_M`      | prefill 428 tok/s, decode 143 tok/s. **`response_format` works** — see below          |
| Transformers.js   | SmolLM2-135M `q4`         | 43.5 tok/s as counted by us. Asked for JSON, replied prose — as predicted             |
| LiteRT-LM         | `gemma-4-tiny-random` CPU | Loads. Degeneracy metric caught the random weights at distinct-3 **0.23**             |

Two of those are new findings rather than confirmations:

- **wllama's `response_format` actually works.** The spike flagged it as a
  pass-through to llama-server with zero upstream test coverage, so it was carried
  as "under test". Asked for a two-field object, it returned exactly that. It is
  still untested upstream; it is no longer untested here.
- **Chrome's context window is 9216 tokens on this device.** There is no
  documented number to cite, because Chrome benchmarks the GPU at first create()
  and hands out a ~2B or ~4B Nano variant accordingly. So this figure is a
  per-device measurement and the demo reads it at runtime.

The failures that matter are still on Safari and on a phone, and those are not
covered yet.

## Spikes

Each runtime also has a bare page of its own under
[`public/spikes/`](public/spikes/): latest version of the library, models chosen by
the repo-wide policy in [MODELS.md](MODELS.md), no shared abstraction. Each answers
one question — does this load and generate on this device, today — and captures the
verbatim error when it doesn't. They came first and the demo was built from what
they found out.

**All five are wired up** and verified on desktop Chrome. They are kept now that
the demo exists, because they answer a question the demo cannot: a spike shares no
provider code with anything, so when one fails the failure is unambiguously the
runtime's rather than an abstraction's. That makes them the control against which
a demo bug is diagnosable.

They are **deliberately not linked from the demo** — they are a workbench, not a
destination — but they stay live at their own URLs:

```sh
npm run dev     # then open http://localhost:4710/public/spikes/
```

The spikes share no provider code with each other or with the demo. What they do
share, via [`public/lib/`](public/lib/), is the apparatus that has to be identical
for the numbers to be comparable: the device probe, the crash black box, and the
degeneracy metric.

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
