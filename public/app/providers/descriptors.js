// The five runtimes, described as data.
//
// This file imports no runtime library. That is deliberate: the chooser renders all
// five and the guidance panel compares them, and neither should require downloading
// five library bundles first. Everything knowable without running a runtime lives
// here; each `providers/<id>.js` imports its library and is fetched only on use.
// The one import below is a leaf module of strings, shared with the spikes.
//
// RULES FOR THE STRINGS IN THIS FILE. Every `note`, `summary` and `tagline` below
// is rendered in the page, so:
//
//   - State what the API does. Name the option or method. No adjectives about how
//     promising, finished or pleasant a runtime is.
//   - Only claims a reader can check against the vendor's own documentation or the
//     library's published types. Do not cite this project's own test runs; a
//     number we measured on one machine is not a property of the runtime, and the
//     page has a diagnostics panel for what happened on the reader's device.
//   - No superlatives and no cross-runtime comparisons unless a receipt backs
//     the count. Transformers.js carried "the widest model selection of the
//     five" here for months; the Hub's own catalog says GGUF has 17x the ONNX
//     text-generation models (37,644 to 2,159, measured 2026-09-15), so the card
//     was wrong about the runtime it was flattering.
//   - Short. The guidance panel is a reference, not prose.
//
// Engineering provenance — which type definition a signature came from, which
// upstream issue covers a defect — belongs in comments like this one, not in the
// rendered strings.

// ---------------------------------------------------------------------------
// Generation defaults. See ../../../MODELS.md for the model policy.
// ---------------------------------------------------------------------------

/** One reply, capped. Applied wherever the runtime exposes a limit. */
export const MAX_REPLY_TOKENS = 512;

/** Default context budget for the runtimes that accept one. */
export const DEFAULT_CONTEXT = 4096;

// Shared with the spike harness so both tiers ask the same question.
export { DEFAULT_SYSTEM, DEFAULT_PROMPT } from "../../lib/defaults.js";

// Two fields, one of them an enum. Small models fail nested schemas, so keeping
// this flat keeps the comparison about the runtime rather than the model.
export const JSON_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
  },
  required: ["answer", "confidence"],
};

// Sent with the prompt on every runtime, including those that also constrain the
// grammar. web-llm's documentation is explicit that JSON mode needs the request in
// the prompt as well: constrained without it, a model can emit whitespace until it
// reaches the token limit.
export const JSON_INSTRUCTION = `Reply with a single JSON object matching this schema, and nothing else: ${JSON.stringify(
  JSON_SCHEMA,
)}`;

// ---------------------------------------------------------------------------
// Tool calling.
// ---------------------------------------------------------------------------

/**
 * The tool a reader starts with.
 *
 * Choosing it took three tries and the two rejects are the reason this comment
 * is worth the space, because both failed for reasons that are properties of
 * small models rather than of this page.
 *
 *   `add(a, b)` — called reliably, but both arguments are already digits in the
 *   question, so nothing is extracted, and the model can do the sum itself:
 *   asked for 81724 + 59318, wllama/Qwen3.5-0.8B and Gemini Nano both answered
 *   141042 unaided.
 *
 *   `countLetter(word, letter)` — never called. 0 of 3 runs, even with a
 *   description saying to prefer it over counting by hand. A model that
 *   believes it can do the job does not delegate, and this one believes it:
 *   it answered 2, 2 and 1 for the r's in "strawberry".
 *
 *   A lookup — called in 2 of 3 runs, and the run that did not call it replied
 *   "I don't have access to the current real-time weather data", which is the
 *   same finding from the other side. THAT is the trigger: a model reaches for
 *   a tool when it knows it cannot answer without one, not when the tool would
 *   merely be more accurate.
 *
 * So: a lookup, with a string argument the model has to lift out of the
 * question and a string result it could not have guessed. The body is a
 * constant and visibly so — the point on screen is whether the runtime routed
 * the call, never what the weather in Tokyo is.
 */
export const DEFAULT_TOOL_SOURCE = `// Look up the current weather in a city.
const weather = (city: string) => \`\${city}: 21C, raining\`;`;

/**
 * A question the default tool answers and the model cannot.
 *
 * Offered as a button rather than written into the prompt box, because a tool
 * and a question have to match before a model will reach for anything: leave
 * the page's default question about bikeshedding in place and a
 * correctly-behaving model declines to call a weather tool, which reads as a
 * broken feature. One click rather than a silent rewrite of what was typed.
 */
export const DEFAULT_TOOL_PROMPT = "What is the weather in Tokyo right now?";

/**
 * How many times a turn may go model → tool → model before the adapter gives
 * up. Every runtime that closes the loop needs a ceiling, because a model that
 * calls the same tool forever is a real failure mode and not a rare one; the
 * wllama example upstream uses 5 and LiteRT-LM defaults to 25.
 */
export const MAX_TOOL_ROUNDS = 4;

// ---------------------------------------------------------------------------

export const DESCRIPTORS = [
  // -------------------------------------------------------------------------
  {
    id: "chrome-prompt-api",
    name: "Chrome Prompt API",
    docs: "https://developer.chrome.com/docs/ai/prompt-api",
    tagline:
      "Gemini Nano. Chrome downloads it, picks the variant, and updates it.",
    summary:
      "Chrome supplies the model, so this page ships no weights and chooses nothing — but the weights are still downloaded, on the first `create()` by any built-in AI API, with Chrome picking the variant from a GPU benchmark. Availability depends on the browser, the OS and the device; `LanguageModel.availability()` reports it.",

    history: {
      owner: "runtime",
      note: "The session stores the conversation. Only the new turn is sent.",
      // Not a detail: on the two runtime-owned ones, clearing the transcript
      // here would leave the model remembering a conversation the page no
      // longer shows.
      reset:
        "New chat destroys the session and creates a replacement with the same `initialPrompts` — there is no other way to clear it, since `clone()` copies the context.",
    },
    systemPrompt: {
      appliedAt: "load",
      // There is no `systemPrompt` option. The debug-gemini-nano page that shows
      // one predates the current API.
      note: "A `system` entry in `initialPrompts`, fixed when the session is created. Changing it requires a new session.",
    },
    modelChoice: {
      kind: "builtin",
      note: "No selection. Chrome picks a Gemini Nano variant for the device and does not report which.",
    },
    context: {
      control: "readonly",
      field: "session.contextWindow",
      note: "Not settable. The window depends on the variant Chrome selected, so it is only readable from a live session.",
    },
    replyCap: {
      control: "none",
      note: "The API has no max-output option.",
    },
    json: {
      supported: true,
      field: "responseConstraint",
      note: "`responseConstraint` takes a JSON Schema object per call.",
    },
    // The one runtime of the five where the tool option is specified and not
    // implemented — and where passing it produces no error, because an unknown
    // member of a WebIDL dictionary is dropped rather than refused. Hence the
    // probe in the adapter: `expectedOutputs: [{ type: "tool-call" }]` is the
    // one form Chrome does reject, so it answers the question a silently
    // ignored option cannot.
    tools: {
      kind: "none",
      appliedAt: "load",
      field: "tools",
      note: "The explainer specifies a `tools` option whose entries carry an `execute()` the browser calls. Chrome does not ship it — chromestatus lists Function Calling in the Prompt API as Proposed with no milestone and no origin trial — and `create()` drops an option it does not know rather than refusing it.",
    },
    progress: {
      kind: "native",
      note: "`monitor` reports a `downloadprogress` event when Chrome has to fetch the model. Nothing to report once the weights are resident — but Chrome redownloads the model in full on every update, and purges it when free disk runs low.",
    },
    // The only one where "is it cached" is not a question the page can ask.
    cache: {
      kind: "browser",
      label: "the browser's",
      tone: "good",
      note: 'Chrome holds the weights and shares them across origins. No page-facing API stores, measures or frees them — `availability()` reporting "downloadable", "downloading" or "available" is the whole of what a page can see.',
    },
    rates: {
      selfReported: false,
      note: "No token-rate API. `contextUsage` reports budget consumption instead, which the other four do not.",
    },
    cancel: {
      kind: "abortsignal",
      api: "promptStreaming(input, { signal })",
      note: "Takes an AbortSignal.",
    },
    unload: {
      frees: ["the session and its history"],
      keeps: ["the model, which belongs to Chrome"],
      caveat:
        "`destroy()` ends the session and makes later prompts reject. The model is shared across origins and the page cannot free or measure it.",
    },
    device: {
      // NOT "any device". There are no weights to fit, which makes the device
      // capacity question trivial — but availability is the binding constraint
      // instead, and it is narrower than any of the other four.
      fits: "chrome-desktop",
      // The badge uses `fits` and shows the binding constraint, which here is the
      // browser. The Device row answers the capacity question instead, so it gets
      // its own label rather than repeating the badge.
      label: "no weights to fit",
      tone: "good",
      note: "No weights to fit, so device memory is not the limit here. Availability is: Chrome documents Windows 10/11, macOS 13+, Linux, and ChromeOS on Chromebook Plus devices only. It also documents minimum hardware — 22 GB free disk, and either more than 4 GB of VRAM or 16 GB of RAM with 4 cores.",
    },
    browsers: {
      label: "Chrome desktop",
      tone: "bad",
      note: "Chrome 148+ on the web. Chrome's documentation states that Chrome for Android, iOS and ChromeOS on non-Chromebook Plus devices are not supported by the APIs that use foundation models. Every iOS browser, including Chrome for iOS, runs on WebKit and so does not have it. There is no Firefox or Safari implementation.",
    },
    models: null,
  },

  // -------------------------------------------------------------------------
  {
    id: "web-llm",
    name: "web-llm",
    docs: "https://github.com/mlc-ai/web-llm",
    tagline:
      "OpenAI-shaped API over WebGPU. Models come from its prebuilt catalog, not the Hub.",
    summary:
      "Runs MLC-compiled models on WebGPU and reports its own prefill and decode rates. Models have to be compiled for MLC, and the available list comes from the library at runtime.",

    history: {
      owner: "caller",
      note: "Every request carries the whole conversation. The KV cache is reused when the new history extends the previous one.",
      reset:
        "New chat drops the transcript and calls `resetChat()`, so the next turn is prefilled against an empty cache.",
    },
    systemPrompt: {
      appliedAt: "turn",
      note: "A `system` message, sent with each request. Changing it means the history no longer extends the last one, so the cache is discarded.",
    },
    modelChoice: {
      kind: "discovered",
      note: "Read from the library's `prebuiltAppConfig`, then filtered to one encoding per model and size. The log lists what was excluded.",
    },
    context: {
      control: "load",
      field: "context_window_size",
      // TYPES 0.2.84: ChatOptions extends Partial<ChatConfig>, which carries
      // context_window_size — a real load-time override, passed as the third
      // argument to CreateMLCEngine.
      default: null,
      min: 512,
      max: 8192,
      step: 512,
      note: "A ChatOptions override. Unset, the value the model was compiled with applies.",
    },
    replyCap: {
      control: "turn",
      field: "max_tokens",
      note: "Per request.",
    },
    json: {
      supported: true,
      field: 'response_format: { type: "json_object", schema }',
      // TYPES 0.2.84 chat_completion.d.ts: ResponseFormat.schema is `string`,
      // not an object — an unstringified schema is silently wrong.
      note: "The schema is a JSON string here, not an object. `grammar` (EBNF) and `structural_tag` modes also exist.",
    },
    // TYPES 0.2.84 chat_completion.d.ts documents `tools` and `tool_choice` in
    // full OpenAI shape, but the library's own request validation is where the
    // real contract is: `tools` is checked against a five-entry allowlist of
    // model ids, and for those it rewrites `response_format` and prepends a
    // system message of its own — throwing if the caller supplied either. The
    // adapter drops both rather than letting the throw happen.
    tools: {
      kind: "parsed",
      appliedAt: "turn",
      field: "tools, tool_choice",
      note: "OpenAI-shaped, and restricted to five model ids: the Hermes-2-Pro and Hermes-3 builds, all 7B or 8B. Any other id throws `UnsupportedModelIdError`. On those five, supplying a system prompt or a `response_format` of your own also throws, because the library writes both itself.",
      // Straight out of the 0.2.84 bundle's own request validation — `if
      // (request.tools) { if (!FUNCTION_CALLING_MODELS.includes(modelId)) throw
      // UnsupportedModelIdError }` — and not from the docs, which mention no
      // restriction at all. It lives here rather than in the adapter because the
      // UI has to mark which models can do this before any bundle is fetched.
      modelAllowlist: [
        "Hermes-2-Pro-Llama-3-8B-q4f16_1-MLC",
        "Hermes-2-Pro-Llama-3-8B-q4f32_1-MLC",
        "Hermes-2-Pro-Mistral-7B-q4f16_1-MLC",
        "Hermes-3-Llama-3.1-8B-q4f32_1-MLC",
        "Hermes-3-Llama-3.1-8B-q4f16_1-MLC",
      ],
    },
    progress: {
      kind: "native",
      note: "`initProgressCallback` reports a fraction and a status line, covering compilation as well as download.",
    },
    // The richest of the five, and the only one that caches a compile artifact
    // separately from the weights — hence the three buckets.
    cache: {
      kind: "native",
      label: "Cache Storage",
      tone: "good",
      store: "Cache Storage",
      note: 'Three buckets: `webllm/model` for weights and tokenizer, `webllm/config` for mlc-chat-config.json, and `webllm/wasm` for the compiled shader library. `AppConfig.cacheBackend` also documents "indexeddb", "opfs" and "cross-origin". `hasModelInCache()` and the `deleteModel*InCache()` helpers manage it.',
      completeness:
        "A model here is over a hundred files, and this asks whether any of them are present — so a download that stopped partway still reads as cached.",
    },
    rates: {
      selfReported: true,
      note: "Reports prefill and decode tokens/second and time-to-first-token on the final chunk, when `stream_options.include_usage` is set.",
    },
    cancel: {
      kind: "library",
      api: "engine.interruptGenerate()",
      // Undocumented in api_reference.html and exercised by no upstream example.
      note: "No AbortSignal. Sets a flag the decode loop checks, so the stream ends rather than throwing.",
    },
    unload: {
      frees: ["the pipelines", "the WebGPU device"],
      keeps: ["the downloaded weights"],
      caveat:
        "`unload()` leaves the instance reusable, which is not true of wllama or Transformers.js.",
    },
    device: {
      fits: "phone-possible",
      note: "Desktop for most of the catalog. Only the smallest entries are plausible on a phone.",
    },
    browsers: {
      label: "needs WebGPU",
      tone: "warn",
      note: "Any browser with WebGPU; there is no CPU fallback, so this page's check refuses to load without an adapter. Most `q4f16_1` models also declare the `shader-f16` feature.",
    },
    models: null, // read from the library at pick time
  },

  // -------------------------------------------------------------------------
  {
    id: "wllama",
    name: "wllama",
    docs: "https://github.com/ngxson/wllama",
    tagline: "llama.cpp in WASM. Loads any Hugging Face GGUF by repo and file.",
    summary:
      "Takes a GGUF file from Hugging Face, so the model list is not limited to a vendor's compiled catalog. WebGPU has been enabled by default since 3.1.",

    history: {
      owner: "caller",
      note: "Every request carries the whole conversation. `cache_prompt` asks the runtime to reuse the prefix.",
      reset:
        "New chat drops the transcript. The runtime keeps no conversation to clear, and the stale cached prefix simply stops matching.",
    },
    systemPrompt: {
      appliedAt: "turn",
      note: "A `system` message, sent with each request. Changing it invalidates the cached prefix.",
    },
    modelChoice: {
      kind: "static",
      // Both of these sort above the model itself when ordering by size.
      note: "A fixed list of GGUF files, plus any repo you name yourself. When adding to the list, note that `mtp-*` files are draft heads and `mmproj-*` are vision projectors rather than models.",
    },
    // Three of the five take a model nobody vetted, each under the grammar its
    // own API uses; see util/custom-model.js. web-llm is the one that cannot:
    // its weights have to be compiled to MLC's format ahead of time, so there is
    // no arbitrary repo to name. Chrome supplies its own model and has nothing
    // to select.
    customModel: {
      kind: "hf-gguf",
      label: "Or a Hugging Face repo",
      placeholder: "unsloth/Qwen3.5-4B-GGUF:Q4_K_M",
      note: "`owner/repo:QUANT` as llama.cpp's `-hf` takes it, `owner/repo|file.gguf`, a Hub URL, or a bare `owner/repo` to let wllama choose the quant. Nothing checks whether it fits this device first.",
    },
    context: {
      control: "load",
      field: "n_ctx",
      default: DEFAULT_CONTEXT,
      min: 512,
      max: 32768,
      step: 512,
      // Defaults to 1024, and n_ctx_auto was removed in v3.0.
      note: "Set explicitly, because it defaults to 1024 rather than the model's trained context. The KV cache is allocated from this, so it is a memory cost as well as a limit.",
    },
    replyCap: {
      control: "turn",
      field: "max_tokens",
      note: "Per request.",
    },
    json: {
      supported: true,
      field:
        'response_format: { type: "json_schema", json_schema: { name, schema } }',
      // TYPES 3.6.0 esm/types/oai-compat.d.ts. `schema` is `unknown` here — an
      // object, where web-llm's same-named field wants a string.
      note: "The schema is an object here, unlike web-llm. This is a pass-through to llama-server.",
    },
    // TYPES 3.6.0 esm/types/oai-compat.d.ts, and the shape is llama-server's
    // verbatim — `tools` and `tool_choice` on the request, `delta.tool_calls`
    // in fragments keyed by `index`, `finish_reason: 'tool_calls'`. The whole
    // options object is JSON.stringify'd into the WASM, so the parsing happens
    // in llama.cpp against the GGUF's own template and no flag turns it on:
    // upstream's examples/tools/index.html loads with nothing but a progress
    // callback.
    tools: {
      kind: "parsed",
      appliedAt: "turn",
      field: "tools, tool_choice",
      note: "OpenAI-shaped, passed through to llama-server, which parses the call out of the GGUF's own chat template — so whether it works is the model's property, not the runtime's. `delta.tool_calls` arrives in fragments keyed by `index`, and `finish_reason` becomes `tool_calls`.",
    },
    progress: {
      kind: "native",
      note: "`progressCallback` reports loaded and total bytes, across shards.",
    },
    // OPFS rather than Cache Storage, which is the practical difference: a
    // caches.keys() audit of a page using wllama finds nothing and reads as
    // "this one re-downloads every time".
    cache: {
      kind: "native",
      label: "OPFS",
      tone: "good",
      store: "OPFS",
      note: "The Origin Private File System, via `navigator.storage.getDirectory()` — so it does not appear in Cache Storage at all. `ModelManager` lists, downloads and removes whole models; `CacheManager` exposes `list()`, `getSize()`, `delete()` and `clear()` per file. Shard-aware.",
      completeness:
        "Exact: the metadata record beside a file is written only once that file completes, so an abandoned download is told apart from a finished one.",
    },
    rates: {
      selfReported: true,
      note: "Reports prefill and decode tokens/second and cached prompt tokens, when `timings_per_token` is set.",
    },
    cancel: {
      kind: "abortsignal",
      api: "createChatCompletion({ abortSignal })",
      note: "Takes an AbortSignal on the request.",
    },
    unload: {
      frees: ["the model", "the WASM heap", "GPU buffers"],
      keeps: ["the weights, in OPFS"],
      caveat:
        "`exit()` leaves the instance spent, so each load constructs a new one. Dropping a reference without calling it frees nothing.",
    },
    device: {
      fits: "phone-possible",
      note: "The whole model stays in main memory even with layers on the GPU, against a 4 GiB WASM limit. The smallest GGUFs are the plausible phone candidates.",
    },
    browsers: {
      label: "any, WebGPU optional",
      tone: "good",
      note: "Runs without WebGPU by falling back to single-threaded CPU. It also selects between four WASM builds on JSPI and Memory64 support, so Safari gets an Asyncify build rather than failing.",
    },
    models: [
      {
        id: "LiquidAI/LFM2.5-350M-GGUF|LFM2.5-350M-Q4_K_M.gguf",
        label: "LFM2.5-350M Q4_K_M",
        sizeMb: 218,
        note: "The smallest entry.",
      },
      {
        id: "unsloth/Qwen3.5-0.8B-GGUF|Qwen3.5-0.8B-UD-Q2_K_XL.gguf",
        label: "Qwen3.5-0.8B Q2_K_XL",
        sizeMb: 398,
        note: "Latest Qwen at the smallest quantization offered.",
      },
      {
        id: "unsloth/Qwen3.5-0.8B-GGUF|Qwen3.5-0.8B-Q4_K_M.gguf",
        label: "Qwen3.5-0.8B Q4_K_M",
        sizeMb: 507,
        note: "The same model at a higher quantization.",
      },
      {
        id: "unsloth/Qwen3.5-4B-GGUF|Qwen3.5-4B-Q4_K_M.gguf",
        label: "Qwen3.5-4B Q4_K_M",
        sizeMb: 2613,
        note: "Over 2 GiB in a single file. Desktop.",
      },
      {
        id: "ggml-org/gemma-4-E2B-it-GGUF|gemma-4-E2B-it-Q4_0.gguf",
        label: "Gemma 4 E2B Q4_0",
        sizeMb: 2709,
        note: "Desktop.",
      },
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: "transformers-js",
    name: "Transformers.js",
    docs: "https://huggingface.co/docs/transformers.js",
    tagline: "Hugging Face's Transformers on ONNX Runtime Web.",
    summary:
      "Runs ONNX models on WebGPU, falling back to WASM. It exposes no token rates, no cache counters and no context size, so every figure this page shows for it is one the page counted.",

    history: {
      owner: "caller",
      note: "Every request carries the whole conversation. No cache counters are exposed, so prefix reuse cannot be observed.",
      reset:
        "New chat drops the transcript. The runtime keeps no conversation to clear.",
    },
    systemPrompt: {
      appliedAt: "turn",
      note: "A `system` message, sent with each request.",
    },
    modelChoice: {
      kind: "static",
      note: "A list of ONNX repositories, plus any repository you name yourself. Sizes are the summed q4 weight files.",
    },
    // `pipeline()` takes a Hub id and fetches from it, so the picker does not
    // have to be a catalog. The three options an id can set here — `subfolder`,
    // `model_file_name`, `dtype` — are the ones 4.2.0's `pipeline()` declares.
    customModel: {
      kind: "hf-onnx",
      label: "Or a Hugging Face repo",
      placeholder: "onnx-community/Qwen3.5-0.8B-Text-ONNX:q4f16",
      note: "`owner/repo` for a repository of ONNX weights, `owner/repo:dtype` to pick the quantization, `owner/repo|onnx/model_q4.onnx` to pick the file, or a Hub URL. Weights are read from the `onnx/` subfolder, which is `pipeline()`'s `subfolder` default. Nothing checks that the file exists first.",
    },
    context: {
      control: "none",
      note: "Not exposed. The model's own config decides, and nothing reads it back.",
    },
    replyCap: {
      control: "turn",
      field: "max_new_tokens",
      note: "Per request.",
    },
    json: {
      supported: false,
      // TYPES 4.2.0 generation/configuration_utils.d.ts: the only related field
      // is `constraints: any[]`, the port of transformers' beam-search Constraint
      // objects — token forcing, not grammar-constrained decoding.
      note: "No grammar or JSON-schema decoding. GenerationConfig offers only `constraints`, which forces tokens during beam search and cannot enforce a shape.",
    },
    // The interesting middle case. `tools` is real — TextGenerationPipeline has
    // taken it since 4.2.0 (#1655) — but it is an `apply_chat_template`
    // argument and nothing more. There is no tool-call type, no `finish_reason`
    // and no parser anywhere in the package: the reply comes back as text with
    // whatever the template's tool syntax looks like embedded in it, and
    // turning that back into a call is the caller's job. So this page declares
    // the tool and shows what came back, rather than hand-rolling a parser and
    // implying the runtime did it.
    tools: {
      kind: "template",
      appliedAt: "turn",
      field: "tools",
      note: "`tools` reaches `apply_chat_template` and stops there. The docs say it has no effect unless the model's template supports tool use, and nothing in the package parses a call back out — the reply is text, and reading a call out of it is yours to write.",
    },
    progress: {
      kind: "native",
      note: "`progress_callback` reports several statuses; `progress_total` is the one covering the whole load rather than one file.",
    },
    cache: {
      kind: "native",
      label: "Cache Storage",
      tone: "good",
      store: "Cache Storage",
      note: "One bucket, named by `env.cacheKey` (`transformers-cache`); `env.useBrowserCache` defaults on where the Cache API exists. `env.customCache` takes anything implementing Cache's `match` and `put`, and `env.useWasmCache` covers the ONNX Runtime binary. There is no list-or-delete helper — open the Cache yourself.",
      completeness:
        "A model here is several files, and this asks whether any of them are present — so a download that stopped partway still reads as cached.",
    },
    rates: {
      selfReported: false,
      note: "Reports nothing about itself. Token counts here come from the streamer.",
    },
    cancel: {
      kind: "library",
      api: "new InterruptableStoppingCriteria().interrupt()",
      note: "No AbortSignal. Stops at the next token boundary.",
    },
    unload: {
      frees: ["the ONNX Runtime session", "GPU-buffer tensors"],
      keeps: ["the weights, in Cache Storage", "the WASM binary"],
      caveat:
        "`dispose()` releases the session. A disposed pipeline must not be called again — doing so affects later loads in the same page.",
    },
    device: {
      fits: "desktop",
      // Upstream: dtype q4 rather than q4f16 (issues #1599, #1416).
      note: "Desktop. dtype is q4 rather than q4f16; upstream issues #1599 and #1416 cover q4f16 problems on WebGPU.",
    },
    browsers: {
      label: "any, WebGPU optional",
      tone: "warn",
      note: "Falls back to WASM without WebGPU. On Safari, 4.2.0 selects an ORT build without WebGPU support; upstream PR #1700 addresses that and is unreleased.",
    },
    models: [
      {
        id: "onnx-community/SmolLM2-135M-Instruct-ONNX",
        label: "SmolLM2-135M Instruct q4",
        sizeMb: 172,
        note: "The smallest entry.",
      },
      {
        id: "onnx-community/LFM2.5-350M-ONNX",
        label: "LFM2.5-350M q4",
        sizeMb: 280,
      },
      {
        id: "onnx-community/Qwen3.5-0.8B-Text-ONNX",
        label: "Qwen3.5-0.8B q4",
        sizeMb: 526,
        note: "Latest Qwen.",
      },
      {
        id: "onnx-community/gemma-4-E2B-it-ONNX",
        label: "Gemma 4 E2B q4",
        sizeMb: 3747,
        note: "Eight files. Desktop.",
      },
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: "litert",
    name: "LiteRT-LM",
    docs: "https://developers.google.com/edge/litert-lm/js",
    tagline:
      "New runtime from Google, in early preview. Two supported models, both Gemma 4.",
    summary:
      "Runs `.litertlm` models through a WASM runtime on CPU or WebGPU. The published selection is small and every available file is over a gigabyte. The library provides no caching and no download progress, so this page implements both.",

    history: {
      owner: "runtime",
      note: "The Conversation holds the history inside the WASM module. Only the new turn is sent.",
      reset:
        "New chat deletes the Conversation and creates a replacement from the same preface. The engine, the weights and the WASM module all stay loaded.",
    },
    systemPrompt: {
      appliedAt: "load",
      note: "Set in `preface.messages` when the conversation is created. Changing it requires a new conversation.",
    },
    modelChoice: {
      kind: "static",
      note: "One entry, plus any `.litertlm` file you name yourself. The model id carries its backend, which decides whether the file is streamed to the GPU or staged through the WASM filesystem.",
    },
    // `Engine.create({ model })` takes a URL, so any reachable `.litertlm` can
    // be named. What it will ACCEPT is narrower than what it will fetch, and the
    // note says so in Google's own words rather than ours.
    customModel: {
      kind: "litertlm",
      label: "Or a .litertlm file",
      placeholder:
        "litert-community/gemma-4-E4B-it-litert-lm/gemma-4-E4B-it-web.litertlm",
      note: "A Hub path, a Hub URL, or any `http(s)` URL ending `.litertlm` — optionally prefixed `GPU_ARTISAN|` or `CPU|` to choose the backend. Google documents the JS API as supporting a limited set of web-compatible models, currently the two `-web.litertlm` Gemma 4 files, so another file may download in full and then fail to load.",
    },
    context: {
      control: "load",
      field: "mainExecutorSettings.maxNumTokens",
      default: DEFAULT_CONTEXT,
      min: 512,
      max: 8192,
      step: 512,
      // Issue #2966 reports memory use doubling since 0.13.1 at large contexts.
      note: "Input and output combined, set at load. Larger values cost GPU memory; reduce this first if a load fails.",
    },
    replyCap: {
      control: "load",
      field: "sessionConfig.maxOutputTokens",
      note: "Set when the conversation is created, not per turn.",
    },
    json: {
      supported: false,
      // TYPES 0.15.0: conversation.d.ts declares sendMessageStreaming(message)
      // with no options argument. The `Schema` type in conversation_config.d.ts
      // is used only by FunctionDeclaration, and enableConstrainedDecoding is a
      // ConversationConfig switch for that tool path.
      note: "No per-turn structured output. `sendMessageStreaming()` takes no options, and the `Schema` type applies to tool declarations only.",
    },
    // The most complete of the five, and the reason the `Schema` type exists at
    // all. `preface.tools` puts declarations in the conversation — so they are
    // fixed at load, exactly like the system prompt — and `AutoToolChat` wraps
    // a conversation to run `execute` itself between decode rounds, reporting
    // each through `onToolProgress`. Nobody else here closes the loop.
    //
    // Two caveats live in code rather than in this string, because they are
    // behaviour rather than API: upstream #2434 (multi-turn tool calling fails
    // on web with `enableConstrainedDecoding: true`, which is why it stays off)
    // and AutoToolChat's own cancel path, which never clears `isBusy` — see
    // providers/litert.js.
    tools: {
      kind: "parsed",
      appliedAt: "load",
      field: "preface.tools",
      note: "Declared in the conversation preface, so they are fixed at load like the system prompt. `AutoToolChat` wraps a conversation and calls `execute` itself — in parallel, waiting for all of them before waking the model — which makes this the only one of the five that closes the loop for you.",
    },
    progress: {
      kind: "handrolled",
      note: "The API has no progress callback. `model` accepts a ReadableStream, so this page fetches the file itself to report progress and to cache it.",
    },
    // Not an omission we are guessing at: engine_settings.js calls
    // setCacheDir(':nocache') unconditionally, commented "Not supported in JS."
    cache: {
      kind: "handrolled",
      label: "implemented here",
      tone: "warn",
      store: "Cache Storage",
      note: "The runtime caches nothing: `engine_settings.js` calls `setCacheDir(':nocache')` unconditionally. Because `Engine.create({ model })` accepts a ReadableStream, this page fetches the file and writes it to Cache Storage itself — under the same name Google's own demo uses, so a model pulled by either is a hit for both. Without that, every load re-downloads.",
      completeness:
        "Exact: one file per model, and Cache Storage only keeps a body it read to the end.",
    },
    rates: {
      selfReported: true,
      note: "Reports prefill and decode tokens/second and a cumulative token count, but only with `benchmarkEnabled: true`; without it the rates read as zero.",
    },
    cancel: {
      kind: "library",
      api: "reader.cancel()",
      note: "Canceling the reader also clears the conversation's busy flag. Leaving the read loop without it blocks later turns.",
    },
    unload: {
      frees: [
        "the conversation and its history",
        "the WASM engine",
        "any staged model file",
      ],
      keeps: ["the WASM module", "the weights, in Cache Storage"],
      caveat:
        "The conversation is deleted before the engine, since it holds a session against it. `unloadLiteRtLm()` would also drop the module, at the cost of re-downloading it.",
    },
    device: {
      fits: "desktop",
      note: "Desktop. The smallest model offered is 1915 MB.",
    },
    browsers: {
      label: "needs WebGPU",
      tone: "warn",
      note: "The GPU backends call for a WebGPU adapter and throw without one. Four WASM builds ship, selected on relaxed-SIMD and JSPI support, so Safari gets an Asyncify build. No threading is used, so no COOP/COEP headers are needed.",
    },
    // One entry. The spike at public/spikes/litert.html carries the loader
    // probes — two 25 MiB random-weight files and two MiniCPM5-1B backends —
    // which establish which packagings load on which backend. None of them
    // produce output worth reading, so they are not offered here.
    models: [
      {
        id: "GPU_ARTISAN|https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.litertlm",
        label: "Gemma 4 E2B -web — GPU_ARTISAN",
        sizeMb: 1915,
        note: "The model Google documents for the web runtime. Desktop.",
      },
    ],
  },
];

export const byId = (id) => DESCRIPTORS.find((d) => d.id === id) ?? null;

// Chrome first because the reader's browser may already hold the weights, so the
// page does something useful before a reader decides whether to spend a gigabyte.
// Not because there is no download: Chrome owns one, it is just not the page's.
// Where the API is absent, its own availability check says so.
export const DEFAULT_PROVIDER_ID = "chrome-prompt-api";
