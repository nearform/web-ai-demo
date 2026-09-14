/* global navigator:false */

// web-llm adapter (@mlc-ai/web-llm 0.2.84).
//
// Verified against the 0.2.84 source and its published types rather than
// remembered:
//   - CreateMLCEngine(modelId, { initProgressCallback, logLevel }, chatOpts)
//   - chatOpts is ChatOptions = Partial<ChatConfig>, which is where
//     context_window_size lives
//   - InitProgressReport = { progress, timeElapsed, text }
//   - engine.chat.completions.create({ messages, stream, stream_options })
//   - usage.extra.{ prefill_tokens_per_s, decode_tokens_per_s, time_to_first_token_s }
//   - ResponseFormat.schema is a STRING, not an object
//   - engine.unload()
// The published bundle is self-contained (no bare-specifier imports, no
// SharedArrayBuffer), so a plain static host with no COOP/COEP is enough.

import * as webllm from "@mlc-ai/web-llm";
import { byId } from "./descriptors.js";

// web-llm is functional per call: the whole history goes over on every request.
// It reuses the KV cache only if it detects the history is an extension of the
// last one — so editing the system prompt mid-conversation silently throws away
// the cache and re-prefills everything. Tracked so the log can say when.
let lastSystem = null;

// Which model is resident. Needed because the tool allowlist below is checked
// per request and `generate` is not told which model it is talking to — the
// engine is the whole handle.
let loadedModelId = null;

// The allowlist lives in the descriptor, not here, because the picker has to
// mark the models that can do this BEFORE the bundle is downloaded — and
// descriptors.js is the tier that imports no library. This module is where it is
// enforced; that one is where it can be read for free.
const TOOL_MODEL_IDS = byId("web-llm").tools.modelAllowlist;

const toolsEnabled = (tools, modelId) =>
  Boolean(tools) && TOOL_MODEL_IDS.includes(modelId);

// With thinking disabled, web-llm still opens the reply with an empty
// `<think></think>` block (conversation.ts appendEmptyThinkingReplyHeader), which
// lands in the visible answer and looks like a bug to a reader. This swallows a
// leading think block and nothing else — the tags arrive split across stream
// chunks, so it has to buffer rather than pattern-match a single delta.
const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

const makeThinkStripper = (onChunk) => {
  let done = false;
  let buf = "";
  return (delta) => {
    if (done) return onChunk(delta);
    buf += delta;
    const trimmed = buf.trimStart();
    if (!trimmed) return; // whitespace so far; can't tell yet
    if (trimmed.startsWith(THINK_OPEN)) {
      const close = trimmed.indexOf(THINK_CLOSE);
      if (close === -1) return; // still inside the block
      done = true;
      const rest = trimmed.slice(close + THINK_CLOSE.length).trimStart();
      buf = "";
      if (rest) onChunk(rest);
      return;
    }
    // Not a think block. Only keep buffering while it could still become one.
    if (THINK_OPEN.startsWith(trimmed)) return;
    done = true;
    onChunk(buf);
    buf = "";
  };
};

// ---------------------------------------------------------------------------
// The MODELS.md policy, applied to a catalog read at runtime rather than to a
// hardcoded list. The exclusions are themselves the interesting result, so the
// filter logs what it dropped and why.
// ---------------------------------------------------------------------------

// Each family maps to the prefix of the newest generation we accept; anything
// else in that family is superseded and dropped. Gemma is absent on purpose —
// see isGemma4Plus.
const LATEST_BY_FAMILY = [
  "Qwen3.5-", // Qwen3.6 ships only at 27B/35B, so it has no browser-sized member
  "Llama-3.2-",
  "Phi-4-",
  "Ministral-3-3B-Instruct", // Base and Reasoning are variants, not sizes
  "OLMo-2-",
  "SmolLM2-", // no SmolLM3 in this catalog; these are the only phone-sized entries
];

// Deliberately NOT in the list above, though each is the newest of its own name:
//   DeepSeek-R1-Distill-* distills onto Llama/Qwen bases we already list
// One entry per class of model means the base family, not every fine-tune of it.
//
// Hermes belongs in that sentence too — they are Llama and Mistral fine-tunes —
// and is admitted anyway, by the one exception below. See MODELS.md rule 9.

// Preference order for the encoding of a given model. web-llm ships each model
// at up to four, and they are the same weights at different precision — not
// different models — so offering all four is just a longer list saying the same
// thing. q4f16_1 is the one to want: 4-bit weights, fp16 activations.
// q0f16/q0f32 are unquantized and enormous (SmolLM2-360M is 376 MB at q4f16_1 and
// 1744 MB at q0f32, for the same model).
const QUANT_PREFERENCE = ["q4f16_1", "q4f32_1", "q0f16", "q0f32"];

// "SmolLM2-360M-Instruct-q4f16_1-MLC" -> { base: "SmolLM2-360M-Instruct",
// quant: "q4f16_1" }. The base is what identifies a distinct model+size, so it
// is the key we dedupe on.
const splitId = (id) => {
  const m = /^(.+)-(q\df\d+(?:_\d)?)-MLC(-\d+k)?$/.exec(id);
  if (!m) return { base: id, quant: null, context: null };
  return { base: m[1], quant: m[2], context: m[3] ?? null };
};

// Gemma 3 and earlier are license-excluded, full stop. Written as "4 or later"
// so that the day MLC lands Gemma 4 (open request #810) it is admitted here
// automatically instead of being silently filtered out by a stale denylist.
const isGemma4Plus = (id) => /^gemma-?([4-9]|\d\d)/i.test(id);

const excludeReason = (m) => {
  const id = m.model_id ?? "";
  // THE ONE EXCEPTION to the fine-tune rule, and it is not a preference. These
  // five ids are the entire set web-llm will accept `tools` for; every other
  // model in the catalog throws UnsupportedModelIdError. Excluding them as
  // fine-tunes would leave the page claiming a capability in the comparison
  // table that nothing in its own picker could exercise.
  if (TOOL_MODEL_IDS.includes(id)) return null;
  // ModelType: LLM = 0, embedding = 1, VLM = 2. Undefined means LLM. Use the
  // catalog's own field rather than pattern-matching names.
  if (m.model_type === 1) return "embedding model, not a language model";
  if (m.model_type === 2) return "vision-language model";
  if (/^gemma/i.test(id) && !isGemma4Plus(id))
    return "Gemma 3 or earlier: license";
  // Reduced-context reruns of a model we already list.
  if (/-MLC-\d+k$/.test(id)) return "reduced-context duplicate";
  if (LATEST_BY_FAMILY.some((p) => id.startsWith(p))) return null;
  if (isGemma4Plus(id)) return null;
  return "superseded: not the latest generation of its family";
};

// One encoding per distinct model+size. Everything else is the same weights at a
// different precision, and four of those in a picker is four ways to say one
// thing.
const pickOneQuantPerModel = (models, log) => {
  const best = new Map();
  const alsoAvailable = [];
  for (const m of models) {
    const { base, quant } = splitId(m.model_id);
    const rank = QUANT_PREFERENCE.indexOf(quant);
    const current = best.get(base);
    if (!current) {
      best.set(base, { m, rank });
      continue;
    }
    const loser = rank < current.rank ? current.m : m;
    alsoAvailable.push(loser.model_id);
    if (rank < current.rank) best.set(base, { m, rank });
  }
  if (alsoAvailable.length) {
    log.info(
      `collapsed ${alsoAvailable.length} duplicate encodings to one per model`,
      { alsoAvailable },
    );
  }
  return [...best.values()].map((v) => v.m);
};

export default {
  id: "web-llm",

  // The catalog is inside the library, so populating the picker means the bundle
  // is already downloaded. That is a real cost and it is why the controller only
  // calls this when web-llm is actually selected, not for all five up front.
  discoverModels: async ({ log }) => {
    const list = webllm.prebuiltAppConfig?.model_list ?? [];
    log.info(`prebuiltAppConfig declares ${list.length} models`, {
      modelVersion: webllm.modelVersion ?? null,
    });

    const kept = [];
    const dropped = [];
    for (const m of list) {
      const reason = excludeReason(m);
      if (reason) dropped.push({ id: m.model_id, reason });
      else kept.push(m);
    }

    // The exclusions are the interesting part, so they are logged rather than
    // quietly applied. Two of them are findings in their own right: every Gemma
    // in this catalog is license-excluded, and there is no Gemma 4 to replace
    // them with.
    const byReason = {};
    for (const d of dropped) (byReason[d.reason] ??= []).push(d.id);
    log.info(
      `policy kept ${kept.length} of ${list.length} models before deduping encodings`,
      byReason,
    );
    log.info(
      `${TOOL_MODEL_IDS.length} Hermes ids are admitted past the fine-tune rule because they are the only models this library accepts \`tools\` for.`,
      { toolCapableModels: TOOL_MODEL_IDS },
    );
    if (!kept.some((m) => /^gemma-?[4-9]/i.test(m.model_id))) {
      log.warn(
        "No Gemma 4 in this catalog — the newest Gemma here is Gemma 3, which the license rule excludes. See MODELS.md.",
      );
    }

    // Smallest first: the cheapest thing that could work should be the default.
    return pickOneQuantPerModel(kept, log)
      .sort((a, b) => (a.vram_required_MB ?? 1e9) - (b.vram_required_MB ?? 1e9))
      .map((m) => ({
        id: m.model_id,
        label: m.model_id,
        // vram_required_MB as the library declares it — not a download size, and
        // not our estimate. Labeled honestly in the picker.
        sizeMb: m.vram_required_MB ?? null,
        // Read by the picker, which marks these in the option text itself. The
        // `note` below only renders for whatever is already selected, and "can
        // this one call a tool" is a question you need answered while scanning
        // the list, not after committing to a 4 GB download.
        toolCapable: TOOL_MODEL_IDS.includes(m.model_id),
        note: TOOL_MODEL_IDS.includes(m.model_id)
          ? "The only models web-llm accepts `tools` for. Here for that reason alone — they are 7B and 8B, so desktop and a long download."
          : undefined,
      }));
  },

  check: async ({ log }) => {
    if (!("gpu" in navigator)) {
      return { ok: false, detail: "navigator.gpu is undefined — no WebGPU" };
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      return { ok: false, detail: "requestAdapter() resolved to null" };
    }
    const f16 = adapter.features?.has?.("shader-f16") ?? false;
    // Most q4f16_1 models declare required_features: ["shader-f16"]. Report it
    // rather than gating on it — the point is to find out what actually happens.
    log.info("WebGPU adapter acquired", {
      shaderF16: f16,
      maxBufferSizeMb: adapter.limits?.maxBufferSize
        ? Math.floor(adapter.limits.maxBufferSize / (1024 * 1024))
        : null,
    });
    if (!f16) {
      log.warn(
        "shader-f16 is absent; q4f16_1 models will likely refuse to load",
      );
    }
    return { ok: true, detail: { shaderF16: f16 } };
  },

  load: async ({ model, context, log, progress }) => {
    // context is null unless the user overrode it. Leaving chatOpts off entirely
    // is the verified path — the model then uses whatever it was compiled with —
    // so an untouched control must not turn into an explicit override of the
    // same-looking number.
    const chatOpts = context ? { context_window_size: context } : undefined;
    log.info(`CreateMLCEngine("${model}")`, {
      contextOverride: context ?? "none (model's compiled default)",
    });
    if (chatOpts) {
      log.warn(
        "Overriding context_window_size. If the load fails, clear the override to use the model's compiled value.",
      );
    }

    const engine = await webllm.CreateMLCEngine(
      model,
      {
        logLevel: "WARN",
        initProgressCallback: (report) => {
          progress(report.progress, report.text);
        },
      },
      chatOpts,
    );
    loadedModelId = model;
    if (!TOOL_MODEL_IDS.includes(model)) {
      log.info(
        `Tool calling is unavailable on this model. web-llm accepts \`tools\` for ${TOOL_MODEL_IDS.length} ids only: ${TOOL_MODEL_IDS.join(", ")}.`,
      );
    }
    return engine;
  },

  generate: async ({
    handle,
    messages,
    system,
    json,
    tools,
    replyCap,
    onChunk,
    stats,
    wire,
    log,
    signal,
  }) => {
    if (lastSystem !== null && lastSystem !== system) {
      log.warn(
        "System prompt changed since the last turn — web-llm will discard the KV cache and re-prefill the whole history",
      );
    }
    lastSystem = system;

    // THE constraint on tool calling here, and it is not a soft one: the library
    // validates `tools` against a five-entry allowlist of model ids before it
    // does anything else, and throws UnsupportedModelIdError for everything
    // else. Checked up front so the reason arrives as a sentence rather than as
    // a thrown error out of the middle of a request.
    const toolModelOk = toolsEnabled(tools, loadedModelId);
    if (tools && !toolModelOk) {
      log.warn(
        `web-llm only accepts \`tools\` for ${TOOL_MODEL_IDS.length} model ids — ${TOOL_MODEL_IDS.join(", ")} — and "${loadedModelId}" is not one. Sending the request with tools would throw UnsupportedModelIdError, so this turn goes out without them and the model answers unaided.`,
      );
    }

    // With tools in play the library writes its OWN system message — the Hermes
    // tool-use preamble, with the declarations interpolated into it — and throws
    // CustomSystemPromptError if it finds one of ours already there. So the
    // system prompt is dropped for the turn rather than sent, and said out loud,
    // because silently losing it would make every later comparison wrong.
    const sendSystem = system && !toolModelOk;
    if (system && toolModelOk) {
      log.warn(
        "System instructions are not sent on a tool-calling turn: web-llm prepends its own Hermes tool preamble as the system message and throws CustomSystemPromptError if the request already has one.",
      );
    }

    const payload = [
      ...(sendSystem ? [{ role: "system", content: system }] : []),
      ...messages,
    ];

    const emit = makeThinkStripper(onChunk);

    // There is no AbortSignal in this API. interruptGenerate() sets a flag the
    // decode loop checks, so the stream ends early and this async iterator
    // completes normally rather than throwing — which is why the controller reads
    // signal.aborted instead of catching. Undocumented in api_reference.html and
    // exercised by no upstream example, so treat the Stop button as its test.
    const onAbort = () => {
      log.info("interruptGenerate()");
      handle.interruptGenerate?.();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    // The stream before makeThinkStripper touches it. This is the only adapter
    // here that removes text from its own output, so it is the only one that has
    // something to report that the conversation panel does not already show.
    let raw = "";
    let lastUsage = null;
    let toolCallsMade = 0;
    const requestsSent = [];

    const buildRequest = () => {
      const request = {
        messages: payload,
        stream: true,
        stream_options: { include_usage: true },
        // Thinking is off everywhere in this demo — see MODELS.md. A small
        // reasoning-capable model asked a simple question will otherwise spend its
        // whole token budget deliberating and never reach an answer, which reads as
        // a hang. web-llm's switch lives on extra_body; per its own docs, setting
        // true or leaving it undefined does nothing, so this only ever suppresses.
        extra_body: { enable_thinking: false },
        max_tokens: replyCap,
      };

      if (toolModelOk) {
        request.tools = tools.declarations.map((d) => ({
          type: "function",
          function: d,
        }));
        request.tool_choice = "auto";
      }

      if (json) {
        // `schema` is typed as a STRING here, not an object — the one place this
        // API differs from wllama's otherwise identical-looking field. Handing it
        // an object is silently wrong rather than a type error at runtime.
        //
        // Never alongside tools: the library sets response_format itself for the
        // Hermes path and throws CustomResponseFormatError if one is already
        // there. The controller does not send both, and this guard is the second
        // lock on the same door.
        if (toolModelOk) {
          log.warn(
            "Dropping response_format for this turn: with `tools` set, web-llm writes its own and throws CustomResponseFormatError if the request carries one.",
          );
        } else {
          request.response_format = {
            type: "json_object",
            schema: JSON.stringify(json.schema),
          };
          log.info("response_format: json_object");
        }
      }
      return request;
    };

    try {
      // model → tool → model, until the model stops asking. The cap is the
      // controller's, and it is not decoration: a small model that has decided
      // a tool is the answer will call it again with the same arguments rather
      // than read the result it was just given.
      const maxRounds = toolModelOk ? (tools.maxRounds ?? 4) : 1;
      for (let round = 1; round <= maxRounds; round += 1) {
        const request = buildRequest();
        // A SNAPSHOT of the history, not the live array. `payload` is mutated
        // between rounds — the assistant's tool_calls and the tool result are
        // pushed onto it — and the panel renders these after the turn ends, so
        // holding the reference would show round 1 carrying messages that did
        // not exist when round 1 was sent. The panel's whole job is to be exact.
        requestsSent.push({ ...request, messages: [...payload] });
        // Reported before the call, so a turn that throws still shows what was
        // sent — and re-reported per round, because a tool turn's second request
        // carries the tool result and is the interesting one.
        wire?.({
          request: requestsSent.length === 1 ? request : requestsSent,
          note:
            requestsSent.length === 1
              ? "The whole history is resent every turn. A leading <think> block is stripped from the visible answer; `raw` below is what the model emitted."
              : "One entry per round trip: the model asked for a tool, the result was appended as a `tool` message, and the whole history went over again. A leading <think> block is stripped from the visible answer.",
        });

        const chunks = await handle.chat.completions.create(request);

        // Fragments, keyed by `index`. The name and the arguments both arrive in
        // pieces across chunks, so they are concatenated rather than assigned —
        // the shape upstream's own tool example uses.
        const collected = new Map();
        let finishReason = null;

        for await (const chunk of chunks) {
          const choice = chunk.choices?.[0];
          finishReason = choice?.finish_reason ?? finishReason;
          const delta = choice?.delta?.content;
          if (delta) {
            raw += delta;
            emit(delta);
          }
          for (const tc of choice?.delta?.tool_calls ?? []) {
            const entry = collected.get(tc.index) ?? {
              id: "",
              name: "",
              arguments: "",
            };
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.name += tc.function.name;
            if (tc.function?.arguments)
              entry.arguments += tc.function.arguments;
            collected.set(tc.index, entry);
          }
          // Usage arrives only in the final chunk, and only because
          // stream_options.include_usage asked for it.
          if (chunk.usage) lastUsage = chunk.usage;
        }

        const calls = [...collected.values()];
        // Both conditions, as the types document: a generation that ended for
        // any reason other than a completed stop returns no tool_calls at all,
        // so finish_reason is the gate and the collected list is the payload.
        if (finishReason !== "tool_calls" || calls.length === 0) {
          if (calls.length > 0) {
            log.warn(
              `${calls.length} partial tool call(s) arrived but finish_reason was "${finishReason}" — web-llm only reports tool_calls on a clean stop, so these are being discarded.`,
              { calls },
            );
          }
          break;
        }
        if (signal?.aborted) break;

        payload.push({
          role: "assistant",
          content: raw || null,
          tool_calls: calls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: c.arguments },
          })),
        });

        for (const call of calls) {
          let args = {};
          try {
            args = JSON.parse(call.arguments);
          } catch (err) {
            log.warn(
              `Tool arguments did not parse as JSON: ${call.arguments}`,
              { message: String(err) },
            );
          }
          const result = await tools.call(call.name, args);
          toolCallsMade += 1;
          payload.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify(result),
          });
        }

        if (round === maxRounds) {
          log.warn(
            `Stopped after ${maxRounds} tool round(s) without a final answer. The tool results are in the history; the model never came back with prose.`,
          );
        }
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      stats({
        promptTokens: lastUsage?.prompt_tokens ?? null,
        completionTokens: lastUsage?.completion_tokens ?? null,
        prefillTokensPerSecond: lastUsage?.extra?.prefill_tokens_per_s ?? null,
        decodeTokensPerSecond: lastUsage?.extra?.decode_tokens_per_s ?? null,
        timeToFirstTokenSeconds:
          lastUsage?.extra?.time_to_first_token_s ?? null,
        endToEndLatencySeconds: lastUsage?.extra?.e2e_latency_s ?? null,
        historyResentByUs: true,
        jsonConstrained: Boolean(json) && !toolModelOk,
        toolsDeclared: toolModelOk ? tools.declarations.length : 0,
        toolCallsMade,
        // More than one means a round trip happened: the first request asked,
        // the second carried the result back.
        requestsThisTurn: requestsSent.length,
        runtimeReportsItsOwnRates: true,
      });
      // In the finally so that a stopped or failed turn still reports what had
      // arrived — a reply swallowed whole by an unclosed think block is exactly
      // the case where the raw text is the only evidence of what happened.
      wire?.({ raw });
    }
  },

  // A new chat. The history is the page's here, so the turns are already gone by
  // the time this runs — what is left is the KV cache, which resetChat() drops.
  // Worth doing rather than skipping: without it the first turn of the new
  // conversation is prefilled against a cache built from the old one, and the
  // prefill rate this page then reports would describe a reuse that the reader
  // has no reason to expect.
  resetConversation: async ({ handle, log }) => {
    await handle?.resetChat?.();
    // The warning this drives compares a turn's system prompt against the cache
    // it would have reused. There is no cache now, so the next turn has nothing
    // to warn about.
    lastSystem = null;
    log.info(
      "engine.resetChat() returned — KV cache dropped, weights untouched",
    );
  },

  unload: async ({ handle, log }) => {
    // unload() disposes the pipelines and destroys the WebGPU device. The
    // downloaded weights stay cached, and unlike wllama and Transformers.js the
    // instance remains reusable afterwards.
    await handle?.unload?.();
    lastSystem = null;
    loadedModelId = null;
    log.info("engine.unload() returned — weights remain cached on disk");
  },
};
