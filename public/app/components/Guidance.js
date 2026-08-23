import { html } from "../util/html.js";
import { listProviders } from "../providers/index.js";
import { FITS_LABEL } from "./RuntimePicker.js";

// The comparison, rendered two ways: a list for the selected runtime and a table
// for all five. Both read from descriptors.js, so neither can drift from what the
// adapters do.

const YES = "yes";
const NO = "no";

const AXES = [
  {
    key: "history",
    label: "History",
    value: (d) => (d.history.owner === "runtime" ? "runtime" : "caller"),
    tone: (d) => (d.history.owner === "runtime" ? "good" : "neutral"),
    note: (d) => d.history.note,
  },
  {
    key: "system",
    label: "System prompt",
    value: (d) =>
      d.systemPrompt.appliedAt === "load" ? "fixed at load" : "each turn",
    tone: (d) => (d.systemPrompt.appliedAt === "load" ? "warn" : "good"),
    note: (d) => d.systemPrompt.note,
  },
  {
    key: "models",
    label: "Model choice",
    value: (d) =>
      ({
        static: "fixed list",
        discovered: "from the library",
        builtin: "none",
      })[d.modelChoice.kind],
    tone: (d) => (d.modelChoice.kind === "builtin" ? "warn" : "neutral"),
    note: (d) => d.modelChoice.note,
  },
  {
    key: "context",
    label: "Context control",
    value: (d) =>
      ({
        load: "settable at load",
        readonly: "read-only",
        none: "not exposed",
      })[d.context.control],
    tone: (d) =>
      d.context.control === "load"
        ? "good"
        : d.context.control === "none"
          ? "bad"
          : "warn",
    note: (d) => d.context.note,
  },
  {
    key: "reply",
    label: "Reply cap",
    value: (d) =>
      ({
        turn: "per turn",
        load: "at load",
        none: "not exposed",
      })[d.replyCap.control],
    tone: (d) =>
      d.replyCap.control === "turn"
        ? "good"
        : d.replyCap.control === "none"
          ? "bad"
          : "warn",
    note: (d) => d.replyCap.note,
  },
  {
    key: "json",
    label: "Enforced JSON",
    value: (d) => (d.json.supported ? YES : NO),
    tone: (d) => (d.json.supported ? "good" : "bad"),
    note: (d) => d.json.note,
  },
  {
    key: "rates",
    label: "Reports token rates",
    value: (d) => (d.rates.selfReported ? YES : NO),
    tone: (d) => (d.rates.selfReported ? "good" : "bad"),
    note: (d) => d.rates.note,
  },
  {
    key: "progress",
    label: "Load progress",
    value: (d) =>
      ({
        native: "built in",
        handrolled: "implemented here",
        none: "none",
      })[d.progress.kind],
    tone: (d) => (d.progress.kind === "native" ? "good" : "warn"),
    note: (d) => d.progress.note,
  },
  {
    key: "browsers",
    label: "Browser support",
    value: (d) => d.browsers.label,
    tone: (d) => d.browsers.tone,
    note: (d) => d.browsers.note,
  },
  {
    key: "cancel",
    label: "Cancellation",
    value: (d) => (d.cancel.kind === "abortsignal" ? "AbortSignal" : "library"),
    tone: (d) => (d.cancel.kind === "abortsignal" ? "good" : "warn"),
    note: (d) => d.cancel.note,
  },
];

const ComparisonTable = ({ activeId }) => {
  const providers = listProviders();
  return html`
    <div className="table-scroll">
      <table className="compare">
        <thead>
          <tr>
            <th scope="col">&nbsp;</th>
            ${providers.map(
              (d) => html`
                <th
                  key=${d.id}
                  scope="col"
                  className=${d.id === activeId ? "compare-active" : ""}
                >
                  ${d.name}
                </th>
              `,
            )}
          </tr>
        </thead>
        <tbody>
          ${AXES.map(
            (axis) => html`
              <tr key=${axis.key}>
                <th scope="row">${axis.label}</th>
                ${providers.map(
                  (d) => html`
                    <td
                      key=${d.id}
                      className=${`cell cell--${axis.tone(d)}${
                        d.id === activeId ? " compare-active" : ""
                      }`}
                    >
                      ${axis.value(d)}
                    </td>
                  `,
                )}
              </tr>
            `,
          )}
        </tbody>
      </table>
    </div>
  `;
};

export const Guidance = ({ descriptor }) => html`
  <section className="panel panel--guidance">
    <details className="detail-block">
      <summary>What ${descriptor.name} will and won't do</summary>
      <p className="panel-note">
        What this runtime's API provides. Follow the docs link for detail.
      </p>
      <dl className="axes">
        ${AXES.map(
          (axis) => html`
            <div className="axis" key=${axis.key}>
              <dt>
                ${axis.label}
                <span
                  className=${`axis-value axis-value--${axis.tone(descriptor)}`}
                >
                  ${axis.value(descriptor)}
                </span>
              </dt>
              <dd>${axis.note(descriptor)}</dd>
            </div>
          `,
        )}
        <div className="axis">
          <dt>
            Device
            <span
              className=${`axis-value axis-value--${
                descriptor.device.tone ??
                FITS_LABEL[descriptor.device.fits].tone
              }`}
            >
              ${
                descriptor.device.label ??
                FITS_LABEL[descriptor.device.fits].text
              }</span
            >
          </dt>
          <dd>${descriptor.device.note}</dd>
        </div>
        <div className="axis">
          <dt>Unload</dt>
          <dd>
            <strong>Frees:</strong> ${descriptor.unload.frees.join(", ")}.${" "}
            <strong>Keeps:</strong> ${descriptor.unload.keeps.join(", ")}.${" "}
            ${descriptor.unload.caveat}
          </dd>
        </div>
      </dl>
    </details>

    <details className="compare-details">
      <summary>All five, side by side</summary>
      <${ComparisonTable} activeId=${descriptor.id} />
    </details>
  </section>
`;
