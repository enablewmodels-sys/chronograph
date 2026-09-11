#!/usr/bin/env python3
"""Standard-library-only Neo4j Query API comparator. Run from the workspace root."""
import argparse
import base64
import csv
import http.client
import json
import math
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]
PREDICATE = "MATCH ()-[e:REL]->() WHERE e.valid_from <= $t AND (e.valid_to = $max OR e.valid_to > $t) "
COUNT = PREDICATE + "RETURN count(e), coalesce(sum(e.edge_id), 0)"
ROWS = PREDICATE + "RETURN e.edge_id, e.src, e.dst, e.kind, e.valid_from, e.valid_to, e.payload"


class Client:
    def __init__(self):
        self.connection = http.client.HTTPConnection("127.0.0.1", 7474, timeout=600)
        self.auth = base64.b64encode(b"neo4j:chronograph-benchmark").decode()

    def query(self, statement, params=None, stream=False):
        body = json.dumps({"statement": statement, "parameters": params or {}})
        started = time.perf_counter_ns()
        self.connection.request("POST", "/db/neo4j/query/v2", body, {
            "Authorization": "Basic " + self.auth,
            "Content-Type": "application/json",
            "Accept": "application/jsonl" if stream else "application/json",
        })
        response = self.connection.getresponse()
        if response.status >= 300:
            raise RuntimeError(f"HTTP {response.status}: {response.read().decode()}")
        if not stream:
            result = json.loads(response.read())
            if result.get("errors"):
                raise RuntimeError(result["errors"])
            return time.perf_counter_ns() - started, result
        count = checksum = 0
        summary = False
        for line in response:
            event = json.loads(line)
            if event["$event"] == "Record":
                count += 1
                checksum += int(event["_body"][0])
            elif event["$event"] == "Error":
                raise RuntimeError(event["_body"])
            elif event["$event"] == "Summary":
                summary = True
        if not summary:
            raise RuntimeError("Incomplete result stream")
        return time.perf_counter_ns() - started, (count, checksum)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--load", action="store_true", help="Load CSVs into an empty database")
    parser.add_argument("--rows", action="store_true", help="Also transfer and consume every result row")
    parser.add_argument("--samples", type=int, default=200)
    args = parser.parse_args()
    if not 1 <= args.samples <= 200:
        parser.error("--samples must be between 1 and 200")
    try:
        subprocess.run(["docker", "info"], capture_output=True, check=True, timeout=10)
    except (subprocess.TimeoutExpired, subprocess.CalledProcessError, FileNotFoundError) as exc:
        raise SystemExit(f"PENDING: Docker unavailable ({type(exc).__name__}). No comparison was measured.")
    client = Client()
    if args.load:
        _, existing = client.query("MATCH (n) RETURN count(n)")
        if existing["data"]["values"][0][0]:
            raise SystemExit("Refusing to load into a nonempty database. Use a fresh comparison volume.")
        started = time.perf_counter()
        subprocess.run(["docker", "compose", "-f", str(ROOT / "bench/neo4j/docker-compose.yml"),
                        "exec", "-T", "neo4j", "cypher-shell", "-u", "neo4j", "-p",
                        "chronograph-benchmark", "--file", "/bench/load.cypher"], check=True)
        print(f"CSV loading plus index creation: {time.perf_counter() - started:.3f}s (not live ingest)")
    with (ROOT / "bench/data/queries.csv").open() as file:
        cases = list(csv.DictReader(file))[:args.samples]
    if not cases:
        raise SystemExit("No query cases")
    destination = ROOT / "bench/results"
    destination.mkdir(exist_ok=True, parents=True)
    params = lambda case: {"t": int(case["t"]), "max": 9223372036854775807}
    _, profile = client.query("PROFILE " + COUNT, params(cases[0]))
    (destination / "neo4j-profile.json").write_text(json.dumps(profile, indent=2))
    for case in cases[:10]:
        client.query(COUNT, params(case))
    for mode in ["count", "rows"] if args.rows else ["count"]:
        measurements = []
        with (destination / f"neo4j-{mode}.csv").open("w") as file:
            writer = csv.writer(file)
            writer.writerow(["t", "elapsed_ns", "count", "checksum"])
            for case in cases:
                ns, result = client.query(ROWS if mode == "rows" else COUNT, params(case), stream=mode == "rows")
                count, checksum = result if mode == "rows" else result["data"]["values"][0]
                assert int(count) == int(case["expected_count"]), (case, count)
                assert int(checksum) == int(case["expected_id_sum"]), (case, checksum)
                writer.writerow([case["t"], ns, count, checksum])
                measurements.append(ns / 1e6)
        measurements.sort()
        percentile = lambda q: measurements[math.ceil(len(measurements) * q) - 1]
        print(f"{mode}: p50={percentile(.50):.3f}ms p99={percentile(.99):.3f}ms; includes HTTP and JSON parsing")


if __name__ == "__main__":
    main()
