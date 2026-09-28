import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const { Client, ApiError, BCIClient } = await import(
  process.env.SDK_SOURCE_ROOT
    ? pathToFileURL(
        resolve(process.env.SDK_SOURCE_ROOT, "typescript/dist/index.js"),
      ).href
    : "../../sdk/typescript/dist/index.js"
);
import { createInterface } from "node:readline";
for await (const line of createInterface({ input: process.stdin })) {
  try {
    const q = JSON.parse(line),
      c = new Client(q.url, q.token, q.timeout ?? 30000, q.limit ?? 4194304);
    let value;
    if (q.helper === "parallel") {
      const results = await Promise.all(
        Array.from({ length: 12 }, () => c.call("stats")),
      );
      if (!results.every((r) => typeof r.revision === "string"))
        throw Error("Concurrent response mismatch");
      value = results.length;
    } else if (q.helper === "upload")
      value = await c.uploadAsset(
        Buffer.from(q.body.data_hex, "hex"),
        q.body.metadata,
      );
    else if (q.helper === "read") {
      const r = await c.readAsset(q.body.asset);
      value = {
        metadata: r.metadata,
        data_hex: Buffer.from(r.data).toString("hex"),
      };
    } else if (q.helper === "pages") {
      value = [];
      for await (const r of c.pages(q.op, q.body, q.max_pages ?? 1000)) {
        value.push(r);
        if (value.length === q.stop_after) break;
      }
    } else if (q.helper === "bci") {
      const b = q.body,
        v = new BCIClient(c, b.instance);
      if (q.op === "bci_sessions") value = await v.sessions();
      else if (q.op === "bci_session") value = await v.session(b.session);
      else if (q.op === "bci_manifest")
        value = await v.manifest(b.sessions, b.stream);
      else
        value = await v.window(
          b.session,
          b.stream,
          BigInt(b.start),
          BigInt(b.end),
          b.channels,
        );
    } else if (q.construct) value = true;
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
