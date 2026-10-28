import { test } from "node:test";
import assert from "node:assert/strict";

import { DIALECT, createClient } from "../../src/app/js/rpc/client.js?v=__QBV__";
import { buildCaps } from "../../src/app/js/rpc/caps.js?v=__QBV__";
import { getSession } from "../../src/app/js/rpc/session.js?v=__QBV__";
import { fetchTorrents } from "../../src/app/js/rpc/torrents.js?v=__QBV__";
import {
  LABELS_IMPORTED_KEY,
  LABELS_MIGRATED_KEY,
  LEGACY_CONFIG_KEY,
  LOCAL_LABELS_KEY,
  createLabelStore,
  memoryStorage,
} from "../../src/app/js/rpc/labels.js?v=__QBV__";
import { fixtureVersions, loadFixtures, okResponse, recordedTransport } from "../fixtures/load.js";

const RECORDED_VERSIONS = fixtureVersions().filter((v) => loadFixtures({ version: v, recorded: true }).length > 0);
const H1 = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const H2 = "B2C3D4E5F60718293A4B5C6D7E8F901234567891";

async function daemon(version, storage) {
  const sets = [];
  const { transport, dialect } = recordedTransport(version, {
    "torrent-set": (body) => {
      sets.push(dialect === DIALECT.JSONRPC ? body.params : body.arguments);
      return okResponse(dialect, body);
    },
  });
  const client = createClient({ transport, dialect });
  const caps = buildCaps(await getSession(client), { dialect });
  const { torrents } = await fetchTorrents(client, caps, new Map());
  const labels = createLabelStore({ client, caps, storage });
  return { client, caps, torrents, labels, sets };
}

test("memoryStorage behaves like the injected storage shape", () => {
  const s = memoryStorage({ a: "1" });
  assert.equal(s.getItem("a"), "1");
  assert.equal(s.getItem("b"), null);
  s.setItem("b", 2);
  assert.equal(s.getItem("b"), "2");
  s.removeItem("a");
  assert.equal(s.getItem("a"), null);
});

test("local mode: write/read/clear by hash, junk ignored", async () => {
  const storage = memoryStorage();
  const caps = buildCaps({ rpcVersion: 15 }, { dialect: DIALECT.LEGACY });
  const client = { call: async () => assert.fail("no RPC on a local daemon") };
  const labels = createLabelStore({ client, caps, storage });
  assert.equal(labels.mode, "local");
  await labels.write([{ id: 1, hash: H1 }, { id: 2, hash: H2 }, { id: 3, hash: "nope" }], [" movies ", "tv", "movies", "", 7]);
  assert.deepEqual(JSON.parse(storage.getItem(LOCAL_LABELS_KEY)), { [H1]: ["movies", "tv"], [H2.toLowerCase()]: ["movies", "tv"] });
  assert.deepEqual(labels.read({ hash: H1, labels: ["server-side-ignored"] }), ["movies", "tv"]);
  assert.deepEqual(labels.read({ hash: H2 }), ["movies", "tv"], "hash lookup is case-insensitive");
  assert.deepEqual(labels.read({ hash: "0000000000000000000000000000000000000000" }), []);
  assert.deepEqual(labels.read(null), []);
  await labels.write([{ id: 2, hash: H2 }], []);
  assert.deepEqual([...labels.localEntries().keys()], [H1]);
  assert.deepEqual(labels.allLabels([{ hash: H1 }, { hash: H2 }]), ["movies", "tv"]);
  assert.deepEqual(labels.importOffer(new Map([[1, { hash: H1 }]])), { count: 0, ids: [] }, "no import offer on a local daemon");
  assert.deepEqual(await labels.importLocal(new Map()), { imported: 0 });
});

test("migrateLegacy copies the previous UI's labelMaps once and leaves the old key alone", () => {
  const legacyBlob = JSON.stringify({ nav: { labels: true }, labelMaps: { [H1]: ["old", "old", " "], [H2]: ["tv"], bad: ["x"] }, labels: [{ name: "old" }] });
  const storage = memoryStorage({ [LEGACY_CONFIG_KEY]: legacyBlob, [LOCAL_LABELS_KEY]: JSON.stringify({ [H1]: ["mine"] }) });
  const caps = buildCaps({ rpcVersion: 15 }, { dialect: DIALECT.LEGACY });
  const labels = createLabelStore({ client: {}, caps, storage });
  assert.equal(labels.migrateLegacy(), 1, "only the hash we did not already hold is copied");
  assert.deepEqual(JSON.parse(storage.getItem(LOCAL_LABELS_KEY)), { [H1]: ["mine"], [H2.toLowerCase()]: ["tv"] });
  assert.equal(storage.getItem(LEGACY_CONFIG_KEY), legacyBlob, "old key untouched");
  assert.equal(storage.getItem(LABELS_MIGRATED_KEY), "1");
  assert.equal(labels.migrateLegacy(), 0, "second run is a no-op");

  const broken = createLabelStore({ client: {}, caps, storage: memoryStorage({ [LEGACY_CONFIG_KEY]: "{not json" }) });
  assert.equal(broken.migrateLegacy(), 0);
  const empty = createLabelStore({ client: {}, caps, storage: memoryStorage() });
  assert.equal(empty.migrateLegacy(), 0);
});

for (const version of RECORDED_VERSIONS) {
  test(`${version}: label store mode follows caps and reads the recorded torrents`, async () => {
    const storage = memoryStorage();
    const { caps, torrents, labels, sets } = await daemon(version, storage);
    assert.equal(labels.mode, caps.nativeLabels ? "native" : "local");
    const all = labels.allLabels(torrents.values());
    if (caps.nativeLabels) {
      assert.ok(all.includes("movies") && all.includes("tv"), `recorded labels present: ${all}`);
      const [first] = torrents.values();
      await labels.write([first], ["movies", "x"]);
      assert.deepEqual(sets, [{ ids: [first.id], labels: ["movies", "x"] }]);
    } else {
      assert.deepEqual(all, [], "2.94 has no server-side labels");
      const [first] = torrents.values();
      await labels.write([first], ["local"]);
      assert.equal(sets.length, 0, "no RPC on 2.94");
      assert.deepEqual(labels.read(first), ["local"]);
    }
  });

  test(`${version}: one-time import offer copies browser labels to a native daemon`, async () => {
    const storage = memoryStorage();
    const first = await daemon(version, storage);
    const [a, b] = [...first.torrents.values()];
    storage.setItem(LOCAL_LABELS_KEY, JSON.stringify({ [a.hash]: ["from-browser"], [b.hash]: ["tv", "from-browser"], [H1]: ["orphan"] }));
    const { caps, torrents, labels, sets } = await daemon(version, storage);
    const offer = labels.importOffer(torrents);
    if (!caps.nativeLabels) {
      assert.deepEqual(offer, { count: 0, ids: [] });
      return;
    }
    assert.equal(offer.count, 2, "only hashes that match a live torrent");
    assert.deepEqual(offer.ids.sort(), [a.id, b.id].sort());
    const { imported } = await labels.importLocal(torrents);
    assert.equal(imported, 2);
    assert.equal(sets.length, 2);
    const forA = sets.find((s) => s.ids[0] === a.id);
    const forB = sets.find((s) => s.ids[0] === b.id);
    assert.deepEqual(forA.labels, [...a.labels, "from-browser"].filter((l, i, arr) => arr.indexOf(l) === i), "merged with the daemon's labels");
    assert.ok(forB.labels.includes("tv") && forB.labels.includes("from-browser"));
    assert.equal(forB.labels.filter((l) => l === "tv").length, 1, "no duplicate after merge");
    assert.equal(storage.getItem(LABELS_IMPORTED_KEY), "1");
    assert.ok(storage.getItem(LOCAL_LABELS_KEY).includes("from-browser"), "local copy kept for rollback");
    assert.deepEqual(labels.importOffer(torrents), { count: 0, ids: [] }, "offered once");
  });
}
