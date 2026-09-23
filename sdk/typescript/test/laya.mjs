import {readFile} from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import {layaDecision,jevDecision} from '../dist/index.js';
const request=JSON.parse(await readFile(new URL('../../../examples/laya/request.json',import.meta.url)));
const response=JSON.parse(await readFile(new URL('../../../examples/laya/response.fixture.json',import.meta.url)));
const options={request,src:'9007199254740993',dst:'9007199254740994',timestampUs:'1700000000000000',mode:'fixture'};
test('Laya retains routing, action metadata and exact IDs without inputs',async()=>{
 const r=await layaDecision(response,options);assert.equal(r.fields.provider,'convai');assert.equal(r.fields.checkpoint,'convaiinnovations/laya');
 assert.deepEqual(r.fields.answers,response.answers);assert.deepEqual(r.fields.routing,response.routing);assert.deepEqual(r.assets,{});assert.equal(r.src,options.src);assert.equal(r.fields.state,undefined);
});
test('Laya requires checkpoint provenance and accepts direct Agent metadata',async()=>{
 const direct={...response};delete direct.routing;await assert.rejects(layaDecision(direct,options));
 const r=await layaDecision(direct,{...options,checkpoint:'local-artifact',checkpointRevision:'test-rev'});assert.equal(r.fields.checkpoint_revision,'test-rev');
 await assert.rejects(layaDecision(response,{...options,checkpointRevision:3}));
});
test('Laya rounded distributions survive intact while malformed mass and Jev are rejected',async()=>{
 const answers={many:{type:'choice',choice:'0',confidence:0.01,probabilities:Object.fromEntries(Array.from({length:64},(_,k)=>[String(k),0.0156]))}};
 const opt={...options,request:{...request,questions:{many:{type:'choice'}}}};
 const r=await layaDecision({...response,answers},opt);assert.deepEqual(r.fields.answers,answers);
 await assert.rejects(jevDecision({...response,answers},opt));answers.many.probabilities['0']=0.5;await assert.rejects(layaDecision({...response,answers},opt));
});
test('Laya attachments carry Convai provenance and invalid records upload nothing',async()=>{
 const calls=[];const client={async uploadAsset(data,metadata){calls.push({data,metadata});return 'asset-id';}};
 await assert.rejects(layaDecision(response,{...options,src:'-1',client,attachInputs:true}));assert.equal(calls.length,0);
 await layaDecision(response,{...options,client,attachInputs:true});assert.equal(calls.length,2);assert.equal(calls[0].metadata.provenance.provider,'convai');
});
