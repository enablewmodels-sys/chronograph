// Official SDK transport is mocked; no provider network calls or credentials.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {TypeSafeClient} from '@typesafe-ai/sdk';
import {jevDecision} from '../../sdk/typescript/dist/index.js';
const request=JSON.parse(await readFile(new URL('request.json',import.meta.url)));
const fixture=JSON.parse(await readFile(new URL('response.fixture.json',import.meta.url)));
let calls=0;
const provider=new TypeSafeClient({apiKey:'test-fixture-not-a-real-key',baseURL:'https://api.typesafe.ai',timeout:30000,retry:{maxRetries:0},logLevel:'off',fetch:async(url,init)=>{
  assert.equal(url,'https://api.typesafe.ai/v1/systemone');
  assert.deepEqual(JSON.parse(init.body),request);calls++;
  return new Response(JSON.stringify(fixture),{status:200,headers:{'content-type':'application/json'}});
}});
const result=await provider.systemOne(request);
const record=await jevDecision(result,{request,src:'9007199254740993',dst:'9007199254740994',timestampUs:'1700000000000000',mode:'fixture'});
assert.equal(calls,1);assert.deepEqual(record.fields.answers,fixture.answers);
console.log('Official TypeSafe JS 0.6.0: mocked HTTP serialization, typed response and Chronograph adapter passed');
