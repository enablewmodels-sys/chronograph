/**
 * Health polling for a started container.
 *
 * WHY this exists rather than a fixed sleep: "docker run" returning means the process is
 * scheduled, not that it can serve traffic - a database-backed app routinely answers 503 for
 * seconds while it opens its journal. A deployment that is not proven healthy is stopped again
 * so a broken build never sits in a port.
 */

import { setTimeout as delay } from "node:timers/promises";

/**
 * Poll a driver's health probe until it answers 2xx or the deadline passes.
 * @param {object} input
 * @param {{ probe: (target: { port: number, path: string }) => Promise<{ ok: boolean, status: number, body: string }> }} input.driver
 * @param {number} input.port published host port
 * @param {string} input.path health path from the manifest, for example /healthz
 * @param {number} [input.timeoutMs]
 * @param {number} [input.intervalMs]
 * @param {() => number} [input.now]
 * @param {(ms: number) => Promise<void>} [input.sleep]
 * @returns {Promise<{ healthy: boolean, attempts: number, elapsedMs: number, url: string, lastResponse: { status: number, body: string } }>}
 */
export async function waitForHealth(input) {
  const timeoutMs = input.timeoutMs ?? 60000;
  const intervalMs = input.intervalMs ?? 1000;
  const now = input.now ?? (() => Date.now());
  const sleep = input.sleep ?? delay;
  const url = "http://127.0.0.1:" + input.port + input.path;
  const startedAt = now();
  let attempts = 0;
  let lastResponse = { status: 0, body: "no response" };
  for (;;) {
    attempts += 1;
    lastResponse = await input.driver.probe({
      port: input.port,
      path: input.path,
    });
    if (lastResponse.ok) {
      return {
        healthy: true,
        attempts,
        elapsedMs: now() - startedAt,
        url,
        lastResponse,
      };
    }
    if (now() - startedAt >= timeoutMs) {
      return {
        healthy: false,
        attempts,
        elapsedMs: now() - startedAt,
        url,
        lastResponse,
      };
    }
    // Wait before the next attempt, but never past the deadline beyond one interval.
    await sleep(
      Math.min(intervalMs, Math.max(0, timeoutMs - (now() - startedAt))),
    );
  }
}
