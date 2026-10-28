import { test } from "node:test";
import assert from "node:assert/strict";

import { DIALECT, createClient } from "../../src/app/js/rpc/client.js?v=__QBV__";
import { buildCaps } from "../../src/app/js/rpc/caps.js?v=__QBV__";
import {
  RECENTLY_ACTIVE,
  STATE,
  STATES,
  STATUS,
  aggregate,
  decodeTorrentGet,
  decodeTorrentRows,
  deriveState,
  fetchTorrents,
  mergeTorrents,
  normalizeTorrent,
  searchTorrents,
  torrentFields,
  torrentGetArgs,
  trackerHost,
} from "../../src/app/js/rpc/torrents.js?v=__QBV__";
import { fixtureTransport, loadFixtures, makeTransport, requestArgs } from "../fixtures/load.js";

const SESSION = "testSessionId0123456789abcdefghijklmnopqrs";
const CAPS_15 = buildCaps({ rpcVersion: 15 }, { dialect: DIALECT.LEGACY });
const CAPS_16 = buildCaps({ rpcVersion: 16 }, { dialect: DIALECT.LEGACY });
const CAPS_41 = buildCaps({ rpcVersionSemver: "6.0.1" }, { dialect: DIALECT.JSONRPC });

const DEPRECATED_FIELDS = ["manualAnnounceTime", "manual_announce_time", "wanted", "rpc_version", "rpc-version"];

/** Normalised store state from one torrent-get fixture, via the real client. */
async function stateFromFixture(fx, current = new Map()) {
  const client = createClient({ transport: fixtureTransport(fx.data), dialect: fx.data.dialect });
  const result = await client.call(fx.data.method, requestArgs(fx.data));
  const replace = requestArgs(fx.data).ids === undefined;
  return mergeTorrents(current, result, { replace });
}

function mapToObject(map) {
  return Object.fromEntries([...map.entries()].map(([id, t]) => [id, t]));
}

test("deriveState covers the seven states, error first", () => {
  assert.deepEqual(STATES, ["stopped", "queued", "checking", "downloading", "seeding", "finished", "error"]);
  assert.equal(deriveState({ status: STATUS.DOWNLOAD, error: 3 }), STATE.ERROR);
  assert.equal(deriveState({ status: STATUS.CHECK, error: 0 }), STATE.CHECKING);
  assert.equal(deriveState({ status: STATUS.CHECK_WAIT, error: 0 }), STATE.QUEUED);
  assert.equal(deriveState({ status: STATUS.DOWNLOAD_WAIT, error: 0 }), STATE.QUEUED);
  assert.equal(deriveState({ status: STATUS.SEED_WAIT, error: 0 }), STATE.QUEUED);
  assert.equal(deriveState({ status: STATUS.DOWNLOAD, error: 0 }), STATE.DOWNLOADING);
  assert.equal(deriveState({ status: STATUS.SEED, error: 0 }), STATE.SEEDING);
  assert.equal(deriveState({ status: STATUS.STOPPED, error: 0, percentDone: 0.5 }), STATE.STOPPED);
  assert.equal(deriveState({ status: STATUS.STOPPED, error: 0, percentDone: 1, leftUntilDone: 0, isFinished: false }), STATE.STOPPED, "a complete torrent the user paused is stopped");
  assert.equal(deriveState({ status: STATUS.STOPPED, error: 0, isFinished: true }), STATE.FINISHED, "finished = stopped because the seeding goal was met");
  assert.equal(deriveState({ status: STATUS.SEED, error: 0, isFinished: true }), STATE.SEEDING, "isFinished only matters once stopped");
  assert.equal(deriveState({ status: STATUS.STOPPED, error: 0 }), STATE.STOPPED, "an empty stopped row is stopped, not finished");
  assert.equal(deriveState({}), STATE.STOPPED);
});

test("torrentFields / torrentGetArgs gate labels and table format on caps", () => {
  const f15 = torrentFields(CAPS_15);
  assert.ok(!f15.includes("labels"));
  assert.ok(f15.includes("trackerStats"));
  for (const d of DEPRECATED_FIELDS) assert.ok(!f15.includes(d), d);
  assert.deepEqual(torrentGetArgs(CAPS_15), { fields: f15 });

  const a16 = torrentGetArgs(CAPS_16, { ids: RECENTLY_ACTIVE, poll: true });
  assert.ok(a16.fields.includes("labels"));
  assert.ok(!a16.fields.includes("hashString"), "poll rows skip immutable fields");
  assert.equal(a16.format, "table");
  assert.equal(a16.ids, "recently-active");

  const extra = torrentGetArgs(CAPS_16, { ids: [1, 2], extra: ["magnetLink", "id"] });
  assert.deepEqual(extra.ids, [1, 2]);
  assert.equal(extra.fields.filter((f) => f === "id").length, 1, "no duplicate fields");
  assert.ok(extra.fields.includes("magnetLink"));
});

test("JSON-RPC path never requests a deprecated field and spells everything snake_case", async () => {
  const transport = makeTransport({ sessionId: SESSION, rpcVersionHeader: "6.0.1" }, {
    "torrent-get": (body) => ({ jsonrpc: "2.0", result: { torrents: [["id", "name"], [1, "x"]], removed: [] }, id: body.id }),
  });
  const client = createClient({ transport });
  await fetchTorrents(client, CAPS_41, new Map());
  await fetchTorrents(client, CAPS_41, new Map(), { ids: RECENTLY_ACTIVE, poll: true });
  const bodies = transport.calls.filter((c) => c.body && c.body.method).map((c) => c.body);
  assert.equal(bodies.length, 2);
  for (const body of bodies) {
    assert.equal(body.jsonrpc, "2.0");
    assert.equal(body.method, "torrent_get");
    assert.equal(body.params.format, "table");
    for (const field of body.params.fields) {
      assert.match(field, /^[a-z0-9_]+$/, `field ${field} is snake_case`);
      assert.ok(!DEPRECATED_FIELDS.includes(field), `deprecated field ${field} requested`);
    }
    assert.ok(body.params.fields.includes("labels"));
    assert.ok(body.params.fields.includes("tracker_stats"));
    const raw = JSON.stringify(body);
    assert.ok(!/manual_?[aA]nnounce/.test(raw), "manualAnnounceTime never leaves the client");
    assert.ok(!/"wanted"/.test(raw), "top-level wanted never requested");
  }
  assert.equal(bodies[0].params.ids, undefined);
  assert.equal(bodies[1].params.ids, "recently_active");
});

test("legacy 2.94 path sends the legacy envelope without format or labels", async () => {
  const transport = makeTransport({ sessionId: SESSION, rpcVersionHeader: null }, {
    "torrent-get": { result: "success", arguments: { torrents: [{ id: 1, name: "x" }] } },
  });
  const client = createClient({ transport });
  const { torrents } = await fetchTorrents(client, CAPS_15, new Map());
  const body = transport.calls.at(-1).body;
  assert.equal(body.method, "torrent-get");
  assert.equal(body.arguments.format, undefined);
  assert.ok(!body.arguments.fields.includes("labels"));
  assert.equal(torrents.get(1).name, "x");
});

test("decodeTorrentRows expands table format with snake or camel headers", () => {
  assert.deepEqual(decodeTorrentRows([["id", "hash_string", "download-dir"], [1, "ab", "/d"], [2, "cd", "/e"]]), [
    { id: 1, hashString: "ab", downloadDir: "/d" },
    { id: 2, hashString: "cd", downloadDir: "/e" },
  ]);
  assert.deepEqual(decodeTorrentRows([{ id: 1 }, null, { id: 2 }]), [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(decodeTorrentRows([]), []);
  assert.deepEqual(decodeTorrentRows(undefined), []);
  assert.deepEqual(decodeTorrentRows([["id"]]), []);
  assert.deepEqual(decodeTorrentGet({ torrents: [["id"], [4]], removed: [5, "6", "x", null] }), { rows: [{ id: 4 }], removed: [5, 6] });
  assert.deepEqual(decodeTorrentGet(null), { rows: [], removed: [] });
});

test("normalizeTorrent tolerates missing fields and never coerces unknown counts to 0", () => {
  const bare = normalizeTorrent({ id: 9, name: "bare" });
  assert.equal(bare.id, 9);
  assert.equal(bare.hash, "");
  assert.equal(bare.state, STATE.STOPPED);
  assert.deepEqual(bare.labels, []);
  assert.deepEqual(bare.trackers, []);
  assert.deepEqual(bare.trackerHosts, []);
  assert.equal(bare.seederCount, null);
  assert.equal(bare.leecherCount, null);
  assert.equal(bare.eta, -1);
  assert.equal(bare.warning, "");
  assert.equal(bare.rateDownload, 0);
  for (const v of Object.values(bare)) assert.ok(!(typeof v === "number" && Number.isNaN(v)), "no NaN");

  const running = normalizeTorrent({ id: 10, status: 4, rateDownload: 1023.6, rateUpload: "12.2", percentDone: "0.25", eta: "90" });
  assert.equal(running.state, STATE.DOWNLOADING);
  assert.equal(running.rateDownload, 1024);
  assert.equal(running.rateUpload, 12);
  assert.equal(running.percentDone, 0.25);
  assert.equal(running.eta, 90);

  const trackers = normalizeTorrent({
    id: 11,
    trackerStats: [
      null,
      { announce: "udp://tracker.one.example:6969/announce", seederCount: -1, leecherCount: -1, tier: 0 },
      { announce: "https://tracker.two.example/announce", seederCount: 12, leecherCount: -1, tier: 1 },
      { announce: "https://tracker.two.example/announce?x=1", seederCount: 4, leecherCount: 2, tier: 1 },
    ],
  });
  assert.equal(trackers.seederCount, 12, "max of the known values");
  assert.equal(trackers.leecherCount, 2);
  assert.deepEqual(trackers.trackerHosts, ["tracker.one.example", "tracker.two.example"]);
  assert.equal(trackers.trackers.length, 3, "null entries dropped");
  assert.equal(trackers.trackers[0].seederCount, null);

  const partial = normalizeTorrent({ id: 11, rateUpload: 5 }, trackers);
  assert.equal(partial.seederCount, 12, "a poll row without trackerStats keeps the previous trackers");
  assert.equal(partial.rateUpload, 5);
  assert.deepEqual(partial.labels, []);

  const labelled = normalizeTorrent({ id: 12, labels: ["a", 3, null, "b"] });
  assert.deepEqual(labelled.labels, ["a", "b"]);
  assert.deepEqual(normalizeTorrent({ id: 13 }, labelled).labels, ["a", "b"]);
});

test("tracker warning: only when every tracker's last announce failed", () => {
  const fail = { announce: "https://a.example/x", lastAnnounceSucceeded: false, lastAnnounceResult: "Could not connect to tracker", lastAnnounceTime: 10 };
  const ok = { announce: "https://b.example/x", lastAnnounceSucceeded: true, lastAnnounceResult: "Success", lastAnnounceTime: 11 };
  assert.equal(normalizeTorrent({ id: 1, trackerStats: [fail] }).warning, "Could not connect to tracker");
  assert.equal(normalizeTorrent({ id: 1, trackerStats: [fail, ok] }).warning, "");
  assert.equal(normalizeTorrent({ id: 1, trackerStats: [{ ...fail, lastAnnounceTime: 0 }] }).warning, "", "never announced is not a warning");
});

test("trackerHost", () => {
  assert.equal(trackerHost("udp://tracker.opentrackr.example:1337/announce"), "tracker.opentrackr.example");
  assert.equal(trackerHost("https://x.example/announce?passkey=abc"), "x.example");
  assert.equal(trackerHost("not a url"), "not a url");
  assert.equal(trackerHost(""), "");
  assert.equal(trackerHost(undefined), "");
});

test("mergeTorrents: incremental merge keeps base fields, applies removed, reports ids", () => {
  const { torrents: first, added } = mergeTorrents(new Map(), {
    torrents: [
      { id: 1, name: "a", hashString: "h1", downloadDir: "/d", status: 4 },
      { id: 2, name: "b", hashString: "h2", downloadDir: "/d", status: 6 },
    ],
  }, { replace: true });
  assert.deepEqual(added, [1, 2]);
  const delta = mergeTorrents(first, {
    torrents: [{ id: 1, rateDownload: 100, status: 4 }, { id: 3, name: "new", status: 0 }],
    removed: [2, 42],
  });
  assert.deepEqual(delta.updated, [1]);
  assert.deepEqual(delta.added, [3]);
  assert.deepEqual(delta.removed, [2]);
  assert.equal(delta.torrents.size, 2);
  assert.equal(delta.torrents.get(1).hash, "h1");
  assert.equal(delta.torrents.get(1).downloadDir, "/d");
  assert.equal(delta.torrents.get(1).rateDownload, 100);
  assert.equal(first.size, 2, "input map is not mutated");

  const full = mergeTorrents(delta.torrents, { torrents: [{ id: 3, name: "new" }] }, { replace: true });
  assert.deepEqual([...full.torrents.keys()], [3]);
});

test("aggregate and search", () => {
  const { torrents } = mergeTorrents(new Map(), {
    torrents: [
      { id: 1, name: "Alpha ISO", hashString: "aaa", downloadDir: "/d/iso", status: 4, totalSize: 10, rateDownload: 5, labels: ["linux"], trackerStats: [{ announce: "https://t1.example/a" }] },
      { id: 2, name: "beta", hashString: "bbb", downloadDir: "/d/iso", status: 6, totalSize: 20, rateUpload: 1, labels: ["linux", "video"], trackerStats: [{ announce: "https://t1.example/a" }, { announce: "https://t2.example/a" }] },
      { id: 3, name: "gamma", hashString: "ccc", downloadDir: "/d/other", status: 0, error: 1, totalSize: 30, trackerStats: [{ announce: "https://t2.example/a", lastAnnounceSucceeded: false, lastAnnounceResult: "x", lastAnnounceTime: 5 }] },
    ],
  }, { replace: true });
  const agg = aggregate(torrents.values());
  assert.equal(agg.count, 3);
  assert.equal(agg.totalSize, 60);
  assert.deepEqual(agg.states, { stopped: 0, queued: 0, checking: 0, downloading: 1, seeding: 1, finished: 0, error: 1 });
  assert.equal(agg.active, 2);
  assert.equal(agg.warning, 1);
  assert.equal(agg.rateDownload, 5);
  assert.equal(agg.rateUpload, 1);
  assert.deepEqual(agg.trackers.get("t1.example"), { key: "t1.example", count: 2, size: 30 });
  assert.deepEqual(agg.trackers.get("t2.example"), { key: "t2.example", count: 2, size: 50 });
  assert.deepEqual(agg.folders.get("/d/iso"), { key: "/d/iso", count: 2, size: 30 });
  assert.deepEqual(agg.labels.get("video"), { key: "video", count: 1, size: 20 });

  const ids = (q) => searchTorrents(torrents.values(), q).map((t) => t.id);
  assert.deepEqual(ids(""), [1, 2, 3]);
  assert.deepEqual(ids("ALPHA"), [1]);
  assert.deepEqual(ids("linux"), [1, 2]);
  assert.deepEqual(ids("t2.example"), [2, 3]);
  assert.deepEqual(ids("/d/iso beta"), [2]);
  assert.deepEqual(ids("ccc"), [3]);
  assert.deepEqual(ids("nothing-here"), []);
});

const torrentFixtures = loadFixtures({ method: "torrent-get" });
assert.ok(torrentFixtures.length >= 10, "torrent-get fixtures present");

for (const fx of torrentFixtures) {
  const args = requestArgs(fx.data);
  const incremental = args.ids !== undefined;
  test(`fixture ${fx.version}/${fx.name}${fx.recorded ? " (recorded)" : ""}: normalises into the store shape`, async () => {
    let current = new Map();
    if (incremental) {
      const base = loadFixtures({ version: fx.version, name: "torrent-get" }).find((b) => b.recorded === fx.recorded)
        ?? loadFixtures({ version: fx.version, name: "torrent-get" })[0];
      assert.ok(base, "a full torrent-get fixture precedes the incremental one");
      current = (await stateFromFixture(base)).torrents;
    }
    const out = await stateFromFixture(fx, current);
    assert.ok(out.torrents.size > 0, "fixture yields torrents");
    for (const t of out.torrents.values()) {
      assert.ok(Number.isInteger(t.id));
      assert.ok(STATES.includes(t.state), `state ${t.state}`);
      assert.equal(typeof t.name, "string");
      assert.ok(Array.isArray(t.labels));
      assert.ok(Array.isArray(t.trackers));
      assert.ok(t.seederCount === null || (Number.isInteger(t.seederCount) && t.seederCount >= 0));
      assert.ok(t.leecherCount === null || (Number.isInteger(t.leecherCount) && t.leecherCount >= 0));
      for (const [k, v] of Object.entries(t)) {
        if (typeof v === "number") assert.ok(Number.isFinite(v), `${k} is finite`);
      }
      if (t.error !== 0) assert.equal(t.state, STATE.ERROR);
    }
    if (fx.recorded && !incremental) {
      // Bench set: two .invalid trackers per torrent, labels on >= 3.00, one local-error torrent except on 3.00.
      for (const t of out.torrents.values()) {
        assert.equal(t.trackers.length, 2, `torrent ${t.id} trackers`);
        for (const host of t.trackerHosts) assert.match(host, /\.invalid$/);
        assert.equal(t.seederCount, null, "unreachable trackers report no seeder count");
        assert.ok(t.hash.length === 40, "hash present on a full fetch");
      }
      const states = new Set([...out.torrents.values()].map((t) => t.state));
      for (const s of [STATE.SEEDING, STATE.STOPPED, STATE.DOWNLOADING, STATE.QUEUED, STATE.FINISHED]) assert.ok(states.has(s), s);
      assert.equal(states.has(STATE.ERROR), fx.version !== "rpc-16", "local-error torrent present except on 3.00");
      const labelled = [...out.torrents.values()].filter((t) => t.labels.length > 0);
      assert.equal(labelled.length > 0, fx.version !== "rpc-15", "native labels on >= 3.00");
    }
    const expect = fx.data.expect ?? {};
    if (expect.ids) assert.deepEqual([...out.torrents.keys()], expect.ids);
    for (const [id, state] of Object.entries(expect.states ?? {})) assert.equal(out.torrents.get(Number(id)).state, state, `torrent ${id}`);
    for (const [id, n] of Object.entries(expect.seederCount ?? {})) assert.equal(out.torrents.get(Number(id)).seederCount, n, `seeders ${id}`);
    for (const [id, n] of Object.entries(expect.leecherCount ?? {})) assert.equal(out.torrents.get(Number(id)).leecherCount, n, `leechers ${id}`);
    for (const [id, labels] of Object.entries(expect.labels ?? {})) assert.deepEqual(out.torrents.get(Number(id)).labels, labels, `labels ${id}`);
    for (const [id, n] of Object.entries(expect.rateDownload ?? {})) assert.equal(out.torrents.get(Number(id)).rateDownload, n, `rate ${id}`);
    if (expect.updated) assert.deepEqual(out.updated, expect.updated);
    if (expect.removed) assert.deepEqual(out.removed, expect.removed);
  });
}

/** Pair every 4.1.3 fixture name present in both dialect directories. */
function dialectPairs() {
  const legacy = loadFixtures({ version: "rpc-41-legacy", method: "torrent-get" });
  const jsonrpc = loadFixtures({ version: "rpc-41-jsonrpc", method: "torrent-get" });
  const pairs = [];
  for (const a of legacy) {
    const b = jsonrpc.find((f) => f.name === a.name && f.recorded === a.recorded);
    if (b) pairs.push([a, b]);
  }
  return pairs;
}

const pairs = dialectPairs();
assert.ok(pairs.length >= 2, "4.1.3 fixtures exist in both dialects");

for (const [legacy, jsonrpc] of pairs) {
  test(`4.1.3 ${legacy.name}${legacy.recorded ? " (recorded)" : ""}: legacy and JSON-RPC yield identical store state`, async () => {
    const seed = async (fx) => {
      if (requestArgs(fx.data).ids === undefined) return new Map();
      const base = loadFixtures({ version: fx.version, name: "torrent-get" }).find((b) => b.recorded === fx.recorded);
      return (await stateFromFixture(base)).torrents;
    };
    const a = await stateFromFixture(legacy, await seed(legacy));
    const b = await stateFromFixture(jsonrpc, await seed(jsonrpc));
    assert.deepEqual(mapToObject(a.torrents), mapToObject(b.torrents));
    assert.deepEqual({ added: a.added, updated: a.updated, removed: a.removed }, { added: b.added, updated: b.updated, removed: b.removed });
    assert.ok(a.torrents.size > 0);
  });
}
