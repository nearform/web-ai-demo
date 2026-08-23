/* global setTimeout:false, clearTimeout:false */

// crashbox wiring, shared by the spikes and the unified demo.
//
// This project exists to find out how five runtimes fail, and the most interesting
// failure — an iOS Safari tab dying mid-load — is the one that destroys its own
// evidence. No JavaScript runs at the moment of a hard kill, so the log panel,
// the console and the diagnostics JSON all go with the tab. crashbox is Ryan's
// own library for exactly this: it persists a small black box (breadcrumb ring +
// state snapshot + heartbeat) to localStorage synchronously, writes a
// clean-shutdown marker on a graceful exit, and on the NEXT load tells you
// whether the previous session died and what it was doing.
//
// This lives in lib/ and is called from the spike harness and from the app's
// session controller, so every page in the project is instrumented by one
// integration. That is not a violation of the "spikes share no code" rule — that
// rule is about runtime/provider code, so that a failure belongs to the runtime
// under test. Crash instrumentation is the same category as the log panel and the
// device probe: shared apparatus.
//
// Three decisions here came out of reading crashbox's source rather than its
// README, and each of them would be a silent bug otherwise.

import {
  init,
  breadcrumb as cbBreadcrumb,
  setSnapshot,
  attachGPUDevice,
  getStatus,
  clearRecovered,
} from "crashbox";

// DECISION 1: namespace per runtime per surface, and it is not optional.
//
// crashbox is single-tab by design. There is exactly one `current` pointer per
// namespace, and localStorage is shared across the whole origin — so a second
// tab's init() repoints `current` at its own session and consumes whatever the
// first tab left there. With five spike pages plus the unified demo on one origin
// that is the normal case, not an edge case: open wllama, then open
// transformers-js, and wllama's crash record is orphaned before it can be
// recovered.
//
// `scope` separates the surfaces as well as the runtimes. The demo selecting
// wllama and the wllama spike are different pages that can each die, and a shared
// namespace would let one consume the other's record — so they get `app-wllama`
// and `spike-wllama`. Both halves matter: an app crash misattributed to a spike
// is worse than no record, because the spike is the page whose whole purpose is
// to be the clean comparison.
const namespaceFor = (name, scope) =>
  `${scope}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

// DECISION 2: snapshots are throttled, because setSnapshot() is a synchronous
// localStorage write.
//
// Every call JSON-serializes the state, re-parses it to detach it, and persists.
// Calling that per streamed chunk would mean a synchronous disk write per token —
// instrumentation causing the crash it is trying to catch, which crashbox's own
// README warns about. So callers mutate a small state object as often as they
// like and it is flushed at most this often, plus once at every phase change.
const SNAPSHOT_INTERVAL_MS = 500;

let state = {};
let flushTimer = null;
let started = false;

const writeNow = () => {
  flushTimer = null;
  if (!started) return;
  setSnapshot(state);
};

/**
 * Merge into the persisted snapshot. Coalesced — safe to call per chunk.
 */
export const track = (patch) => {
  state = { ...state, ...patch };
  if (!started || flushTimer !== null) return;
  flushTimer = setTimeout(writeNow, SNAPSHOT_INTERVAL_MS);
};

/**
 * Merge and persist immediately. For phase changes, where the pending 500 ms is
 * exactly the window in which the tab dies.
 */
export const trackNow = (patch) => {
  state = { ...state, ...patch };
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  writeNow();
};

/** Drop a breadcrumb. Cheap, persisted synchronously. */
export const crumb = (msg, data) => {
  if (!started) return;
  cbBreadcrumb(msg, data);
};

/**
 * Acknowledge the recovered record.
 *
 * This does NOT clear storage, and it is not what stops a crash being re-reported.
 * crashbox's own `recoverPrevious()` removes the persisted record on the load that
 * delivers it ("fire-once delivery"), so re-reporting cannot happen; verified over
 * three consecutive loads after an induced crash. `clearRecovered()` nulls the
 * in-memory `lastRecovered` that the `window.__crashbox` debug handle reports, so
 * calling it just keeps that handle honest once we have surfaced the record.
 *
 * Consequence for a device pass, and it comes from fire-once delivery rather than
 * from this call: a reload loses the banner. The record stays in this session's log
 * and in the copied diagnostics, so the rule is **hit Copy diagnostics before
 * anything else.**
 */
export const dismissRecovered = () => {
  if (!started) return;
  try {
    clearRecovered();
  } catch {
    // Nothing to clear, or storage is gone. Either way there is no record now.
  }
};

/** In-session warnings crashbox has collected (memory pressure, device loss). */
export const warnings = () => {
  if (!started) return [];
  try {
    return getStatus()?.warnings ?? [];
  } catch {
    return [];
  }
};

// DECISION 3: patch requestDevice, because the webgpu detector cannot see the
// device otherwise.
//
// crashbox's wasm detector patches `WebAssembly.Memory.prototype.grow` at the
// prototype, so it tracks committed linear memory across every runtime for free —
// which is most of what we want, since four of the five are WASM. But its webgpu
// detector is **per-instance**: `device.lost`, `uncapturederror` and the
// oversized-buffer early warning are all wired by attachGPUDevice(device), and
// the harness never holds a device. Each runtime calls requestDevice() privately
// and keeps the result to itself (LiteRT-LM hands it to the WASM module as
// `preinitializedWebGPUDevice`, wllama and web-llm keep theirs internal).
//
// So intercept the one call they all have to make. This forwards unconditionally
// and only observes, so a runtime cannot be broken by it — and it is what makes a
// GPU-process death on the iPhone attributable rather than just "the tab went
// away". Worth knowing this is our instrumentation and not crashbox's, if any of
// it ends up in the article.
const interceptDevices = (log) => {
  const proto = globalThis.GPUAdapter?.prototype;
  if (!proto || typeof proto.requestDevice !== "function") return false;
  if (proto.requestDevice.__crashboxPatched) return true;

  const original = proto.requestDevice;
  const patched = async function requestDevice(...args) {
    const device = await original.apply(this, args);
    try {
      if (device) {
        attachGPUDevice(device);
        crumb("webgpu device acquired", {
          maxBufferSize: device.limits?.maxBufferSize ?? null,
        });
      }
    } catch (err) {
      // Never let instrumentation break a runtime's own device acquisition.
      log?.warn?.("attachGPUDevice failed", { message: String(err) });
    }
    return device;
  };
  patched.__crashboxPatched = true;
  proto.requestDevice = patched;
  return true;
};

// DECISION 4: suppress the back/forward-cache false positive.
//
// MEASURED, after a clean-exit test came back "FALSE POSITIVE" twice. Closing the
// tab is handled correctly — `pagehide` fires with `persisted: false`, crashbox
// writes `cleanShutdown: true`, and the next load is quiet. But a same-tab
// NAVIGATION fires `pagehide` with `persisted: true`, because the page goes into
// the back/forward cache. crashbox deliberately does not treat that as a clean
// exit (src/index.js: "`persisted:true` means bfcache (may return) → not a clean
// shutdown"), which is the right call — a restored page's session really does
// continue. The gap is what happens when it is never restored: the record is left
// with `cleanShutdown: false`, and the next fresh load infers a crash.
//
// That matters here specifically because navigating between the five spike pages
// is the normal device-pass workflow. A banner that fires every time Ryan moves
// from wllama to transformers-js is a banner he learns to ignore, which costs us
// the one signal the iPhone test exists to produce.
//
// So: remember the session id when we enter the bfcache, forget it if we come back
// out, and on the next load suppress a "crash" whose session id is the one we
// parked. A genuine kill of an already-frozen tab is suppressed too, which is an
// accepted trade — the crashes this article is about happen during inference, with
// the page visible, and that path is untouched.
const bfcacheKey = (ns) => `bfcache:${ns}`;

const readParkedSession = (ns) => {
  try {
    const v = globalThis.localStorage?.getItem(bfcacheKey(ns));
    globalThis.localStorage?.removeItem(bfcacheKey(ns));
    return v || null;
  } catch {
    return null;
  }
};

const watchBfcache = (ns) => {
  const win = globalThis;
  if (!win.addEventListener) return;
  win.addEventListener("pagehide", (e) => {
    if (!e.persisted) return; // persisted:false is crashbox's own clean-exit path
    try {
      const id = getStatus()?.sessionId;
      if (id) win.localStorage?.setItem(bfcacheKey(ns), id);
    } catch {
      // No storage, no suppression. Preferable to throwing on the way out.
    }
  });
  win.addEventListener("pageshow", (e) => {
    // Restored from the bfcache: the session continues, so there is nothing to
    // suppress and the parked id must go, or a later real crash gets swallowed.
    if (!e.persisted) return;
    try {
      win.localStorage?.removeItem(bfcacheKey(ns));
    } catch {
      // Nothing to remove.
    }
  });
};

/**
 * Start the black box. Call before anything that can kill the tab.
 *
 * Returns the previous session's crash record if there was one, or null. The
 * record arrives synchronously during init, which is why this is called at the
 * top of runSpike rather than after the page is built.
 */
export const startBlackbox = ({
  name,
  scope = "spike",
  log,
  onMemoryPressure,
}) => {
  const ns = namespaceFor(name, scope);
  // Read (and consume) the parked id BEFORE init, because init does its inference
  // synchronously and calls onCrashRecovered during the call below.
  const parkedSession = readParkedSession(ns);
  let recovered = null;
  try {
    init({
      namespace: ns,
      // `js` is on by default; the other three are what make this useful here.
      // `memory` reads performance.memory and is a no-op off Chromium, so it
      // gives us desktop detail and costs nothing on the iPhone.
      detectors: ["js", "webgpu", "wasm", "memory"],
      // Deliberately NOT setting memoryBudgetBytes. crashbox scales its growth
      // thresholds to a budget and falls back to raw growth tracking when there
      // is none — which is what happens on iOS Safari, where no memory API
      // exists. The only number we have there is the adapter's maxBufferSize,
      // and that is a single-buffer cap, not a memory budget. Feeding it in
      // would be inventing the figure this whole article is trying to measure
      // honestly, so we let crashbox track growth instead.
      onCrashRecovered(record) {
        recovered = record;
      },
      onMemoryPressure,
    });
    started = true;
  } catch (err) {
    // A blocked localStorage (private browsing, storage disabled) must not stop
    // the spike from running — it just means no black box this session.
    log?.warn?.("crashbox init failed; no crash recording this session", {
      message: String(err),
    });
    return { recovered: null, gpuIntercepted: false };
  }

  watchBfcache(ns);
  const gpuIntercepted = interceptDevices(log);

  // The suppression. Reported rather than silent: a swallowed crash report should
  // still leave a trace of having been swallowed.
  if (recovered && parkedSession && recovered.sessionId === parkedSession) {
    log?.info?.(
      "Previous session went into the back/forward cache rather than crashing; suppressing the crash report",
      { sessionId: recovered.sessionId, reason: recovered.reason },
    );
    dismissRecovered();
    return { recovered: null, gpuIntercepted, suppressedBfcache: true };
  }

  return { recovered, gpuIntercepted, suppressedBfcache: false };
};
