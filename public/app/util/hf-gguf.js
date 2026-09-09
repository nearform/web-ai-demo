// Hugging Face GGUF specifiers, parsed without loading a runtime to do it.
//
// This is in util/ rather than in providers/wllama.js on purpose. The picker has
// to validate what a reader typed BEFORE anything downloads, and importing the
// adapter to borrow its parser would pull the whole wllama bundle just to check a
// string — the exact cost providers/index.js exists to avoid. The adapter imports
// this instead, so both ends agree on what an id means.
//
// The reason a quant on its own is enough: wllama 3.6.0's `loadModelFromHF` takes
// `{ repo, quant }` as well as `{ repo, file }` (esm/huggingface.d.ts), and does
// the resolution itself — it reads `/api/models/<repo>/tree/main?recursive=true`,
// matches the quant as a case-insensitive substring of the path, skips `mmproj`
// files, and rewrites a `-00003-of-00005.gguf` hit to the first shard so a split
// model loads whole. With no quant it tries `Q4_K_M`, then `Q8_0`, then the first
// GGUF in the repo. So none of that is reimplemented here; this file only decides
// which of the two shapes a string meant.

/** `owner/name`. The Hub allows letters, digits, `-`, `_` and `.` in both. */
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** `Q4_K_M`, `UD-Q2_K_XL`, `BF16` — a filename fragment, not a path. */
const QUANT_RE = /^[A-Za-z0-9._-]+$/;

const HOST_RE = /^(?:https?:\/\/)?(?:www\.)?(?:huggingface\.co|hf\.co)\//i;

// Files that download and then cannot answer, which reads as a broken runtime
// rather than as the wrong file. Speculative draft heads are the trap that
// catches everyone: they are a fraction of the size of the model they accelerate,
// so they look like a wonderfully small version of it. `mtp-*` at least announces
// itself in the filename; `DFlash`, `DSpark` and `EAGLE` are whole repos, carry
// `pipeline_tag: text-generation`, and several of them share the target's token
// embeddings and LM head at load — so they cannot run alone even in principle.
// Same story for vision projectors. Warned about rather than refused: pointing a
// runtime at one to see what it does is a legitimate thing to want from this page.
const NOT_A_MODEL_RE =
  /(?:^|[-_./])(?:mtp|dflash|dspark|eagle|draft|mmproj|imatrix)/i;

const repoName = (repo) => repo.slice(repo.indexOf("/") + 1);

// Tested against the whole id, not just the filename: `DFlash` and `EAGLE` heads
// are often published in a repo of their own, so the repo name is where the tell
// is and a `:Q8_0` on the end says nothing.
const warningFor = (id) =>
  NOT_A_MODEL_RE.test(id)
    ? "This looks like a draft head, a vision projector or an importance matrix rather than a model. Those load and then cannot answer, so an empty or garbled reply is the file rather than the runtime."
    : null;

/**
 * Canonical id for a parsed specifier. `repo|file.gguf` where a file is named,
 * `repo:QUANT` where a quant is, and the bare repo where neither — the three
 * forms `parseGgufSpec` accepts back, so an id round-trips through a deep link.
 */
const idFor = ({ repo, file, quant }) =>
  file ? `${repo}|${file}` : quant ? `${repo}:${quant}` : repo;

const labelFor = ({ repo, file, quant }) =>
  file
    ? file
        .split("/")
        .pop()
        .replace(/\.gguf$/i, "")
    : quant
      ? `${repoName(repo)} ${quant}`
      : repoName(repo);

const noteFor = ({ repo, file, quant }) => {
  const how = file
    ? `\`${file}\``
    : quant
      ? `the first file whose name contains \`${quant}\``
      : "`Q4_K_M`, then `Q8_0`, then the first GGUF";
  return `From \`${repo}\`: ${how}. The size is not known until the download starts, so this entry does not carry one.`;
};

const fail = (error) => ({ ok: false, error });

/**
 * Parse a Hugging Face GGUF specifier.
 *
 * Accepts, in order of how likely it is to be what someone pasted:
 *
 *   - `owner/repo:Q8_0`               — llama.cpp's own `-hf` form
 *   - `owner/repo|Model-Q8_0.gguf`    — the form the curated list uses
 *   - `owner/repo/Model-Q8_0.gguf`    — a Hub path
 *   - `owner/repo`                    — let wllama pick the quant
 *   - a `huggingface.co` URL in any of the above shapes, `/blob/`, `/resolve/`
 *     and `/tree/` included
 *
 * The revision in a URL is dropped, because wllama only ever reads `main`.
 *
 * Returns `{ ok: true, id, repo, file, quant, label, note, warning }` or
 * `{ ok: false, error }`. `warning` is set for a file that is not a model —
 * see NOT_A_MODEL_RE — and is advice, not a rejection.
 */
export const parseGgufSpec = (raw) => {
  const input = String(raw ?? "").trim();
  if (!input) return fail("Enter a Hugging Face repo.");
  if (/\s/.test(input)) return fail("A specifier contains no spaces.");

  // `?download=true` is what the Hub's own download button puts on the end, and
  // a fragment is what a copied anchor leaves. Neither part of a specifier can
  // contain either character, so both are dropped before anything is parsed.
  let rest = input.replace(HOST_RE, "").replace(/[?#].*$/, "");
  // Uninitialised, unlike the two below: every branch sets it, and a `null` here
  // would be dead code the linter is right to flag.
  let repo;
  let file = null;
  let quant = null;

  // A single-file URL off the Hub. `/blob/` is the page a reader is looking at
  // and `/resolve/` is the download behind it; both name one file.
  const blob = rest.match(/^(.+?)\/(?:blob|resolve)\/[^/]+\/(.+)$/);
  if (blob) {
    [, repo, file] = blob;
  } else {
    // `/tree/<rev>/<dir>` is the file browser. Only the repo part is meaningful.
    rest = rest.replace(/\/tree\/.*$/, "");

    if (rest.includes("|")) {
      const parts = rest.split("|");
      if (parts.length > 2)
        return fail("Only one `|`, as in `repo|file.gguf`.");
      [repo, file] = parts;
    } else if (/\.gguf$/i.test(rest)) {
      // `owner/repo/path/to/file.gguf` — the repo is the first two segments, and
      // everything after is the path, which the Hub API reports with its
      // directories intact.
      const cut = rest.indexOf("/", rest.indexOf("/") + 1);
      if (cut === -1)
        return fail(`\`${rest}\` names a file but no owner/repo.`);
      repo = rest.slice(0, cut);
      file = rest.slice(cut + 1);
    } else {
      // `owner/repo:QUANT`. A repo name cannot contain a colon, so the last one
      // is unambiguously the separator — and by this point any URL scheme has
      // already been stripped off the front.
      const colon = rest.lastIndexOf(":");
      if (colon > 0) {
        repo = rest.slice(0, colon);
        quant = rest.slice(colon + 1);
      } else {
        repo = rest;
      }
    }
  }

  repo = (repo ?? "").trim().replace(/\/+$/, "");
  file = (file ?? "").trim() || null;
  quant = (quant ?? "").trim() || null;

  if (!REPO_RE.test(repo)) {
    return fail(`\`${repo || input}\` is not an \`owner/repo\` name.`);
  }
  if (file && !/\.gguf$/i.test(file)) {
    return fail(`\`${file}\` is not a \`.gguf\` file.`);
  }
  if (quant && !QUANT_RE.test(quant)) {
    return fail(`\`${quant}\` is not a quantization name.`);
  }

  const spec = { repo, file, quant };
  const id = idFor(spec);
  return {
    ok: true,
    ...spec,
    id,
    label: labelFor(spec),
    note: noteFor(spec),
    warning: warningFor(id),
  };
};

/**
 * The `{ repo, file, quant }` a runtime should be handed, with the keys it did
 * not learn left off rather than set to undefined — wllama branches on
 * `file != null`, so an explicit undefined works but says the wrong thing.
 */
export const ggufLoadParams = (id) => {
  const spec = parseGgufSpec(id);
  if (!spec.ok) throw new Error(`Unusable model id "${id}": ${spec.error}`);
  return {
    repo: spec.repo,
    ...(spec.file ? { file: spec.file } : {}),
    ...(spec.quant ? { quant: spec.quant } : {}),
  };
};
