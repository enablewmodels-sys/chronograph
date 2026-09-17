import { Client, ApiError } from "../../sdk/typescript/dist/index.js";
import { createInterface } from "node:readline";
for await (const line of createInterface({ input: process.stdin })) {
  try {
    const q = JSON.parse(line),
      c = new Client(q.url, q.token, q.timeout ?? 30000, q.limit ?? 4194304);
    let value;
    if (q.construct) value = true;
    else if (q.method)
      value = Buffer.from(await c.request(q.path, q.method, q.body)).toString(
        "hex",
      );
    else if (q.asset_roundtrip) {
      const data = Uint8Array.from({ length: 1048607 }, (_, i) => i % 251);
      const id = await c.uploadAsset(data, {
        version: 1,
        kind: "opaque",
        encoding: "sdk_fixture",
      });
      const got = await c.readAsset(id);
      if (!Buffer.from(got.data).equals(Buffer.from(data)))
        throw Error("roundtrip");
      value = { bytes: got.data.length, encoding: got.metadata.encoding };
    } else value = await c.call(q.op, q.body ?? {});
    console.log(JSON.stringify({ ok: true, value }));
  } catch (e) {
    console.log(
      JSON.stringify(
        e instanceof ApiError
          ? { ok: false, status: e.status, code: e.code, retry: e.retryAfter }
          : { ok: false, local: true, type: e.name },
      ),
    );
  }
}
