#!/usr/bin/env python3
"""Offline by default. --live calls Laya; --write persists to Chronograph."""
import argparse
import json
import os
import uuid
from pathlib import Path
from chronograph_connectors import Client
from chronograph_connectors.laya import laya_decision

HERE = Path(__file__).resolve().parent

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live', action='store_true')
    parser.add_argument('--runtime', choices=['http', 'local'], default='http')
    parser.add_argument('--model', choices=['auto', 'english', 'multilingual', 'typed-decisions'], default='auto')
    parser.add_argument('--write', action='store_true')
    parser.add_argument('--init', action='store_true', help='Create migration using an admin token')
    parser.add_argument('--attach-inputs', action='store_true', help='Explicitly store raw request and response JSON assets')
    args = parser.parse_args()
    if (args.init or args.attach_inputs) and not args.write:
        parser.error('--init and --attach-inputs require --write')
    request = json.loads((HERE / 'request.json').read_text())
    request['model'] = args.model
    runtime_version = None
    if args.live and args.runtime == 'local':
        from laya import Router
        from importlib.metadata import version
        runtime_version = version('laya')
        with Router(device=os.environ.get('LAYA_DEVICE', 'cpu')) as provider:
            response = provider.predict(request['state'], request['questions'],
                                        model=None if args.model == 'auto' else args.model)
    elif args.live:
        from http_provider import predict
        response = predict(request)
    else:
        if args.model != 'auto':
            parser.error('--model requires --live; fixture provenance is fixed')
        response = json.loads((HERE / 'response.fixture.json').read_text())
    client = None
    if args.write:
        token = Path(os.environ['CHRONOGRAPH_TOKEN_FILE']).read_text().strip()
        client = Client(os.environ['CHRONOGRAPH_URL'], token)
        if args.init:
            binding = dict(id='laya_decisions', connector='laya', preset='decisions-v1', contract_version=1,
                           kind=421, clock_domain='unix_us', modalities=['text'], secret_refs=['LAYA_API_KEY'])
            generated = client.call('connector_template', binding)
            preview = client.call('schema_preview', {'source':generated['source']})
            client.call('schema_apply', {k:preview[k] for k in ('checksum','expected_revision')} | {'source':generated['source']})
    record = laya_decision(response, request=request, src='9007199254740993', dst='9007199254740994',
                          timestamp_us='1700000000000000', mode='live' if args.live else 'fixture',
                          client=client, attach_inputs=args.attach_inputs, episode='warehouse-replay-001',
                          runtime_version=runtime_version, checkpoint_revision=os.environ.get('LAYA_CHECKPOINT_REVISION'))
    if client:
        # One fresh source partition per run. Do not rerun inference to retry a lost receipt.
        partition = 'example-' + uuid.uuid4().hex
        receipt = client.ingest('laya_decisions', partition, 0, [record])
        saved = client.call('connector_record', {'edge':receipt['receipt']['first_edge']})
        print(json.dumps({'mode':record['fields']['mode'], 'receipt':receipt, 'stored':saved}, indent=2))
    else:
        print(json.dumps(record, indent=2))

if __name__ == '__main__': main()
