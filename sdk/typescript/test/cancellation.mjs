import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { Client } from "../dist/index.js";
test("cancelling a multipart upload aborts the in-flight request and prevents composition", async () => {
  const cancel = new AbortController();
  let requests = 0;
  const server = createServer(async (req, res) => {
    requests++;
    req.on("error", () => {});
    try {
      for await (const _ of req) {
      }
      cancel.abort();
    } catch {}
    res.destroy();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const c = new Client(
      `http://127.0.0.1:${server.address().port}`,
      "test-only",
    );
    await assert.rejects(
      c.uploadAsset(
        new Uint8Array(1048577),
        { version: 1, kind: "opaque", encoding: "fixture" },
        cancel.signal,
      ),
      { name: "AbortError" },
    );
    assert.equal(
      requests,
      1,
      "no second chunk or composition after cancellation",
    );
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
