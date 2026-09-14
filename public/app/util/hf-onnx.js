// Hugging Face ONNX specifiers for Transformers.js, parsed without loading the
// runtime to do it.
//
// Same reasoning as util/hf-gguf.js, and the same shape: the picker validates
// what a reader typed BEFORE anything downloads, and importing the adapter to
// borrow its parser would pull the whole @huggingface/transformers bundle just
// to check a string. The adapter imports this instead, so both ends agree on
// what an id means.
//
// WHAT A TRANSFORMERS.JS MODEL ID ACTUALLY SELECTS, from 4.2.0's own source
// (`src/pipelines.js`, `src/utils/dtypes.js`) rather than remembered. The
// `pipeline(task, model, options)` signature destructures these four:
//
//     model         'owner/repo' on the Hub
//     subfolder     DEFAULTS TO 'onnx' — the weights live in a subdirectory
//     model_file_name  the base name, excluding the dtype and `.onnx` suffixes
//     dtype         which quantization of that base name to fetch
//
// and the file that ends up requested is
// `<repo>/<subfolder>/<model_file_name><suffix>.onnx`, where the suffix comes
// from DTYPE_SUFFIX below. That composition is the whole reason this file can
// accept a pasted file URL: the mapping is invertible, so a reader who found
// `onnx/model_q4f16.onnx` in the Hub's file browser can paste it and get
// exactly that file, subfolder and dtype included, without learning the three
// option names.
//
// A repo is NOT checked against the Hub here. Nothing on this path touches the
// network — the same rule util/hf-gguf.js follows, for the same reason: a
// validator that costs a round trip is a validator that runs at load time, and
// by then the point of catching a typo early is gone.

/** `owner/name`. The Hub allows letters, digits, `-`, `_` and `.` in both. */
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

const HOST_RE = /^(?:https?:\/\/)?(?:www\.)?(?:huggingface\.co|hf\.co)\//i;

// VERBATIM from 4.2.0 `src/utils/dtypes.js` — DATA_TYPES keys paired with
// DEFAULT_DTYPE_SUFFIX_MAPPING values. Copied rather than imported for the
// reason at the top of this file, and ordered longest-suffix-first because
// `model_q4f16` ends with both `_q4f16` and nothing else — but `model_q1f16`
// would match a naive `_q1` scan first if the short forms came earlier.
//
// `fp32` maps to the empty suffix, so it is the fallback below rather than a
// member of this scan: every name trivially "ends with" an empty string.
const DTYPE_SUFFIX = [
  ["q4f16", "_q4f16"],
  ["q2f16", "_q2f16"],
  ["q1f16", "_q1f16"],
  ["bnb4", "_bnb4"],
  ["uint8", "_uint8"],
  ["int8", "_int8"],
  ["fp16", "_fp16"],
  ["q8", "_quantized"],
  ["q4", "_q4"],
  ["q2", "_q2"],
  ["q1", "_q1"],
];

/**
 * Every DATA_TYPES key in 4.2.0, including `auto` — which has no suffix of its
 * own because it resolves against the model's config at load. Accepted here so
 * a reader can ask a repo to choose for itself.
 */
const DTYPES = ["auto", "fp32", ...DTYPE_SUFFIX.map(([d]) => d)];

/**
 * The dtype used when a specifier does not name one.
 *
 * `q4`, NOT `q4f16`, and that is a measured decision rather than a preference —
 * see the DTYPE note in providers/transformers-js.js, which imports this. It
 * lives here rather than there so that the picker can name the default it is
 * about to apply without importing the adapter.
 */
export const DEFAULT_DTYPE = "q4";

/** `onnx`, from the `subfolder = 'onnx'` default in 4.2.0's `pipeline()`. */
export const DEFAULT_SUBFOLDER = "onnx";

// Transformers.js runs ONNX graphs and nothing else, so a repo of PyTorch or
// GGUF weights has no file for it to fetch — the load fails on a 404 for
// `onnx/model_q4.onnx`, which reads as a broken runtime rather than as the
// wrong repo. There is no way to be sure from a name alone, so this is the
// cheap tell: the `onnx-community` org and the `-ONNX` repo suffix are the two
// conventions the Hub's converted repos actually follow.
const HAS_ONNX_TELL_RE = /onnx/i;

// Models that are ONNX, load, and still cannot answer, because
// `pipeline("text-generation", ...)` wants a decoder language model. An
// embedding or reranking model has no LM head; an ASR or vision model wants a
// processor and different inputs. Warned about rather than refused, as in
// util/hf-gguf.js: pointing the runtime at one to see what it does is a
// legitimate thing to want from this page.
const NOT_TEXT_GEN_RE =
  /(?:^|[-_./])(?:all-minilm|bge|gte|e5|nomic-embed|embed(?:ding)?s?|rerank(?:er)?|sentence-transformers|whisper|wav2vec|clip|siglip|vit|dinov|sam|detr|yolo|resnet|florence|trocr|donut)/i;

const repoName = (repo) => repo.slice(repo.indexOf("/") + 1);

const warningsFor = ({ repo, file }) => {
  const out = [];
  // Tested against the repo only. A file path is `onnx/model_q4.onnx` on every
  // repo in existence, so folding it in would make the tell fire for everyone.
  if (!HAS_ONNX_TELL_RE.test(repo)) {
    out.push(
      "Nothing in this name says ONNX. Transformers.js loads `.onnx` graphs from the repo's `onnx/` subfolder, so a repo of PyTorch or GGUF weights fails the load with a 404 rather than running slowly.",
    );
  }
  if (NOT_TEXT_GEN_RE.test(file ? `${repo}/${file}` : repo)) {
    out.push(
      "This looks like an embedding, reranking, speech or vision model rather than a decoder language model. Those have no LM head for `text-generation` to sample from, so the pipeline fails to build or answers with nothing.",
    );
  }
  return out.length ? out.join(" ") : null;
};

/**
 * Split `onnx/model_q4f16.onnx` back into the three options that compose it.
 *
 * The inverse of what `pipeline()` does with `{ subfolder, model_file_name,
 * dtype }`, so a path taken out of the Hub's file browser resolves to that
 * exact file. A base name matching no suffix is fp32, which is the one dtype
 * whose suffix is empty.
 */
const splitOnnxPath = (path) => {
  const slash = path.lastIndexOf("/");
  const subfolder = slash === -1 ? "" : path.slice(0, slash);
  const base = path.slice(slash + 1).replace(/\.onnx$/i, "");
  const hit = DTYPE_SUFFIX.find(([, suffix]) =>
    base.toLowerCase().endsWith(suffix),
  );
  return hit
    ? { subfolder, fileName: base.slice(0, -hit[1].length), dtype: hit[0] }
    : { subfolder, fileName: base, dtype: "fp32" };
};

/**
 * Canonical id. `repo|path/to/model_q4.onnx` where a file is named, `repo:dtype`
 * where a dtype is, and the bare repo where neither — the three forms
 * `parseOnnxSpec` accepts back, so an id round-trips through a deep link.
 *
 * File and dtype are exclusive on purpose: a path already encodes its dtype in
 * the suffix, so carrying both would let a link disagree with itself.
 */
const idFor = ({ repo, file, dtype }) =>
  file ? `${repo}|${file}` : dtype ? `${repo}:${dtype}` : repo;

const labelFor = ({ repo, file, dtype }) =>
  file
    ? `${repoName(repo)} ${splitOnnxPath(file).dtype}`
    : `${repoName(repo)} ${dtype ?? DEFAULT_DTYPE}`;

const noteFor = ({ repo, file, dtype }) => {
  const how = file
    ? `\`${file}\``
    : `\`${DEFAULT_SUBFOLDER}/model_*.onnx\` at dtype \`${dtype ?? DEFAULT_DTYPE}\``;
  return `From \`${repo}\`: ${how}. Nothing has checked that the file exists, and the size is not known until the download starts, so this entry does not carry one.`;
};

const fail = (error) => ({ ok: false, error });

/**
 * Parse a Hugging Face ONNX specifier.
 *
 * Accepts, in order of how likely it is to be what someone pasted:
 *
 *   - `owner/repo`                      — the form the curated list uses
 *   - `owner/repo:q4f16`                — pick the quantization yourself
 *   - `owner/repo|onnx/model_q4.onnx`   — pick the exact file
 *   - `owner/repo/onnx/model_q4.onnx`   — a Hub path
 *   - a `huggingface.co` URL in any of the above shapes, `/blob/`, `/resolve/`
 *     and `/tree/` included
 *
 * The revision in a URL is dropped: 4.2.0's `pipeline()` takes a `revision`
 * option, but this page does not pass one, so `main` is what would be fetched
 * and echoing a different one back into the id would be a lie.
 *
 * Returns `{ ok: true, id, repo, file, dtype, subfolder, fileName, label, note,
 * warning, detail }` or `{ ok: false, error }`. `warning` is advice, not a
 * rejection — see warningsFor.
 */
export const parseOnnxSpec = (raw) => {
  const input = String(raw ?? "").trim();
  if (!input) return fail("Enter a Hugging Face repo.");
  if (/\s/.test(input)) return fail("A specifier contains no spaces.");

  // `?download=true` is what the Hub's own download button appends, and a
  // fragment is what a copied anchor leaves. Neither part of a specifier can
  // contain either character, so both go before anything is parsed.
  let rest = input.replace(HOST_RE, "").replace(/[?#].*$/, "");
  let repo;
  let file = null;
  let dtype = null;

  // A single-file URL off the Hub. `/blob/` is the page a reader is looking at
  // and `/resolve/` is the download behind it; both name one file.
  const blob = rest.match(/^(.+?)\/(?:blob|resolve)\/[^/]+\/(.+)$/);
  if (blob) {
    [, repo, file] = blob;
  } else {
    // `/tree/<rev>/<dir>` is the file browser. Only the repo part is meaningful:
    // a bare subfolder with no file would be a third axis that the `repo|file`
    // XOR `repo:dtype` id shape has nowhere to put.
    rest = rest.replace(/\/tree\/.*$/, "");

    if (rest.includes("|")) {
      const parts = rest.split("|");
      if (parts.length > 2)
        return fail("Only one `|`, as in `repo|onnx/model_q4.onnx`.");
      [repo, file] = parts;
    } else if (/\.onnx$/i.test(rest)) {
      // `owner/repo/path/to/model_q4.onnx` — the repo is the first two
      // segments and everything after is the path inside it.
      const cut = rest.indexOf("/", rest.indexOf("/") + 1);
      if (cut === -1)
        return fail(`\`${rest}\` names a file but no owner/repo.`);
      repo = rest.slice(0, cut);
      file = rest.slice(cut + 1);
    } else {
      // `owner/repo:dtype`. A repo name cannot contain a colon, so the last one
      // is unambiguously the separator — and any URL scheme came off the front
      // above.
      const colon = rest.lastIndexOf(":");
      if (colon > 0) {
        repo = rest.slice(0, colon);
        dtype = rest.slice(colon + 1);
      } else {
        repo = rest;
      }
    }
  }

  repo = (repo ?? "").trim().replace(/\/+$/, "");
  file = (file ?? "").trim() || null;
  dtype = (dtype ?? "").trim() || null;

  if (!REPO_RE.test(repo)) {
    return fail(`\`${repo || input}\` is not an \`owner/repo\` name.`);
  }
  if (file && !/\.onnx$/i.test(file)) {
    return fail(`\`${file}\` is not an \`.onnx\` file.`);
  }
  if (dtype && !DTYPES.includes(dtype.toLowerCase())) {
    return fail(`\`${dtype}\` is not a dtype. One of: ${DTYPES.join(", ")}.`);
  }
  if (dtype) dtype = dtype.toLowerCase();

  const spec = { repo, file, dtype };
  // Resolved rather than stored: these three are what the adapter passes, and
  // deriving them in one place means the label, the note and the load can never
  // read a path differently from one another.
  const resolved = file
    ? splitOnnxPath(file)
    : {
        subfolder: DEFAULT_SUBFOLDER,
        fileName: null,
        dtype: dtype ?? DEFAULT_DTYPE,
      };

  return {
    ok: true,
    ...spec,
    ...resolved,
    id: idFor(spec),
    label: labelFor(spec),
    note: noteFor(spec),
    warning: warningsFor(spec),
    detail: {
      repo,
      subfolder: resolved.subfolder,
      modelFileName: resolved.fileName,
      dtype: resolved.dtype,
    },
  };
};

/**
 * The `pipeline()` options a specifier resolves to, with the keys it did not
 * learn left off rather than set to undefined.
 *
 * `subfolder` and `model_file_name` are only emitted when a file path supplied
 * them: 4.2.0 defaults `subfolder` to `'onnx'` and `model_file_name` to null,
 * and passing those values explicitly would say "a reader chose this" when
 * nobody did.
 */
export const onnxLoadParams = (id) => {
  const spec = parseOnnxSpec(id);
  if (!spec.ok) throw new Error(`Unusable model id "${id}": ${spec.error}`);
  return {
    model: spec.repo,
    dtype: spec.dtype,
    ...(spec.file
      ? {
          subfolder: spec.subfolder,
          ...(spec.fileName ? { model_file_name: spec.fileName } : {}),
        }
      : {}),
  };
};
