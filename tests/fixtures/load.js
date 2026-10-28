/**
 * Fixture loader and fake transport shared by the RPC tests.
 *
 * Layout: `tests/fixtures/<version>/<name>.json` holds spec-derived captures;
 * `tests/fixtures/<version>/recorded/<dialect>.<call>.json` holds captures
 * recorded from a real daemon, with `recorded/handshake-409.json` carrying the
 * headers that daemon put on its 409. Every JSON file under both is loaded, so
 * a recorded capture is exercised by the same tests the moment it lands.
 *
 * Spec-derived file shape:
 * {
 *   "_source":   "spec-derived",
 *   "dialect":   "legacy" | "jsonrpc",
 *   "method":    "torrent-get" | "session-get" | ...   (legacy spelling)
 *   "handshake": { "sessionId": string, "rpcVersionHeader": string|null },
 *   "request":   <wire body as the client sends it>,
 *   "response":  <wire body as the daemon answers>,
 *   "expect":    <optional assertions a test may read>
 * }
 *
 * Recorded file shape: `{ "_source", "request", "response" }`. The dialect is
 * the file-name prefix, the method comes from the request, and the handshake
 * from `handshake-409.json`. Both shapes load into the spec-derived one.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURE_ROOT = dirname(fileURLToPath(import.meta.url));

const HANDSHAKE_FILE = "handshake-409.json";
const RECORDED_SESSION_ID = "recordedSessionId0123456789abcdefghijklmnop";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

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
 * Lift a recorded capture into the spec-derived shape.
 * `legacy.torrent-get-table.json` -> dialect `legacy`, name `torrent-get-table`;
 * `jsonrpc.torrent_get_recent.json` -> dialect `jsonrpc`, name `torrent-get-recent`.
 */
function liftRecorded(path, data, handshakeHeaders) {
  const file = basename(path, ".json");
  const dot = file.indexOf(".");
  const prefix = dot === -1 ? "" : file.slice(0, dot);
  const dialect = prefix === "jsonrpc" || (data.request && data.request.jsonrpc) ? "jsonrpc" : "legacy";
  const name = (dot === -1 ? file : file.slice(dot + 1)).replace(/_/g, "-");
  const method = String(data.request && data.request.method ? data.request.method : name).replace(/_/g, "-");
  const rpcVersionHeader = handshakeHeaders["X-Transmission-Rpc-Version"] ?? null;
  return {
    name,
    data: {
      _source: data._source,
      dialect,
      method,
      handshake: { sessionId: RECORDED_SESSION_ID, rpcVersionHeader },
      request: data.request,
      response: data.response,
      expect: data.expect,
    },
  };
}

/**
 * @param {{ version?: string, method?: string, name?: string, recorded?: boolean }} [filter]
 * @returns {{ version: string, name: string, path: string, recorded: boolean, data: object }[]}
 */
export function loadFixtures(filter = {}) {
  const out = [];
  for (const version of fixtureVersions()) {
    if (filter.version && filter.version !== version) continue;
    const dir = join(FIXTURE_ROOT, version);
    const entries = [];
    if (filter.recorded !== true) {
      for (const p of jsonFiles(dir)) {
        entries.push({ path: p, recorded: false, name: basename(p, ".json"), data: readJson(p) });
      }
    }
    if (filter.recorded !== false) {
      const recordedDir = join(dir, "recorded");
      const handshakePath = join(recordedDir, HANDSHAKE_FILE);
      let headers = {};
      try {
        headers = readJson(handshakePath).headers ?? {};
      } catch {
        headers = {};
      }
      for (const p of jsonFiles(recordedDir)) {
        if (basename(p) === HANDSHAKE_FILE) continue;
        const raw = readJson(p);
        if (!raw.request || !raw.response) continue;
        const { name, data } = liftRecorded(p, raw, headers);
        entries.push({ path: p, recorded: true, name, data });
      }
    }
    for (const e of entries) {
      if (filter.method && e.data.method !== filter.method) continue;
      if (filter.name && filter.name !== e.name) continue;
      out.push({ version, ...e });
    }
  }
  return out;
}

/** Legacy-spelled call arguments from a fixture's wire request. */
export function requestArgs(fixture) {
  const req = fixture.request ?? {};
  return fixture.dialect === "jsonrpc" ? (req.params ?? {}) : (req.arguments ?? {});
}

/** True when the recorded daemon answered the call with an RPC-level error. */
export function isErrorResponse(fixture) {
  const res = fixture.response ?? {};
  return fixture.dialect === "jsonrpc" ? Boolean(res.error) : res.result !== "success";
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
