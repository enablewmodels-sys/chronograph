import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "./main";
import {
  Busy,
  Code,
  Field,
  Head,
  SubmitForm,
  useAction,
  Drawer,
  Disclosure,
} from "./shared";
import { managedApi } from "./managed-api";
interface Secret {
  name: string;
  version: number;
  updated_at: number;
}
interface ReaderKey {
  id: string;
  name: string;
  expires_at: number;
}
export default function ManagedSecrets() {
  const { connection } = useAuth(),
    action = useAction(),
    [secrets, setSecrets] = useState<Secret[]>([]),
    [keys, setKeys] = useState<ReaderKey[]>([]),
    [name, setName] = useState(""),
    [value, setValue] = useState(""),
    [keyName, setKeyName] = useState(""),
    [days, setDays] = useState(30),
    [issued, setIssued] = useState("");
  const [creating, setCreating] = useState(false);
  const [creatingKey, setCreatingKey] = useState(false);
  const load = async () => {
    const r = await managedApi<{ secrets: Secret[]; keys: ReaderKey[] }>(
      "/managed/secrets",
    );
    setSecrets(r.secrets);
    setKeys(r.keys);
  };
  useEffect(() => {
    void action.run(load);
  }, []);
  return (
    <>
      <Head
        title="Secrets"
        text="Store provider credentials for your trusted applications. Separate reader keys keep secret access distinct from graph access."
      />
      <p className="small muted">
        Changes require recent verification in{" "}
        <Link to="/app/security">Account security</Link>. Values are encrypted,
        never shown in the list, and never included in audit events.
      </p>
      <div className="section-head">
        <button className="primary" onClick={() => setCreating(true)}>
          Add or rotate secret
        </button>
      </div>
      <Drawer
        open={creating}
        onClose={() => {
          setCreating(false);
          setValue("");
        }}
        title="Add or rotate a secret"
      >
        <section className="panel form-panel">
          <h2>Add or rotate a secret</h2>
          <SubmitForm
            onSubmit={() =>
              void action.run(async () => {
                await managedApi("/managed/secrets", { name, value });
                setValue("");
                setName("");
                await load();
              }, "Secret saved. Its version has been updated.")
            }
          >
            <Field label="Secret name">
              <input
                value={name}
                onChange={(e) => setName(e.target.value.toUpperCase())}
                placeholder="TYPESAFE_API_KEY"
                pattern="[A-Z][A-Z0-9_]{0,63}"
                maxLength={64}
                required
              />
            </Field>
            <Field label="Secret value">
              <input
                type="password"
                autoComplete="off"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                maxLength={65536}
                required
              />
            </Field>
            <button className="primary" disabled={action.busy}>
              <Busy busy={action.busy}>Save secret</Busy>
            </button>
          </SubmitForm>
        </section>
        {action.feedback}
      </Drawer>
      <Disclosure title="Read secrets from your backend">
        <section className="panel form-panel">
          <h2>Read from your backend</h2>
          <p>
            A secret-reader key can read this project’s secrets. It cannot query
            or modify the graph. Keep it in your server’s environment.
          </p>
          <Code
            text={`const response = await fetch(\n  "${connection?.api_url}/secrets/TYPESAFE_API_KEY",\n  { headers: { Authorization:\n    \`Bearer \${process.env.CHRONOGRAPH_SECRET_KEY}\`\n  }}\n);\nif (!response.ok) throw new Error("Secret unavailable");\nconst { value } = await response.json();`}
          />
          <p className="small">
            Connector producers use the returned secret to call their provider.
            Chronograph does not run model inference.
          </p>
        </section>
      </Disclosure>
      <section className="panel form-panel">
        <h2>Project secrets</h2>
        <div className="table-scroll">
          <table className="managed-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Version</th>
                <th>Updated</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {secrets.map((s) => (
                <tr key={s.name}>
                  <td>
                    <code>{s.name}</code>
                  </td>
                  <td>{s.version}</td>
                  <td>{new Date(s.updated_at).toLocaleString()}</td>
                  <td>
                    <button
                      disabled={action.busy}
                      onClick={() =>
                        void action.run(async () => {
                          if (
                            !window.confirm(
                              `Delete ${s.name}? Applications reading it will fail.`,
                            )
                          )
                            return;
                          await managedApi("/managed/secrets/delete", {
                            name: s.name,
                          });
                          await load();
                        })
                      }
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!secrets.length && (
          <p>
            No secrets yet. Add a provider key when your application needs one.
          </p>
        )}
      </section>
      <section className="panel form-panel">
        <div className="section-head">
          <h2>Secret-reader keys</h2>
          <button className="outline" onClick={() => setCreatingKey(true)}>
            New reader key
          </button>
        </div>
        <Drawer
          open={creatingKey}
          onClose={() => {
            setCreatingKey(false);
            setIssued("");
          }}
          title="Create secret-reader key"
        >
          <p className="small">
            This key can read project secrets. Keep it only in a trusted
            backend.
          </p>
          <SubmitForm
            className="member-invite"
            onSubmit={() =>
              void action.run(async () => {
                const r = await managedApi<{ token: string }>(
                  "/managed/secrets/keys",
                  { name: keyName, days },
                );
                setIssued(r.token);
                setKeyName("");
                await load();
              })
            }
          >
            <Field label="Key name">
              <input
                value={keyName}
                onChange={(e) => setKeyName(e.target.value)}
                required
                maxLength={80}
                placeholder="robotics-backend"
              />
            </Field>
            <Field label="Expires in days">
              <input
                type="number"
                min={1}
                max={90}
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
                required
              />
            </Field>
            <button disabled={action.busy}>
              <Busy busy={action.busy}>Create reader key</Busy>
            </button>
          </SubmitForm>
          {issued && (
            <div className="notice">
              <strong>Copy this key now. It will not be shown again.</strong>
              <Code text={issued} />
              <button
                onClick={() => {
                  setIssued("");
                  setCreatingKey(false);
                }}
              >
                I saved it
              </button>
            </div>
          )}
          {action.feedback}
        </Drawer>
        <div className="table-scroll">
          <table className="managed-table">
            <thead>
              <tr>
                <th>Key</th>
                <th>Expires</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td>{k.name}</td>
                  <td>{new Date(k.expires_at).toLocaleString()}</td>
                  <td>
                    <button
                      disabled={action.busy}
                      onClick={() =>
                        void action.run(async () => {
                          if (!window.confirm(`Revoke ${k.name}?`)) return;
                          await managedApi("/managed/secrets/keys/revoke", {
                            id: k.id,
                          });
                          await load();
                        })
                      }
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {action.feedback}
    </>
  );
}
