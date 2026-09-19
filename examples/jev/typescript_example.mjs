// Node 20+. Offline by default; --live calls TypeSafe; --write uses Chronograph.
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Client, jevDecision } from '../../sdk/typescript/dist/index.js';
const args = new Set(process.argv.slice(2));
for (const arg of args) if (!['--live','--write','--init','--attach-inputs'].includes(arg)) throw new Error(`Unknown option ${arg}`);
if ((args.has('--init') || args.has('--attach-inputs')) && !args.has('--write')) throw new Error('--init and --attach-inputs require --write');
const read = async name => JSON.parse(await readFile(new URL(name, import.meta.url), 'utf8'));
const request = await read('request.json');
let response;
if (args.has('--live')) {
  const { TypeSafeClient } = await import('@typesafe-ai/sdk');
  response = await new TypeSafeClient({ baseURL:'https://api.typesafe.ai', timeout:30000, logLevel:"off", retry:{ maxRetries:0 } }).systemOne(request);
} else response = await read('response.fixture.json');
let client;
if (args.has('--write')) {
  client = new Client(process.env.CHRONOGRAPH_URL, (await readFile(process.env.CHRONOGRAPH_TOKEN_FILE, 'utf8')).trim());
  if (args.has('--init')) {
    const generated = await client.call('connector_template', { id:'jev_decisions',connector:'jev',preset:'decisions-v1',contract_version:1,kind:420,clock_domain:'unix_us',modalities:['text'],secret_refs:['TYPESAFE_API_KEY'] });
    const preview = await client.call('schema_preview', { source:generated.source });
    await client.call('schema_apply', { source:generated.source,checksum:preview.checksum,expected_revision:preview.expected_revision });
  }
}
const record = await jevDecision(response, { request,src:'9007199254740993',dst:'9007199254740994',timestampUs:'1700000000000000',mode:args.has('--live')?'live':'fixture',client,attachInputs:args.has('--attach-inputs'),episode:'warehouse-replay-001' });
if (client) {
  const receipt = await client.ingest('jev_decisions', 'example-' + randomUUID().replaceAll('-',''), '0', [record]);
  const stored = await client.call('connector_record', { edge:receipt.receipt.first_edge });
  console.log(JSON.stringify({ mode:record.fields.mode,receipt,stored }, null, 2));
} else console.log(JSON.stringify(record, null, 2));
