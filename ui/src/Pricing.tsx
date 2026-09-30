import { useEffect } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, Check, Clock, Minus } from "lucide-react";
import { Logo } from "./shared";
import SiteFooter from "./SiteFooter";
import { managedSite, publicSite } from "./site";
import "./pricing.css";

// Billing is not enabled. Prices shown for the planned Managed tiers are
// indicative and are labelled as such everywhere they appear.
const billingLive = false;

type Plan = {
  name: string;
  price: string;
  cadence?: string;
  badge?: string;
  summary: string;
  cta: string;
  to: string;
  external?: boolean;
  featured?: boolean;
  included: string[];
  excluded?: string[];
};

const plans: Plan[] = [
  {
    name: "Community",
    price: "Free",
    cadence: "forever",
    summary:
      "The full engine, service and console, on your own infrastructure. No account, no licence server, no telemetry.",
    cta: "Read the quickstart",
    to: "/documentation/QUICKSTART",
    included: [
      "Embedded Rust engine and durable branches",
      "Self-hosted service, console and MCP",
      "Schema designer and 38 connector presets",
      "All eight language SDKs",
      "Local backups and restore",
    ],
    excluded: ["Hosted projects", "Team roles and audit records"],
  },
  {
    name: "Managed preview",
    price: "Free",
    cadence: "during preview",
    badge: "Invite only",
    summary:
      "The same engine, operated for you. Private projects, accounts, scoped keys and an encrypted secret vault.",
    cta: "About Managed",
    to: "/documentation/HOSTED",
    featured: true,
    included: [
      "Private project with its own database and process",
      "Google, GitHub and invited email accounts",
      "Authenticator MFA and recovery codes",
      "Scoped API keys and project roles",
      "Encrypted project secret vault",
      "Scheduled local backups and protected metrics",
    ],
    excluded: ["Self-service billing", "Off-host recovery or an SLA"],
  },
  {
    name: "Managed Team",
    price: "Coming soon",
    summary:
      "Planned for teams that need to hand operation to us: larger projects, more seats and a support agreement.",
    cta: "Read the editions guide",
    to: "/documentation/EDITIONS",
    included: [
      "Everything in the Managed preview",
      "More projects and collaborators",
      "Longer key expiry and rotation",
      "Priority support",
    ],
    excluded: ["Published price", "Uptime commitment"],
  },
];

const comparison: [string, string, string][] = [
  ["Embedded engine and branching", "included", "included"],
  ["Self-hosted service, console, MCP", "included", "included"],
  ["Schema designer and migrations", "included", "included"],
  ["Language SDKs", "included", "included"],
  ["Operated for you", "none", "included"],
  ["User accounts and team roles", "none", "included"],
  ["Scoped API keys", "workspace tokens", "per project"],
  ["Encrypted secret vault", "none", "included"],
  ["Scheduled off-host backups", "none", "local only"],
  ["Availability commitment", "none", "none"],
  ["Self-service billing", "none", "none"],
];

export default function Pricing() {
  useEffect(() => {
    const previous = document.title;
    document.title = "Pricing · ChronoDB";
    window.scrollTo(0, 0);
    return () => {
      document.title = previous;
    };
  }, []);

  const mark = (value: string) => {
    if (value === "included")
      return <Check aria-label="Included" size={16} className="pricing-yes" />;
    if (value === "none")
      return (
        <Minus aria-label="Not included" size={16} className="pricing-no" />
      );
    return <span className="pricing-partial">{value}</span>;
  };

  return (
    <div className="pricing-page">
      <nav className="public-nav" aria-label="Main navigation">
        <Logo />
        <div className="nav-links">
          <Link to="/">Product</Link>
          <Link to="/pricing">Pricing</Link>
          <Link to="/documentation/EDITIONS">Editions</Link>
        </div>
        <Link className="button primary" to={publicSite ? "/app" : "/login"}>
          {publicSite
            ? "Explore demo"
            : managedSite
              ? "Create account"
              : "Open console"}
        </Link>
      </nav>

      <main id="main" className="pricing-main">
        <header className="pricing-header">
          <span className="landing-eyebrow">Pricing</span>
          <h1>Start free. Pay only when we operate it for you.</h1>
          <p>
            Community is free and self-hosted, permanently. Managed hosting is
            in an invited preview and costs nothing today.
          </p>
        </header>

        {!billingLive && (
          <div className="pricing-notice" role="status">
            <Clock size={18} aria-hidden="true" />
            <div>
              <strong>Billing coming soon.</strong> Self-service billing is not
              enabled, so nothing on this page can be purchased. The preview is
              free while it lasts and no account is enrolled automatically. Any
              paid plan will be shown with a final price and your explicit
              agreement before a charge. See the <Link to="/terms">terms</Link>{" "}
              and the <Link to="/documentation/HOSTED">Managed guide</Link>.
            </div>
          </div>
        )}

        <section className="pricing-plans" aria-label="Plans">
          {plans.map((plan) => (
            <article
              key={plan.name}
              className={
                plan.featured ? "pricing-plan featured" : "pricing-plan"
              }
            >
              <header>
                <h2>{plan.name}</h2>
                {plan.badge && (
                  <span className="pricing-badge">{plan.badge}</span>
                )}
              </header>
              <p className="pricing-price">
                <strong>{plan.price}</strong>
                {plan.cadence && <span>{plan.cadence}</span>}
              </p>
              <p className="pricing-summary">{plan.summary}</p>
              <ul>
                {plan.included.map((item) => (
                  <li key={item}>
                    <Check size={15} aria-hidden="true" />
                    {item}
                  </li>
                ))}
                {plan.excluded?.map((item) => (
                  <li key={item} className="muted">
                    <Minus size={15} aria-hidden="true" />
                    {item}
                  </li>
                ))}
              </ul>
              <Link
                className={plan.featured ? "button primary" : "button"}
                to={plan.to}
              >
                {plan.cta} <ArrowUpRight size={14} />
              </Link>
            </article>
          ))}
        </section>

        <section className="pricing-compare" aria-label="Plan comparison">
          <h2>Compare</h2>
          <div className="pricing-table-wrap">
            <table className="pricing-table">
              <caption className="sr-only">
                Feature comparison between Community and Managed
              </caption>
              <thead>
                <tr>
                  <th scope="col">Capability</th>
                  <th scope="col">Community</th>
                  <th scope="col">Managed preview</th>
                </tr>
              </thead>
              <tbody>
                {comparison.map(([capability, community, managed]) => (
                  <tr key={capability}>
                    <th scope="row">{capability}</th>
                    <td>{mark(community)}</td>
                    <td>{mark(managed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="pricing-faq" aria-label="Pricing questions">
          <h2>Questions people actually ask</h2>
          <details>
            <summary>What does Community cost?</summary>
            <p>
              Nothing. It is source-available under PolyForm Perimeter 1.0.0,
              which permits modification and commercial use in noncompeting
              products. You pay only for your own infrastructure. It is not OSI
              open source. See <Link to="/licensing">the licence</Link>.
            </p>
          </details>
          <details>
            <summary>When will billing exist?</summary>
            <p>
              Not yet, and no date is promised. Managed currently runs as an
              invited preview with bounded capacity. A paid plan will ship with
              a published price, metered usage and a cancellation path before
              anyone is charged.
            </p>
          </details>
          <details>
            <summary>What will Managed cost at launch?</summary>
            <p>
              Undecided, and deliberately not published here. Agent-memory tools
              sit at $125–375 per month and managed data platforms start near
              $29. A temporal database for engineering teams is most likely to
              land in that lower band, but the number will be announced with the
              billing feature, not before. Do not budget against a figure this
              page does not state.
            </p>
          </details>
          <details>
            <summary>Do I need to pay to try it?</summary>
            <p>
              No. Run the{" "}
              <Link to="/documentation/QUICKSTART">local quickstart</Link> today
              with no account at all, or{" "}
              <Link to="/documentation/HOSTED">request a Managed preview</Link>.
            </p>
          </details>
          <details>
            <summary>Is there an SLA?</summary>
            <p>
              No. Neither edition carries an availability commitment. The{" "}
              <Link to="/documentation/LIMITATIONS">known limits</Link> describe
              what is and is not guaranteed.
            </p>
          </details>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
