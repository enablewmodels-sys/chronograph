# Schema and migrations

The Community console includes **Schema & migrations** at `/app/schema`. Define named relationship kinds, map typed properties into their payloads, import migration files and keep an applied history. Visual edits generate the same migration format accepted by HTTP and MCP.

This is a service-level catalog for Chronograph's temporal graph, not a SQL or PostgreSQL engine. A migration changes definitions and service settings; it never executes code, rewrites edge payloads, deletes temporal history, or changes the journal format.

## First relation

1. Connect with an admin token, then open **Schema & migrations → Relations → New relation**.
2. Enter a stable numeric kind, an identifier such as `observes`, and source/target labels such as `sensor` and `object`.
3. Add properties with a type and byte offset. The payload has exactly 16 bytes. Fields cannot overlap.
4. Choose **Create migration**. Review or export the generated JSON in the editor.
5. Choose **Preview migration**. Review the before/after definitions, warnings and schema revision.
6. Choose **Apply migration**. The server validates again, synchronizes the graph, then atomically persists the catalog and history.
7. Open **Write data**, select the schema relation and enter structured properties. The server packs them into little-endian bytes. Query results show the relation name and decoded values; the explorer inspector retains the raw hex too.

Read and ingest tokens can inspect definitions, preview files and encode property values. Only admin tokens can apply migrations. Synthetic preview cannot write or apply schema changes.

Endpoint labels describe intended use. Core node IDs have no stored type tags, so labels do **not** enforce endpoint membership, foreign keys, cardinality or node properties. Schema is shared by main and every branch; it is not versioned with graph valid time and does not fork with graph branches.

## Migration files

Use the included `examples/migrations/20260910_observations.json` as a starting point. Import one JSON file with **Import file**, edit it directly, or generate it from the forms. Files are processed in the browser and sent as text for validation. The server never accepts a filesystem path from a migration.

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

All operations within **one file** succeed together or leave the catalog unchanged. Separate files are separate commits. Unknown fields and operations are rejected. The full source is retained and can be exported from migration history. The checksum is SHA-256 of the normalized typed JSON, so formatting and object-key order do not change identity. Property arrays and operation order remain significant.

An identical ID and checksum is an idempotent retry, even after later migrations. An existing ID with different content returns `409`. A changed schema revision or mismatched preview checksum also returns `409`. Refresh and preview again; do not overwrite history to resolve a conflict.

The console retains the current draft in this browser tab's session storage, scoped to the credential. Viewing applied history does not replace the saved draft. Use **Back to draft** or **Copy to a new migration**. Export a file for durable storage outside the browser.

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

String, JSON, vector and arbitrary node properties are not supported by this 16-byte mapping. Store large values in a sidecar or external store and use an integer reference in the payload.

## Changing existing definitions

Names, descriptions and endpoint documentation can change without rewriting observations. Once a kind has stored versions in main or an active branch, its property layout cannot change and its definition cannot be dropped. Even inactive versions count. This prevents old bytes silently acquiring a different interpretation.

To evolve a used layout, define a new kind, move producers to it and retain the historical definition. Migrations do not transform or copy graph records automatically. Defining a schema for an existing unregistered kind interprets its existing bytes; preview checks their boolean/float validity. Choose offsets that match the actual producer's encoding.

Preview and apply both inspect affected main and active-branch histories when constraints change. Metadata-only updates do not scan graph history. Apply holds the graph write lock so concurrent service writes cannot bypass the validation-to-commit boundary. A preview can become invalid if graph data changes before apply; apply checks data again. This can make previews/applies of constraint changes expensive on large histories.

## Database settings

The **Settings** form generates `set_settings` migrations:

| Setting | Default | Effect |
| --- | --- | --- |
| `name` | `My graph` | Workspace name, 1–80 bytes, exposed in catalog and `/v1/info`. |
| `description` | empty | Workspace description, up to 2000 bytes. |
| `default_durability` | `buffered` | `buffered` or `fsync` for service graph writes that omit durability. Explicit request options take precedence. Console writes explicitly choose fsync. |
| `default_query_limit` | `100` | Default page size, 1–1000, for query/as_of/between/history/neighbors. Explicit limits take precedence. Sampling keeps its own bounds. |
| `strict_relations` | `false` | Require defined kinds for service edge ingestion and merges. Enabling requires every kind in main and active branches to be defined. |

Known property layouts are validated for service writes even when `strict_relations` is false. Strict mode additionally rejects undefined kinds. These checks belong to HTTP/MCP; direct embedded Rust writers and offline connectors bypass them. They must produce compatible bytes. Server file ownership prevents a second engine writer from concurrently opening the same running workspace, but offline embedded changes are possible.

Host binding, TLS, origin, storage locations, worker limits and token administration are not migration settings. See [deployment](DEPLOYMENT.md), [security](SECURITY.md) and Agent access for those controls.

## HTTP and MCP

All HTTP requests require a bearer token and a JSON object body. MCP exposes the same names and authorization rules for Codex, Cursor and Claude.

| POST endpoint / MCP name | Input | Scope |
| --- | --- | --- |
| `/v1/schema` / `schema` | `{}` | read, ingest, admin |
| `/v1/schema_preview` / `schema_preview` | `{"source":"…JSON file contents…"}` | read, ingest, admin |
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

Run files in the intended order. The client accepts one file per invocation, requires HTTPS for remote origins, refuses redirects, and exits nonzero on failure. Retrying the same applied file is safe. It does not roll back a previous file if a later invocation fails.

## Persistence, backup and limits

The service writes `schema.json` inside `CHRONOGRAPH_DATA` with private permissions, a temporary file, fsync and atomic rename. Definitions and history are in one commit. On startup, the service replays every migration and checks checksums and the resulting snapshot. Untracked edits, duplicates and malformed catalogs prevent startup. Do not edit `schema.json` by hand. If persistence fails ambiguously, schema access and service graph writes fail closed until restart reconciles the on-disk state.

Backups capture `schema.json` under the same graph lock as the journal. Restore validates its history before exposing the destination. Credentials remain excluded. Backups created before this feature have no catalog and restore with default settings and no definitions. Older server binaries do not understand these service constraints; use a schema-capable binary to preserve their behavior.

Limits: 256 KiB per file, 128 operations per migration, 1024 definitions, 16 properties per relation, 1024 retained migrations and 8 MiB total catalog. The service's general 4 MiB HTTP body limit also applies. History is retained, not silently pruned. Automatic down migrations, arbitrary DDL/SQL, node-type constraints, background data transformations and history squashing are not implemented.


## Connector migrations (version 2)

The migration editor also provides Family → Connector/model → Version/preset controls. Generated files use `payload_encoding: "arrow_record_v1"` and a `bind_connector` operation. The catalog publishes both in one atomic migration. Bindings are immutable and require unused kinds; sidecar references cannot be decoded as inline numeric properties or submitted through raw `add_edges`. Migration-v1 files and checksums remain supported. See the [connector platform guide](CONNECTOR_PLATFORM.md) for configuration, supported presets, ingestion receipts and the local agent.
