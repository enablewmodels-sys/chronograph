import { useRef, useState, type ReactNode, type FormEvent } from "react";
import { ArrowUpRight, Check, Copy, LoaderCircle } from "lucide-react";
import { Link } from "react-router-dom";
export function Logo() {
  return (
    <Link className="logo" to="/" aria-label="Chronograph home">
      <svg viewBox="0 0 40 40" aria-hidden="true">
        <path d="m9 25 12-17 11 24-23-7" />
        <circle cx="9" cy="25" r="4" />
        <circle cx="21" cy="8" r="4" />
        <circle cx="32" cy="32" r="4" />
      </svg>
      <span>chronograph</span>
    </Link>
  );
}
export function useAction() {
  const running = useRef(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  async function run(work: () => Promise<void>, success = "") {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
      setNotice(success);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Operation failed");
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return {
    busy,
    run,
    feedback: (
      <>
        {error && (
          <div role="alert" className="notice error">
            {error}
          </div>
        )}
        {notice && (
          <div role="status" className="notice success">
            {notice}
          </div>
        )}
      </>
    ),
  };
}
export function Busy({
  busy,
  children,
}: {
  busy: boolean;
  children: ReactNode;
}) {
  return (
    <>
      {busy && <LoaderCircle className="spin" size={16} />}{" "}
      {busy ? "Working…" : children}
    </>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Head({
  title,
  text,
  children,
}: {
  title: string;
  text: string;
  children?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        <p>{text}</p>
      </div>
      {children}
    </header>
  );
}
export function SubmitForm({
  children,
  onSubmit,
  className = "",
}: {
  children: ReactNode;
  onSubmit: () => void;
  className?: string;
}) {
  return (
    <form
      className={className}
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {children}
    </form>
  );
}
export function Code({ text }: { text: string }) {
  const [copied, setCopied] = useState(false),
    [error, setError] = useState("");
  return (
    <div className="code-wrap">
      <button
        className="copy ghost"
        aria-label="Copy configuration"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          } catch {
            setError(
              "Select and copy the text below. Clipboard access is unavailable.",
            );
          }
        }}
      >
        {copied ? <Check size={17} /> : <Copy size={17} />}
      </button>
      {error && <p role="status">{error}</p>}
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  );
}
export function DocLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link className="text-link" to={`/documentation/${to}`}>
      {children}
      <ArrowUpRight size={16} />
    </Link>
  );
}
