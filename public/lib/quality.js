// Degenerate-output detection.
//
// A small model that loads fine and then loops — "micro-server-agnostic,
// micro-server-agnostic, micro-server-agnostic…" — is a different failure from one
// that crashes, and it is the failure that actually decides whether a model that
// FITS a device is usable on it. "Gibberish" is not a publishable observation; a
// ratio is. So this is measured, not eyeballed.
//
// This lives in lib/ rather than in the spike harness or the app because the
// number has to mean the same thing in both. The spikes and the unified demo will
// produce figures that end up side by side in the article, and two copies of a
// threshold drift. Same category as probe.js and blackbox.js: shared apparatus,
// no provider code.
//
// distinct3 is the standard diversity metric: unique word trigrams over total.
// Healthy prose sits high; a repetition loop collapses it. topPhraseRepeat counts
// the most-repeated 4-gram, which catches a loop that is otherwise wordy.
// A reply this long that yields almost no words is not prose. Prose runs about
// 5-6 characters per word, so anything past this threshold should comfortably
// clear the 12-word floor below; if it does not, the output is non-linguistic.
const NON_LINGUISTIC_CHARS = 80;

export const textQuality = (text) => {
  const words = text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
  // Below a dozen words the trigram ratios are noise, so abstain rather than
  // emitting a confident-looking number — but abstaining unconditionally was a
  // hole, and a real run fell straight through it. MEASURED 2026-08-23: on an
  // iPhone, Qwen3.5-0.8B Q2_K_XL emitted **513 characters containing 2 words**,
  // ran to the full 512-token cap, and was scored `looksDegenerate: null` —
  // "too short to judge" — when 513 characters resolving to 2 words is itself
  // the loudest possible signal. Note the word pattern already counts digit runs
  // as words, so this is not a numbers-only blind spot; whatever that output was,
  // it was not language.
  if (words.length < 12) {
    const nonLinguistic = text.length >= NON_LINGUISTIC_CHARS;
    return {
      words: words.length,
      chars: text.length,
      charsPerWord:
        words.length > 0
          ? Number((text.length / words.length).toFixed(1))
          : null,
      distinct3: null,
      // true when it is long-but-wordless, null when it is genuinely just short.
      looksDegenerate: nonLinguistic ? true : null,
      degenerateReason: nonLinguistic
        ? `${text.length} chars resolved to only ${words.length} word(s) — non-linguistic output`
        : null,
    };
  }
  const ngrams = (n) => {
    const counts = new Map();
    for (let i = 0; i + n <= words.length; i += 1) {
      const key = words.slice(i, i + n).join(" ");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  };
  const tri = ngrams(3);
  const distinct3 = Number((tri.size / (words.length - 2)).toFixed(3));
  let topPhraseRepeat = 0;
  let topPhrase = null;
  for (const [phrase, n] of ngrams(4)) {
    if (n > topPhraseRepeat) {
      topPhraseRepeat = n;
      topPhrase = phrase;
    }
  }
  return {
    words: words.length,
    chars: text.length,
    distinct3,
    topPhraseRepeat,
    // Only worth naming when it is actually repeating.
    topPhrase: topPhraseRepeat >= 3 ? topPhrase : null,
    looksDegenerate: distinct3 < 0.5 || topPhraseRepeat >= 5,
    degenerateReason: null,
  };
};

// Why a degenerate reply looks degenerate, in one line, for a log or a badge.
// Shared for the same reason as the metric: the spikes phrase this in the
// harness and the app phrases it in the session controller, and they should not
// diverge.
export const degeneracyReason = (quality) =>
  quality?.degenerateReason ??
  `distinct-trigram ratio ${quality?.distinct3}, most-repeated phrase seen ${quality?.topPhraseRepeat}x`;
