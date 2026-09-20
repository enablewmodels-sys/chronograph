# Agent integrations

Chronograph exposes the tools below over authenticated MCP Streamable HTTP at `/mcp`. The official Rust SDK (`rmcp` 3.2.0) handles protocol negotiation and transport. A native Rust binary exposes the same tools over stdio through the official SDK. Start the service before connecting a client.

For [Managed](HOSTED.md), use the project endpoint shown in **Connections & API keys**:
`https://YOUR_HOST/p/PROJECT_ID/mcp`. For [isolated Community](ISOLATED.md), use
your server origin followed by `/mcp`. The examples below use a local Community
server; replace the URL with the exact endpoint for your deployment.

Create a token in **Connections & API keys**. Choose read-only for exploration and ingest only for agents that should mutate this workspace. Tokens expire after your selected duration and can be revoked immediately. Store the token in a client environment or secret manager; never commit it to a repository. MCP requires a scoped API key; Managed GitHub account login is separate. Managed
console cookies do not authenticate agent clients, and the engine does not provide
an MCP OAuth authorization server.

## Codex

Add this to a trusted project’s `.codex/config.toml` or merge it into `~/.codex/config.toml`. The Codex desktop, CLI and IDE clients share host configuration. Set `CHRONOGRAPH_TOKEN` in the environment of the client process, then restart it.

```toml
[mcp_servers.chronograph]
url = "http://127.0.0.1:8080/mcp"
bearer_token_env_var = "CHRONOGRAPH_TOKEN"
tool_timeout_sec = 60
```

Use `codex mcp list` to inspect registration and `/mcp` in the Codex TUI for connection status. A shell export only affects programs launched from that shell; a desktop app launched from the Dock may need an environment-aware launcher or the documented Codex header helper. The server does not require `codex mcp login`, which is an OAuth flow. See [official Codex MCP configuration](https://developers.openai.com/codex/mcp).

## Cursor

Merge into `.cursor/mcp.json` for a project, or `~/.cursor/mcp.json` globally. Cursor resolves the environment placeholder in headers.

```json
{
  "mcpServers": {
    "chronograph": {
      "url": "http://127.0.0.1:8080/mcp",
      "headers": {
        "Authorization": "Bearer ${env:CHRONOGRAPH_TOKEN}"
      }
    }
  }
}
```

Open Cursor’s MCP settings, enable the server and inspect its tools. Do not substitute Claude’s placeholder syntax here. See [official Cursor MCP documentation](https://cursor.com/docs/mcp).

## Claude Code

Merge into the project’s `.mcp.json`, set the environment variable for the Claude process, and accept the project MCP configuration in Claude Code.

```json
{
  "mcpServers": {
    "chronograph": {
      "type": "http",
      "url": "http://127.0.0.1:8080/mcp",
      "headers": {
        "Authorization": "Bearer ${CHRONOGRAPH_TOKEN}"
      }
    }
  }
}
```

Use `/mcp` to inspect the connection. See [official Claude Code MCP documentation](https://code.claude.com/docs/en/mcp).

## Claude Desktop and other stdio clients

Use `chronograph-mcp`, built with the service. It requires no Node runtime and
connects to the existing HTTP service; it never opens another graph owner.
Configure an absolute binary path and a private token file:

```json
{
  "mcpServers": {
    "chronograph": {
      "command": "/absolute/path/to/chronograph-mcp",
      "env": {
        "CHRONOGRAPH_MCP_URL": "http://127.0.0.1:8080/mcp",
        "CHRONOGRAPH_TOKEN_FILE": "/absolute/path/to/config/agent.token"
      }
    }
  }
}
```

The token file must be mode 0600. `CHRONOGRAPH_TOKEN` is also supported when the
client can supply a secret environment variable. Tokens are never accepted in
URLs or command arguments. Stdout contains only MCP messages; diagnostics go to
stderr. Remote plaintext and HTTP redirects are rejected. Timeouts never trigger
automatic write retry. The compatibility `scripts/mcp-stdio.mjs` launcher simply
starts the native bridge; new installations should use the binary directly.

## Tools and usage

- `ingest_edges`: atomic batch, ingest/admin scope, explicit optional durability.
- `as_of`, `between`, `history`, `neighbors`: bounded temporal pages.
- `sample_neighbors`: batch sampler, nodes × k ≤1000.
- `backup`: consistent journal/index/sidecar archive, admin scope.
- `stats`, `get_edge`, `contains_node`: counters and exact lookups.
- `add_node`, `invalidate_edge`, `sync`: ingest/admin mutations.
- `fork`, `merge`, `discard`: durable branch mutations with ingest/admin scope.
- `forks`, `fork_info`, `preview_merge`: branch metadata, retained results and conflict-aware preview.
- `add_edges` and `query`: documented compatibility tools.

Graph read/write tools accept optional `fork` to select a branch. Edge IDs are local to that selection. Input edges accept optional `valid_to` for atomic bounded intervals. A merge returns node/edge remappings without rewriting opaque payloads; preview first and inspect conflicts. See [durable branches](BRANCHES.md).

Writes use the effective deployment policy. Managed and the production Compose
recipe enforce fsync; buffered requests are rejected. Other Community deployments
use the catalog default, initially buffered. Set `durability: "fsync"` on writes
or call `sync`; read the returned acknowledgement policy. The console selects
fsync explicitly. A stale pagination cursor returns a conflict, including when
the graph changes between MCP calls.

Ask the client: “Use Chronograph stats, then query at timestamp `2000000` with limit 20. Report whether more pages exist.” For an ingest token, explicitly request the desired graph mutation. Tool annotations describe read-only, destructive and idempotent behavior; the server enforces scopes independently of the model’s decisions.

All tool IDs and microsecond timestamps are decimal strings. Check `next_cursor` before claiming a query is complete. A token grants workspace-wide scope, not row-level filtering. Do not automatically retry an ambiguous insertion. See [API semantics](API.md).

## Verification and troubleshooting

`node scripts/protocol-test.mjs` starts disposable local services, uses the official TypeScript client to initialize/list/call, exercises the stdio bridge, verifies scope and revocation, forces a restart, and checks restore. It does not modify your global client configuration or invoke a paid language-model session. Test reports distinguish protocol compatibility from an interactive session in a particular client application.

- 401: token missing, expired or revoked; the client may not have inherited its environment.
- 403: check scope, exact origin and Host; do not use a cookie for MCP.
- “Connection refused”: run the service; match the configured port.
- Wrong endpoint/HTML response: use `/mcp`, not `/` or `/app`.
- Desktop stdio startup error: use absolute paths, build chronograph-mcp and check private token-file permissions.
- 429: respect Retry-After; reduce request/verification rate. 503: the worker/auth queue is saturated.
- Remote deployment: use the same public HTTPS origin as the UI. OAuth-only hosted connectors need a separate authorization provider; they are not supported by token configuration alone.

## Schema tools

`schema`, `schema_preview`, `schema_plan`, `schema_export`, `schema_rollback`, `schema_migration` and `schema_encode` are available to every scope. `schema_apply` and `schema_apply_plan` require admin scope and the checksum/revision returned by their corresponding preview. `schema_rollback` only drafts a safe compensation; it does not apply changes. Agents can submit dependency-ordered files in one atomic plan, inspect before/after definitions, and explicitly apply the reviewed plan. All clients (Codex, Cursor, Claude) use the same tools and authorization boundary. See [migration format, property encoding and service-only constraints](SCHEMA.md).
