import { useState } from "react";
import { html } from "../util/html.js";

const STATUS_LABEL = {
  not_loaded: "not loaded",
  loading: "loading",
  loaded: "loaded",
  unavailable: "unavailable here",
  error: "error",
};

const ModelPicker = ({
  descriptor,
  models,
  modelsState,
  model,
  setModel,
  discoverModels,
  disabled,
}) => {
  // No picker: Chrome selects the variant.
  if (descriptor.modelChoice.kind === "builtin") {
    return html`
      <div className="control">
        <span className="control-label">Model</span>
        <p className="control-note">${descriptor.modelChoice.note}</p>
      </div>
    `;
  }

  // The catalog lives inside the library bundle, so reading it downloads the
  // library. An explicit step rather than a side effect of selecting the runtime.
  if (modelsState === "idle") {
    return html`
      <div className="control">
        <span className="control-label">Model</span>
        <button
          type="button"
          className="btn btn--small"
          onClick=${discoverModels}
          disabled=${disabled}
        >
          Read the catalog
        </button>
        <p className="control-note">
          The model list is inside the library, so reading it downloads the
          library.
        </p>
      </div>
    `;
  }

  if (modelsState === "loading") {
    return html`
      <div className="control">
        <span className="control-label">Model</span>
        <p className="control-note">Reading the catalog…</p>
      </div>
    `;
  }

  if (modelsState === "failed") {
    return html`
      <div className="control">
        <span className="control-label">Model</span>
        <p className="control-note control-note--bad">
          Reading the catalog failed. See the log.
        </p>
      </div>
    `;
  }

  const selected = models?.find((m) => m.id === model);
  return html`
    <label className="control">
      <span className="control-label">Model</span>
      <select
        className="control-input"
        value=${model ?? ""}
        onChange=${(e) => setModel(e.target.value)}
        disabled=${disabled}
      >
        ${(models ?? []).map(
          (m) => html`
            <option key=${m.id} value=${m.id}>
              ${m.sizeMb ? `${m.label} — ${m.sizeMb} MB` : m.label}${
                m.toolCapable ? " · tool calling" : ""
              }
            </option>
          `,
        )}
      </select>
      ${
        // Only where "which model" and "can it call a tool" are different
        // questions, which today is web-llm alone: its library accepts `tools`
        // for a fixed handful of ids and throws for the rest. An <option> takes
        // no markup, so the marker has to live in the text.
        (models ?? []).some((m) => m.toolCapable)
          ? html`<p className="control-note">
              <code>· tool calling</code> marks the models this runtime will
              accept a tool declaration for. The rest are refused.
            </p>`
          : null
      }
      ${
        selected?.note
          ? html`<p className="control-note">${selected.note}</p>`
          : null
      }
    </label>
  `;
};

// A model nobody vetted, for the runtimes that can take one. What counts as a
// valid entry differs per runtime — a Hub repo, an ONNX repo and dtype, a
// `.litertlm` URL and backend — but this component knows none of that: the
// label, the placeholder and the note all come from the descriptor, and
// addCustomModel validates under whichever grammar that runtime declared.
//
// Kept separate from the select rather than folded into it as an "other…"
// option: the list is a set of vetted picks with measured sizes, and a model
// typed in here is explicitly not that. What is applied joins the list — see
// addCustomModel — so this field is an entry point, not a second kind of
// selection.
const CustomModelInput = ({ custom, addCustomModel, disabled }) => {
  const [text, setText] = useState("");
  const [error, setError] = useState(null);

  const apply = () => {
    const spec = addCustomModel(text);
    if (spec.ok) {
      // Cleared on success because the field's job is done: the specifier is now
      // in the picker above, which is where the current selection is read from.
      setText("");
      setError(null);
    } else {
      setError(spec.error);
    }
  };

  return html`
    <label className="control">
      <span className="control-label">${custom.label}</span>
      <div className="control-row">
        <input
          type="text"
          className="control-input"
          spellcheck="false"
          autocapitalize="off"
          autocomplete="off"
          placeholder=${custom.placeholder}
          value=${text}
          onChange=${(e) => {
            setText(e.target.value);
            setError(null);
          }}
          onKeyDown=${(e) => {
            // Enter submits. There is no form here, so nothing else would.
            if (e.key === "Enter") {
              e.preventDefault();
              apply();
            }
          }}
          disabled=${disabled}
        />
        <button
          type="button"
          className="btn btn--small"
          onClick=${apply}
          disabled=${disabled || !text.trim()}
        >
          Use
        </button>
      </div>
      ${
        error
          ? html`<p className="control-note control-note--bad">${error}</p>`
          : null
      }
      <p className="control-note">${custom.note}</p>
    </label>
  `;
};

const ContextControl = ({
  descriptor,
  context,
  setContext,
  discoveredContext,
  disabled,
}) => {
  const c = descriptor.context;

  // No control, and nothing reads the value back. Stated explicitly, since an
  // empty input would read as a defect.
  if (c.control === "none") {
    return html`
      <div className="control">
        <span className="control-label">Context</span>
        <p className="control-note">${c.note}</p>
      </div>
    `;
  }

  // Readable but not writable, and only once a session exists.
  if (c.control === "readonly") {
    return html`
      <div className="control">
        <span className="control-label">Context</span>
        <p className="control-value control-value--prose">
          ${
            discoveredContext
              ? `${discoveredContext.toLocaleString()} tokens, from ${c.field}`
              : `Not known until loaded — ${c.field} needs a live session`
          }
        </p>
        <p className="control-note">${c.note}</p>
      </div>
    `;
  }

  // Settable at load, so it is disabled rather than hidden once loaded: the value
  // in force is worth seeing alongside the numbers it produced.
  const clamped = discoveredContext && context && discoveredContext !== context;
  return html`
    <label className="control">
      <span className="control-label"> Context <code>${c.field}</code> </span>
      <div className="control-row">
        <input
          type="range"
          className="control-range"
          min=${c.min}
          max=${c.max}
          step=${c.step}
          value=${context ?? c.default ?? c.min}
          onChange=${(e) => setContext(Number(e.target.value))}
          disabled=${disabled}
        />
        <span className="control-value">
          ${context ? context.toLocaleString() : "model default"}
        </span>
      </div>
      ${
        context && descriptor.id === "web-llm"
          ? html`
              <button
                type="button"
                className="btn btn--small"
                onClick=${() => setContext(null)}
                disabled=${disabled}
              >
                Clear override
              </button>
            `
          : null
      }
      ${
        clamped
          ? html`
              <p className="control-note control-note--bad">
                Asked for ${context?.toLocaleString()}, runtime reported
                ${discoveredContext.toLocaleString()} — it was clamped.
              </p>
            `
          : null
      }
      <p className="control-note">${c.note}</p>
    </label>
  `;
};

const ReplyCapControl = ({ descriptor, replyCap, setReplyCap, disabled }) => {
  const r = descriptor.replyCap;
  if (r.control === "none") {
    return html`
      <div className="control">
        <span className="control-label">Reply cap</span>
        <p className="control-note">${r.note}</p>
      </div>
    `;
  }
  return html`
    <label className="control">
      <span className="control-label">
        Reply cap <code>${r.field}</code>
        ${
          r.control === "load"
            ? html`<span className="control-flag">set at load</span>`
            : null
        }
      </span>
      <div className="control-row">
        <input
          type="range"
          className="control-range"
          min="64"
          max="2048"
          step="64"
          value=${replyCap}
          onChange=${(e) => setReplyCap(Number(e.target.value))}
          disabled=${disabled}
        />
        <span className="control-value">${replyCap} tokens</span>
      </div>
      <p className="control-note">${r.note}</p>
    </label>
  `;
};

export const RuntimePanel = ({ rt }) => {
  const { descriptor, status } = rt;
  // Fields fixed at load must not stay editable, or the UI implies a change the
  // runtime will not apply. Which fields those are differs per runtime.
  const busy = status === "loading";
  const loaded = status === "loaded";
  const lockedAtLoad = busy || loaded;
  const systemLocked =
    descriptor.systemPrompt.appliedAt === "load" && lockedAtLoad;

  return html`
    <section className="panel panel--runtime">
      <div className="panel-head">
        <div className="panel-title">${descriptor.name}</div>
        <a
          className="panel-docs"
          href=${descriptor.docs}
          target="_blank"
          rel="noopener noreferrer"
          >docs ↗</a
        >
      </div>
      <p className="panel-note">${descriptor.summary}</p>

      <div className=${`status status--${status}`}>
        <span className="status-dot"></span>
        <span className="status-text">
          ${STATUS_LABEL[status] ?? status}
          ${rt.statusDetail ? html` — ${rt.statusDetail}` : null}
        </span>
      </div>

      ${
        rt.progress
          ? html`
              <div className="progress">
                <div className="progress-track">
                  <div
                    className="progress-bar"
                    style=${{
                      width: `${Math.round(rt.progress.fraction * 100)}%`,
                    }}
                  ></div>
                </div>
                <span className="progress-text">${rt.progress.text}</span>
              </div>
            `
          : null
      }

      <${ModelPicker}
        descriptor=${descriptor}
        models=${rt.models}
        modelsState=${rt.modelsState}
        model=${rt.model}
        setModel=${rt.setModel}
        discoverModels=${rt.discoverModels}
        disabled=${lockedAtLoad}
      />

      ${
        descriptor.customModel
          ? html`<${CustomModelInput}
              custom=${descriptor.customModel}
              addCustomModel=${rt.addCustomModel}
              disabled=${lockedAtLoad}
            />`
          : null
      }

      <${ContextControl}
        descriptor=${descriptor}
        context=${rt.context}
        setContext=${rt.setContext}
        discoveredContext=${rt.discoveredContext}
        disabled=${lockedAtLoad}
      />

      <${ReplyCapControl}
        descriptor=${descriptor}
        replyCap=${rt.replyCap}
        setReplyCap=${rt.setReplyCap}
        disabled=${descriptor.replyCap.control === "load" && lockedAtLoad}
      />

      <label className="control">
        <span className="control-label">
          System instructions
          ${
            descriptor.systemPrompt.appliedAt === "load"
              ? html`<span className="control-flag">set at load</span>`
              : html`<span className="control-flag control-flag--ok"
                  >sent each turn</span
                >`
          }
        </span>
        <textarea
          className="control-input control-input--area"
          rows="3"
          value=${rt.system}
          onChange=${(e) => rt.setSystem(e.target.value)}
          disabled=${systemLocked}
        ></textarea>
        <p className="control-note">${descriptor.systemPrompt.note}</p>
      </label>

      <div className="btn-row">
        <button
          type="button"
          className="btn btn--primary"
          onClick=${() => rt.load()}
          disabled=${busy || loaded}
        >
          ${busy ? "Loading…" : "Load"}
        </button>
        <button
          type="button"
          className="btn"
          onClick=${() => rt.unload()}
          disabled=${!loaded}
        >
          Unload
        </button>
      </div>
      ${
        loaded
          ? html`
              <p className="control-note">
                <strong>Unload frees:</strong>
                ${descriptor.unload.frees.join(", ")}.
                <strong>Keeps:</strong> ${descriptor.unload.keeps.join(", ")}.
              </p>
            `
          : null
      }
    </section>
  `;
};
