import { useEffect } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, Check, Clock, Minus } from "lucide-react";
import { Logo } from "./shared";
import SiteFooter from "./SiteFooter";
import { managedSite, publicSite } from "./site";
import "./pricing.css";

// Billing is not enabled. Every figure below is planned launch pricing, shown so
// the tiers can be reviewed; none of it can be purchased.
const billingLive = false;

type Plan = {
  name: string;
  price: string;
  cadence?: string;
  badge?: string;
  summary: string;
  cta: string;
  to: string;
  featured?: boolean;
  included: string[];
  excluded?: string[];
};

const plans: Plan[] = [
  {
    name: "Free",
    price: "$0",
    cadence: "/month",
    summary:
      "Community on your own machine, plus one small hosted project to try Managed. Community needs no account at all.",
    cta: "Read the quickstart",
    to: "/documentation/QUICKSTART",
    included: [
      "Community engine, console and MCP, self-hosted",
      "1 hosted project, 1 GB memory, 1 GB storage",
      "Unlimited API requests on your own hardware",
      "Scoped API keys",
      "Local backup and restore",
      "Community support",
    ],
    excluded: ["Scheduled off-host backups", "Support agreement"],
  },
  {
    name: "Pro",
    price: "$25",
    cadence: "/month",
    badge: "Most popular",
    summary:
      "For a production graph and a team that needs it to keep serving. First project included; add more as you grow.",
    cta: "Read the Managed guide",
    to: "/documentation/HOSTED",
    featured: true,
    included: [
      "Everything in Free, plus:",
      "First project included, extra projects from $10/month",
      "4 GB memory and 10 GB storage per project",
      "Scheduled daily backups kept 7 days",
      "Raised branch and fork limits",
      "Email support",
    ],
    excluded: ["Single sign-on", "Uptime SLA"],
  },
  {
    name: "Team",
    price: "$599",
    cadence: "/month",
    summary:
      "For organisations that need access control, longer retention and someone contractually answerable.",
    cta: "Read the editions guide",
    to: "/documentation/EDITIONS",
    included: [
      "Everything in Pro, plus:",
      "Single sign-on for the console",
      "Project roles and audit records",
      "Daily backups kept 14 days",
      "Read-only and project-scoped access",
      "Priority support with response targets",
    ],
    excluded: ["Uptime SLA", "Private deployment"],
  },
  {
    name: "Enterprise",
    price: "Custom",
    summary:
      "For regulated or very large deployments, including running the control plane inside your own account.",
    cta: "Read the production guide",
    to: "/documentation/PRODUCTION",
    included: [
      "Everything in Team, plus:",
      "Private deployment on your own infrastructure",
      "Uptime SLA and named support",
      "Security questionnaires and review",
      "Longer retention and custom limits",
      "Migration and integration assistance",
    ],
  },
];

// A hosted project is one process with its own database, and the engine keeps its
// indexes in memory, so memory is the honest unit to price.
const compute: [string, string, string][] = [
  ["Micro", "$10", "1 GB memory, shared"],
  ["Small", "$15", "2 GB memory, shared"],
  ["Medium", "$60", "4 GB memory, shared"],
  ["Large", "$110", "8 GB memory, dedicated"],
  ["XL", "$210", "16 GB memory, dedicated"],
  ["2XL", "$410", "32 GB memory, dedicated"],
];

const comparison: [string, string, string, string, string][] = [
  [
    "Community engine, self-hosted",
    "included",
    "included",
    "included",
    "included",
  ],
  ["Hosted projects", "1", "1 + $10 each", "1 + $10 each", "Custom"],
  ["Memory per project", "1 GB", "4 GB", "4 GB", "Custom"],
  ["Scoped API keys", "included", "included", "included", "included"],
  ["Scheduled off-host backups", "none", "7 days", "14 days", "Custom"],
  ["Team roles and audit records", "none", "included", "included", "included"],
  ["Single sign-on", "none", "none", "included", "included"],
  ["Uptime SLA", "none", "none", "none", "included"],
  ["Support", "community", "email", "priority", "named"],
];

const unmetered: [string, string][] = [
  [
    "Collaborators",
    "Pricing is per project, never per seat. Invite the people who need access.",
  ],
  [
    "API requests",
    "Requests are not metered. A project's cost tracks the history it keeps.",
  ],
  ["Egress", "No egress fee is planned for normal API use."],
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
          <h1>Start free. Scale when we operate it for you.</h1>
          <p>
            Community is free and self-hosted, permanently. Hosted plans are
            planned as four tiers, priced on project memory because that is what
            the engine actually consumes.
          </p>
        </header>

        {!billingLive && (
          <div className="pricing-notice" role="status">
            <Clock size={18} aria-hidden="true" />
            <div>
              <strong>Billing coming soon.</strong> Nothing on this page can be
              purchased. These are planned launch prices, published for review,
              and they may change before billing ships. The Managed preview is
              free while it lasts and no account is enrolled automatically. Any
              paid plan will show a final price and require your explicit
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
          <h2>Compare plans</h2>
          <div className="pricing-table-wrap">
            <table className="pricing-table four">
              <caption className="sr-only">
                Feature comparison across the Free, Pro, Team and Enterprise
                plans
              </caption>
              <thead>
                <tr>
                  <th scope="col">Capability</th>
                  <th scope="col">Free</th>
                  <th scope="col">Pro</th>
                  <th scope="col">Team</th>
                  <th scope="col">Enterprise</th>
                </tr>
              </thead>
              <tbody>
                {comparison.map(([capability, free, pro, team, enterprise]) => (
                  <tr key={capability}>
                    <th scope="row">{capability}</th>
                    <td>{mark(free)}</td>
                    <td>{mark(pro)}</td>
                    <td>{mark(team)}</td>
                    <td>{mark(enterprise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="pricing-compare" aria-label="Project memory">
          <h2>Project memory</h2>
          <p className="pricing-lede">
            A hosted project is one process with its own database, and its
            resident cost tracks the history it keeps. Paid plans include{" "}
            <strong>$10/month in compute credit</strong>, enough to cover one
            Micro project.
          </p>
          <div className="pricing-table-wrap">
            <table className="pricing-table">
              <thead>
                <tr>
                  <th scope="col">Size</th>
                  <th scope="col">Per month</th>
                  <th scope="col">Included</th>
                </tr>
              </thead>
              <tbody>
                {compute.map(([size, price, included]) => (
                  <tr key={size}>
                    <th scope="row">{size}</th>
                    <td className="pricing-money">{price}</td>
                    <td className="pricing-left">{included}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="pricing-compare" aria-label="What we do not meter">
          <h2>What we do not meter</h2>
          <ul className="pricing-list">
            {unmetered.map(([name, note]) => (
              <li key={name}>
                <strong>{name}.</strong> {note}
              </li>
            ))}
          </ul>
        </section>

        <section className="pricing-faq" aria-label="Pricing questions">
          <h2>Questions people actually ask</h2>
          <details>
            <summary>What does Community cost?</summary>
            <p>
              Nothing, on your own hardware and with no account. It is
              source-available under PolyForm Perimeter 1.0.0, which permits
              modification and commercial use in noncompeting products. It is
              not OSI open source. See <Link to="/licensing">the licence</Link>.
            </p>
          </details>
          <details>
            <summary>Can I buy a plan today?</summary>
            <p>
              No. Billing is not enabled, so nothing here is purchasable and no
              card is ever stored. The Managed preview is free while it lasts. A
              paid plan will ship with metered usage, a published final price
              and a cancellation path before anyone is charged.
            </p>
          </details>
          <details>
            <summary>Why price per project rather than per seat?</summary>
            <p>
              A project is the unit that costs us money: one process, one
              database, its own memory footprint. Per-seat pricing would
              penalise exactly the collaboration the product exists for, and
              per-byte pricing would earn almost nothing on a 16-byte payload
              model.
            </p>
          </details>
          <details>
            <summary>Are these prices final?</summary>
            <p>
              No. They are planned launch prices published so the tiers can be
              reviewed, modelled on comparable managed platforms. Treat them as
              indicative and do not budget against them. Final numbers ship with
              billing.
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
              Not below Enterprise. Free, Pro and Team carry no availability
              commitment. The{" "}
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
