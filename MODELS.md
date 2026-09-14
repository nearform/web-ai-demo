# Which models we offer, and why

One policy for the spikes and for the unified demo. Every model picker in this
repo follows it. Sizes below are bytes read off the Hugging Face tree API on
2026-08-21, not estimates.

## The rules

1. **Gemma 4 if the runtime can run it.** It is the current good small open model
   and the reason the "can I run today's model" question is interesting.
2. **No Gemma 3 or earlier.** License. This one is not a preference, so it
   overrides "well, it fits" — a 270 MB Gemma 3 that runs beautifully on a phone
   still does not ship here.
3. **Latest Qwen with a browser-sized variant.** Today that is **Qwen3.5**
   (0.8B / 2B / 4B). Qwen3.6 exists but ships only at 27B and 35B-A3B, so it has
   no browser-sized member at all.
4. **Something that actually fits an iPhone.** The working budget is ~400 MB of
   weights; see the receipts in the article repo. Every picker should have at
   least one entry under that, or the phone has nothing to run.
5. **Language models only — no embedding models.** They load and then cannot
   answer, which reads as a broken demo.
6. **For any other family: latest generation only.** One entry per class, newest
   release. No back catalog.
7. **Multiple sizes of the same model are fine** and in fact wanted — same
   architecture at two sizes is the cleanest way to show where a device gives out.
8. **Sizes yes, encodings no.** One quantization per model+size. web-llm ships
   most models at up to four (`q4f16_1`, `q4f32_1`, `q0f16`, `q0f32`) and they are
   the same weights at different precision, not different models — four of those
   in a picker is four ways to say one thing. Preference order is `q4f16_1` first
   (4-bit weights, fp16 activations), falling back only where a model has no
   quantized build. For scale: SmolLM2-360M is 376 MB at `q4f16_1` and 1744 MB at
   `q0f32`.
9. **One entry per class means the base family, not every fine-tune of it.** So no
   `DeepSeek-R1-Distill-*` (distills onto Llama and Qwen bases), since Llama and
   Qwen are already listed. Same for variants that are not sizes: of
   `Ministral-3-3B` in Base / Instruct / Reasoning, only Instruct ships.

   **One exception, and it is a capability rather than a preference:** the five
   `Hermes-2-Pro-*` / `Hermes-3-*` ids web-llm ships are Llama and Mistral
   fine-tunes, and they are also the entire set the library will accept `tools`
   for — every other id in the catalog throws `UnsupportedModelIdError`. Dropping
   them as fine-tunes would leave the demo's capability table claiming tool
   calling that nothing in its own picker could demonstrate, so they are
   admitted, labeled with why, and left at the bottom of the list on size.

10. **No reduced-context duplicates** — web-llm's `-1k` entries are the same model
    with a smaller window.

## What that yields per runtime

**wllama** (GGUF, so nearly everything is available):

| Model        | File                           | Size     | Why it is here                                    |
| ------------ | ------------------------------ | -------- | ------------------------------------------------- |
| LFM2.5-350M  | `LFM2.5-350M-Q4_K_M.gguf`      | 218 MiB  | The comfortable iPhone pick                       |
| Qwen3.5-0.8B | `Qwen3.5-0.8B-UD-Q2_K_XL.gguf` | 398 MiB  | Latest Qwen, at the iPhone budget edge            |
| Qwen3.5-0.8B | `Qwen3.5-0.8B-Q4_K_M.gguf`     | 507 MiB  | Same model, honest quant — the size/quality pair  |
| Qwen3.5-4B   | `Qwen3.5-4B-Q4_K_M.gguf`       | 2613 MiB | Desktop, and the >2 GiB single-file test          |
| Gemma 4 E2B  | `gemma-4-E2B-it-Q4_0.gguf`     | 2709 MiB | Rule 1. Desktop only, and expected to be marginal |

wllama also takes a repo **you** name, in the field under the picker — as do
Transformers.js and LiteRT-LM, each under its own grammar; see "Models you name
yourself" below. The policy above governs the curated list, not what the runtime
will accept. A GGUF is a
GGUF, so there is no vetted-catalog reason to refuse one — `owner/repo:QUANT` as
llama.cpp's `-hf` takes it, `owner/repo|file.gguf`, a Hub URL, or a bare
`owner/repo` to let wllama pick the quant. wllama 3.6.0 resolves a quant itself
(`loadModelFromHF` accepts `{ repo, quant }`), including rewriting a shard hit to
`-00001-of-0000N`, so nothing here reimplements that. Such an entry joins the
picker and the `?model=` link like any other, and carries no size, because this
page has not asked the Hub for one and an invented number beside a measured one
would be worse than a blank.

The two traps below are why that field warns rather than just accepting: a name
matching `mtp`, `dflash`, `eagle`, `draft`, `mmproj` or `imatrix` is called out in
the log before the download starts. It is advice, not a refusal — pointing a
runtime at one to see what it does is a legitimate thing to want from this page.

**web-llm** reads its own catalog at runtime, so the policy is applied as a filter
rather than a hardcoded list — and the filter **logs what it dropped and why**,
because the exclusions are themselves the interesting result. It takes the catalog
from **163 entries to 13**: 163 → 31 on the family and license rules, then 31 → 13
by collapsing 18 duplicate encodings. Re-measured 2026-08-23 against
`modelVersion: v0_2_84/base`, in both the spike and the unified demo, which agree.
(An earlier draft of this file said 43 for the intermediate step; that was wrong.)
What ships:

| Model                        | Declared VRAM | Note                                                                                                                                   |
| ---------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| SmolLM2-135M-Instruct        | 359.69 MB     | The only iPhone-plausible entry, and the one model the public record confirms works on iOS. `q0f16` because it has no quantized build. |
| SmolLM2-360M-Instruct        | 376.06 MB     |                                                                                                                                        |
| Llama-3.2-1B-Instruct        | 879.04 MB     |                                                                                                                                        |
| Qwen3.5-0.8B                 | 1629.49 MB    | Smallest of the latest Qwen                                                                                                            |
| SmolLM2-1.7B-Instruct        | 1774.19 MB    |                                                                                                                                        |
| OLMo-2-0425-1B-Instruct      | 1776.75 MB    |                                                                                                                                        |
| Qwen3.5-2B                   | 2245.44 MB    |                                                                                                                                        |
| Llama-3.2-3B-Instruct        | 2263.69 MB    |                                                                                                                                        |
| Ministral-3-3B-Instruct-2512 | 2863.69 MB    | Latest of the Mistral family                                                                                                           |
| Phi-4-mini-instruct          | 3437.58 MB    |                                                                                                                                        |
| Qwen3.5-4B                   | 3867.82 MB    |                                                                                                                                        |
| Qwen3.5-9B                   | 6433.01 MB    |                                                                                                                                        |
| OLMo-2-1124-7B-Instruct      | 6479.01 MB    |                                                                                                                                        |

Those are `vram_required_MB` as the catalog declares it, which is not a download
size. Two findings fall straight out of the filter:

- **There is no Gemma 4 in the catalog at all.** The newest Gemma is
  `gemma3-1b-it`, which rule 2 excludes. So under this policy web-llm has no
  Gemma. That is not us being fussy; it is the format-availability problem.
- Qwen3.5 **is** there (0.8B / 2B / 4B / 9B), so rule 3 is satisfiable.

Embeddings are excluded properly via the catalog's own `model_type` field
(`ModelType.embedding`), not by guessing at names.

**LiteRT-LM** is where this policy runs out of road, and the emptiness is the
finding rather than a gap in the list. Rule 4 wants an entry under ~400 MB so a
phone has something to run; **there is nothing to offer.** Measured 2026-08-22 by
running it, not by reading the catalog:

| Model                 | Size     | Backend       | Result                                                      |
| --------------------- | -------- | ------------- | ----------------------------------------------------------- |
| `gemma-4-tiny-random` | 25 MiB   | `CPU`         | Loads. Random weights — loader probe only, output is noise  |
| `gemma-4-tiny-random` | 25 MiB   | `GPU_ARTISAN` | **Fails** — `Streaming HF_Tokenizer_Zlib … not supported`   |
| `MiniCPM5-1B-web`     | 1052 MiB | `GPU_ARTISAN` | **Fails** — same error, despite `-web` in the filename      |
| `MiniCPM5-1B-web`     | 1052 MiB | `CPU`         | Loads and answers. Prefill 5.6 tok/s — ~70x slower than GPU |
| `gemma-4-E2B-it-web`  | 1915 MiB | `GPU_ARTISAN` | **Loads and holds a five-turn conversation**                |

Three consequences for the picker:

1. **On the default backend the catalog is Google's allowlist of two**, and that is
   not a conservative reading of the docs — a community `-web.litertlm` downloads
   and then refuses to load. Google's own page says so in as many words: "The
   LiteRT-LM JS API currently supports a limited set of web-compatible models.
   We're working on expanding this to cover general `.litertlm` model files, but
   for now, the following models are supported" — then names
   `gemma-4-E2B-it-web.litertlm` and `gemma-4-E4B-it-web.litertlm`. Rule 6
   ("latest generation only") is moot when the generation has one publisher.
   That "we're working on expanding this" is also why the picker takes a file you
   name: the allowlist is the kind of fact that goes stale, and re-checking it
   should not require editing this repo.
2. **The smallest thing that works is 1915 MiB**, ~5x the iPhone budget. So this
   runtime is desktop-only by arithmetic, and the picker says so in its labels
   rather than implying a phone option exists.
3. **The backend belongs in the model id.** It is not a detail: it decides whether
   the `-web` packaging requirement applies at all, and whether prefill is 5.6 or
   500 tok/s. The spike encodes it as `BACKEND|url` for that reason. `Backend.GPU`
   is deliberately not offered — the tab-crash claim is untested and should stay a
   deliberate act.

Note rule 2 (no Gemma 3 or earlier) removes what would otherwise look like the
answer here: the small MediaPipe `-web.task` files at 238 MB and 668 MB are all
Gemma 3, and they are gated behind a 401 anyway. License and policy land on the
same files, from two directions.

## Thinking is off, everywhere

Every provider in this repo disables reasoning output: `enable_thinking: false`,
passed through `chat_template_kwargs` in wllama and `extra_body` in web-llm. Any
runtime added later should do the same.

The reason is not a preference about reasoning models. It is that a small model
given a 512-token budget spends all of it deliberating and never reaches an
answer. Measured on Qwen3.5-0.8B Q4_K_M, asked "what is node.js?": uncapped and
thinking-on, 9948 characters in 2304 chunks with no answer, which reads as a hang.
Same model and prompt with thinking off and the cap in place: a direct 1180-character
answer. Note the deliberation arrived as ordinary `content`, not on a
`reasoning_content` channel, so it could not be filtered out downstream — it had
to be switched off at the template.

Replies are also capped at **512 tokens**. An uncapped turn eats the context
budget that the multi-turn tests are supposed to be measuring.

## Two traps when pinning GGUF sizes

Both of these bit while writing this file, and both silently produce a model list
that cannot work:

- **`mtp-*` files are multi-token-prediction draft heads**, not the model. In
  `unsloth/gemma-4-E2B-it-GGUF` they are 56–93 MiB, so sorting by size puts them
  first and they look like a wonderfully small Gemma 4.
- **`mmproj-*` files are vision projectors**, same story, 531–941 MiB.
- **Speculative draft heads are published as standalone repos**, which is the
  same trap without the filename prefix to give it away, and they declare
  `pipeline_tag: text-generation` so a pipeline filter does not catch them.
  `LiquidAI/LFM2.5-8B-A1B-DSpark-GGUF` is 340 MiB at Q8_0 next to an 8B target;
  its own card calls it a "draft sidecar" that takes the token embeddings and LM
  head from the target at load, so it cannot run alone even in principle.
  `Alittlehammmer/Qwen3.6-35B-A3B-DFlash-GGUF-llama.cpp` is 421 MB at Q8_0 and
  reads like a browser-sized Qwen3.6; it is the DFlash draft head, and its own
  README pairs it with the real 35B via llama.cpp's `model-draft` and
  `spec-type = draft-dflash`. There is no draft slot in any runtime here, so it
  would download and then answer with nothing. Not offered for that reason.

Sort by size to find the small end, then exclude `mtp`, `mmproj`, `imatrix`,
`draft`, and `-0000N-of-0000M` shard members before believing the answer.

## Models you name yourself

The curated lists are what this repo vouches for. Three of the five runtimes will
also load a model **you** name, in the field under the picker, and the policy
above does not govern that field — it governs the list. web-llm is the one that
cannot: its weights have to be compiled to MLC's format ahead of time, so there
is no arbitrary repo to point it at. Chrome supplies its own model and has
nothing to select.

Each runtime takes the grammar its own API takes, rather than one invented
syntax, so what a reader already knows transfers:

| Runtime         | Accepts                                                                                                        | Resolves to                                            |
| --------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| wllama          | `owner/repo:QUANT`, `owner/repo\|file.gguf`, `owner/repo`, a Hub URL                                           | `loadModelFromHF({ repo, file, quant })`               |
| Transformers.js | `owner/repo`, `owner/repo:dtype`, `owner/repo\|onnx/model_q4.onnx`, a Hub URL                                  | `pipeline()`'s `subfolder`, `model_file_name`, `dtype` |
| LiteRT-LM       | `owner/repo/file-web.litertlm`, any `http(s)` `.litertlm` URL, either with a `GPU_ARTISAN\|` or `CPU\|` prefix | `Engine.create({ model: url })` on that backend        |

Three things are true of all three, and they are the point of doing it this way:

1. **Validation happens when you press Use, not when the download starts.** The
   parsers are pure string code in `public/app/util/`, importing no runtime
   library, precisely so the picker can reject a typo without pulling a bundle
   down to do it. A malformed specifier never becomes a several-hundred-megabyte
   request.
2. **What you apply joins the picker and the `?model=` link**, so it can be sent
   on like any other selection. Ids round-trip: what the field accepts is what a
   link carries back.
3. **They warn rather than refuse.** Each grammar knows the files that download
   and then cannot answer — draft heads and vision projectors for wllama,
   embedding and speech models for Transformers.js, a non-`-web` packaging for
   LiteRT-LM — and says so in the log before the bytes move. Pointing a runtime
   at one to see what it does is a legitimate thing to want from this page.

None of these entries carries a size. The size is on the Hub and this page has
not asked; an invented number beside a measured one would be worse than a blank.

## When this goes stale

It will. Re-check on: a new Gemma or Qwen generation, a Qwen3.6 small variant
appearing, or Gemma 4 landing in web-llm's catalog (open request #810). The
per-file method is a single `curl` against
`https://huggingface.co/api/models/{repo}/tree/main?recursive=true`.
