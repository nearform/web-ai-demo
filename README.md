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

The page compares them on eleven axes — history ownership, system prompt, context
control, enforced JSON, **tool calling**, cancellation and the rest — in a table
under _Capabilities_.

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

### Tool calling

The **Tool** toggle beside Ask declares one function to the model and runs it when
the model asks for it. The function is yours, editable, and defaults to a lookup:

```js
// Look up the current weather in a city.
const weather = (city: string) => `${city}: 21C, raining`;
```

A lookup rather than something like `add(a, b)` on purpose. A small model reaches
for a tool when it knows it cannot answer without one — not when the tool would
merely be more accurate. Measured on Qwen3.5-0.8B: this one is called in roughly
two runs of three, and the run that does not call it says it has no access to live
weather, which makes the same point from the other side. A letter-counting tool
was never called at all, because the model believes it can count letters (it
cannot). There is a button beside the field that puts a matching question in the
prompt box, since a tool and a question that disagree produce no call and look
like a broken feature.

A JSON Schema is derived from the signature and shown beside it, since the model
is given the schema and not the source. Parameter types come from the two rules
the panel states: a TypeScript-style annotation wins (`(name: string)`), and
anything unannotated is a `number`. A leading `//` comment becomes the tool's
description. The page evaluates what you type, in your own tab; nothing is sent
anywhere.

The five do not agree, and that is the point:

| Runtime           | What happens                                                                                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chrome Prompt API | Nothing. `tools` is in the explainer, not in Chrome — and an unknown option is dropped silently, so the adapter probes for it and reports.                                   |
| web-llm           | Works, on **five model ids only** — the Hermes builds, 7B and 8B. Any other id throws, and the page says so instead.                                                         |
| wllama            | Works. `tools` passes through to llama-server, which parses the call out of the GGUF's own template.                                                                         |
| Transformers.js   | The declarations reach `apply_chat_template` and stop there. Nothing parses a call back out, so nothing runs — you get the model's tool-call syntax as text.                 |
| LiteRT-LM         | Works, and it is the only one that closes the loop itself: `AutoToolChat` calls your function between decode rounds. Declarations are fixed at load, like the system prompt. |

Calls that happen appear above the reply with their arguments, result and timing,
and every round trip shows in the **verbatim** panel — one request per round, so
you can read the `tool` message going back.

### Linking to a runtime

The chooser is in the URL, so a selection can be sent to someone:

```
?runtime=wllama
?runtime=wllama&model=unsloth%2FQwen3.5-0.8B-GGUF%7CQwen3.5-0.8B-Q4_K_M.gguf
```

`runtime` is one of `chrome-prompt-api`, `web-llm`, `wllama`, `transformers-js`,
`litert`; `model` is a model id from that runtime's picker, URL-encoded. Both
update as you click, so the address bar is always a link to what is on screen.

For **wllama**, **Transformers.js** and **LiteRT-LM**, `model` need not be one of
the listed ids: each takes a model you name, in the field under its picker, under
the grammar its own API takes. What you apply joins the picker and the link, so it
can be sent on like any other selection.

- **wllama** — any Hugging Face GGUF specifier: `owner/repo:Q4_K_M` in
  llama.cpp's `-hf` form, `owner/repo|file.gguf`, a Hub URL, or a bare
  `owner/repo` to let wllama choose the quant.
- **Transformers.js** — any repository of ONNX weights: `owner/repo`,
  `owner/repo:q4f16` to choose the quantization, `owner/repo|onnx/model_q4.onnx`
  to choose the file, or a Hub URL. Weights are read from the repo's `onnx/`
  subfolder, which is what `pipeline()` defaults to.
- **LiteRT-LM** — any `.litertlm` file: `owner/repo/model-web.litertlm`, a Hub
  URL, or any `http(s)` URL, optionally prefixed `GPU_ARTISAN|` or `CPU|` to pick
  the backend. Google documents the JS API as supporting a limited set of
  web-compatible models — currently two `-web.litertlm` files — so another file
  may download in full and then fail to load.

Nothing is checked against the Hub before you press Load, so an id that parses is
not an id that exists. What the field _does_ catch is the shape, and the files
that download and then cannot answer — a draft head, a vision projector, an
embedding model, a non-`-web` LiteRT packaging — which are called out in the log
before the bytes move. See [MODELS.md](MODELS.md) for the full grammars.

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
