#!/usr/bin/env python3
"""Official TypeSafe SDK against mocked HTTP; never an inference quality claim."""
import json
from pathlib import Path
import httpx2
from typesafe_sdk import TypeSafeClient, RetryPolicy
from chronograph_connectors.jev import jev_decision
root=Path(__file__).resolve().parents[1]
request=json.loads((root/'examples/jev/request.json').read_text())
response=json.loads((root/'examples/jev/response.fixture.json').read_text())
calls=[]
def mock(req):
    assert str(req.url)=='https://api.typesafe.ai/v1/systemone'
    assert json.loads(req.content)==request
    calls.append(req.method)
    return httpx2.Response(200,json=response,headers={'x-typesafe-request-id':'synthetic-contract-fixture'})
with TypeSafeClient(api_key='test-fixture-not-a-real-key',base_url='https://api.typesafe.ai',transport=httpx2.MockTransport(mock),retry=RetryPolicy(max_retries=0)) as provider:
    result=provider.system_one(**request)
    record=jev_decision(result,request=request,src='9007199254740993',dst='9007199254740994',timestamp_us='1700000000000000',mode='fixture')
assert calls==['POST']
assert record['fields']['answers']==response['answers']
print('Official TypeSafe Python 0.7.0: mocked HTTP serialization, typed response and Chronograph adapter passed')
