#!/usr/bin/env node
// Optional Node 20+ migration client. JSON files are data, never executable code.
import { readFile, stat } from "node:fs/promises";

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(
      "Usage: node scripts/migrate.mjs --file migration.json --token-file config/admin.token [--url http://127.0.0.1:8080] [--apply]\nWithout --apply, prints a preview and does not change the database.",
    );
    return;
  }
  let file,
    tokenFile,
    apply = false,
    origin = process.env.CHRONOGRAPH_URL || "http://127.0.0.1:8080";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--apply") apply = true;
    else if (args[i] === "--file" && args[i + 1]) file = args[++i];
    else if (args[i] === "--token-file" && args[i + 1]) tokenFile = args[++i];
    else if (args[i] === "--url" && args[i + 1]) origin = args[++i];
    else throw new Error(`Unknown or incomplete argument: ${args[i]}`);
  }
  if (!file || !tokenFile)
    throw new Error("--file and --token-file are required; use --help");
  const url = new URL(origin);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    )
  )
    throw new Error(
      "URL must be an HTTPS origin or a loopback HTTP origin without credentials, query or path",
    );
  const metadata = await stat(file),
    tokenMetadata = await stat(tokenFile);
  if (!metadata.isFile() || metadata.size > 262144)
    throw new Error("Migration must be a regular file within 256 KiB");
  if (!tokenMetadata.isFile() || tokenMetadata.size > 4096)
    throw new Error("Invalid token file");
  const source = await readFile(file, "utf8"),
    token = (await readFile(tokenFile, "utf8")).trim();
  if (!/^cg_[a-f0-9]{16}_[a-f0-9]{64}$/.test(token))
    throw new Error("Token file does not contain a Chronograph API token");
  const request = async (op, body) => {
    const response = await fetch(new URL(`/v1/${op}`, url), {
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
  const preview = await request("schema_preview", { source });
  if (!apply) console.log(JSON.stringify(preview, null, 2));
  else
    console.log(
      JSON.stringify(
        await request("schema_apply", {
          source,
          checksum: preview.checksum,
          expected_revision: preview.expected_revision,
        }),
        null,
        2,
      ),
    );
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
