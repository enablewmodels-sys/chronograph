"""Line protocol for the shared SDK conformance suite; credentials stay on stdin."""
import json
import sys
from chronograph_connectors import Client, ApiError
for line in sys.stdin:
    try:
        q=json.loads(line)
        c=Client(q["url"],q["token"],timeout=q.get("timeout",30000)/1000,max_response_bytes=q.get("limit",4194304))
        if q.get("construct"): result=True
        elif "method" in q: result=c.request(q["path"],q["method"],q.get("body")).hex()
        elif q.get("asset_roundtrip"):
            data=bytes(i%251 for i in range(1048607))
            asset=c.asset(data,kind="opaque",encoding="sdk_fixture")
            metadata,actual=c.read_asset(asset)
            assert actual==data
            result={"bytes":len(actual),"encoding":metadata["encoding"]}
        else: result=c.call(q["op"],q.get("body",{}))
        print(json.dumps({"ok":True,"value":result}),flush=True)
    except ApiError as e: print(json.dumps({"ok":False,"status":e.status,"code":e.code,"retry":e.retry_after}),flush=True)
    except Exception as e: print(json.dumps({"ok":False,"local":True,"type":type(e).__name__}),flush=True)
