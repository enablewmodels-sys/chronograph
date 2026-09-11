import argparse
import json
import os
from pathlib import Path
import sys
import time
from . import Client, Spool, ApiError


def main():
    p=argparse.ArgumentParser(description="Chronograph outbound normalized-record agent (Linux/macOS)")
    p.add_argument("command", choices=["enqueue","run","pause","resume","cancel","status"])
    p.add_argument("--spool", required=True)
    p.add_argument("--instance", required=True)
    p.add_argument("--partition", default="main")
    p.add_argument("--start-sequence", type=int, default=0)
    p.add_argument("--url", default="http://127.0.0.1:8080")
    p.add_argument("--token-file")
    p.add_argument("--input", help="JSONL file containing one normalized record per line")
    p.add_argument("--once", action="store_true")
    args=p.parse_args()
    with Spool(args.spool,args.instance,args.partition,start_sequence=args.start_sequence) as spool:
        if args.command=="enqueue":
            if not args.input:
                p.error("enqueue requires --input")
            # A malformed later line leaves earlier, explicitly queued records intact.
            with open(args.input,"rb") as file:
                while True:
                    line=file.readline(2*1024*1024+1)
                    if not line:
                        break
                    if len(line)>2*1024*1024:
                        raise ValueError("Input record exceeds 2 MiB")
                    if line.strip():
                        spool.enqueue([json.loads(line)])
        elif args.command in ("pause","resume","cancel"):
            spool.control({"pause":"paused","resume":"running","cancel":"cancelled"}[args.command])
        elif args.command=="run":
            token=Path(args.token_file).read_text().strip() if args.token_file else os.environ.get("CHRONOGRAPH_TOKEN","")
            client=Client(args.url,token)
            delay=1
            while True:
                try:
                    sent=spool.drain(client)
                    if args.once or spool.status()["state"]=="cancelled":
                        break
                    delay=1
                    if sent==0:
                        time.sleep(1)
                except (OSError, ApiError) as error:
                    if isinstance(error,ApiError) and error.status not in (429,500,502,503,504):
                        raise
                    if args.once:
                        raise
                    print(f"Transport unavailable; pending batches retained. Retry in {delay}s.",file=sys.stderr)
                    time.sleep(delay)
                    delay=min(delay*2,30)
        print(json.dumps(spool.status()))


if __name__=="__main__":
    main()
