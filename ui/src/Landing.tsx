import { useState } from "react";
import { ArrowRight, ArrowUpRight, Github } from "lucide-react";
import { Link } from "react-router-dom";
import SiteFooter from "./SiteFooter";
import { Code, Logo, Tabs } from "./shared";
import { managedSite, publicPath, publicSite } from "./site";
import WorldTimeline, { worldFrames } from "./WorldTimeline";
import CinematicScene, { HistorySequence } from "./CinematicScene";
import "./landing.css";

const domains = [
  {
    name: "Decision models",
    image: "t2",
    alt: "Illustrative recorded outcome of a robot placing an object",
    kind: "decision",
    title: "Jev & Laya",
    text: "Keep decisions, probabilities and model history.",
    doc: "DECISION_MODELS",
    label: "Get the examples",
    detail: "Decision → probability → outcome",
    fields: ["decision", "probability", "observed_at"],
  },
  {
    name: "World models",
    image: "world",
    alt: "Illustrative autonomous rover in a reconstructed warehouse",
    kind: "world",
    title: "A world, with a history.",
    text: "Keep states, observations and their relationships through time.",
    doc: "connectors/worldmodel",
    label: "Explore world model examples",
    detail: "Observation → state → prediction",
    fields: ["observation", "state", "timestamp"],
  },
  {
    name: "Physical AI",
    image: "pointcloud",
    alt: "Illustrative point-cloud reconstruction of a robot and its world",
    kind: "physical",
    title: "Physical AI",
    text: "Keep observations, actions and their relationships over time.",
    doc: "connectors/robotics",
    label: "Explore robotics examples",
    detail: "Observation → action → outcome",
    fields: ["sensor", "action", "episode"],
  },
  {
    name: "BCI",
    image: "bci",
    alt: "Illustrative non-invasive EEG acquisition equipment in a research laboratory",
    kind: "bci",
    title: "Signals, in context.",
    text: "Connect channel samples, acquisition time and experimental events.",
    doc: "connectors/bci",
    label: "Explore BCI examples",
    detail: "Channel → sample → event",
    fields: ["channel", "sample", "acquisition_time"],
  },
  {
    name: "Quantum",
    image: "quantum",
    alt: "Illustrative cryogenic apparatus for recording quantum experiment history",
    kind: "quantum",
    title: "Track the experiment.",
    text: "Record circuit relationships and changing calibrations.",
    doc: "connectors/quantum",
    label: "Explore quantum examples",
    detail: "Circuit → calibration → result",
    fields: ["circuit", "calibration", "valid_from"],
  },
];
const snippets: Record<string, string> = {
  Python:
    'from chronograph_connectors import Client\n\nclient = Client(url, token)\nstate = client.call("as_of", {"t": "2000000"})',
  TypeScript:
    'import { Client } from "@chronograph-community/sdk";\n\nconst client = new Client(url, token);\nconst state = await client.call("as_of", { t: "2000000" });',
  HTTP: 'curl "$CHRONOGRAPH_URL/v1/info" \\\n  -H "Authorization: Bearer $CHRONOGRAPH_TOKEN"',
  MCP: '[mcp_servers.chronograph]\nurl = "https://chronodb.co/p/PROJECT_ID/mcp"\nbearer_token_env_var = "CHRONOGRAPH_TOKEN"',
};
export default function Landing() {
  const [domain, setDomain] = useState(1);
  const [language, setLanguage] = useState("HTTP");
  const current = domains[domain];
  const doc = managedSite ? "HOSTED" : "ISOLATED";
  return (
    <div className="landing cinematic-landing">
      <div className="integration-banner">
        <span className="integration-tag">NEW INTEGRATIONS</span>
        <span>
          <strong>Jev & Laya, with a memory.</strong> Keep decisions,
          probabilities and model history.
        </span>
        <Link to="/documentation/DECISION_MODELS">
          Get the examples <ArrowRight size={14} />
        </Link>
      </div>
      <nav className="public-nav" aria-label="Main navigation">
        <Logo />
        <div>
          <a href="#product">Product</a>
          <a href="#use-cases">Use cases</a>
          <Link to={`/documentation/${doc}`}>Docs</Link>
          {managedSite ? (
            <Link to="/login" className="nav-signin">
              Sign in <ArrowUpRight size={14} />
            </Link>
          ) : (
            <Link className="nav-signin" to={publicSite ? "/app" : "/login"}>
              {publicSite ? "Open demo" : "Connect"} <ArrowUpRight size={14} />
            </Link>
          )}
        </div>
      </nav>
      <main id="main">
        <section className="hero" id="product">
          <img
            className="hero-ambient"
            fetchPriority="high"
            src={publicPath("/images/world/t1.webp")}
            alt=""
            width="1200"
            height="800"
            aria-hidden="true"
          />
          <div className="hero-copy">
            <h1>
              Build worlds
              <br />
              that remember.
            </h1>
            <p>
              A temporal graph database for models that observe, decide and act.
            </p>
            <div className="hero-actions">
              {managedSite ? (
                <Link className="button primary" to="/login?provider=github">
                  <Github size={19} />
                  Start with GitHub
                </Link>
              ) : (
                <Link className="button primary" to="/documentation/ISOLATED">
                  Start locally <ArrowRight size={16} />
                </Link>
              )}
              <a className="demo-link" href="#world-demo">
                Explore the demo <ArrowRight size={16} />
              </a>
            </div>
            {managedSite && (
              <Link className="other-signin" to="/login">
                More sign-in options
              </Link>
            )}
          </div>
          <WorldTimeline />
        </section>
        <section className="principles" aria-label="Temporal capabilities">
          {[
            ["Replay", "Query any moment."],
            ["Branch", "Explore another outcome."],
            ["Connect", "Use HTTP and MCP."],
          ].map(([title, text]) => (
            <article key={title}>
              <h2>{title}</h2>
              <p>{text}</p>
            </article>
          ))}
        </section>
        <section className="history-section landing-section" id="history">
          <div className="section-intro">
            <h2>See what changed.</h2>
            <p>Replay history. Branch an outcome. Keep the original.</p>
            <Link to="/documentation/BRANCHES" className="text-link">
              Explore temporal memory <ArrowRight size={15} />
            </Link>
          </div>
          <HistorySequence frames={worldFrames} />
        </section>
        <section className="model-section landing-section" id="use-cases">
          <h2>Memory for the models you build.</h2>
          <div
            className="model-tabs tabs"
            role="tablist"
            aria-label="Model categories"
          >
            {domains.map((item, index) => (
              <button
                key={item.name}
                role="tab"
                id={`model-tab-${index}`}
                aria-controls="model-panel"
                aria-selected={domain === index}
                tabIndex={domain === index ? 0 : -1}
                onKeyDown={(e) => {
                  if (
                    ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)
                  ) {
                    e.preventDefault();
                    const next =
                      e.key === "Home"
                        ? 0
                        : e.key === "End"
                          ? domains.length - 1
                          : (domain +
                              (e.key === "ArrowRight" ? 1 : -1) +
                              domains.length) %
                            domains.length;
                    setDomain(next);
                    document.getElementById(`model-tab-${next}`)?.focus();
                  }
                }}
                onClick={() => setDomain(index)}
              >
                {item.name}
              </button>
            ))}
          </div>
          <div
            className="model-content"
            id="model-panel"
            role="tabpanel"
            aria-labelledby={`model-tab-${domain}`}
          >
            <div>
              <h3>{current.title}</h3>
              <p>{current.text}</p>
              <Link className="text-link" to={`/documentation/${current.doc}`}>
                {current.label}
                <ArrowRight size={16} />
              </Link>
              {domain === 0 && (
                <a
                  className="model-download"
                  href={publicPath(
                    "/downloads/chronograph-decision-examples.zip",
                  )}
                  download
                >
                  Download Python & TypeScript examples
                </a>
              )}
            </div>
            <CinematicScene
              key={current.kind}
              image={current.image}
              alt={current.alt}
              kind={current.kind}
            >
              <div className="model-data">
                <span>{current.detail}</span>
                <code>{current.fields.join("  ·  ")}</code>
              </div>
            </CinematicScene>
          </div>
        </section>
        <section className="developer-section landing-section" id="platform">
          <h2>Your graph. Your workflow.</h2>
          <div className="developer-grid">
            <div className="connection-example">
              <Tabs
                label="Connection examples"
                options={Object.keys(snippets)}
                value={language}
                onChange={setLanguage}
              />
              <Code text={snippets[language]} />
              <Link
                to={
                  language === "MCP"
                    ? "/documentation/MCP"
                    : "/documentation/SDK"
                }
                className="example-doc-link"
              >
                Setup and complete example <ArrowRight size={13} />
              </Link>
            </div>
            <div className="developer-cta">
              <p>
                Start managed.
                <br />
                Or run Community yourself.
              </p>
              {managedSite ? (
                <Link className="button primary" to="/signup">
                  Create your account
                  <ArrowRight size={16} />
                </Link>
              ) : (
                <Link className="button primary" to="/documentation/ISOLATED">
                  Start locally
                  <ArrowRight size={16} />
                </Link>
              )}
              <Link className="text-link" to="/documentation/ISOLATED">
                Community docs <ArrowRight size={15} />
              </Link>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
