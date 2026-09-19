#!/usr/bin/env python3
"""Offline by default. --live calls TypeSafe; --write persists to Chronograph."""
import argparse
import json
import os
import uuid
from pathlib import Path
from chronograph_connectors import Client
from chronograph_connectors.jev import jev_decision

HERE = Path(__file__).resolve().parent

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live', action='store_true')
    parser.add_argument('--write', action='store_true')
    parser.add_argument('--init', action='store_true', help='Create migration using an admin token')
    parser.add_argument('--attach-inputs', action='store_true', help='Explicitly store raw request and response JSON assets')
    args = parser.parse_args()
    if (args.init or args.attach_inputs) and not args.write:
        parser.error('--init and --attach-inputs require --write')
    request = json.loads((HERE / 'request.json').read_text())
    if args.live:
        from typesafe_sdk import TypeSafeClient, RetryPolicy
        # Fixed trusted provider endpoint, bounded wait, no implicit inference retries.
        with TypeSafeClient(base_url='https://api.typesafe.ai', timeout=30, retry=RetryPolicy(max_retries=0)) as provider:
            response = provider.system_one(**request)
    else:
        response = json.loads((HERE / 'response.fixture.json').read_text())
    client = None
    if args.write:
        token = Path(os.environ['CHRONOGRAPH_TOKEN_FILE']).read_text().strip()
        client = Client(os.environ['CHRONOGRAPH_URL'], token)
        if args.init:
            binding = dict(id='jev_decisions', connector='jev', preset='decisions-v1', contract_version=1,
                           kind=420, clock_domain='unix_us', modalities=['text'], secret_refs=['TYPESAFE_API_KEY'])
            generated = client.call('connector_template', binding)
            preview = client.call('schema_preview', {'source':generated['source']})
            client.call('schema_apply', {k:preview[k] for k in ('checksum','expected_revision')} | {'source':generated['source']})
    record = jev_decision(response, request=request, src='9007199254740993', dst='9007199254740994',
                          timestamp_us='1700000000000000', mode='live' if args.live else 'fixture',
                          client=client, attach_inputs=args.attach_inputs, episode='warehouse-replay-001')
    if client:
        # One fresh source partition per run. Do not rerun inference to retry a lost receipt.
        partition = 'example-' + uuid.uuid4().hex
        receipt = client.ingest('jev_decisions', partition, 0, [record])
        saved = client.call('connector_record', {'edge':receipt['receipt']['first_edge']})
        print(json.dumps({'mode':record['fields']['mode'], 'receipt':receipt, 'stored':saved}, indent=2))
    else:
        print(json.dumps(record, indent=2))

if __name__ == '__main__': main()
