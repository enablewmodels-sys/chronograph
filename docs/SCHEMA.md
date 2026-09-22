# Schema and migrations

Both Managed and isolated Community deployments include **Schema & migrations** at `/app/schema`. In Managed, select the project first: its catalog, history, API keys and data stay isolated from other projects. Define named relationship kinds, map typed properties into their payloads, import migration files and keep an applied history. Visual edits generate the same migration format accepted by HTTP and MCP.

This is a service-level catalog for Chronograph's temporal graph, not a SQL or PostgreSQL engine. A migration changes definitions and service settings; it never executes code, rewrites edge payloads, deletes temporal history, or changes the journal format.

## First relation

1. Sign in to Managed with an owner/admin account, or connect Community with an admin key, then open **Schema & migrations → Relations → New relation**.
2. Enter a stable numeric kind, an identifier such as `observes`, and source/target labels such as `sensor` and `object`.
3. Add properties with a type and byte offset. The payload has exactly 16 bytes. Fields cannot overlap.
4. Choose **Create migration**. Review or export the generated JSON in the editor.
5. Choose **Preview migration**. Review the before/after definitions, warnings and schema revision.
6. Choose **Apply migration**. The server validates again, synchronizes the graph, then atomically persists the catalog and history.
7. Open **Write data**, select the schema relation and enter structured properties. The server packs them into little-endian bytes. Query results show the relation name and decoded values; the explorer inspector retains the raw hex too.

Read and ingest tokens can inspect definitions, preview files and encode property values. Only admin tokens can apply migrations. Synthetic preview cannot write or apply schema changes.

Endpoint labels describe intended use. Core node IDs have no stored type tags, so labels do **not** enforce endpoint membership, foreign keys, cardinality or node properties. Schema is shared by main and every branch; it is not versioned with graph valid time and does not fork with graph branches.

## Console editor

Open **Schema & migrations → Migrations**. The JSON editor provides line numbers,
syntax highlighting, JSON diagnostics, undo/redo and bracket matching. Tab moves
focus out of the editor, so keyboard users can reach the preview controls.
**Presets** opens the model/connector generator. **Preview migration** opens a
review panel beside the source (below it on smaller screens); **Back to editing**
dismisses the preview without losing the draft. **Migration history** expands the
applied records and rollback controls. Client-side JSON hints supplement server
validation; they do not authorize an apply. Revision/checksum checks and atomic
multi-file semantics apply to both deployment editions.

## Migration files

Use the included `examples/migrations/20260910_observations.json` as a starting point. Use **Import files** to select one or more JSON files (sorted by filename), edit them directly, or generate them from the forms. A single object, an ordered array of migrations, or a `{ "migrations": [...] }` bundle is accepted by the editor and CLI. Files are processed in the browser and sent as text for validation. The server never accepts a filesystem path from a migration.

```json
{
  "version": 1,
  "id": "20260910_observations",
  "name": "Define observation properties",
  "operations": [
    {
      "op": "upsert_relation",
      "relation": {
        "kind": 10,
        "name": "observes",
        "description": "Sensor confidence and sequence",
        "source_label": "sensor",
        "target_label": "object",
        "properties": [
          { "name": "confidence", "type": "f32", "offset": 0 },
          { "name": "sequence", "type": "u64", "offset": 8 }
        ]
      }
    }
  ]
}
```

Commit migration files to your application's version control. IDs contain 1–96 ASCII letters, digits, underscores or hyphens. Timestamp prefixes are a convention; the server records actual application order. Use a **new ID** to amend an applied migration. Names contain 1–120 bytes; relation, property and endpoint identifiers use `[A-Za-z_][A-Za-z0-9_]*` and at most 64 bytes.

Supported operations:

| Operation | Fields | Behavior |
| --- | --- | --- |
| `upsert_relation` | `relation` | Create or replace one complete definition by numeric `kind` (0–65535). Names and kinds must be unique in the resulting catalog. |
| `drop_relation` | `kind` | Remove an unused definition. Unknown or used kinds are rejected. Does not remove graph records. |
| `set_settings` | `settings` | Patch one or more supported settings. Omitted settings remain unchanged. |
| `bind_connector` (v2+) | `binding` | Register a validated connector/model contract and unused sidecar relation kind. |
| `patch_relation` (v3) | `kind`, `patch` | Update selected name, description, endpoint labels or properties; omitted fields stay unchanged. `properties` replaces the whole list. |
| `rename_property` (v3) | `kind`, `from`, `to` | Change a field name while preserving its type, offset and every stored payload. |
| `unbind_connector` (v3) | `id` | Remove an unused binding. Used bindings remain protected, including on active branches. |

All operations within one file succeed together. With `schema_apply_plan`, **all pending files commit together** or no file is applied. Files submitted through separate apply requests remain separate commits. Each intermediate file must define a valid catalog: put tightly coupled relation/binding changes in the same file. Unknown fields and operations are rejected. The full source is retained and can be exported from migration history. The checksum is SHA-256 of the normalized typed JSON, so formatting and object-key order do not change identity. Property arrays and operation order remain significant.

An identical ID and checksum is an idempotent retry, even after later migrations. An existing ID with different content returns `409`. A changed schema revision or mismatched preview checksum also returns `409`. Refresh and preview again; do not overwrite history to resolve a conflict.

The console retains the current draft in this browser tab's session storage, scoped to the selected project and credential. Viewing applied history does not replace the saved draft. Use **Back to draft** or **Copy to a new migration**. Export a file for durable storage outside the browser.

## Typed payloads

| Type | Bytes | JSON representation |
| --- | --- | --- |
| `bool` | 1 | `true` / `false`; raw byte must be 0 or 1 |
| `u32` / `i32` | 4 | In-range integer number |
| `u64` / `i64` | 8 | In-range decimal **string** to preserve exact precision |
| `f32` / `f64` | 4 / 8 | Finite JSON number; f32 rounding applies |

All fields use little-endian encoding and explicit offsets starting at 0. Unmapped bytes are zeroed for structured writes. Raw hex writes preserve unmapped bytes. A structured write requires exactly every defined property, with no unknown names. Provide `properties` **or** `payload`; providing both is rejected. Without either, the payload defaults to 16 zero bytes and is still validated against a known definition.

```json
{
  "edges": [{
    "src": "1001", "dst": "1002", "kind": 10, "valid_from": "5000000",
    "properties": { "confidence": 0.75, "sequence": "18446744073709551615" }
  }],
  "durability": "fsync"
}
```

POST this to `/v1/edges` or use MCP `ingest_edges`. `schema_encode` validates and packs properties without writing. Queries preserve the existing `payload` field and add `relation` and `properties` when a definition exists. Invalid bytes written through an external embedded client retain their raw payload and return `schema_error` instead of misleading decoded values. Arrow export continues to contain the native graph fields and raw payload; the catalog is available separately through `schema`.

String, JSON and vector values do not fit this inline mapping. Use the typed sidecar records and assets in the [connector platform](CONNECTOR_PLATFORM.md) for larger observations, tensors, actions and metadata. Connector schemas are validated contracts; a migration does not install an arbitrary model runtime. Arbitrary node property bags are not implemented.

## Changing existing definitions

Names, descriptions and endpoint documentation can change without rewriting observations. Once a kind has stored versions in main or an active branch, its property types and byte offsets cannot change and its definition cannot be dropped. Property names can change: all historical query results then use the current names. Applications must coordinate their producers and consumers with a rename. Even inactive versions count. This prevents old bytes silently acquiring a different interpretation.

To evolve a used layout, define a new kind, move producers to it and retain the historical definition. Migrations do not transform or copy graph records automatically. Defining a schema for an existing unregistered kind interprets its existing bytes; preview checks their boolean/float validity. Choose offsets that match the actual producer's encoding.

Preview and apply both inspect affected main and active-branch histories when constraints change. Metadata-only updates do not scan graph history. Apply holds the graph write lock so concurrent service writes cannot bypass the validation-to-commit boundary. A preview can become invalid if graph data changes before apply; apply checks data again. This can make previews/applies of constraint changes expensive on large histories.

## Database settings

The **Settings** form generates `set_settings` migrations. These apply to the
selected Managed project or the connected isolated Community workspace. Managed
and servers with `CHRONOGRAPH_REQUIRE_FSYNC=true` reject migrations that select
buffered durability. The operator floor takes precedence over catalog/request
options; the effective policy appears in Operations and `/v1/info`.

| Setting | Default | Effect |
| --- | --- | --- |
| `name` | `My graph` | Workspace name, 1–80 bytes, exposed in catalog and `/v1/info`. |
| `description` | empty | Workspace description, up to 2000 bytes. |
| `default_durability` | `buffered` | `buffered` or `fsync` for service graph writes that omit durability. Explicit request options take precedence unless the operator enforces fsync. Console writes explicitly choose fsync. |
| `default_query_limit` | `100` | Default page size, 1–1000, for query/as_of/between/history/neighbors. Explicit limits take precedence. Sampling keeps its own bounds. |
| `strict_relations` | `false` | Require defined kinds for service edge ingestion and merges. Enabling requires every kind in main and active branches to be defined. |

Known property layouts are validated for service writes even when `strict_relations` is false. Strict mode additionally rejects undefined kinds. These checks belong to HTTP/MCP; direct embedded Rust writers and offline connectors bypass them. They must produce compatible bytes. Server file ownership prevents a second engine writer from concurrently opening the same running workspace, but offline embedded changes are possible.

Host binding, TLS, origin, storage locations, worker limits and token administration are not migration settings. See [deployment](DEPLOYMENT.md), [security](SECURITY.md) and Connections & API keys for those controls.

## HTTP and MCP

External HTTP requests require a project API key (Managed) or workspace API key (Community), and a JSON object body. The Managed console uses its authenticated session. For Managed, prefix the endpoints below with `/p/PROJECT_ID`; the CLI supports that exact base URL. MCP exposes the same names and authorization rules for Codex, Cursor and Claude.

| POST endpoint / MCP name | Input | Scope |
| --- | --- | --- |
| `/v1/schema` / `schema` | `{}` | read, ingest, admin |
| `/v1/schema_preview` / `schema_preview` | `{"source":"…JSON file contents…"}` | read, ingest, admin |
| `/v1/schema_plan` / `schema_plan` | `{"sources":["…file 1…","…file 2…"]}` | read, ingest, admin |
| `/v1/schema_apply_plan` / `schema_apply_plan` | `{"sources":["…"],"checksum":"…","expected_revision":0}` | admin |
| `/v1/schema_export` / `schema_export` | `{"id":"baseline_001","name":"Portable baseline"}` | read, ingest, admin |
| `/v1/schema_rollback` / `schema_rollback` | `{"target_revision":1,"id":"restore_001","name":"Restore definitions"}` | read, ingest, admin; **preparation only** |
| `/v1/schema_apply` / `schema_apply` | `{"source":"…","checksum":"…","expected_revision":0}` | admin |
| `/v1/schema_migration` / `schema_migration` | `{"id":"20260910_observations"}` | read, ingest, admin |
| `/v1/schema_encode` / `schema_encode` | `{"kind":10,"properties":{"confidence":0.75,"sequence":"1"}}` | read, ingest, admin |

Preview returns `before`, `after`, operations, warnings, checksum and `expected_revision`. Apply returns `schema_revision`, `applied`, `already_applied` and ID. Schema revision counts applied files; it is separate from the engine's graph revision.

For a file-based workflow, the optional Node 20+ client reads a local token file without putting credentials in command-line arguments:

```sh
# Preview only. The server must already be running.
node scripts/migrate.mjs --file examples/migrations/20260910_observations.json \
  --token-file config/admin.token --url http://127.0.0.1:8080

# Apply a reviewed file. Revalidation protects against concurrent changes.
node scripts/migrate.mjs --file examples/migrations/20260910_observations.json \
  --token-file config/admin.token --url http://127.0.0.1:8080 --apply
```

## Ordered plans and dependencies

Version 3 adds explicit dependencies. Existing v1/v2 files and their checksums remain valid. A dependency must already be applied, or occur earlier in the submitted plan; files are never reordered automatically. Duplicate IDs in a plan and cycles/missing dependencies are rejected. Applied files with matching checksums are skipped. The plan checksum binds the ordered IDs and each normalized file checksum; `expected_revision` prevents concurrent plans from overwriting one another.

```json
{
  "version": 3,
  "id": "002_score_name",
  "name": "Rename confidence to score",
  "requires": ["20260910_observations"],
  "operations": [
    { "op": "rename_property", "kind": 10, "from": "confidence", "to": "score" },
    { "op": "patch_relation", "kind": 10, "patch": { "description": "Decision confidence" } }
  ]
}
```

The ready-to-run `examples/migrations/ordered/` folder demonstrates definitions, a dependency-bound rename and settings. Use it on an empty test workspace first.

```sh
chmod 600 config/admin.token
# Preview an entire folder; pending/applied entries and before/after are returned.
node scripts/migrate.mjs --dir examples/migrations/ordered \
  --token-file config/admin.token --url http://127.0.0.1:8080
# Apply the folder as one catalog commit.
node scripts/migrate.mjs --dir examples/migrations/ordered \
  --token-file config/admin.token --url http://127.0.0.1:8080 --apply
# The same client targets a specific Managed project.
node scripts/migrate.mjs --status --token-file config/project-admin.token \
  --url https://YOUR_HOST/p/PROJECT_ID
```

The CLI previews and then applies when `--apply` is present. For a separately approved deployment, retain the exact source files, checksum and expected revision returned by `schema_plan`, then submit them to `schema_apply_plan`. A stale plan fails with `409`; review a fresh preview instead of forcing it. Retrying an entirely applied plan is safe, including after subsequent migrations. A partially applied plan only commits its pending files if the revision still matches.

The client refuses redirects, accepts HTTPS remotely and HTTP only on loopback, rejects symlink input files, requires a private token file on Unix, and exits nonzero on any failure. Secrets must never appear in migration files. `secret_refs` name producer-side secrets without containing their values.

## Export and safe rollback

**Export schema** downloads a replayable baseline for a new empty workspace. It contains current relations, connector bindings and service settings, split into dependency-ordered files when necessary. It excludes graph data, sidecar assets, credentials and original applied history. Import it through the editor or CLI; use a full backup when you need data and historical migrations. On a deployment that enforces fsync, generated baselines retain that floor.

```sh
node scripts/migrate.mjs --export --out baseline.json --token-file config/admin.token
node scripts/migrate.mjs --file baseline.json --token-file config/new-workspace.token \
  --url http://127.0.0.1:8082 --apply
```

In **Migrations → Restore definitions from revision**, select an earlier revision and choose **Prepare rollback**. This drafts a **new compensating migration**; review its preview and explicitly apply it. The current catalog is not changed by preparation. CLI `--rollback REVISION` also prepares only unless `--apply` is given. MCP `schema_rollback` returns `sources` and a plan `preview` suitable for review, followed by `schema_apply_plan`.

Rollback preserves every applied history entry and graph record. It rejects removing a used kind or connector, changing a used byte layout, or enabling strict relations over undefined historical kinds. Operator-enforced fsync is preserved even when the target predates it. A compensation that exceeds 128 operations must be designed as smaller reviewed migrations; it is not silently split into potentially invalid intermediate states. Rollback cannot undo ingestion or resurrect discarded branches.

## Schema evolution beyond metadata

For a new payload encoding or changed numeric field types, allocate a new relation kind (and a new connector binding when needed), then migrate producers. Backfill with an explicit ingestion job, check its results, and retain the old kind to keep historical queries interpretable. Data backfills are separate from schema commits and need their own retry/receipt strategy. This system does not execute SQL, JavaScript, shell hooks or arbitrary data-transformation code.

## Persistence, backup and limits

The service writes `schema.json` inside `CHRONOGRAPH_DATA` with private permissions, a temporary file, fsync and atomic rename. Definitions and history are in one commit. On startup, the service replays every migration and checks checksums and the resulting snapshot. Untracked edits, duplicates and malformed catalogs prevent startup. Do not edit `schema.json` by hand. If persistence fails ambiguously, schema access and service graph writes fail closed until restart reconciles the on-disk state.

Backups capture `schema.json` under the same graph lock as the journal. Restore validates its history before exposing the destination. Credentials remain excluded. Backups created before this feature have no catalog and restore with default settings and no definitions. Older server binaries do not understand these service constraints; use a schema-capable binary to preserve their behavior.

Limits: 64 files / 1 MiB of source text per plan, 256 KiB per file, 128 operations per migration, 1024 definitions, 16 properties per relation, 1024 retained migrations and 8 MiB total catalog. The service's general 4 MiB HTTP body limit also applies. History is retained, not silently pruned. Automatic destructive down migrations, arbitrary DDL/SQL, node-type constraints, background data transformations and history squashing are not implemented.


## Connector migrations (version 2)

The migration editor also provides Family → Connector/model → Version/preset controls. Generated files use `payload_encoding: "arrow_record_v1"` and a `bind_connector` operation. The catalog publishes both in one atomic migration. Bindings require unused kinds and cannot be changed or removed while their kind has stored versions; sidecar references cannot be decoded as inline numeric properties or submitted through raw `add_edges`. Migration-v1 files and checksums remain supported. See the [connector platform guide](CONNECTOR_PLATFORM.md) for configuration, supported presets, ingestion receipts and the local agent.

Version-3 catalog entries require this release or newer. Before upgrading, keep a verified backup and its compatible binary. Deploying the new binary alone does not change a catalog; after applying v3 files, an older binary must use the retained pre-upgrade backup, not the upgraded catalog. See [upgrade notes](UPGRADE_0_4.md).


### Evolving connector and model schemas

Choose **Family → Connector/model → Version/preset** in the editor to generate a validated v2 contract. Those files can be included directly in a v3 batch; the batch itself has no separate migration version. A subsequent v3 file can declare `requires` on the generated migration ID and patch the relation's name, description or endpoint labels.

To retire an unused contract, put both operations in one file so the final catalog remains valid:

```json
{
  "version": 3,
  "id": "retire_unused_model",
  "name": "Retire an unused model binding",
  "operations": [
    { "op": "unbind_connector", "id": "model_trial" },
    { "op": "drop_relation", "kind": 42000 }
  ]
}
```

The IDs above are placeholders for an existing unused binding. Removing a binding with stored records fails, even when its relation remains. For used JEPA/Jev, BCI, robotics or quantum contracts, create a new instance and kind for the new configuration and retain the prior binding. Exported schema baselines include connector configurations and secret reference names; they do not copy provider credentials, assets, checkpoints or ingestion receipts. Full backups preserve data and receipts.
