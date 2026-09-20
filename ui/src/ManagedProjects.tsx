import { useState, useRef, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, Database, Plus, ShieldCheck } from "lucide-react";
import { Busy, Field, Logo, SubmitForm, useAction } from "./shared";
import {
  managedApi,
  setManagedProject,
  type ManagedSession,
} from "./managed-api";
export default function ManagedProjects({
  session,
  refresh,
}: {
  session: ManagedSession;
  refresh: () => Promise<void>;
}) {
  const action = useAction(),
    navigate = useNavigate(),
    [name, setName] = useState("");
  const select = async (id: string) => {
    setManagedProject("");
    await managedApi("/managed/projects/select", { projectId: id });
    await refresh();
    navigate("/app");
  };
  return (
    <main id="main" className="projects-page">
      <header>
        <Logo />
        <div>
          <Link to="/account/security">Account security</Link>
          <button
            onClick={() =>
              void action.run(async () => {
                await managedApi("/api/auth/sign-out", {});
                await refresh();
                navigate("/login");
              })
            }
          >
            Sign out
          </button>
        </div>
      </header>
      <div className="projects-heading">
        <div>
          <p className="eyebrow">{session.user?.email}</p>
          <h1>Your projects.</h1>
          <p>
            Each project has its own graph, migrations, credentials, and team.
          </p>
        </div>
        <ShieldCheck size={40} strokeWidth={1.2} />
      </div>
      <div className="project-list">
        {session.projects.map((p) => (
          <button
            className="project-row"
            key={p.id}
            onClick={() => void action.run(() => select(p.id))}
            disabled={action.busy}
          >
            <Database size={24} />
            <span>
              <strong>{p.name}</strong>
              <small>
                {p.id} · {p.role}
              </small>
            </span>
            <span className="scope-badge">{p.state}</span>
            <ArrowRight size={20} />
          </button>
        ))}
        {!session.projects.length && (
          <p className="panel">
            Create your first project to start recording relationships and model
            history.
          </p>
        )}
      </div>
      <section className="panel form-panel new-project">
        <h2>
          <Plus size={20} /> Create a project
        </h2>
        <p>
          Start with an empty temporal graph. Apply a connector preset or write
          your own migration in the console.
        </p>
        <SubmitForm
          onSubmit={() =>
            void action.run(async () => {
              setManagedProject("");
              const result = await managedApi<{ project: { id: string } }>(
                "/managed/projects",
                { name },
              );
              setName("");
              await select(result.project.id);
            })
          }
        >
          <Field label="Project name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              placeholder="robot-memory"
              required
            />
          </Field>
          <button className="primary" disabled={action.busy}>
            <Busy busy={action.busy}>Create project</Busy>
          </button>
        </SubmitForm>
        <p className="small muted">
          Launch preview: up to two projects per account, subject to host
          capacity. Your graph stays private to your project’s members.
        </p>
        {action.feedback}
      </section>
    </main>
  );
}

export function JoinProject({ refresh }: { refresh: () => Promise<void> }) {
  const token = useRef(
    new URLSearchParams(window.location.hash.slice(1)).get("token") || "",
  );
  const action = useAction(),
    navigate = useNavigate();
  useEffect(() => {
    window.history.replaceState(null, "", window.location.pathname);
  }, []);
  return (
    <main id="main" className="projects-page">
      <Logo />
      <h1>Join your project.</h1>
      <p>
        Sign in with the invited email and verify your authenticator before
        accepting this invitation.
      </p>
      <button
        className="primary"
        disabled={action.busy}
        onClick={() =>
          void action.run(async () => {
            const r = await managedApi<{ projectId: string }>(
              "/managed/invitation/accept",
              { token: token.current },
            );
            window.history.replaceState(null, "", window.location.pathname);
            setManagedProject("");
            await managedApi("/managed/projects/select", {
              projectId: r.projectId,
            });
            await refresh();
            navigate("/app");
          })
        }
      >
        <Busy busy={action.busy}>Accept invitation</Busy>
      </button>
      <Link className="text-link" to="/login">
        Sign in first, then reopen your invitation
      </Link>
      {action.feedback}
    </main>
  );
}
