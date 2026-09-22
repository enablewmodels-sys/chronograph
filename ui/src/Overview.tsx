import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, RefreshCw } from "lucide-react";
import { useAuth } from "./main";
import { publicPath } from "./site";
import { graph, bytes, type Stats } from "./api";
import { Busy, DocLink, Head, useAction } from "./shared";
export default function Overview() {
  const { connection } = useAuth();
  const [stats, setStats] = useState<Stats | null>(null),
    action = useAction();
  const refresh = async () => setStats(await graph<Stats>("stats"));
  useEffect(() => {
    void action.run(refresh);
  }, []);
  return (
    <>
      <Head
        title="Overview"
        text="A persistent workspace for relationships and their history."
      >
        <button
          className="outline"
          onClick={() => void action.run(refresh)}
          disabled={action.busy}
        >
          <RefreshCw size={16} /> Refresh
        </button>
      </Head>
      {action.feedback}
      <div className="stat-strip">
        {[
          ["Nodes", stats ? BigInt(stats.nodes).toLocaleString() : undefined],
          [
            "Edge versions",
            stats ? BigInt(stats.edge_versions).toLocaleString() : undefined,
          ],
          ["Append-only log", stats ? bytes(stats.log_bytes) : undefined],
          ["Commit policy", stats ? stats.default_durability : undefined],
        ].map(([label, value]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{value ?? "—"}</strong>
          </div>
        ))}
      </div>
      {stats?.nodes === "0" ? (
        <section className="welcome-panel">
          <img
            className="overview-world"
            src={publicPath("/images/world/t0.webp")}
            width="1200"
            height="800"
            alt="Illustrative robot world"
          />
          <div>
            <p className="mono">Your project is ready.</p>
            <h2>Explore a sample world.</h2>
            <p>
              Load a small, synthetic scene: 8 nodes and 40 relationship
              versions across five moments. Explore how a robot’s view changes
              through time.
            </p>
            <button
              className="primary"
              disabled={action.busy || connection?.credential.scope !== "admin"}
              onClick={() =>
                void action.run(async () => {
                  await graph("load_demo");
                  await refresh();
                }, "Sample workspace loaded. Open the explorer to travel through time.")
              }
            >
              <Busy busy={action.busy}>Load sample workspace</Busy>
            </button>
            <Link to="/app/write" className="text-link">
              Or write your own data <ArrowRight size={16} />
            </Link>
          </div>
        </section>
      ) : (
        stats && (
          <section className="welcome-panel">
            <div>
              <p className="mono">Every relationship has a timeline.</p>
              <h2>Explore your graph.</h2>
              <p>
                Move between a point in time, an interval, and the full
                relationship history. Sample a local neighborhood for your next
                model input.
              </p>
              <Link className="button primary" to="/app/explorer">
                Open temporal explorer <ArrowRight size={17} />
              </Link>
            </div>
            <div className="time-preview" aria-hidden="true">
              <span>PAST</span>
              <div />
              <span>PRESENT</span>
              <div />
              <span>NEXT</span>
            </div>
          </section>
        )
      )}
      <section className="workflow-links">
        <article>
          <span className="mono">01 / Model</span>
          <h3>Write relationships</h3>
          <p>
            Insert a single edge or an atomic batch, with microsecond validity
            and a 16-byte payload.
          </p>
          <Link className="text-link" to="/app/write">
            Write data <ArrowRight size={16} />
          </Link>
        </article>
        <article>
          <span className="mono">02 / Connect</span>
          <h3>Give agents context</h3>
          <p>
            Create a scoped token and connect Codex, Cursor or Claude through
            MCP.
          </p>
          <Link className="text-link" to="/app/access">
            Manage agent access <ArrowRight size={16} />
          </Link>
        </article>
        <article>
          <span className="mono">03 / Operate</span>
          <h3>Keep your memory safe</h3>
          <p>
            Synchronize the log, download a consistent backup, and manage your
            access tokens.
          </p>
          <DocLink to="DEPLOYMENT">Deployment guide</DocLink>
        </article>
      </section>
    </>
  );
}
