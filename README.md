Web AI Demo 🕸️
==============

Five ways to run a language model in the browser, in one page. No backend, no
build step, and nothing leaves the device.

Each runtime has its own constraints and advantages. Load one, ask it something,
and compare.

| Runtime                                                              | What it is                          | Runs where           |
| -------------------------------------------------------------------- | ----------------------------------- | -------------------- |
| [Chrome Prompt API](https://developer.chrome.com/docs/ai/prompt-api) | Gemini Nano, built into the browser | Chrome desktop only  |
| [web-llm](https://github.com/mlc-ai/web-llm)                         | MLC-compiled weights over WebGPU    | Needs WebGPU         |
| [wllama](https://github.com/ngxson/wllama)                           | llama.cpp in WASM, loads GGUFs      | Any, WebGPU optional |
| [Transformers.js](https://huggingface.co/docs/transformers.js)       | ONNX Runtime Web                    | Any, WebGPU optional |
| [LiteRT-LM](https://developers.google.com/edge/litert-lm/js)         | Google's on-device LLM runtime      | Needs WebGPU         |

_Note_: `@litert-lm/core` (LiteRT-LM) is not `@litertjs/core` (LiteRT.js), which
runs general `.tflite` models rather than LLMs.

## Usage

```sh
nvm use
npm ci
npm run dev     # http://localhost:4710/public/
```

`Ask` downloads and loads the model on first use, so a first answer takes one
click. The page reports what each runtime supports as you go, along with a device
probe, per-turn timings, and a log you can copy.

### Linking to a runtime

The chooser is in the URL, so a selection can be sent to someone:

```
?runtime=wllama
?runtime=wllama&model=unsloth%2FQwen3.5-0.8B-GGUF%7CQwen3.5-0.8B-Q4_K_M.gguf
```

`runtime` is one of `chrome-prompt-api`, `web-llm`, `wllama`, `transformers-js`,
`litert`; `model` is a model id from that runtime's picker, URL-encoded. Both
update as you click, so the address bar is always a link to what is on screen.

For wllama, `model` need not be one of the listed ids — it takes any Hugging Face
GGUF specifier, which is also what the field under its picker accepts:
`owner/repo:Q4_K_M` in llama.cpp's `-hf` form, `owner/repo|file.gguf`, a Hub URL,
or a bare `owner/repo` to let wllama choose the quant. What you apply joins the
picker and the link, so it can be sent on like any other selection.

A link **selects** a runtime and downloads nothing — the model still loads on
`Ask`, as it does for a click. Anything unrecognised is ignored and reported in
the log rather than failing. `?model=` for web-llm is held until its catalog is
read, because that list ships inside the library bundle.

## Notes

- **Desktop Chrome so far.** The layout is built and checked for a phone — down
  to 320px wide, portrait and landscape, on every runtime and every spike page —
  but that check ran in Chrome's device emulation. Real iOS Safari and a real
  phone are still untested, which is where the runtimes themselves are expected
  to fail anyway.
- **Models**: one policy for every picker here, in [MODELS.md](MODELS.md). It
  governs the curated lists; wllama will also load a repo you name yourself.
- **Spikes**: a bare page per runtime under [`public/spikes/`](public/spikes/),
  no shared abstraction, for when one of them breaks. Not linked from the demo.
- **Threads**: `npm run dev` sends no COOP/COEP headers, matching the GitHub Pages
  target, so `SharedArrayBuffer` is off and the WASM runtimes fall back to
  single-threaded. `npm run dev:isolated` (port 4711) sends them for comparison.

## Development

```sh
npm run check   # lint + prettier, no writes
npm run format  # lint --fix + prettier --write
```

## License

[MIT](LICENSE.txt)
