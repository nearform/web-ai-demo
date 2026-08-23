import { html } from "../util/html.js";
import { listProviders } from "../providers/index.js";

// The binding constraint on where a runtime can run, as a badge.
//
// For the four that download weights it is device capacity: the sizes involved
// rule most of them out on a phone. For the Chrome Prompt API there are no
// weights, so capacity is not the limit — availability is, and it is narrower
// than any of the other four. A badge reading "any device" there was wrong in
// both directions: no iOS browser has the API, and Chrome documents Android and
// non-Chromebook-Plus ChromeOS as unsupported too.
export const FITS_LABEL = {
  "chrome-desktop": { text: "Chrome desktop only", tone: "bad" },
  "phone-possible": { text: "desktop, maybe phone", tone: "warn" },
  desktop: { text: "desktop only", tone: "warn" },
};

// The chooser. Every field comes from descriptors.js, which imports no libraries,
// so all five render without fetching anything. The library is fetched on use.
export const RuntimePicker = ({ activeId, onSelect, disabled }) => html`
  <section className="panel panel--picker">
    <div className="panel-title">Runtime</div>
    <p className="panel-note">
      Libraries and weights are fetched on first use, not on selection.
    </p>
    <div className="picker">
      ${listProviders().map((d) => {
        const fits = FITS_LABEL[d.device.fits];
        const active = d.id === activeId;
        return html`
          <button
            key=${d.id}
            type="button"
            className=${`picker-card${active ? " picker-card--active" : ""}`}
            onClick=${() => onSelect(d.id)}
            disabled=${disabled && !active}
            aria-pressed=${active}
          >
            <span className="picker-name">${d.name}</span>
            <span className=${`picker-badge picker-badge--${fits.tone}`}>
              ${fits.text}
            </span>
            <span className="picker-tagline">${d.tagline}</span>
          </button>
        `;
      })}
    </div>
  </section>
`;
