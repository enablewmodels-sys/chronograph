"""One writer for every branch: parent and branch recording through the same writer."""

import json
from bci_support import Service
from chronograph_connectors.bci import Session, BCIClient, initialize
from chronograph_connectors.bci_spool import BCISpool
from chronograph_connectors.bci_acquisition import synthetic

INSTANCE = "branch_research"
KIND = 440

service = Service(port=18097)
try:
    client = service.client
    initialize(client, INSTANCE, KIND, "simulation_us")
    bci = BCIClient(client, INSTANCE)

    # Parent recording through the ordinary writer.
    with BCISpool(service.root / "parent", INSTANCE, "parent_run") as q:
        session = Session(q, source="synthetic", clock_domain="simulation_us")
        synthetic(session, seconds=4, rate=250, channels=4, seed=1)
        assert q.drain(client) > 0
        parent_session = session.id
    parent_rows = list(bci.records(parent_session, max_records=500))
    parent_sessions = len(list(bci.sessions()))
    assert parent_sessions == 1 and parent_rows, "parent recording is missing"

    # Branch created after the parent recording, so it inherits the parent state.
    # BCI stream metadata is recorded at timestamp 0, so a branch that records a new
    # session forks at 0. Decoder-only branches fork at the decode time instead.
    fork = client.call("fork", {"t": "0", "name": "decode-branch"})["fork"]["id"]

    # The same spool writer records a second session into the selected branch.
    with BCISpool(service.root / "branch", INSTANCE, "branch_run") as q:
        branch = Session(q, source="synthetic", clock_domain="simulation_us")
        synthetic(branch, seconds=4, rate=250, channels=4, seed=2)
        sent = q.drain(client, fork=fork)
        assert sent > 0, "branch recording sent nothing"
        branch_session = branch.id
        assert q.drain(client, fork=fork) == 0, "a drained spool must not resend"

    branch_sessions = client.call(
        "bci_sessions", {"instance": INSTANCE, "fork": fork}
    )["sessions"]
    ids = {s["session"] for s in branch_sessions}
    assert parent_session in ids, "the branch must inherit the parent session"
    assert branch_session in ids, "the branch session is missing"
    assert all(s["scope"] == "fork:" + fork for s in branch_sessions)

    # The parent is untouched: same sessions, same records, byte-identical rows.
    parent_scoped = list(bci.sessions())
    assert len(parent_scoped) == parent_sessions, json.dumps(parent_scoped)[:800]
    assert list(bci.records(parent_session, max_records=500)) == parent_rows
    try:
        list(bci.records(branch_session, max_records=1))
        raise AssertionError("a branch session must not appear in the parent scope")
    except Exception as error:
        assert "not found" in str(error), str(error)

    branch_rows = client.call(
        "bci_records",
        {"instance": INSTANCE, "session": branch_session, "fork": fork, "limit": 500},
    )["records"]
    assert branch_rows, "branch records are missing"
    other = {s["session"] for s in bci.sessions()}
    assert branch_session not in other
    chunks = [r["record"] for r in branch_rows if r["record"]["fields"]["type"] == "signal"]
    assert chunks and all(c["dst"] != parent_session for c in chunks)

    # The durable receipt is branch-scoped: the same lookup reads either scope, and a branch
    # partition never appears in the parent scope.
    branch_receipt = client.call(
        "connector_checkpoint",
        {"instance": INSTANCE, "partition": "branch_run", "fork": fork},
    )["checkpoint"]
    parent_receipt = client.call(
        "connector_checkpoint", {"instance": INSTANCE, "partition": "parent_run"}
    )["checkpoint"]
    assert branch_receipt is not None, "the branch receipt is missing"
    assert branch_receipt["sequence"] == str(sent - 1), branch_receipt
    assert parent_receipt is not None
    unscoped = client.call(
        "connector_checkpoint", {"instance": INSTANCE, "partition": "branch_run"}
    )["checkpoint"]
    assert unscoped is None, "a branch partition must not appear in the parent scope"

    # Immutability and the cursor rules apply to a branch exactly as to the parent.
    events = [
        r["record"]
        for r in branch_rows
        if r["record"]["fields"]["type"] == "event"
    ]
    assert events, "branch cue events are missing"
    observation = events[0]["dst"]

    path = client.call(
        "bci_causal_path",
        {
            "instance": INSTANCE,
            "session": branch_session,
            "observation": observation,
            "fork": fork,
        },
    )["path"]
    kinds = {n["type"] for n in path["nodes"]}
    assert {"event", "stream", "session"} <= kinds, json.dumps(path)[:500]
    assert any(link["kind"] == "observed_in" for link in path["links"])
    assert any(link["kind"] == "declares_stream" for link in path["links"])
    shallow = client.call(
        "bci_causal_path",
        {
            "instance": INSTANCE,
            "session": branch_session,
            "observation": observation,
            "fork": fork,
            "depth": 1,
        },
    )["path"]
    assert shallow["truncated"] is True
    try:
        client.call(
            "bci_causal_path",
            {
                "instance": INSTANCE,
                "session": branch_session,
                "observation": observation,
                "fork": fork,
                "depth": 9,
            },
        )
        raise AssertionError("depth above 8 must be rejected")
    except Exception as error:
        assert "depth" in str(error), str(error)

    # A merged branch publishes its sessions to the parent through the same writer.
    preview = client.call("preview_merge", {"fork": fork})
    assert preview["preview"] is True and preview["merge"]["edges"], json.dumps(preview)[:400]
    committed = client.call("merge", {"fork": fork, "durability": "fsync"})["merge"]
    assert committed["edges"] == preview["merge"]["edges"], "merge must apply the previewed mappings"
    merged = {s["session"] for s in bci.sessions()}
    assert {parent_session, branch_session} <= merged, sorted(merged)
    first = next(iter(bci.records(branch_session, max_records=500)), None)
    assert first is not None, "a merged branch must publish its records to the parent"

    # A closed branch is no longer writable and its derived rows are dropped.
    with BCISpool(service.root / "closed", INSTANCE, "closed_run") as q:
        closed = Session(q, source="synthetic", clock_domain="simulation_us")
        synthetic(closed, seconds=1, rate=250, channels=4, seed=3, start_us=20_000_000)
        try:
            q.drain(client, fork=fork)
            raise AssertionError("a merged branch must reject new records")
        except Exception as error:
            assert "fork" in str(error).lower() or "branch" in str(error).lower(), str(error)

    print(
        json.dumps(
            {
                "passed": True,
                "parent_session": parent_session,
                "branch_session": branch_session,
                "fork": fork,
                "parent_records": len(parent_rows),
                "branch_records": len(branch_rows),
                "causal_nodes": len(path["nodes"]),
                "causal_links": len(path["links"]),
                "merged_sessions": len(merged),
                "writer": "one writer, parent and branch through the same connector path",
            }
        )
    )
finally:
    service.close()
