// Making an adapter's request payload renderable, without lying about it.
//
// The payloads are the real objects handed to the libraries, so they contain
// things JSON does not: wllama puts a live `AbortSignal` in its request, several
// carry class instances, and a `messages` array is shared structure that could in
// principle be cyclic. `JSON.stringify` on those either throws (cycles) or
// silently drops them (functions, undefined) — and a viewer that silently drops
// half a payload is worse than no viewer, because it reads as "we sent nothing".
//
// So anything that cannot survive as data is replaced by a visible marker naming
// what was there. Nothing is truncated: the whole point of the panel is that the
// system prompt and the resent history are shown at full length.
//
// This never throws. A diagnostic that fails to render takes the page with it.

const MAX_DEPTH = 12;

export const jsonSafe = (value, seen = new WeakSet(), depth = 0) => {
  if (value === null || value === undefined) return null;

  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return value;
  if (t === "bigint") return `${value}n`;
  if (t === "function") return `[function ${value.name || "anonymous"}]`;
  if (t === "symbol") return String(value);

  if (depth >= MAX_DEPTH) return "[too deep]";

  // Cycles only — meaning an object that contains ITSELF, somewhere up its own
  // parent chain. `seen` therefore holds the current path and is unwound on the
  // way back out, not a running set of everything ever visited.
  //
  // The distinction is not academic. A tool-calling turn reports one request per
  // round trip, and rounds 1 and 2 hold the same message objects: with a global
  // set, every message round 1 already showed rendered as "[circular]" in round
  // 2, which is precisely the history a reader opened the panel to read. Shared
  // structure is not a cycle, and the panel has to show it twice.
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  const done = (out) => {
    seen.delete(value);
    return out;
  };

  if (Array.isArray(value)) {
    return done(value.map((v) => jsonSafe(v, seen, depth + 1)));
  }

  // Dates and anything else that already knows how to describe itself as data.
  if (typeof value.toJSON === "function") {
    try {
      return done(jsonSafe(value.toJSON(), seen, depth + 1));
    } catch {
      return done("[toJSON threw]");
    }
  }

  if (value instanceof Error) {
    return done({ name: value.name, message: value.message });
  }

  // Typed arrays and the like: the length is the informative part, not 40,000
  // numbers.
  if (ArrayBuffer.isView(value)) {
    return done(
      `[${value.constructor?.name ?? "TypedArray"}(${value.length ?? value.byteLength})]`,
    );
  }

  // A plain object is data; anything else is an instance whose identity is the
  // interesting fact — `[AbortSignal]` tells you the signal was wired up, which
  // is exactly what a reader of this panel wants to know.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    const name = value.constructor?.name;
    return done(`[${name || "object"}]`);
  }

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = jsonSafe(v, seen, depth + 1);
  }
  return done(out);
};

/** Pretty JSON for the panel, with the same no-throw guarantee. */
export const formatWire = (value) => {
  try {
    return JSON.stringify(jsonSafe(value), null, 2);
  } catch (err) {
    return `[could not be rendered: ${String(err)}]`;
  }
};
