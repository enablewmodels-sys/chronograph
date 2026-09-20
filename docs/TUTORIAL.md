# Replay a world-model relationship

This small example records an agent's relative position to an object. It then accepts a delayed observation and queries the corrected history. The data is synthetic: there is no robot, perception model or sensor connection involved.

The question is precise: **after accepting all observations, which relative-position version is active at 2.75 seconds?**

## Try the temporal model in Managed

Create a [Managed project](HOSTED.md), open its console and load the synthetic
sample into the empty graph. In **Temporal explorer**, query at `2000000`
microseconds, then `-1`, to compare an observed scene with its empty earlier state.
Use **Write data** to add your own relationship and **Schema & migrations** to name
its relation and map its properties. Changes are persisted in that project.
Switch the graph preview to **Tree layout** to inspect its displayed hierarchy.
API keys and MCP clients query the same database; see [Managed connections](HOSTED.md#api-keys-and-endpoints).

## Try the same workflow in isolated Community

Follow the [self-hosted quickstart](ISOLATED.md), open your local console and
connect with a scoped key. Load the same sample into an empty workspace and use
**Temporal explorer**, **Write data** and **Schema & migrations** as described above.
The temporal semantics are identical; Community credentials belong to your one
workspace, while Managed keys belong to the selected project.

For programmatic access, create a read key and save it privately as
`/private/chronograph-read.token` (mode 0600). This Python standard-library example
queries either deployment. Set the base to your exact Managed project URL or to
`http://127.0.0.1:8080` for a local Community server. Keep remote URLs on HTTPS.

```python
import json
from pathlib import Path
import urllib.request

base = "https://YOUR_HOST/p/YOUR_PROJECT_ID"
token = Path("/private/chronograph-read.token").read_text().strip()
request = urllib.request.Request(
    base + "/v1/as_of",
    data=json.dumps({"t": "2000000", "limit": 100}).encode(),
    headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
    method="POST",
)
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None
with urllib.request.build_opener(NoRedirect()).open(request, timeout=15) as response:
    graph = json.load(response)
print(graph["count"], "relationships active at 2 seconds")
```

The sample loaded by the console has eight active relationships at this time.
An empty database returns zero. Do not log the token or use an admin key for this
read. See [SDKs](SDK.md) for reusable clients and [production operations](PRODUCTION.md)
for durability, metrics and deployment checks for both editions.

The embedded example below is a separate, smaller fixture demonstrating delayed
observations and exact interval boundaries. It does not write to your hosted project.

## Run it locally

With Rust 1.93 or newer installed, run this from the source checkout's root:

```sh
cargo run --locked --release -p chronograph-db --example world_model
```

The first run downloads and compiles dependencies. No server, frontend, cloud account or database configuration is required. The example creates a temporary database, closes and reopens it, then removes it. A fresh run produces:

```text
Gridworld replay: agent -> object relative x position
t=0.00s  x=0.0  version=0  interval=[0, 1000000)
t=1.00s  x=1.0  version=1  interval=[1000000, 2000000)
t=2.00s  x=2.0  version=2  interval=[2000000, 2500000)
t=2.75s  x=2.5  version=8  interval=[2500000, 3000000)
t=3.00s  x=3.0  version=3  interval=[3000000, 4000000)
t=7.00s  x=7.0  version=7  interval=[7000000, 9223372036854775807)
Arrow snapshot: 1 row(s), 6 columns
Reopened: 3 nodes, 9 historical versions
```

This output was verified with the release build on 9 September 2026. The complete source is `examples/world_model.rs` in the source bundle.

## Read the result

`NodeId(0)` is the agent and `NodeId(1)` the object. `EdgeKind(1)` represents relative position. Those meanings are application conventions; the database stores numeric identities and a typed relationship, not built-in object labels.

The example first inserts eight versions at one-second intervals. The same `(source, destination, kind)` identifies their relationship. Each newer version closes the preceding active version. Timestamps use integer microseconds, and an interval includes its start and excludes its end.

After the eight inserts, a ninth observation arrives with timestamp `2_500_000`. Its x position is `2.5`. The database places it between the existing starts at 2 and 3 seconds:

| Version | Active interval | Relative x |
| --- | --- | --- |
| 2 | `[2.0 s, 2.5 s)` | 2.0 |
| 8, inserted late | `[2.5 s, 3.0 s)` | 2.5 |
| 3 | `[3.0 s, 4.0 s)` | 3.0 |

At 2.75 seconds the answer is version 8. At exactly 3 seconds the answer is version 3. Version IDs follow insertion order, so they do not necessarily follow observation time.

The final version's end is `i64::MAX`, the open-ended sentinel. All nine versions remain stored. The third node is an isolated identity, demonstrating that nodes can exist without active edges.

## What the code stores

Each edge carries 16 opaque bytes. The first eight observations encode four little-endian `f32` values: x, y, z and confidence. The delayed example sets x and leaves the remaining bytes at zero. It replaces a complete payload; it does not merge fields with its predecessor. Your importer should explicitly encode every value it needs to retain.

The temporal query is:

```rust
for edge in graph.as_of(2_750_000).edges() {
    let x = f32::from_le_bytes(edge.payload[..4].try_into().unwrap());
    println!("x={x}, version={}", edge.id.0);
}
```

`as_of` creates a view. Consuming `edges()` scans retained versions and returns active ones. Use `neighbors(node, timestamp)` when the question concerns a particular source node. See [architecture](ARCHITECTURE.md) for query complexity and sampling semantics.

The example then exports one active row as six Arrow columns, calls `close()` and reopens the log. Its explicit `sync()` and `close()` establish durability boundaries; the embedded API defaults to buffered writes.

## Apply it to one of your episodes

Start with one derived relationship stream, such as an agent's relative position to an object. Define stable numeric IDs, one relation kind, timestamp units and a payload encoding. Choose a few timestamps where you already know the correct answers, then compare the graph result with your existing representation. Include a delayed observation and a boundary timestamp.

Keep images, raw waveforms and large tensors in your existing storage. A compact payload can contain an external identifier, but the application must coordinate that external data. If a relationship stops without a replacement, explicitly invalidate its current version. If the destination changes, it is a different relationship tuple; adding the new edge alone does not close the old one.

This is corrected valid-time history. It does not retain a second transaction-time axis to answer what the database believed before the correction arrived. All history and indexes remain in memory, and one process owns the database file. Review [the limits](LIMITATIONS.md) before choosing a long-running workload.

## Explore the console and agents

Follow the [service quickstart](QUICKSTART.md) to run the authenticated console and load its separate synthetic sample workspace. The service owns its own database; do not open that same file simultaneously from this embedded example. [MCP setup](MCP.md) explains scoped access for Codex, Cursor and Claude.

If you try a real workload, use the repository's alpha feedback template to report your first useful query, setup time, what was difficult to represent and whether you would use it again. See `CONTRIBUTING.md` in the source bundle. Use synthetic reproductions in public reports.
