#!/usr/bin/env node
// Node 20+ client: ordered JSON migrations are data, never executable code.
import { open, readdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, join } from "node:path";

const MAX_PLAN = 1048576;
async function regularFile(path, limit, privateFile = false) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const meta = await file.stat();
    if (!meta.isFile() || meta.size > limit)
      throw new Error(`${path}: must be a regular file within ${limit} bytes`);
    if (privateFile && process.platform !== "win32" && meta.mode & 0o077)
      throw new Error("Token file must be private: chmod 600 <token-file>");
    const content = await file.readFile("utf8");
    if (Buffer.byteLength(content) > limit)
      throw new Error("File grew beyond limit");
    return content;
  } finally {
    await file.close();
  }
}
function sourcesFrom(text) {
  const value = JSON.parse(text);
  if (Array.isArray(value)) return value.map((m) => JSON.stringify(m));
  if (
    value &&
    Object.keys(value).length === 1 &&
    Array.isArray(value.migrations)
  )
    return value.migrations.map((m) => JSON.stringify(m));
  return [text];
}
async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(`Usage: node scripts/migrate.mjs --token-file config/admin.token [--url BASE] MODE [--apply] [--out result.json]
Modes (choose one):
  --file migration.json   Single migration, array, or {"migrations":[...]} bundle
  --dir migrations       All .json files, lexically sorted by filename
  --status               Print applied history (read credential supported)
  --export               Export a portable schema baseline; --out required
  --rollback REVISION    Prepare a compensating migration; never erases history
Without --apply, validates and previews without changing the database.
BASE: HTTPS origin or loopback HTTP, optionally /p/PROJECT_ID for Managed.
--out saves the preview, apply result, or exported baseline without overwriting.
Limits: 64 migrations, 256 KiB each, 1 MiB total. Requires schema v3 service.`);
    return;
  }
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (Object.hasOwn(options, key))
      throw new Error(`Repeated argument: ${key}`);
    if (["--apply", "--status", "--export"].includes(key)) options[key] = true;
    else if (
      [
        "--file",
        "--dir",
        "--token-file",
        "--url",
        "--rollback",
        "--out",
      ].includes(key) &&
      args[i + 1] &&
      !args[i + 1].startsWith("--")
    )
      options[key] = args[++i];
    else throw new Error(`Unknown or incomplete argument: ${key}`);
  }
  const modes = [
    "--file",
    "--dir",
    "--status",
    "--export",
    "--rollback",
  ].filter((k) => options[k] !== undefined);
  if (modes.length !== 1 || !options["--token-file"])
    throw new Error(
      "Choose exactly one mode and provide --token-file; use --help",
    );
  if ((options["--status"] || options["--export"]) && options["--apply"])
    throw new Error("This mode cannot be applied");
  if (options["--export"] && !options["--out"])
    throw new Error("--export requires --out baseline.json");
  // Check the literal path too: URL normalization must not silently discard /../.
  const base =
    options["--url"] || process.env.CHRONOGRAPH_URL || "http://127.0.0.1:8080";
  const url = new URL(base);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/(?:p\/[A-Za-z0-9_-]+\/?)?$/.test(url.pathname) ||
    /%|\\|(?:\/|^)\.{1,2}(?:\/|$)/.test(base) ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    )
  )
    throw new Error(
      "URL must be HTTPS (or loopback HTTP), optionally /p/PROJECT_ID, without credentials or query",
    );
  url.pathname = url.pathname.replace(/\/$/, "") + "/";
  const token = (await regularFile(options["--token-file"], 4096, true)).trim();
  if (!/^cg_[a-f0-9]{16}_[a-f0-9]{64}$/.test(token))
    throw new Error("Invalid Chronograph API key in token file");
  const request = async (op, body = {}) => {
    const response = await fetch(new URL(`v1/${op}`, url), {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const value = await response.json();
    if (!response.ok)
      throw new Error(
        `${response.status}: ${value.error?.message || "Request failed"}`,
      );
    return value;
  };
  const id = `cli_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  let result;
  if (options["--status"]) result = await request("schema");
  else if (options["--export"]) {
    const exported = await request("schema_export", {
      id,
      name: "Exported schema baseline",
    });
    result = { migrations: exported.sources.map((s) => JSON.parse(s)) };
  } else {
    let sources;
    if (options["--rollback"] !== undefined) {
      if (
        !/^\d+$/.test(options["--rollback"]) ||
        !Number.isSafeInteger(Number(options["--rollback"]))
      )
        throw new Error("Rollback revision must be a non-negative integer");
      result = await request("schema_rollback", {
        id,
        name: `Restore schema revision ${options["--rollback"]}`,
        target_revision: Number(options["--rollback"]),
      });
      sources = result.sources;
    } else {
      const files = options["--file"]
        ? [options["--file"]]
        : (await readdir(options["--dir"]))
            .filter((f) => f.endsWith(".json"))
            .sort()
            .map((f) => join(options["--dir"], f));
      if (!files.length || files.length > 64)
        throw new Error("Select 1–64 JSON files");
      sources = [];
      let bytes = 0;
      for (const file of files) {
        const text = await regularFile(file, MAX_PLAN);
        bytes += Buffer.byteLength(text);
        if (bytes > MAX_PLAN) throw new Error("Migration input exceeds 1 MiB");
        sources.push(...sourcesFrom(text));
      }
    }
    if (
      !sources.length ||
      sources.length > 64 ||
      sources.some((s) => Buffer.byteLength(s) > 262144) ||
      sources.reduce((n, s) => n + Buffer.byteLength(s), 0) > MAX_PLAN
    )
      throw new Error(
        "Plan exceeds 64 files, 256 KiB per migration or 1 MiB total",
      );
    // Preserve the established single-file API and checksum for existing users.
    const single = sources.length === 1 && options["--file"];
    const body = single ? { source: sources[0] } : { sources };
    const preview = await request(
      single ? "schema_preview" : "schema_plan",
      body,
    );
    result = options["--apply"]
      ? await request(single ? "schema_apply" : "schema_apply_plan", {
          ...body,
          checksum: preview.checksum,
          expected_revision: preview.expected_revision,
        })
      : result || preview;
  }
  const output = JSON.stringify(result, null, 2) + "\n";
  if (options["--out"]) {
    await writeFile(resolve(options["--out"]), output, {
      flag: "wx",
      mode: 0o600,
    });
    console.error(`Saved ${resolve(options["--out"])}`);
  }
  console.log(output.trimEnd());
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
