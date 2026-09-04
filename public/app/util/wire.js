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

  // Cycles and shared structure. A `messages` array reused across turns is not
  // cyclic, but it is the kind of thing that becomes cyclic by accident, and one
  // stack overflow here would take out the whole conversation panel.
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((v) => jsonSafe(v, seen, depth + 1));
  }

  // Dates and anything else that already knows how to describe itself as data.
  if (typeof value.toJSON === "function") {
    try {
      return jsonSafe(value.toJSON(), seen, depth + 1);
    } catch {
      return "[toJSON threw]";
    }
  }

  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }

  // Typed arrays and the like: the length is the informative part, not 40,000
  // numbers.
  if (ArrayBuffer.isView(value)) {
    return `[${value.constructor?.name ?? "TypedArray"}(${value.length ?? value.byteLength})]`;
  }

  // A plain object is data; anything else is an instance whose identity is the
  // interesting fact — `[AbortSignal]` tells you the signal was wired up, which
  // is exactly what a reader of this panel wants to know.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    const name = value.constructor?.name;
    return `[${name || "object"}]`;
  }

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = jsonSafe(v, seen, depth + 1);
  }
  return out;
};

/** Pretty JSON for the panel, with the same no-throw guarantee. */
export const formatWire = (value) => {
  try {
    return JSON.stringify(jsonSafe(value), null, 2);
  } catch (err) {
    return `[could not be rendered: ${String(err)}]`;
  }
};
