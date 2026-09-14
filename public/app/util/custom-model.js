// One entry point for "a reader typed a model id", across every runtime that
// takes one.
//
// Each runtime names a specifier grammar in its descriptor's
// `customModel.kind`, and this maps that name to the parser for it. The callers
// — the picker, the deep link, the hook — then have no runtime-specific
// branches at all: they ask this what a string means and get the same shaped
// answer back whichever runtime is selected.
//
// The three grammars have deliberately converged rather than being unified.
// `repo:QUANT` for wllama, `repo:dtype` for Transformers.js and `BACKEND|url`
// for LiteRT-LM each mirror what that runtime's own API takes, so a reader who
// knows llama.cpp's `-hf` flag, or `pipeline()`'s `dtype`, or Google's sample
// can paste what they already know. A single invented syntax would have been
// tidier here and wrong at every one of those three ends.
//
// Every parser in this map is pure string code that imports no runtime library.
// That is the constraint that makes this file safe to import from the picker:
// validating an id must never be what pulls a bundle down. See the header of
// util/hf-gguf.js for the full argument.

import { parseGgufSpec } from "./hf-gguf.js";
import { parseOnnxSpec } from "./hf-onnx.js";
import { parseLitertlmSpec } from "./litertlm.js";

const PARSERS = {
  "hf-gguf": parseGgufSpec,
  "hf-onnx": parseOnnxSpec,
  litertlm: parseLitertlmSpec,
};

/**
 * Parse `raw` under the grammar `descriptor` declares, or report that this
 * runtime takes no typed id.
 *
 * Returns the parser's own result: `{ ok: true, id, label, note, warning,
 * detail, ... }` or `{ ok: false, error }`. The five keys named there are the
 * contract every parser satisfies; the rest are grammar-specific and only the
 * matching adapter reads them.
 */
export const parseCustomModel = (descriptor, raw) => {
  const kind = descriptor?.customModel?.kind ?? null;
  if (!kind) {
    return {
      ok: false,
      error: `${descriptor?.name ?? "This runtime"} does not take a model id.`,
    };
  }
  const parse = PARSERS[kind];
  if (!parse) {
    // A descriptor naming a grammar nobody implemented. Reported rather than
    // thrown: the picker renders this string, and a blank field that silently
    // refuses every entry would be the worse failure.
    return { ok: false, error: `No parser for custom model kind "${kind}".` };
  }
  return parse(raw);
};
