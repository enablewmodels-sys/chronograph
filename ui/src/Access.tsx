import { useEffect, useState } from "react";
import { api } from "./api";
import { useAuth } from "./main";
import {
  Busy,
  Code,
  DocLink,
  Field,
  Head,
  SubmitForm,
  useAction,
} from "./shared";
interface Token {
  id: string;
  name: string;
  scope: string;
  expires_at: number;
  created_at: number;
}
export default function Access() {
  const { connection } = useAuth(),
    action = useAction(),
    [client, setClient] = useState("Codex"),
    [tokens, setTokens] = useState<Token[]>([]),
    [name, setName] = useState(""),
    [scope, setScope] = useState("read"),
    [days, setDays] = useState(30),
    [secret, setSecret] = useState("");
  const refresh = async () =>
    setTokens((await api<{ tokens: Token[] }>("/v1/tokens")).tokens);
  useEffect(() => {
    void action.run(refresh);
  }, []);
  const url = connection!.mcp_url;
  const config =
    client === "Codex"
      ? `[mcp_servers.chronograph]\nurl = "${url}"\nbearer_token_env_var = "CHRONOGRAPH_TOKEN"\ntool_timeout_sec = 60`
      : JSON.stringify(
          {
            mcpServers: {
              chronograph: {
                ...(client === "Claude" ? { type: "http" } : {}),
                url,
                headers: {
                  Authorization:
                    client === "Cursor"
                      ? "Bearer ${env:CHRONOGRAPH_TOKEN}"
                      : "Bearer ${CHRONOGRAPH_TOKEN}",
                },
              },
            },
          },
          null,
          2,
        );
  return (
    <>
      <Head title="Connect your agents." text="Scoped access. One protocol." />
      <div className="agent-layout">
        <section>
          <div role="tablist" aria-label="MCP client" className="tabs">
            {["Codex", "Cursor", "Claude"].map((c) => (
              <button
                key={c}
                role="tab"
                aria-selected={client === c}
                onClick={() => setClient(c)}
              >
                {c}
              </button>
            ))}
          </div>
          <div className="panel form-panel">
            <h2>MCP configuration</h2>
            <p>
              {client === "Codex"
                ? "Add to your trusted project’s .codex/config.toml."
                : client === "Cursor"
                  ? "Add to .cursor/mcp.json in your project."
                  : "Add to .mcp.json for Claude Code. Claude Desktop can use the documented stdio bridge."}
            </p>
            <Code text={config} />
            <p className="small">
              Provide CHRONOGRAPH_TOKEN in the client’s environment and restart
              the client. The server uses Streamable HTTP with bearer
              authentication.
            </p>
            <DocLink to="MCP">Client setup and verification</DocLink>
          </div>
        </section>
        <aside className="access-note">
          <span className="mono">Access model</span>
          <h2>
            Only the scope
            <br />
            you grant.
          </h2>
          <dl>
            <div>
              <dt>Read only</dt>
              <dd>Stats, history, time queries and neighborhood sampling.</dd>
            </div>
            <div>
              <dt>Read + write</dt>
              <dd>
                Also register nodes, insert versions, invalidate and sync.
              </dd>
            </div>
            <div>
              <dt>Admin</dt>
              <dd>Admin tokens manage credentials and backups.</dd>
            </div>
          </dl>
        </aside>
      </div>
      <section className="panel form-panel">
        <div className="section-head">
          <h2>Access tokens</h2>
          <span className="small muted">Tokens are shown once.</span>
        </div>
        <SubmitForm
          className="token-form"
          onSubmit={() =>
            void action.run(async () => {
              const created = await api<{ token: string }>(
                "/v1/tokens",
                "POST",
                { name, scope, days },
              );
              setSecret(created.token);
              setName("");
              await refresh();
            }, "Token created. Store it securely before leaving this page.")
          }
        >
          <Field label="Token name">
            <input
              placeholder="Research assistant"
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="Scope">
            <select value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="read">Read only</option>
              <option value="ingest">Read + ingest</option>
              <option value="admin">Admin</option>
            </select>
          </Field>
          <Field label="Expiry">
            <select
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            >
              {[1, 7, 30, 90, 365].map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </select>
          </Field>
          <button className="primary" disabled={action.busy}>
            <Busy busy={action.busy}>Create token</Busy>
          </button>
        </SubmitForm>
        {action.feedback}
        {secret && (
          <div className="secret-panel">
            <div className="section-head">
              <strong>Copy your token now</strong>
              <button className="ghost" onClick={() => setSecret("")}>
                Dismiss secret
              </button>
            </div>
            <Code text={secret} />
            <p className="small">
              Keep this in your client’s secret storage. It cannot be retrieved
              later.
            </p>
          </div>
        )}
        <div className="table-scroll">
          <table className="token-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Scope</th>
                <th>Expires</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td>
                    <span className="scope-badge">{t.scope}</span>
                  </td>
                  <td>
                    {new Date(t.expires_at * 1000).toLocaleDateString()}
                    {t.expires_at * 1000 < Date.now() ? " (expired)" : ""}
                  </td>
                  <td>
                    <button
                      className="ghost danger"
                      disabled={action.busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Revoke “${t.name}”? Connected agents will lose access.`,
                          )
                        )
                          void action.run(async () => {
                            await api(`/v1/tokens/${t.id}`, "DELETE");
                            setSecret("");
                            await refresh();
                          }, "Token revoked.");
                      }}
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {tokens.length === 0 && (
            <p className="empty-table">
              No tokens yet. Create a read-only token to connect your first
              agent.
            </p>
          )}
        </div>
      </section>
    </>
  );
}
