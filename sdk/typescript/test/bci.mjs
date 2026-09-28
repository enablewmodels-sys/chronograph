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
  }, /did not advance/);
});
