import { html } from "./util/html.js";

const REPO_URL = "https://github.com/nearform/web-ai-demo";
const BANNER_URL =
  "https://www.nearform.com/contact/?utm_source=open-source&utm_medium=banner&utm_campaign=os-project-pages";

const ExtLink = ({ href, children }) =>
  html`<a href=${href} target="_blank" rel="noopener noreferrer"
    >${children}</a
  >`;

export const App = () => html`
  <div className="app-container">
    <header className="app-header">
      <h1>Web AI Demo</h1>
      <p className="intro">
        A tour of the different ways to run AI models directly in the browser,
        by${" "}
        <${ExtLink} href="https://nearform.com">Nearform<//>.${" "}
        <a
          href=${REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="intro-github-link"
          aria-label="View on GitHub"
        >
          <i className="ph ph-github-logo"></i>
        </a>
      </p>
    </header>

    <main className="content">
      <section className="card">
        <h2>Under construction</h2>
        <p>
          The unified demo isn't built yet. In the meantime the${" "}
          <a href="./spikes/index.html">reality-check spikes</a> are live: one
          bare page per runtime, no shared abstraction, answering whether each
          one loads and generates on your device right now.
        </p>
        <p>
          Everything runs locally in your browser. Nothing is collected or sent
          anywhere.
        </p>
      </section>
    </main>

    <footer className="footer">
      <${ExtLink} href=${BANNER_URL}>
        <img
          src="https://raw.githubusercontent.com/nearform/.github/refs/heads/master/assets/os-banner-green.svg"
          alt="Nearform Open Source"
          className="nearform-banner"
        />
      <//>
    </footer>
  </div>
`;
