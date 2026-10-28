/**
 * Fixture loader and fake transport shared by the RPC tests.
 *
 * Layout: `tests/fixtures/<version>/<name>.json` holds spec-derived captures;
 * `tests/fixtures/<version>/recorded/<name>.json` holds captures recorded from
 * a real daemon. Every JSON file under both is loaded, so a recorded capture
 * is exercised by the same tests the moment it lands.
 *
 * Fixture shape:
 * {
 *   "_source":   "spec-derived" | "recorded <bench, date>",
 *   "dialect":   "legacy" | "jsonrpc",
 *   "method":    "torrent-get" | "session-get" | ...   (legacy spelling)
 *   "handshake": { "sessionId": string, "rpcVersionHeader": string|null },
 *   "request":   <wire body as the client sends it>,
 *   "response":  <wire body as the daemon answers>,
 *   "expect":    <optional assertions a test may read>
 * }
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURE_ROOT = dirname(fileURLToPath(import.meta.url));

function jsonFiles(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(".json"))
    .sort()
    .map((n) => join(dir, n));
}

/** Sorted fixture version directories (`rpc-15`, `rpc-16`, ...). */
export function fixtureVersions() {
  return readdirSync(FIXTURE_ROOT)
    .filter((n) => statSync(join(FIXTURE_ROOT, n)).isDirectory())
    .sort();
}

/**
 * @param {{ version?: string, method?: string, name?: string }} [filter]
 * @returns {{ version: string, name: string, path: string, recorded: boolean, data: object }[]}
 */
export function loadFixtures(filter = {}) {
  const out = [];
  for (const version of fixtureVersions()) {
    if (filter.version && filter.version !== version) continue;
    const dir = join(FIXTURE_ROOT, version);
    const paths = [
      ...jsonFiles(dir).map((p) => ({ p, recorded: false })),
      ...jsonFiles(join(dir, "recorded")).map((p) => ({ p, recorded: true })),
    ];
    for (const { p, recorded } of paths) {
      const data = JSON.parse(readFileSync(p, "utf8"));
      if (filter.method && data.method !== filter.method) continue;
      const name = basename(p, ".json");
      if (filter.name && filter.name !== name) continue;
      out.push({ version, name, path: p, recorded, data });
    }
  }
  return out;
}

/** Legacy-spelled call arguments from a fixture's wire request. */
export function requestArgs(fixture) {
  const req = fixture.request ?? {};
  return fixture.dialect === "jsonrpc" ? (req.params ?? {}) : (req.arguments ?? {});
}

/**
 * Wire-method name (`torrent_get` / `torrent-get`) of a request body, so the
 * fake transport can route by method in either dialect.
 */
function wireMethod(body) {
  if (!body || typeof body !== "object") return "";
  return String(body.method ?? "").replace(/_/g, "-");
}

function jsonResponse(status, body, headers = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/**
 * Build a fetch-compatible fake transport.
 *
 * Without a valid `X-Transmission-Session-Id` header it answers 409 with the
 * handshake headers. With it, it routes by method to `responses[method]`,
 * which is either a wire body or a function `(body, call) => Response | body`.
 * Every call is pushed to `calls` as `{ url, init, body }`.
 *
 * @param {{ sessionId: string, rpcVersionHeader?: string|null }} handshake
 * @param {Record<string, object|((body: object, call: object) => unknown)>} responses
 */
export function makeTransport(handshake, responses) {
  const calls = [];
  const transport = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    const call = { url, init, body };
    calls.push(call);
    const headers = init && init.headers ? init.headers : {};
    if (headers["X-Transmission-Session-Id"] !== handshake.sessionId) {
      const h = { "X-Transmission-Session-Id": handshake.sessionId };
      if (handshake.rpcVersionHeader) h["X-Transmission-Rpc-Version"] = handshake.rpcVersionHeader;
      return jsonResponse(409, undefined, h);
    }
    const method = wireMethod(body);
    const handler = responses[method];
    if (handler === undefined) return jsonResponse(404, { message: `no fixture for ${method}` });
    const answer = typeof handler === "function" ? await handler(body, call) : handler;
    return answer instanceof Response ? answer : jsonResponse(200, answer);
  };
  transport.calls = calls;
  return transport;
}

/** Transport that serves exactly one fixture (its method -> its response). */
export function fixtureTransport(fixture) {
  return makeTransport(fixture.handshake, { [fixture.method]: fixture.response });
}
