# Reproducible Neo4j comparison

Status on the implementation machine: **pending**. The Docker client is installed,
but the daemon check timed out after ten seconds. There are no Neo4j measurements.

From the workspace root, generate the default ten-million-version dataset:

```sh
cargo run --release -p chronograph-bench --bin measure -- --export
docker compose -f bench/neo4j/docker-compose.yml up -d --wait
python3 bench/neo4j/run.py --load --rows
docker compose -f bench/neo4j/docker-compose.yml down
```

The loader requires an empty database and never deletes existing data. Docker
retains its named volume after `down`; choose a new Compose project name and use
the corresponding name for the runner if you need another independent import.
The scripts use a fixed, local-only benchmark password, not application credentials.

The pinned Community image uses a 2 GiB heap, 3 GiB page cache, 7 GiB container
limit, and 10 CPUs. Record the image digest, Docker VM resources and host details
with results. Run engines sequentially so they do not contend for memory or CPUs.

`edges.csv` contains exactly the final intervals produced by the operation stream
in `operations.csv`. Replay operations in row order, then apply nonempty
`invalidate_at` values to their IDs. Payloads are represented as hex strings in
Neo4j; Chronograph stores 16 raw bytes. Nodes and relationships are loaded in
10,000-row transactions. The loader creates node uniqueness and relationship
start/end indexes and waits for the indexes to become usable.

The runner uses the persistent HTTP Query API connection, ten warm-up queries,
and the same 200 seeded timestamps as Chronograph. It checks counts and ID sums
against independent expected results and saves a PROFILE response. It reports:

- Aggregate count plus ID sum, including transport and JSON parsing.
- With `--rows`, all seven projected fields (six data fields plus validation ID),
  consumed through the streaming Query API, also including transport/parsing.

Chronograph's traversal is an in-process count/checksum over yielded edge values;
its Arrow export separately measures column materialization. Do not describe
Neo4j's HTTP result as pure engine latency or compare a count-only query with row
transfer without naming the distinction. CSV loading plus index construction is
not equivalent to Chronograph's live version insertion. A general-purpose database
offers functionality outside this MVP, so these numbers cannot establish a general
database ranking. Cold OS caches are not forced; mark results as warm traversal.

References: [Docker deployment](https://neo4j.com/docs/operations-manual/current/docker/docker-compose-standalone/),
[Query API streaming](https://neo4j.com/docs/query-api/current/streaming/),
[relationship indexes](https://neo4j.com/docs/cypher-manual/current/indexes/search-performance-indexes/using-indexes/).
