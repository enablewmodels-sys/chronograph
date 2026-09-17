import { mkdtemp, readFile, writeFile, mkdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
export const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const serverBinary = join(
  root,
  process.env.CHRONOGRAPH_TEST_PROFILE || "target/release",
  "chronograph-server",
);
export async function startServer({
  port = 18081,
  data,
  config,
  tokenFile,
  extra = {},
} = {}) {
  const base = await mkdtemp(join(tmpdir(), "chronograph-test-"));
  data ||= join(base, "data");
  config ||= join(base, "config/auth.json");
  tokenFile ||= join(base, "admin.token");
  try {
    await access(tokenFile);
  } catch {
    execFileSync(
      serverBinary,
      ["admin", "create-token", "test administrator", "admin", "1", tokenFile],
      {
        cwd: root,
        env: { ...process.env, CHRONOGRAPH_AUTH: config },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  }
  const adminToken = (await readFile(tokenFile, "utf8")).trim();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(serverBinary, ["serve"], {
    cwd: root,
    env: {
      ...process.env,
      CHRONOGRAPH_DATA: data,
      CHRONOGRAPH_AUTH: config,
      CHRONOGRAPH_BIND: `127.0.0.1:${port}`,
      CHRONOGRAPH_ORIGIN: url,
      ...extra,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let log = "";
  child.stderr.on("data", (s) => {
    log += s;
  });
  const stop = async (signal = "SIGTERM") => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const done = once(child, "exit");
    child.kill(signal);
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      await done;
    } finally {
      clearTimeout(timer);
    }
  };
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`Server exited: ${log}`);
    try {
      const r = await fetch(`${url}/healthz`, {
        signal: AbortSignal.timeout(250),
      });
      if (r.ok)
        return {
          url,
          data,
          config,
          tokenFile,
          adminToken,
          child,
          stop,
          logs: () => log,
        };
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  await stop();
  throw new Error(`Server did not start: ${log}`);
}
export function client(server, token = server.adminToken) {
  const request = (
    path,
    body,
    method = body === undefined ? "GET" : "POST",
    override = {},
  ) =>
    fetch(server.url + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...override,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(120000),
    });
  const json = async (path, body, method) => {
    const r = await request(path, body, method);
    const v = await r.json();
    if (!r.ok) throw new Error(`${path}: ${r.status}: ${JSON.stringify(v)}`);
    return v;
  };
  return { request, json };
}
export async function report(name, value) {
  const phase = process.env.CHRONOGRAPH_REPORT_PHASE || "phase-3";
  if (!/^phase-[a-z0-9-]+$/.test(phase))
    throw new Error("Invalid report phase");
  const dir = join(root, "bench/reports/v0.4.0-alpha.3", phase);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, name),
    typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n",
  );
}
