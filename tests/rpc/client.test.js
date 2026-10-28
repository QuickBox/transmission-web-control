import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DIALECT,
  RpcError,
  SESSION_HEADER,
  createClient,
  mapKeys,
  normalizeResult,
  toCamelKey,
  toJsonRpcParams,
  toSnakeKey,
} from "../../src/app/js/rpc/client.js?v=__QBV__";
import { fixtureTransport, isErrorResponse, loadFixtures, makeTransport, requestArgs } from "../fixtures/load.js";

const SESSION = "testSessionId0123456789abcdefghijklmnopqrs";
const LEGACY = { sessionId: SESSION, rpcVersionHeader: null };
const JSONRPC = { sessionId: SESSION, rpcVersionHeader: "6.0.1" };

function hasSeparator(value) {
  if (Array.isArray(value)) return value.some(hasSeparator);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([k, v]) => /[-_]/.test(k) || hasSeparator(v));
}

test("key conversion: legacy and JSON-RPC spellings meet at camelCase", () => {
  assert.equal(toSnakeKey("trackerStats"), "tracker_stats");
  assert.equal(toSnakeKey("download-dir"), "download_dir");
  assert.equal(toSnakeKey("peersGettingFromUs"), "peers_getting_from_us");
  assert.equal(toSnakeKey("isUTP"), "is_utp");
  assert.equal(toSnakeKey("id"), "id");
  assert.equal(toCamelKey("tracker_stats"), "trackerStats");
  assert.equal(toCamelKey("download-dir"), "downloadDir");
  assert.equal(toCamelKey("rpc_version_semver"), "rpcVersionSemver");
  assert.equal(toCamelKey("rpc-version-semver"), "rpcVersionSemver");
  assert.equal(toCamelKey("is_utp"), "isUTP");
  assert.equal(toCamelKey("percentDone"), "percentDone");
  for (const key of ["hashString", "percentDone", "leftUntilDone", "trackerStats", "uploadRatio", "queuePosition"]) {
    assert.equal(toCamelKey(toSnakeKey(key)), key, key);
  }
});

test("toJsonRpcParams: snake keys, snake fields, recently_active sentinel", () => {
  const params = toJsonRpcParams({
    fields: ["id", "hashString", "trackerStats"],
    ids: "recently-active",
    format: "table",
    "download-dir": "/x",
  });
  assert.deepEqual(params, {
    fields: ["id", "hash_string", "tracker_stats"],
    ids: "recently_active",
    format: "table",
    download_dir: "/x",
  });
  assert.deepEqual(toJsonRpcParams({ ids: [1, 2] }).ids, [1, 2]);
  assert.deepEqual(toJsonRpcParams(undefined), {});
});

test("normalizeResult walks arrays and nested objects", () => {
  const out = normalizeResult({ torrents: [{ tracker_stats: [{ seeder_count: 3 }], "download-dir": "/d" }], removed: [1] });
  assert.deepEqual(out, { torrents: [{ trackerStats: [{ seederCount: 3 }], downloadDir: "/d" }], removed: [1] });
  assert.equal(mapKeys(null, toCamelKey), null);
  assert.equal(mapKeys(7, toCamelKey), 7);
});

test("fresh client: concurrent callers share one handshake, then each sends once", async () => {
  const transport = makeTransport(LEGACY, { "session-stats": { "arguments": { activeTorrentCount: 2 }, result: "success" } });
  const client = createClient({ transport });
  const results = await Promise.all([
    client.call("session-stats"),
    client.call("session-stats"),
    client.call("session-stats"),
  ]);
  assert.deepEqual(results, Array(3).fill({ activeTorrentCount: 2 }));
  const handshakes = transport.calls.filter((c) => !c.init.headers[SESSION_HEADER]);
  assert.equal(handshakes.length, 1, "exactly one handshake request");
  assert.equal(handshakes[0].init.body, "{}");
  assert.equal(transport.calls.length, 4);
  assert.equal(client.sessionId, SESSION);
  assert.equal(client.dialect, DIALECT.LEGACY);
  assert.equal(client.rpcVersionHeader, null);
  for (const c of transport.calls) {
    assert.equal(c.init.method, "POST");
    assert.equal(c.init.credentials, "same-origin");
    assert.equal(c.url, "../rpc");
  }
});

test("legacy dialect: {method, arguments, tag} envelope, camelCase result", async () => {
  const transport = makeTransport(LEGACY, {
    "torrent-get": (body) => {
      assert.equal(body.method, "torrent-get");
      assert.deepEqual(body.arguments, { fields: ["id", "hashString"], ids: "recently-active" });
      assert.equal(typeof body.tag, "number");
      return { result: "success", arguments: { torrents: [{ id: 1, hashString: "ab" }], removed: [] }, tag: body.tag };
    },
  });
  const client = createClient({ transport });
  const out = await client.call("torrent-get", { fields: ["id", "hashString"], ids: "recently-active" });
  assert.deepEqual(out, { torrents: [{ id: 1, hashString: "ab" }], removed: [] });
});

test("409 with X-Transmission-Rpc-Version selects JSON-RPC 2.0", async () => {
  const transport = makeTransport(JSONRPC, {
    "torrent-get": (body) => {
      assert.equal(body.jsonrpc, "2.0");
      assert.equal(body.method, "torrent_get");
      assert.deepEqual(body.params, { fields: ["id", "hash_string", "tracker_stats"], ids: "recently_active", format: "table" });
      assert.equal(typeof body.id, "number");
      assert.equal(body.arguments, undefined);
      assert.equal(body.tag, undefined);
      return { jsonrpc: "2.0", result: { torrents: [["id", "hash_string"], [1, "ab"]], removed: [] }, id: body.id };
    },
  });
  const client = createClient({ transport });
  const out = await client.call("torrent-get", { fields: ["id", "hashString", "trackerStats"], ids: "recently-active", format: "table" });
  assert.equal(client.dialect, DIALECT.JSONRPC);
  assert.equal(client.rpcVersionHeader, "6.0.1");
  assert.deepEqual(out, { torrents: [["id", "hash_string"], [1, "ab"]], removed: [] });
});

test("an explicit dialect option is kept across the handshake", async () => {
  const transport = makeTransport(JSONRPC, { "session-stats": { result: "success", arguments: { "cumulative-stats": { "files-added": 1 } } } });
  const client = createClient({ transport, dialect: DIALECT.LEGACY });
  const out = await client.call("session-stats");
  assert.equal(client.dialect, DIALECT.LEGACY);
  assert.equal(client.rpcVersionHeader, "6.0.1", "header is still captured");
  assert.deepEqual(out, { cumulativeStats: { filesAdded: 1 } });
});

test("expired session: a 409 mid-stream is retried exactly once with the new id", async () => {
  let session = "oldSession";
  const calls = [];
  const transport = async (url, init) => {
    calls.push(init);
    if (init.headers[SESSION_HEADER] !== session) {
      return new Response(null, { status: 409, headers: { [SESSION_HEADER]: session } });
    }
    return new Response(JSON.stringify({ result: "success", arguments: { ok: 1 } }), { status: 200 });
  };
  const client = createClient({ transport });
  await client.call("session-stats");
  assert.equal(calls.length, 2, "handshake + call");
  session = "newSession";
  const out = await client.call("session-stats");
  assert.deepEqual(out, { ok: 1 });
  assert.equal(calls.length, 4, "one rejected call + one retry");
  assert.equal(calls[3].headers[SESSION_HEADER], "newSession");
  assert.equal(client.sessionId, "newSession");
});

test("a second 409 on the retry surfaces as RpcError 409, never a loop", async () => {
  let n = 0;
  const transport = async () => {
    n += 1;
    return new Response(null, { status: 409, headers: { [SESSION_HEADER]: `s${n}` } });
  };
  const client = createClient({ transport });
  await assert.rejects(client.call("session-stats"), (err) => {
    assert.ok(err instanceof RpcError);
    assert.equal(err.status, 409);
    assert.equal(err.method, "session-stats");
    return true;
  });
  assert.equal(n, 3, "handshake, call, one retry");
});

test("a 409 without a session id is an error, not a silent retry", async () => {
  const transport = async () => new Response(null, { status: 409 });
  const client = createClient({ transport });
  await assert.rejects(client.call("session-stats"), { status: 409 });
});

test("HTTP and RPC-level failures become {status, message}", async () => {
  const transport = makeTransport(LEGACY, {
    "session-stats": () => new Response("nope", { status: 500 }),
    "torrent-get": { result: "invalid argument", arguments: {} },
    "session-get": () => new Response("<html>", { status: 200 }),
  });
  const client = createClient({ transport });
  await assert.rejects(client.call("session-stats"), (err) => {
    assert.equal(err.status, 500);
    assert.deepEqual(err.toJSON(), { status: 500, message: err.message });
    return true;
  });
  await assert.rejects(client.call("torrent-get"), { status: 200, message: "invalid argument" });
  await assert.rejects(client.call("session-get"), (err) => /non-JSON/.test(err.message));
});

test("JSON-RPC error objects carry code and message", async () => {
  const transport = makeTransport(JSONRPC, {
    "torrent-get": (body) => ({ jsonrpc: "2.0", error: { code: -32602, message: "Invalid params" }, id: body.id }),
  });
  const client = createClient({ transport });
  await assert.rejects(client.call("torrent-get"), (err) => {
    assert.ok(err instanceof RpcError);
    assert.equal(err.status, 200);
    assert.equal(err.code, -32602);
    assert.equal(err.message, "Invalid params");
    return true;
  });
});

test("timeout aborts through the signal and reports status 0", async () => {
  const transport = (url, init) =>
    new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  const client = createClient({ transport, timeout: 20 });
  await assert.rejects(client.call("session-stats"), (err) => {
    assert.ok(err instanceof RpcError);
    assert.equal(err.status, 0);
    assert.match(err.message, /timed out/);
    return true;
  });
});

test("network failure reports status 0 with the transport message", async () => {
  const client = createClient({
    transport: async () => {
      throw new TypeError("Failed to fetch");
    },
  });
  await assert.rejects(client.call("session-stats"), { status: 0, message: "Failed to fetch" });
});

test("explicit Authorization header is sent on every request, including the handshake", async () => {
  const transport = makeTransport(LEGACY, { "session-stats": { result: "success", arguments: {} } });
  const client = createClient({ transport, authorization: "Basic dXNlcjpwYXNz", url: "/transmission/rpc" });
  await client.call("session-stats");
  assert.equal(transport.calls.length, 2);
  for (const c of transport.calls) {
    assert.equal(c.init.headers.Authorization, "Basic dXNlcjpwYXNz");
    assert.equal(c.url, "/transmission/rpc");
  }
  const bare = makeTransport(LEGACY, { "session-stats": { result: "success", arguments: {} } });
  await createClient({ transport: bare }).call("session-stats");
  for (const c of bare.calls) assert.equal(c.init.headers.Authorization, undefined);
});

for (const fx of loadFixtures()) {
  test(`fixture ${fx.version}/${fx.name}${fx.recorded ? " (recorded)" : ""}: round-trips through the client with camelCase keys`, async () => {
    const transport = fixtureTransport(fx.data);
    // A 4.1 daemon answers legacy only when the client is told to; force the fixture's dialect.
    const client = createClient({ transport, dialect: fx.data.dialect });
    if (isErrorResponse(fx.data)) {
      await assert.rejects(client.call(fx.data.method, requestArgs(fx.data)), (err) => {
        assert.ok(err instanceof RpcError);
        assert.equal(err.status, 200, "an RPC-level error arrives over HTTP 200");
        assert.equal(typeof err.message, "string");
        if (fx.data.dialect === DIALECT.JSONRPC) assert.equal(err.code, fx.data.response.error.code);
        return true;
      });
      return;
    }
    const result = await client.call(fx.data.method, requestArgs(fx.data));
    assert.equal(client.rpcVersionHeader, fx.data.handshake.rpcVersionHeader ?? null, "409 header captured");
    const unforced = createClient({ transport: fixtureTransport(fx.data) });
    await unforced.handshake();
    assert.equal(unforced.dialect, fx.data.handshake.rpcVersionHeader ? DIALECT.JSONRPC : DIALECT.LEGACY, "header selects the dialect");
    assert.ok(result && typeof result === "object");
    assert.equal(hasSeparator(result), false, "no kebab or snake key survives normalisation");
    const sent = transport.calls.find((c) => c.init.headers[SESSION_HEADER]);
    if (fx.data.dialect === DIALECT.JSONRPC) {
      assert.equal(sent.body.jsonrpc, "2.0");
      assert.equal(sent.body.method, fx.data.request.method);
    } else {
      assert.equal(sent.body.method, fx.data.method);
    }
  });
}
