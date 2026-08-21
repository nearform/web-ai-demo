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
        <h2>Hello world</h2>
        <p>Nothing here yet — this is the starting point for the demos.</p>
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
