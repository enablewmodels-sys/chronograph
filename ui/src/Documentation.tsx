import { isValidElement, useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, useParams } from "react-router-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Logo } from "./shared";
import { publicPath, publicSite } from "./site";
const docs = [
  ["QUICKSTART", "Quickstart"],
  ["TUTORIAL", "Temporal model"],
  ["BRANCHES", "Durable branches"],
  ["API", "HTTP API"],
  ["SDK", "Language SDKs"],
  ["INTEGRATIONS", "Platform integration recipes"],
  ["SCHEMA", "Schema & migrations"],
  ["CONNECTOR_PLATFORM", "Connector platform"],
  ["UPGRADE_0_4", "Upgrade to 0.4"],
  ["MCP", "Agent integrations"],
  ["connectors/bci", "BCI & LSL"],
  ["connectors/robotics", "Robotics & LeRobot"],
  ["connectors/worldmodel", "World models & Minari"],
  ["connectors/quantum", "Quantum (exploratory)"],
  ["ARCHITECTURE", "Architecture"],
  ["SECURITY", "Authentication"],
  ["OPERATIONS", "Operations"],
  ["DEPLOYMENT", "Deployment"],
  ["INSTALL", "Install & upgrade"],
  ["TESTING", "Testing & latency"],
  ["BENCHMARKS", "Benchmark results"],
  ["FORMAT", "Storage format"],
  ["LIMITATIONS", "Known limits"],
  ["EDITIONS", "Community & Managed"],
  ["REQUIREMENTS", "Release status"],
  ["LICENSING", "License and permitted use"],
  ["WEBSITE", "Deploy on Vercel"],
];
function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node))
    return textOf(node.props.children);
  return "";
}
function slug(node: ReactNode) {
  return textOf(node)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}
export default function Documentation() {
  const params = useParams(),
    doc = params["*"]?.replace(/\/+$/, "") || "QUICKSTART";
  const [text, setText] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    setText("");
    setError("");
    if (!docs.some(([id]) => id === doc)) {
      setError("Document not found.");
      return;
    }
    fetch(publicPath(`/docs/${doc}.md`), {
      signal: abort.signal,
      credentials: "omit",
    })
      .then((r) => {
        if (!r.ok || !(r.headers.get("content-type") || "").includes("text/"))
          throw new Error("Document could not be loaded.");
        return r.text();
      })
      .then((body) => {
        if (body.trimStart().toLowerCase().startsWith("<!doctype"))
          throw new Error("Document is not available in this build.");
        setText(body);
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => abort.abort();
  }, [doc]);
  useEffect(() => {
    if (text && window.location.hash)
      requestAnimationFrame(() =>
        document
          .getElementById(decodeURIComponent(window.location.hash.slice(1)))
          ?.scrollIntoView(),
      );
  }, [text]);
  const link = (href: string | undefined, children: ReactNode) => {
    if (!href) return <span>{children}</span>;
    if (href.startsWith("#")) return <a href={href}>{children}</a>;
    try {
      const resolved = new URL(
        href,
        `https://chronograph-docs.invalid/docs/${doc}.md`,
      );
      if (
        resolved.origin === "https://chronograph-docs.invalid" &&
        resolved.pathname.startsWith("/docs/") &&
        resolved.pathname.endsWith(".md")
      ) {
        const target = resolved.pathname.slice(6, -3);
        if (docs.some(([id]) => id === target))
          return (
            <Link to={`/documentation/${target}${resolved.hash}`}>
              {children}
            </Link>
          );
        return (
          <a href={`${publicPath(`/docs/${target}.md`)}${resolved.hash}`}>
            {children}
          </a>
        );
      }
    } catch {
      return <span>{children}</span>;
    }
    return <a href={href}>{children}</a>;
  };
  return (
    <div className="documentation">
      <nav className="public-nav">
        <Logo />
        <div className="nav-links">
          <Link to="/">Product</Link>
          <Link to="/documentation/EDITIONS">Editions</Link>
        </div>
        <Link className="button primary" to="/app">
          {publicSite ? "Explore demo" : "Open console"}
        </Link>
      </nav>
      <div className="docs-layout">
        <aside>
          <h2>Community documentation</h2>
          <nav aria-label="Documentation">
            {docs.map(([id, title]) => (
              <NavLink key={id} to={`/documentation/${id}`}>
                {title}
              </NavLink>
            ))}
          </nav>
          <Link to="/">← Back to home</Link>
        </aside>
        <main id="main" className="prose">
          {error ? (
            <p role="alert">{error}</p>
          ) : text ? (
            <Markdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ href, children }) => link(href, children),
                img: ({ src, alt }) => {
                  const resolved = new URL(
                    src || "",
                    `https://chronograph-docs.invalid/docs/${doc}.md`,
                  );
                  return resolved.origin ===
                    "https://chronograph-docs.invalid" &&
                    resolved.pathname.startsWith("/docs/") ? (
                    <img
                      className="docs-image"
                      src={publicPath(resolved.pathname)}
                      alt={alt || ""}
                    />
                  ) : (
                    <span>{alt}</span>
                  );
                },
                h1: ({ children }) => <h1 id={slug(children)}>{children}</h1>,
                h2: ({ children }) => <h2 id={slug(children)}>{children}</h2>,
                h3: ({ children }) => <h3 id={slug(children)}>{children}</h3>,
                h4: ({ children }) => <h4 id={slug(children)}>{children}</h4>,
                table: ({ children }) => (
                  <div className="table-scroll">
                    <table>{children}</table>
                  </div>
                ),
              }}
            >
              {text}
            </Markdown>
          ) : (
            <p role="status">Loading documentation…</p>
          )}
        </main>
      </div>
    </div>
  );
}
