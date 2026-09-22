import {
  useRef,
  useState,
  useEffect,
  useId,
  type ReactNode,
  type FormEvent,
} from "react";
import {
  ArrowUpRight,
  Check,
  Copy,
  LoaderCircle,
  CircleHelp,
  X,
} from "lucide-react";
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
export function Tabs({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: string[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {options.map((name, index) => (
        <button
          key={name}
          role="tab"
          aria-selected={value === name}
          tabIndex={value === name ? 0 : -1}
          onClick={() => onChange(name)}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
              return;
            event.preventDefault();
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? options.length - 1
                  : (index +
                      (event.key === "ArrowRight" ? 1 : -1) +
                      options.length) %
                    options.length;
            onChange(options[next]);
            (
              event.currentTarget.parentElement?.children[
                next
              ] as HTMLButtonElement
            )?.focus();
          }}
        >
          {name}
        </button>
      ))}
    </div>
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
      <div className="page-heading">
        <h1>{title}</h1>
        {text && (
          <details className="page-help">
            <summary aria-label={`Help with ${title}`}>
              <CircleHelp size={17} />
            </summary>
            <p>{text}</p>
          </details>
        )}
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

export function Drawer({
  open,
  onClose,
  title,
  children,
  className = "",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  className?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open || !dialog.current) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    dialog.current.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      dialog.current?.close();
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, [open]);
  if (!open) return null;
  return (
    <dialog
      ref={dialog}
      className={`drawer ${className}`}
      aria-labelledby={heading}
      onCancel={(e) => {
        e.preventDefault();
        close.current();
      }}
    >
      <header className="drawer-header">
        <h2 id={heading}>{title}</h2>
        <button
          type="button"
          className="ghost"
          aria-label={`Close ${title}`}
          onClick={() => close.current()}
        >
          <X size={18} />
        </button>
      </header>
      <div className="drawer-body">{children}</div>
    </dialog>
  );
}
export function Disclosure({
  title,
  children,
  open = false,
}: {
  title: string;
  children: ReactNode;
  open?: boolean;
}) {
  return (
    <details className="disclosure" open={open || undefined}>
      <summary>{title}</summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}
