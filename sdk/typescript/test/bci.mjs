import test from "node:test";
import assert from "node:assert/strict";
import { BCIClient } from "../dist/index.js";
test("BCI windows retain microsecond precision and reject unbounded queries", async () => {
  let called;
  const bci = new BCIClient(
    {
      call: async (op, args) => {
        called = { op, args };
        return {};
      },
    },
    "eeg",
  );
  await bci.window(
    "18446744073709551615",
    "signal",
    9007199254740993n,
    9007199254741993n,
    [0, 2],
  );
  assert.equal(called.args.start, "9007199254740993");
  assert.equal(called.args.session, "18446744073709551615");
  assert.throws(() => bci.window("1", "eeg", 0n, 60000001n), RangeError);
});
test("filtered empty pages advance without losing subsequent BCI records", async () => {
  let n = 0;
  const bci = new BCIClient({
    call: async (_op, args) =>
      ++n === 1
        ? { records: [], has_more: true, cursor: "12" }
        : (assert.equal(args.after, "12"),
          { records: [{ edge: "13" }], has_more: false, cursor: "13" }),
  });
  const rows = [];
  for await (const row of bci.records("1", "event")) rows.push(row);
  assert.deepEqual(rows, [{ edge: "13" }]);
});
test("a nonprogressing BCI cursor is rejected instead of looping", async () => {
  const bci = new BCIClient({
    call: async () => ({ records: [], has_more: true, cursor: "10" }),
  });
  await assert.rejects(async () => {
    for await (const _ of bci.records("1")) {
    }
  }, /Non-progressing/);
});

test("BCI reads and causal paths target a branch and reject bad arguments", async () => {
  const calls = [];
  const bci = new BCIClient(
    {
      call: async (op, args) => {
        calls.push({ op, args });
        return { sessions: [], records: [], path: {} };
      },
    },
    "bci_research",
  );
  await bci.session("101", { branch: 7 });
  await bci.window("101", "eeg", 0n, 1000n, [0], { branch: "7" });
  await bci.manifest(["101"], "eeg", { branch: 7 });
  await bci.causalPath("101", "9007199254740993", { branch: 7, depth: 3 });
  assert.deepEqual(
    calls.map((c) => [c.op, c.args.fork]),
    [
      ["bci_session", "7"],
      ["bci_window", "7"],
      ["bci_manifest", "7"],
      ["bci_causal_path", "7"],
    ],
  );
  assert.equal(calls[3].args.observation, "9007199254740993");
  assert.equal(calls[3].args.depth, 3);
  // An omitted branch stays on the parent: no fork key is sent at all.
  await bci.session("101");
  assert.equal(calls[4].args.fork, undefined);
  assert.equal(JSON.stringify(calls[4].args).includes("fork"), false);
  // Argument validation happens before any request, so it throws synchronously.
  assert.throws(() => bci.session("101", { branch: "one" }), RangeError);
  assert.throws(() => bci.causalPath("101", "0"), RangeError);
  assert.throws(() => bci.causalPath("101", "5", { depth: 9 }), RangeError);
});
