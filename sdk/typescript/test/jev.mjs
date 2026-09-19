import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { jevDecision } from '../dist/index.js';
const request = JSON.parse(await readFile(new URL('../../../examples/jev/request.json',import.meta.url)));
const response = JSON.parse(await readFile(new URL('../../../examples/jev/response.fixture.json',import.meta.url)));
const options = {request, src:'9007199254740993',dst:'18446744073709551615',timestampUs:'0',mode:'fixture'};
test('Jev preserves probabilities, exact IDs and input privacy by default', async () => {
  const r=await jevDecision(response,options);
  assert.equal(r.src,options.src); assert.deepEqual(r.fields.answers,response.answers);
  assert.deepEqual(r.assets,{}); assert.equal(r.fields.input_sha256.length,64);
  assert.equal(r.fields.state,undefined);
});
test('Jev rejects malformed probabilities, missing questions and inexact IDs',async () => {
  for (const [name,key,value] of [['obstructed','noul',true],['obstructed','noul',1.1],['route','choice','unknown'],['route','probabilities',{a:.9}],['review_priority','score',30],['route','confidence',NaN]]) {
    const bad=structuredClone(response); bad.answers[name][key]=value;
    await assert.rejects(jevDecision(bad,options));
  }
  await assert.rejects(jevDecision(response,{...options,src:9007199254740993}));
  await assert.rejects(jevDecision(response,{...options,request:{...request,questions:{}}}));
});
test('Jev uploads opted-in JSON attachments',async () => {
  const raw=[]; const client={uploadAsset:async (bytes,meta)=>{raw.push([JSON.parse(new TextDecoder().decode(bytes)),meta]);return String(raw.length)}};
  const r=await jevDecision(response,{...options,client,attachInputs:true});
  assert.deepEqual(r.assets,{request:'1',response:'2'});assert.deepEqual(raw[0][0],request);
});
