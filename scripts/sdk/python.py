"""Line protocol for the shared SDK conformance suite; credentials stay on stdin."""

import json
import sys
from chronograph_connectors import Client, ApiError

for line in sys.stdin:
    try:
        q = json.loads(line)
        c = Client(
            q["url"],
            q["token"],
            timeout=q.get("timeout", 30000) / 1000,
            max_response_bytes=q.get("limit", 4194304),
        )
        if q.get("helper") == "parallel":
            from concurrent.futures import ThreadPoolExecutor

            with ThreadPoolExecutor(max_workers=4) as pool:
                results = list(pool.map(lambda _: c.call("stats"), range(12)))
            assert all("revision" in r for r in results)
            result = len(results)
        elif q.get("helper") == "upload":
            m = q["body"]["metadata"]
            result = c.asset(
                bytes.fromhex(q["body"]["data_hex"]),
                **{k: v for k, v in m.items() if k != "version"},
            )
        elif q.get("helper") == "read":
            m, data = c.read_asset(q["body"]["asset"])
            result = {"metadata": m, "data_hex": data.hex()}
        elif q.get("helper") == "pages":
            result = []
            for page in c.pages(
                q["op"], q.get("body", {}), max_pages=q.get("max_pages", 1000)
            ):
                result.append(page)
                if len(result) == q.get("stop_after", 0):
                    break
        elif q.get("helper") == "bci":
            from chronograph_connectors.bci import BCIClient

            b = q["body"]
            v = BCIClient(c, b["instance"])
            if q["op"] == "bci_session":
                result = v.session(b["session"])
            elif q["op"] == "bci_window":
                result = v.window(
                    b["session"],
                    b["stream"],
                    b["start"],
                    b["end"],
                    channels=b.get("channels", []),
                )
            else:
                result = c.call(q["op"], b)
        elif q.get("construct"):
            result = True
        elif "method" in q:
            result = c.request(q["path"], q["method"], q.get("body")).hex()
        elif q.get("asset_roundtrip"):
            data = bytes(i % 251 for i in range(1048607))
            asset = c.asset(data, kind="opaque", encoding="sdk_fixture")
            metadata, actual = c.read_asset(asset)
            assert actual == data
            result = {"bytes": len(actual), "encoding": metadata["encoding"]}
        else:
            result = c.call(q["op"], q.get("body", {}))
        print(json.dumps({"ok": True, "value": result}), flush=True)
    except ApiError as e:
        print(
            json.dumps(
                {
                    "ok": False,
                    "status": e.status,
                    "code": e.code,
                    "retry": e.retry_after,
                }
            ),
            flush=True,
        )
    except Exception as e:
        print(
            json.dumps({"ok": False, "local": True, "type": type(e).__name__}),
            flush=True,
        )
