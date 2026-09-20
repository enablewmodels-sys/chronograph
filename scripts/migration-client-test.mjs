#!/usr/bin/env node
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  writeFile,
  mkdir,
  symlink,
  chmod,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const run = promisify(execFile);
const cli = fileURLToPath(new URL("./migrate.mjs", import.meta.url));
test("CLI keeps Managed project path, orders files, rejects redirects and protects credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chronograph-cli-"));
  const requests = [];
  let redirect = false;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, body: JSON.parse(body) });
    if (redirect) {
      res.writeHead(302, { location: "/leak" });
      res.end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        checksum: "plan",
        expected_revision: 0,
        pending: 2,
        applied_count: 2,
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const token = join(dir, "admin.token");
    await writeFile(token, `cg_${"a".repeat(16)}_${"b".repeat(64)}`, {
      mode: 0o600,
    });
    const migrations = join(dir, "migrations");
    await mkdir(migrations);
    for (const n of [2, 1])
      await writeFile(
        join(migrations, `00${n}.json`),
        JSON.stringify({
          version: 3,
          id: `m${n}`,
          name: `Migration ${n}`,
          operations: [],
        }),
      );
    const base = [
      cli,
      "--token-file",
      token,
      "--url",
      `http://127.0.0.1:${server.address().port}/p/prj_example`,
    ];
    const result = await run(process.execPath, [
      ...base,
      "--dir",
      migrations,
      "--apply",
    ]);
    assert.equal(JSON.parse(result.stdout).applied_count, 2);
    assert.deepEqual(
      requests.map((r) => r.path),
      ["/p/prj_example/v1/schema_plan", "/p/prj_example/v1/schema_apply_plan"],
    );
    assert.deepEqual(
      requests[0].body.sources.map((s) => JSON.parse(s).id),
      ["m1", "m2"],
    );
    assert.equal(requests[1].body.checksum, "plan");
    assert.ok(!result.stdout.includes("cg_"));
    redirect = true;
    await assert.rejects(run(process.execPath, [...base, "--status"]));
    assert.ok(!requests.some((r) => r.path === "/leak"));
    const count = requests.length;
    await symlink(join(migrations, "001.json"), join(dir, "symlink.json"));
    await assert.rejects(
      run(process.execPath, [...base, "--file", join(dir, "symlink.json")]),
    );
    await chmod(token, 0o644);
    await assert.rejects(
      run(process.execPath, [...base, "--status"]),
      /Token file must be private/,
    );
    assert.equal(requests.length, count);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
