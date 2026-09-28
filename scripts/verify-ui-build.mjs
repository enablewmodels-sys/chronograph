import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function verifyUiBuild(directory, expected) {
  if (!["managed", "community", "public"].includes(expected))
    throw new Error("Expected edition must be managed, community or public.");
  const root =
    directory instanceof URL ? fileURLToPath(directory) : resolve(directory);
  const manifest = JSON.parse(
    await readFile(resolve(root, "chronodb-build.json"), "utf8"),
  );
  const html = await readFile(resolve(root, "index.html"), "utf8");
  if (
    manifest.schemaVersion !== 1 ||
    manifest.edition !== expected ||
    !html.includes(`<meta name="chronodb-edition" content="${expected}">`)
  )
    throw new Error(
      `UI edition mismatch: expected ${expected}. Rebuild the correct artifact before deploying.`,
    );
  const entry = html.match(/<script[^>]+src="([^"]+)"/);
  if (!entry) throw new Error("Missing UI entry script.");
  const asset = entry[1].match(/(?:^|\/)assets\/([a-zA-Z0-9_.-]+\.js)$/);
  if (!asset) throw new Error("Unexpected UI entry script path.");
  await readFile(resolve(root, "assets", asset[1]));
  console.log(`Verified ${expected} UI build.`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await verifyUiBuild(process.argv[2], process.argv[3]);
