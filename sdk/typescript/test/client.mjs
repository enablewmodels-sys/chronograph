import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "../dist/index.js";
const client = () => new Client("http://127.0.0.1:1", "fixture");
test("asset helper rejects stuck cursors, inconsistent length, metadata drift and truncation", async () => {
  for (const [first, second] of [
    [
      {
        asset: "a",
        bytes: 2,
        offset: 0,
        data_hex: "00",
        next_offset: 0,
        metadata: {},
      },
      null,
    ],
    [
      {
        asset: "a",
        bytes: 2,
        offset: 0,
        data_hex: "00",
        next_offset: null,
        metadata: {},
      },
      null,
    ],
    [
      {
        asset: "a",
        bytes: 2,
        offset: 0,
        data_hex: "00",
        next_offset: 1,
        metadata: {},
      },
      {
        asset: "a",
        bytes: 3,
        offset: 1,
        data_hex: "00",
        next_offset: 2,
        metadata: {},
      },
    ],
    [
      {
        asset: "a",
        bytes: 2,
        offset: 0,
        data_hex: "00",
        next_offset: 1,
        metadata: {},
      },
      {
        asset: "a",
        bytes: 2,
        offset: 1,
        data_hex: "00",
        next_offset: null,
        metadata: { changed: true },
      },
    ],
  ]) {
    const c = client(),
      pages = [first, second];
    c.call = async () => pages.shift();
    await assert.rejects(c.readAsset("a"));
  }
});
test("pagination detects repeated cursor and respects maxPages", async () => {
  const c = client();
  let calls = 0;
  c.call = async () => {
    calls++;
    return { next_cursor: "same", edges: [] };
  };
  await assert.rejects(async () => {
    for await (const _ of c.pages("as_of", { t: "0" }, 10)) {
    }
  });
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(async () => {
    for await (const _ of c.pages("as_of", { t: "0" }, 1)) {
    }
  });
  assert.equal(calls, 1);
});
test("non-finite values and bigint are rejected before transport", async () => {
  const c = client();
  await assert.rejects(c.call("stats", { bad: NaN }));
  await assert.rejects(c.call("stats", { bad: 1n }));
});
