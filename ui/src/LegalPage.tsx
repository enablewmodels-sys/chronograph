import { useEffect, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowLeft, ArrowUpRight, RefreshCw } from "lucide-react";
import { Logo } from "./shared";
import SiteFooter from "./SiteFooter";
import { policies, policyDate } from "./legal-content";
import { managedSite } from "./site";
import "./legal.css";

const navigation = [
  ["privacy", "Privacy"],
  ["terms", "Terms"],
  ["data-protection", "Data protection"],
  ["security", "Security"],
  ["subprocessors", "Providers"],
  ["cookies", "Cookies"],
  ["acceptable-use", "Acceptable use"],
  ["support", "Support"],
  ["legal", "Company"],
  ["status", "Status"],
];

export default function LegalPage() {
  const location = useLocation();
  const slug = location.pathname.slice(1);
  const page = policies[slug];
  const title =
    slug === "status" ? "Service status" : page?.title || "Page not found";
  useEffect(() => {
    const previous = document.title;
    document.title = `${title} · ChronoDB`;
    if (!location.hash) window.scrollTo(0, 0);
    else
      requestAnimationFrame(() =>
        document.getElementById(location.hash.slice(1))?.scrollIntoView(),
      );
    return () => {
      document.title = previous;
    };
  }, [title, location.hash]);
  return (
    <div className="information-page">
      <header className="information-header">
        <Logo />
        <nav aria-label="Main navigation">
          <Link to="/documentation/HOSTED">Docs</Link>
          <Link to="/login">
            Log in <ArrowUpRight size={15} />
          </Link>
        </nav>
      </header>
      <main id="main" className="information-main">
        <aside className="information-nav">
          <Link to="/" className="back-home">
            <ArrowLeft size={14} /> Back to ChronoDB
          </Link>
          <nav aria-label="Trust centre">
            {navigation.map(([path, label]) => (
              <NavLink key={path} to={`/${path}`}>
                {label}
              </NavLink>
            ))}
          </nav>
        </aside>
        <article className="policy-document">
          <header>
            <p className="policy-eyebrow">ChronoDB · Trust & information</p>
            <h1>{title}</h1>
            <p className="policy-summary">
              {page?.summary ||
                "A live connectivity check for the hosted service."}
            </p>
            {page && <p className="policy-date">Effective {policyDate}</p>}
          </header>
          {slug === "status" ? (
            managedSite ? (
              <ServiceStatus />
            ) : (
              <section>
                <h2>Hosted service status</h2>
                <p>
                  <a href="https://chronodb.co/status">
                    Open the live ChronoDB Managed status page
                  </a>
                  . This website does not connect to your self-hosted database.
                </p>
              </section>
            )
          ) : page ? (
            <>
              <nav className="policy-contents" aria-label="On this page">
                {page.sections.map((section) => (
                  <a key={section.id} href={`#${section.id}`}>
                    {section.title}
                  </a>
                ))}
              </nav>
              {page.sections.map((section) => (
                <section id={section.id} key={section.id}>
                  <h2>{section.title}</h2>
                  <Markdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      a: ({ href, children }) =>
                        href?.startsWith("/") ? (
                          <Link to={href}>{children}</Link>
                        ) : (
                          <a href={href}>{children}</a>
                        ),
                      table: ({ children }) => (
                        <div
                          className="policy-table"
                          role="region"
                          aria-label="Provider information table"
                          tabIndex={0}
                        >
                          <table>{children}</table>
                        </div>
                      ),
                    }}
                  >
                    {section.body}
                  </Markdown>
                </section>
              ))}
            </>
          ) : (
            <Link to="/legal">Open company information</Link>
          )}
        </article>
      </main>
      <SiteFooter />
    </div>
  );
}

function ServiceStatus() {
  const [status, setStatus] = useState<
    "checking" | "available" | "unavailable" | "unknown"
  >("checking");
  const [checked, setChecked] = useState<Date | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function check() {
      if (document.hidden) {
        timer = setTimeout(() => void check(), 60000);
        return;
      }
      try {
        const result = await fetch("/readyz", {
          cache: "no-store",
          credentials: "omit",
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(10000),
          ]),
        });
        await result.body?.cancel();
        if (!controller.signal.aborted)
          setStatus(result.ok ? "available" : "unavailable");
      } catch {
        if (!controller.signal.aborted) setStatus("unknown");
      }
      if (!controller.signal.aborted) {
        setChecked(new Date());
        timer = setTimeout(() => void check(), 60000);
      }
    }
    void check();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [revision]);
  return (
    <>
      <div className="service-check" role="status" data-state={status}>
        <span className="service-dot" />
        <div>
          <strong>
            {
              {
                checking: "Checking service…",
                available: "Service is responding",
                unavailable: "Service needs attention",
                unknown: "Unable to confirm status",
              }[status]
            }
          </strong>
          <p>
            {checked
              ? `Last checked ${checked.toLocaleTimeString()}`
              : "Waiting for the live readiness endpoint."}
          </p>
        </div>
        <button
          aria-label="Check service status again"
          disabled={status === "checking"}
          onClick={() => {
            setStatus("checking");
            setRevision((n) => n + 1);
          }}
        >
          <RefreshCw size={17} />
        </button>
      </div>
      <section>
        <h2>What this checks</h2>
        <p>
          This check tests the hosted gateway and primary database readiness. It
          does not claim historical uptime or confirm every customer project.
          Open your workspace for project-specific health.
        </p>
        <p>
          A network or browser restriction can also prevent the check. Use{" "}
          <Link to="/support">support</Link> if you are unable to connect.
        </p>
      </section>
      <section>
        <h2>Current service scope</h2>
        <p>
          ChronoDB Managed runs in AWS US West (Northern California). The launch
          preview has bounded capacity and no contractual uptime SLA. See the{" "}
          <Link to="/documentation/HOSTED">Managed guide</Link> for limits and
          recovery responsibilities.
        </p>
      </section>
    </>
  );
}
