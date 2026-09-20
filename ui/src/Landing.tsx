import { managedSite, publicPath, publicSite } from "./site";
import {
  ArrowRight,
  ArrowUpRight,
  GitBranch,
  Check,
  Clock3,
  Terminal,
  ShieldCheck,
  Bot,
  Activity,
  Boxes,
  Atom,
} from "lucide-react";
import { Link } from "react-router-dom";
import { Code, Logo } from "./shared";
const domains = [
  {
    id: "worldmodel",
    icon: Boxes,
    name: "World models",
    text: "Save complete environment state. Replay a moment, branch a policy, and carry the selected future forward.",
    tag: "State + RNG · Minari",
  },
  {
    id: "robotics",
    icon: Bot,
    name: "Robotics & physical AI",
    text: "Connect joint observations, actions and video references through time. Turn recordings into replayable training data.",
    tag: "rosbag2 · MCAP · LeRobot",
  },
  {
    id: "bci",
    icon: Activity,
    name: "BCI & neural signals",
    text: "Keep acquisition time with each channel sample. Ingest simulated or LSL streams and export precise epochs.",
    tag: "Optional LSL · Arrow epochs",
  },
  {
    id: "quantum",
    icon: Atom,
    name: "Quantum experiments",
    text: "Model static circuit dependencies and changing coupling calibrations with explicit validity windows.",
    tag: "OpenQASM subset · Exploratory",
  },
];
function FuturesIllustration() {
  return (
    <div className="futures-illustration">
      <div className="section-head">
        <span className="mono">ONE SNAPSHOT / THREE POSSIBILITIES</span>
        <span className="scope-badge">Illustration</span>
      </div>
      <svg
        viewBox="0 0 800 340"
        role="img"
        aria-label="Illustration of three independent futures branching from one snapshot"
      >
        <path className="future-main" d="M 40 180 H 740" />
        <path
          className="future-option"
          d="M 290 180 C 380 180 405 80 580 80 H 740"
        />
        <path
          className="future-selected"
          d="M 290 180 C 400 180 430 150 580 150 H 740"
        />
        <path
          className="future-option"
          d="M 290 180 C 390 180 425 270 580 270 H 740"
        />
        {[70, 160, 250].map((x) => (
          <circle key={x} cx={x} cy="180" r="5" className="future-dot" />
        ))}
        <circle cx="290" cy="180" r="10" className="future-root" />
        {[440, 545, 650, 740].map((x, i) => (
          <circle
            key={x}
            cx={x}
            cy={i === 0 ? 164 : 150}
            r="6"
            className="future-dot-selected"
          />
        ))}
        <text x="42" y="213">
          Recorded past
        </text>
        <text x="240" y="320">
          Fork point
        </text>
        <path d="M 290 202 V 293" className="future-guide" />
        <text x="590" y="57">
          Candidate A
        </text>
        <text x="585" y="127" className="selected-label">
          Selected future
        </text>
        <text x="590" y="298">
          Candidate C
        </text>
      </svg>
      <div className="future-caption">
        <GitBranch size={18} />
        <span>Keep the history. Change the next action.</span>
      </div>
    </div>
  );
}
export default function Landing() {
  return (
    <div className="landing">
      <aside className="release-banner" aria-label="New Jev integration">
        <span className="release-label">NEW INTEGRATION</span>
        <span>
          <strong>TypeSafe Jev, with a memory.</strong> Keep decisions,
          probabilities and model history.
        </span>
        <Link to="/documentation/JEV">
          Get the examples <ArrowRight size={15} />
        </Link>
      </aside>
      <nav className="public-nav">
        <Logo />
        <div className="nav-links">
          <a href="#product">Product</a>
          <a href={managedSite ? "#connectors" : "#community"}>
            {managedSite ? "Use cases" : "Community"}
          </a>
          <a href="#managed">{managedSite ? "Platform" : "Managed"}</a>
          <Link
            to={
              managedSite
                ? "/documentation/HOSTED"
                : "/documentation/QUICKSTART"
            }
          >
            Docs
          </Link>
        </div>
        {managedSite ? (
          <Link className="button primary" to="/login">
            Sign in <ArrowUpRight size={16} />
          </Link>
        ) : (
          <a className="button primary" href="#quickstart">
            Start locally <ArrowUpRight size={16} />
          </a>
        )}
      </nav>
      <main id="main">
        <section className="hero" id="product">
          <div className="hero-copy">
            <p className="eyebrow">
              {managedSite
                ? "Managed temporal graph database"
                : "Temporal graph database · Rust · Community 0.4 alpha"}
            </p>
            <h1>
              Build worlds
              <br />
              that remember.
            </h1>
            <p>
              {managedSite
                ? "The memory layer for models that observe, decide and act. Store observations, relationships and decisions over time. Query any moment, explore another future, and connect your agents."
                : "An embedded temporal graph database in Rust. Replay relationships, explore alternate futures, and keep your data local."}
            </p>
            <div className="hero-actions">
              {managedSite ? (
                <Link className="button primary" to="/login?provider=github">
                  Start with GitHub <ArrowRight size={18} />
                </Link>
              ) : (
                <a className="button primary" href="#quickstart">
                  Start locally <ArrowRight size={18} />
                </a>
              )}
              <Link
                className="button outline"
                to={managedSite ? "/documentation/JEV" : "/app"}
              >
                {managedSite
                  ? "See a working example"
                  : publicSite
                    ? "Explore the demo"
                    : "Explore the console"}
              </Link>
            </div>
            <div className="hero-proof">
              <span>
                <Check size={14} />
                {managedSite
                  ? "GitHub & email sign-in"
                  : "PolyForm Perimeter 1.0.0"}
              </span>
              <span>
                <Check size={14} />
                {managedSite
                  ? "Private projects · HTTP & MCP"
                  : "Embedded & self-hosted"}
              </span>
            </div>
          </div>
          <div className="hero-visual">
            <img
              src={publicPath("/images/temporal-terrain.png")}
              width="1536"
              height="1024"
              alt="A forest terrain preserved across glass time slices, with connected brass nodes"
              fetchPriority="high"
            />
            <span className="hero-image-caption">
              Relationships, seen through time.
            </span>
          </div>
        </section>
        <section className="principles" aria-label="Core capabilities">
          {[
            [
              "Replay",
              "Reconstruct relationships as they were. Query a moment or an interval.",
            ],
            [
              "Branch",
              "Explore another future. Inspect the changes, then merge or discard.",
            ],
            [
              "Connect",
              "Bring observations, environments and agents into a shared temporal model.",
            ],
          ].map(([title, text]) => (
            <article key={title}>
              <div>
                <h2>{title}</h2>
                <p>{text}</p>
              </div>
            </article>
          ))}
        </section>
        <section className="landing-section branching-section">
          <div className="section-intro">
            <p className="eyebrow">Built for what happens next</p>
            <h2>
              One world.
              <br />
              Many possible futures.
            </h2>
            <p>
              Your world changes. Its history should stay useful. Freeze a
              moment, try another policy, and inspect the result before it joins
              the parent graph.
            </p>
          </div>
          <div className="branching-showcase">
            <FuturesIllustration />
            <div className="landing-code">
              <span className="code-label">
                <Terminal size={15} />
                {managedSite ? "FROM YOUR APPLICATION" : "THE RUST API"}
              </span>
              <Code
                text={
                  managedSite
                    ? 'const response = await fetch(\n  `${process.env.CHRONOGRAPH_URL}/v1/as_of`,\n  {\n    method: "POST",\n    headers: {\n      "Content-Type": "application/json",\n      Authorization: `Bearer ${process.env.CHRONOGRAPH_TOKEN}`\n    },\n    body: JSON.stringify({ t: "1700000000000000" })\n  }\n);\nconst history = await response.json();'
                    : "let fork = graph.fork(2_000_000)?;\n\ngraph.add_edges_to_fork(fork, &observations)?;\nlet future = graph.fork_view(fork, 3_000_000)?;\nlet snapshot = future.export_arrow()?;\n\nlet changes = graph.preview_merge(fork)?;\nlet committed = graph.merge(fork)?;\ngraph.sync()?;"
                }
              />
              <Link className="text-link" to="/documentation/BRANCHES">
                Explore durable branches <ArrowUpRight size={16} />
              </Link>
            </div>
          </div>
          <div className="feature-notes">
            <p>
              <Clock3 size={18} />
              <span>
                <strong>Time is part of every relationship.</strong> Half-open
                intervals, microsecond precision and late-arriving observations.
              </span>
            </p>
            <p>
              <ShieldCheck size={18} />
              <span>
                <strong>Changes have a durable record.</strong> Checked journal
                frames, explicit synchronization and source-preserving
                migration.
              </span>
            </p>
          </div>
        </section>
        <section className="landing-section domains-section" id="connectors">
          <div className="section-intro">
            <p className="eyebrow">Bring your own world</p>
            <h2>
              From signals
              <br />
              to systems that act.
            </h2>
            <p>
              Explicit mappings keep source timestamps and meaning close to the
              data. Start with a working example, then bring your own state
              codec or recording.
            </p>
          </div>
          <div className="domain-list">
            {managedSite && (
              <Link to="/documentation/JEV" className="domain-row">
                <div className="domain-art worldmodel">
                  <GitBranch size={54} strokeWidth={1.2} />
                </div>
                <div>
                  <span className="eyebrow">
                    TypeSafe Jev · Python & TypeScript
                  </span>
                  <h3>Decision models</h3>
                  <p>
                    Keep every decision with its probabilities, input
                    fingerprint and model version. Inspect how answers change
                    over time.
                  </p>
                </div>
                <ArrowUpRight size={23} />
              </Link>
            )}
            {domains.map((d) => (
              <Link
                key={d.id}
                to={`/documentation/connectors/${d.id}`}
                className="domain-row"
              >
                <div className={`domain-art ${d.id}`}>
                  <d.icon size={54} strokeWidth={1.2} />
                </div>
                <div>
                  <span className="eyebrow">{d.tag}</span>
                  <h3>{d.name}</h3>
                  <p>{d.text}</p>
                </div>
                <ArrowUpRight size={23} />
              </Link>
            ))}
          </div>
          <p className="small muted domain-footnote">
            Adapters have explicit scope limits. Synthetic datasets and protocol
            tests do not establish physical hardware compatibility.
          </p>
        </section>
        <section className="landing-section editions-section" id="community">
          <div className="section-intro">
            <p className="eyebrow">
              {managedSite
                ? "From model output to managed memory"
                : "Own the foundation"}
            </p>
            <h2>
              {managedSite ? "Your data. Your team." : "Community at the core."}
              <br />
              {managedSite
                ? "One connected workspace."
                : "Managed when it is ready."}
            </h2>
            <p>
              {managedSite
                ? "Create an isolated project. Define your relationships with reviewed migrations. Invite collaborators and give each application only the access it needs."
                : "The Community edition contains the temporal engine, durable branches, console, scoped authentication and MCP. Run it inside your application or operate the service yourself."}
            </p>
          </div>
          <div className="edition-grid">
            <article className="edition community-edition">
              <span className="scope-badge">
                {managedSite
                  ? "MANAGED PROJECTS"
                  : "COMMUNITY · SOURCE-AVAILABLE ALPHA"}
              </span>
              <h3>
                {managedSite ? "From first migration" : "Your graph."}
                <br />
                {managedSite ? "to model history." : "Your infrastructure."}
              </h3>
              <p>
                {managedSite
                  ? "Build and inspect temporal graphs in your browser. Each project has its own database, credentials, migrations and team."
                  : "PolyForm Perimeter 1.0.0. No account required for the embedded engine. Self-host the console and service with scoped credentials."}
              </p>
              <ul>
                {(managedSite
                  ? [
                      "GitHub and email login with authenticator MFA",
                      "Project provisioning and team roles",
                      "Migration editor with 36 connector presets",
                      "Graph history, durable branches and exports",
                    ]
                  : [
                      "Temporal Rust engine and durable branches",
                      "HTTP, native MCP bridge and browser console",
                      "BCI, robotics, world-model and quantum adapters",
                      "Local consistent backups and restore tools",
                    ]
                ).map((s) => (
                  <li key={s}>
                    <Check size={16} />
                    {s}
                  </li>
                ))}
              </ul>
              <Link
                className="button primary"
                to={
                  managedSite
                    ? "/login?provider=github"
                    : "/documentation/QUICKSTART"
                }
              >
                {managedSite ? "Create your first project" : "Run Community"}{" "}
                <ArrowRight size={17} />
              </Link>
              <p className="small muted">
                {managedSite
                  ? "Start with GitHub. Email accounts use a private invitation while automated email delivery is being connected."
                  : "Modification and noncompeting commercial use allowed. Competing products are restricted. Read the license before redistributing."}
              </p>
            </article>
            <article className="edition managed-edition" id="managed">
              <span className="scope-badge">
                {managedSite
                  ? "APPLICATIONS & AGENTS"
                  : "MANAGED · INVITATION-ONLY ALPHA"}
              </span>
              <h3>
                {managedSite ? "Your stack," : "A hosted home"}
                <br />
                {managedSite ? "with a shared memory." : "for your workspace."}
              </h3>
              <p>
                {managedSite
                  ? "Connect Codex, Cursor, Claude and your own backends to a project endpoint. Store provider secrets separately from graph credentials."
                  : "Your temporal graph, available over HTTPS. Connect the console, your SDK or an MCP client with a scoped workspace token."}
              </p>
              <ul>
                {(managedSite
                  ? [
                      "Project API URLs and expiring application keys",
                      "MCP setup for Codex, Cursor and Claude",
                      "Encrypted secrets with separate reader keys",
                      "Project audit events and revocable sessions",
                    ]
                  : [
                      "Hosted database, console and migration editor",
                      "Scoped API credentials and MCP endpoint",
                      "Scheduled local backups and restore tools",
                      "Dedicated single-workspace service",
                    ]
                ).map((s) => (
                  <li key={s}>
                    <Check size={16} />
                    {s}
                  </li>
                ))}
              </ul>
              <Link className="button outline" to="/documentation/HOSTED">
                {managedSite
                  ? "Explore the managed platform"
                  : "Hosted setup & limits"}{" "}
                <ArrowUpRight size={17} />
              </Link>
              <p className="small muted">
                {managedSite
                  ? "Launch preview with bounded host capacity. Model inference runs in your application; hardware compatibility and availability SLAs are not implied."
                  : "Operator-issued access. Self-service signup, teams, billing and an uptime SLA are not available."}
              </p>
            </article>
          </div>
        </section>
        <section className="landing-section benchmarks-section">
          <div className="section-intro">
            <p className="eyebrow">Measured on a developer Mac</p>
            <h2>
              Built in Rust.
              <br />
              Benchmarks you can reproduce.
            </h2>
            <p>
              The final candidate run uses 100,000 nodes and 10 million temporal
              edge versions. Results include the actual workload and machine
              details.
            </p>
          </div>
          <div className="benchmark-strip">
            <article>
              <strong>
                1.10M<span>/s</span>
              </strong>
              <h3>Batch ingest + final sync</h3>
              <p>Ordered 10M-version workload</p>
            </article>
            <article>
              <strong>
                19.05<span>ms</span>
              </strong>
              <h3>Median as-of query</h3>
              <p>Fully consumed results · p99 19.80 ms</p>
            </article>
            <article>
              <strong>10M</strong>
              <h3>Edge versions</h3>
              <p>100,000 nodes · seeded dataset</p>
            </article>
          </div>
          <div className="benchmark-source">
            <p>
              Community candidate · Apple M5 · 16 GiB RAM · Low Power Mode on ·
              10 workers · warm OS caches. Batch and as-of targets were missed
              in this run. Service latency is measured separately.
            </p>
            <Link className="text-link" to="/documentation/BENCHMARKS">
              Read results & methodology <ArrowUpRight size={16} />
            </Link>
          </div>
        </section>
        <section className="quickstart-section" id="quickstart">
          <div>
            <p className="eyebrow">Start with one moment</p>
            <h2>
              {managedSite ? "Give your next model" : "A world you can"}
              <br />
              {managedSite ? "a memory that lasts." : "run on your machine."}
            </h2>
            <p>
              {managedSite
                ? "Sign in, create a project, and connect your first application. Keep observations, decisions, and their history together from the first request."
                : "From this source checkout, run the hundred-future example. It creates a new dataset, checks every restored state, and merges the best future."}
            </p>
            <div className="hero-actions">
              <Link
                className="button primary"
                to={
                  managedSite
                    ? "/login?provider=github"
                    : "/documentation/QUICKSTART"
                }
              >
                {managedSite ? "Start with GitHub" : "Read the quickstart"}{" "}
                <ArrowRight size={17} />
              </Link>
              <Link className="text-link" to="/app">
                Open console <ArrowUpRight size={16} />
              </Link>
            </div>
          </div>
          <div>
            <span className="code-label">
              <Terminal size={15} />
              {managedSite
                ? "YOUR PROJECT · HTTPS API + MCP"
                : "FROM A SOURCE CHECKOUT · RUST 1.93+"}
            </span>
            <Code
              text={
                managedSite
                  ? `curl '${window.location.origin}/v1/info' \\\n  -H "Authorization: Bearer $CHRONOGRAPH_TOKEN"`
                  : "cargo run --locked --release \\\n  -p chronograph-conn-worldmodel \\\n  --example fork_demo -- ./fork-demo"
              }
            />
            <p className="small">
              {managedSite
                ? "Create a scoped API key in Connections & API keys. Your key routes requests to its project. Keep it in your server environment."
                : "The output directory must be new. For an existing v1 database, use the separate migration path in the docs."}
            </p>
          </div>
        </section>
      </main>
      <footer className="landing-footer">
        <div>
          <Logo />
          <p>Temporal data for a world in motion.</p>
          <span>
            {managedSite
              ? "Chronograph Managed · Launch preview"
              : "Community 0.4 alpha · Service preview"}
          </span>
        </div>
        <div>
          <span>BUILD</span>
          <Link
            to={
              managedSite
                ? "/documentation/HOSTED"
                : "/documentation/QUICKSTART"
            }
          >
            Quickstart
          </Link>
          <Link to="/documentation/BRANCHES">Branches</Link>
          <Link to="/documentation/MCP">MCP integrations</Link>
        </div>
        <div>
          <span>OPERATE</span>
          <Link to="/documentation/SECURITY">Security</Link>
          <Link to="/documentation/OPERATIONS">Backups & restore</Link>
          <Link to="/documentation/LIMITATIONS">Known limits</Link>
        </div>
        <div>
          <span>PROJECT</span>
          <Link to="/documentation/EDITIONS">Editions</Link>
          <Link to="/documentation/REQUIREMENTS">Release status</Link>
          <Link to="/documentation/LICENSING">License and permitted use</Link>
          <a href="https://github.com/enablewmodels-sys/chronograph">
            Community on GitHub
          </a>
          <a href="https://github.com/enablewmodels-sys/chronograph/releases/tag/v0.4.0-alpha.2">
            Download alpha
          </a>
          <Link to="/documentation/BENCHMARKS">Benchmarks</Link>
          <a href="/brand/chronograph-logo.png" download>
            Download the logo
          </a>
        </div>
      </footer>
    </div>
  );
}
