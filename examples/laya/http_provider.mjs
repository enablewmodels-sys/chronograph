// Laya runs outside ChronoDB. Never forward its key through a redirect.
export async function predict(request) {
  const url = new URL(process.env.LAYA_URL ?? 'http://127.0.0.1:8000');
  if (!['https:','http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || (url.protocol === 'http:' && !['127.0.0.1','localhost','[::1]'].includes(url.hostname))) throw new Error('Use an HTTPS or loopback HTTP Laya origin');
  const headers = {'Content-Type':'application/json'};
  if (process.env.LAYA_API_KEY) {
    if (/[\s\x00-\x1f\x7f]/.test(process.env.LAYA_API_KEY)) throw new Error('Invalid Laya key');
    headers.Authorization = 'Bearer ' + process.env.LAYA_API_KEY;
  }
  const result = await fetch(new URL('/v1/systemone',url), {method:'POST',headers,body:JSON.stringify(request),redirect:'error',signal:AbortSignal.timeout(30000)});
  if (!result.ok) { await result.body?.cancel(); throw new Error(`Laya returned HTTP ${result.status}`); }
  const reader = result.body.getReader(), chunks=[];let total=0;
  try { for (;;) { const {value,done}=await reader.read();if(done)break;total+=value.length;
    if(total>2*1024*1024)throw new Error('Laya response exceeds 2 MiB');chunks.push(value);
  }} finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
