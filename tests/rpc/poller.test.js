import { test } from "node:test";
import assert from "node:assert/strict";

import { DIALECT, SESSION_HEADER, createClient } from "../../src/app/js/rpc/client.js?v=__QBV__";
import { buildCaps } from "../../src/app/js/rpc/caps.js?v=__QBV__";
import { getSession } from "../../src/app/js/rpc/session.js?v=__QBV__";
import {
  ALWAYS_VISIBLE,
  DEFAULT_INTERVAL_SECONDS,
  INTERVAL_PREF,
  connectionFailure,
  createPoller,
} from "../../src/app/js/rpc/poller.js?v=__QBV__";
import { RpcError } from "../../src/app/js/rpc/client.js?v=__QBV__";
import { createStore } from "../../src/app/js/core/store.js?v=__QBV__";
import { fixtureVersions, loadFixtures, makeTransport, okResponse, recordedTransport } from "../fixtures/load.js";

const RECORDED_VERSIONS = fixtureVersions().filter((v) => loadFixtures({ version: v, recorded: true }).length > 0);
const SESSION = "testSessionId0123456789abcdefghijklmnopqrs";

/** Deterministic timers: nothing fires until `flush()`. */
function fakeTimers() {
  let seq = 0;
  const pending = new Map();
  return {
    setTimeout: (fn, ms) => {
      seq += 1;
      pending.set(seq, { fn, ms });
      return seq;
    },
    clearTimeout: (id) => {
      pending.delete(id);
    },
    pending: () => [...pending.values()],
    async flush() {
      const due = [...pending.entries()];
      pending.clear();
      for (const [, { fn }] of due) await fn();
    },
  };
}

function fakeVisibility(hidden = false) {
  const subs = new Set();
  return {
    isHidden: () => hidden,
    subscribe: (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    set(next) {
      hidden = next;
      for (const fn of [...subs]) fn();
    },
  };
}

async function recordedPoller(version, { prefs = {}, visibility = ALWAYS_VISIBLE } = {}) {
  const { transport, dialect } = recordedTransport(version);
  const client = createClient({ transport, dialect });
  const caps = buildCaps(await getSession(client), { dialect });
  const store = createStore({ prefs });
  const timers = fakeTimers();
  const poller = createPoller({ client, caps, store, visibility, timers, now: () => 1000 });
  return { client, caps, store, timers, poller, transport, dialect };
}

const torrentGets = (transport, dialect) =>
  transport.calls.filter((c) => c.body && /torrent.get/.test(c.body.method)).map((c) => (dialect === DIALECT.JSONRPC ? c.body.params : c.body.arguments));

for (const version of RECORDED_VERSIONS) {
  test(`${version}: start does a full fetch, then polls recently-active with poll fields`, async () => {
    const { store, timers, poller, transport, dialect } = await recordedPoller(version, { prefs: { [INTERVAL_PREF]: 2 } });
    await poller.start();
    const first = store.get();
    assert.equal(first.torrents.size, 6, "recorded set has six torrents");
    assert.equal(first.connection.state, "online");
    assert.equal(typeof first.session.downloadDir, "string", "the full session-get is merged");
    assert.ok(Number.isInteger(first.stats.torrentCount));
    const gets = torrentGets(transport, dialect);
    assert.equal(gets.length, 1);
    assert.equal(gets[0].ids, undefined, "first fetch is full");
    assert.ok(gets[0].fields.some((f) => /hash/.test(f)), "full fetch carries base fields");

    assert.equal(timers.pending().length, 1, "next tick scheduled after the first settles");
    assert.equal(timers.pending()[0].ms, 2000, "interval from prefs");

    await timers.flush();
    const second = store.get();
    assert.ok(!Object.is(first.torrents, second.torrents), "a NEW Map lands in the store each tick");
    assert.equal(second.torrents.size, 6);
    const poll = torrentGets(transport, dialect).at(-1);
    assert.match(String(poll.ids), /recently.active/);
    assert.ok(!poll.fields.some((f) => /hash/.test(f)), "poll rows skip immutable fields");
    for (const [id, t] of second.torrents) {
      assert.equal(t.hash.length, 40, `torrent ${id} keeps its hash across the poll`);
      assert.equal(t.trackers.length, 2);
    }
    assert.equal(second.connection, first.connection, "connection object is not rewritten while it stays online");
    assert.equal(timers.pending().length, 1);
    poller.stop();
    assert.equal(timers.pending().length, 0, "stop clears the timer");
    assert.equal(poller.isRunning(), false);
  });
}

test("default interval is 5 s; junk prefs fall back to it", async () => {
  for (const prefs of [{}, { [INTERVAL_PREF]: "abc" }, { [INTERVAL_PREF]: 0 }, { [INTERVAL_PREF]: -3 }]) {
    const { timers, poller } = await recordedPoller("rpc-17", { prefs });
    await poller.start();
    assert.equal(timers.pending()[0].ms, DEFAULT_INTERVAL_SECONDS * 1000);
    poller.stop();
  }
  const { timers, poller } = await recordedPoller("rpc-17", { prefs: { [INTERVAL_PREF]: "7" } });
  await poller.start();
  assert.equal(timers.pending()[0].ms, 7000);
  poller.stop();
});

test("ticks never overlap: a tick during a tick joins it", async () => {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  let torrentGetCount = 0;
  const transport = makeTransport({ sessionId: SESSION, rpcVersionHeader: null }, {
    "torrent-get": async (body) => {
      torrentGetCount += 1;
      await gate;
      return okResponse("legacy", body, { torrents: [{ id: 1, name: "a", hashString: "h" }] });
    },
    "session-get": (body) => okResponse("legacy", body, { "alt-speed-enabled": false, "rpc-version": 15 }),
    "session-stats": (body) => okResponse("legacy", body, { torrentCount: 1 }),
  });
  const client = createClient({ transport });
  const caps = buildCaps({ rpcVersion: 15 }, { dialect: DIALECT.LEGACY });
  const store = createStore();
  const timers = fakeTimers();
  const poller = createPoller({ client, caps, store, timers });
  const a = poller.start();
  const b = poller.tick();
  const c = poller.refreshAll();
  assert.equal(a, b);
  assert.equal(b, c);
  release();
  await a;
  assert.equal(torrentGetCount, 1, "one request set for three overlapping asks");
  assert.equal(store.get().torrents.size, 1);
  poller.stop();
});

test("an unseen id in the recently-active delta triggers one base-field refetch", async () => {
  let gets = 0;
  const transport = makeTransport({ sessionId: SESSION, rpcVersionHeader: null }, {
    "torrent-get": (body) => {
      gets += 1;
      const { ids } = body.arguments;
      if (ids === undefined) return okResponse("legacy", body, { torrents: [{ id: 1, name: "a", hashString: "h1", downloadDir: "/d" }] });
      if (ids === "recently-active") {
        return okResponse("legacy", body, { torrents: [{ id: 1, rateDownload: 9 }, { id: 2, name: "new", rateDownload: 5 }], removed: [] });
      }
      assert.deepEqual(ids, [2], "refetch asks only for the unseen id");
      assert.ok(body.arguments.fields.includes("hashString"));
      return okResponse("legacy", body, { torrents: [{ id: 2, name: "new", hashString: "h2", downloadDir: "/e", rateDownload: 5 }] });
    },
    "session-get": (body) => okResponse("legacy", body, { "rpc-version": 15 }),
    "session-stats": (body) => okResponse("legacy", body, {}),
  });
  const client = createClient({ transport });
  const caps = buildCaps({ rpcVersion: 15 }, { dialect: DIALECT.LEGACY });
  const store = createStore();
  const timers = fakeTimers();
  const poller = createPoller({ client, caps, store, timers });
  await poller.start();
  assert.equal(gets, 1);
  await poller.tick();
  assert.equal(gets, 3, "poll + one refetch");
  const t2 = store.get().torrents.get(2);
  assert.equal(t2.hash, "h2");
  assert.equal(t2.downloadDir, "/e");
  assert.equal(t2.rateDownload, 5);
  assert.equal(store.get().torrents.get(1).rateDownload, 9);
  assert.equal(store.get().torrents.get(1).hash, "h1");
  poller.stop();
});

test("hidden pages pause polling; becoming visible polls at once", async () => {
  const visibility = fakeVisibility(true);
  const { store, timers, poller, transport, dialect } = await recordedPoller("rpc-16", { visibility });
  await poller.start();
  assert.equal(store.get().torrents.size, 6, "start still primes the store");
  assert.equal(timers.pending().length, 0, "nothing scheduled while hidden");
  assert.equal(poller.isPaused(), true);
  const before = torrentGets(transport, dialect).length;
  visibility.set(false);
  assert.equal(poller.isPaused(), false);
  await new Promise((r) => setTimeout(r, 0));
  // allow the immediate poll to settle
  for (let i = 0; i < 10 && torrentGets(transport, dialect).length === before; i += 1) await new Promise((r) => setTimeout(r, 0));
  assert.equal(torrentGets(transport, dialect).length, before + 1, "one poll on becoming visible");
  for (let i = 0; i < 10 && timers.pending().length === 0; i += 1) await new Promise((r) => setTimeout(r, 0));
  assert.equal(timers.pending().length, 1, "and the cadence resumes");
  visibility.set(true);
  assert.equal(timers.pending().length, 0, "hiding again cancels the pending tick");
  poller.stop();
});

test("failures mark the connection and keep polling; 401 is unauthorized", async () => {
  let mode = "ok";
  const transport = async (url, init) => {
    if (!init.headers[SESSION_HEADER]) return new Response(null, { status: 409, headers: { [SESSION_HEADER]: SESSION } });
    if (mode === "down") return new Response("nope", { status: 500 });
    if (mode === "auth") return new Response("", { status: 401 });
    const body = JSON.parse(init.body);
    const args = body.method === "torrent-get" ? { torrents: [] } : body.method === "session-get" ? { "rpc-version": 15 } : {};
    return new Response(JSON.stringify({ result: "success", arguments: args, tag: body.tag }), { status: 200 });
  };
  const client = createClient({ transport });
  const caps = buildCaps({ rpcVersion: 15 }, { dialect: DIALECT.LEGACY });
  const store = createStore();
  const timers = fakeTimers();
  const poller = createPoller({ client, caps, store, timers, now: () => 42 });
  await poller.start();
  assert.deepEqual(store.get().connection, { state: "online", error: null, since: 42 });

  mode = "down";
  await timers.flush();
  assert.equal(store.get().connection.state, "offline");
  assert.match(store.get().connection.error, /HTTP 500/);
  assert.equal(timers.pending().length, 1, "still scheduled after a failure");

  mode = "auth";
  await timers.flush();
  assert.equal(store.get().connection.state, "unauthorized");

  mode = "ok";
  await timers.flush();
  assert.equal(store.get().connection.state, "online");
  poller.stop();
});

test("connectionFailure maps 401/403 to unauthorized and everything else to offline", () => {
  assert.deepEqual(connectionFailure(new RpcError(401, "nope"), 7), { state: "unauthorized", error: "nope", since: 7 });
  assert.deepEqual(connectionFailure(new RpcError(403, "no"), 8), { state: "unauthorized", error: "no", since: 8 });
  assert.deepEqual(connectionFailure(new RpcError(500, "HTTP 500"), 9), { state: "offline", error: "HTTP 500", since: 9 });
  assert.deepEqual(connectionFailure(new TypeError("Failed to fetch"), 10), { state: "offline", error: "Failed to fetch", since: 10 });
  assert.deepEqual(connectionFailure(null, 11), { state: "offline", error: "request failed", since: 11 });
  assert.ok(Number.isFinite(connectionFailure(new Error("x")).since), "since defaults to now");
});
