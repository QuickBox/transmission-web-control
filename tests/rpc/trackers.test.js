import { test } from "node:test";
import assert from "node:assert/strict";

import { DIALECT, createClient } from "../../src/app/js/rpc/client.js?v=__QBV__";
import { buildCaps } from "../../src/app/js/rpc/caps.js?v=__QBV__";
import { getSession } from "../../src/app/js/rpc/session.js?v=__QBV__";
import {
  diffTrackers,
  formatTrackerList,
  parseTrackerList,
  setTrackers,
  tiersFromTrackers,
} from "../../src/app/js/rpc/trackers.js?v=__QBV__";
import { fixtureVersions, loadFixtures, okResponse, recordedTransport } from "../fixtures/load.js";

const RECORDED_VERSIONS = fixtureVersions().filter((v) => loadFixtures({ version: v, recorded: true }).length > 0);

test("parseTrackerList / formatTrackerList round-trip tiers", () => {
  const text = "  https://a.example/announce \nudp://b.example:1/announce\n\n\nhttps://c.example/announce\nhttps://a.example/announce\n";
  const tiers = parseTrackerList(text);
  assert.deepEqual(tiers, [["https://a.example/announce", "udp://b.example:1/announce"], ["https://c.example/announce"]]);
  assert.equal(formatTrackerList(tiers), "https://a.example/announce\nudp://b.example:1/announce\n\nhttps://c.example/announce");
  assert.deepEqual(parseTrackerList(""), []);
  assert.deepEqual(parseTrackerList(undefined), []);
  assert.equal(formatTrackerList([[], ["x"]]), "x");
});

test("tiersFromTrackers groups by tier in order", () => {
  assert.deepEqual(
    tiersFromTrackers([
      { announce: "c", tier: 2 },
      { announce: "a", tier: 0 },
      { announce: "b", tier: 0 },
      { announce: "", tier: 1 },
      null,
    ]),
    [["a", "b"], ["c"]],
  );
  assert.deepEqual(tiersFromTrackers(undefined), []);
});

test("diffTrackers pairs a drop with an add into a replace", () => {
  const current = [
    { id: 10, announce: "a", tier: 0 },
    { id: 11, announce: "b", tier: 0 },
    { id: 12, announce: "c", tier: 1 },
  ];
  assert.deepEqual(diffTrackers(current, [["a", "b"], ["c"]]), { add: [], remove: [], replace: [] });
  assert.deepEqual(diffTrackers(current, [["a", "x"], ["c"]]), { add: [], remove: [], replace: [[11, "x"]] });
  assert.deepEqual(diffTrackers(current, [["a"]]), { add: [], remove: [11, 12], replace: [] });
  assert.deepEqual(diffTrackers(current, [["a", "b"], ["c", "d", "e"]]), { add: ["d", "e"], remove: [], replace: [] });
  assert.deepEqual(diffTrackers(current, [["x", "y"]]), { add: [], remove: [12], replace: [[10, "x"], [11, "y"]] });
  assert.deepEqual(diffTrackers(undefined, [["x"]]), { add: ["x"], remove: [], replace: [] });
});

for (const version of RECORDED_VERSIONS) {
  test(`${version}: setTrackers uses trackerList on 4.x and row edits below`, async () => {
    const sets = [];
    const { transport, dialect } = recordedTransport(version, {
      "torrent-set": (body) => {
        sets.push(dialect === DIALECT.JSONRPC ? body.params : body.arguments);
        return okResponse(dialect, body);
      },
    });
    const client = createClient({ transport, dialect });
    const caps = buildCaps(await getSession(client), { dialect });

    // Start from what the recorded torrent 1 announces today, then swap one URL and add one.
    const rows = (await client.call("torrent-get", { ids: [1], fields: ["id", "trackers"] })).torrents;
    const row = rows.find((r) => r.id === 1);
    assert.ok(row && Array.isArray(row.trackers) && row.trackers.length === 2, "recorded torrent 1 has two trackers");
    const current = tiersFromTrackers(row.trackers);
    const flat = current.flat();
    const next = [[flat[0], "https://replacement.invalid/announce"], ["udp://added.invalid:6969/announce"]];

    const out = await setTrackers(client, caps, [1], formatTrackerList(next));
    if (caps.trackerList) {
      assert.equal(out.mode, "trackerList");
      assert.equal(out.requests, 1);
      assert.equal(sets.length, 1);
      const key = dialect === DIALECT.JSONRPC ? "tracker_list" : "trackerList";
      assert.deepEqual(sets[0].ids, [1]);
      assert.equal(sets[0][key], formatTrackerList(next));
      assert.equal(sets[0].trackerAdd, undefined);
    } else {
      assert.equal(out.mode, "rows");
      assert.equal(sets.length, 1, "one torrent-set for the one target, not one per recorded row");
      assert.deepEqual(sets[0].ids, [1]);
      assert.deepEqual(sets[0].trackerReplace, [row.trackers.find((t) => t.announce === flat[1]).id, "https://replacement.invalid/announce"]);
      assert.deepEqual(sets[0].trackerAdd, ["udp://added.invalid:6969/announce"]);
      assert.equal(sets[0].trackerRemove, undefined);
      assert.equal(sets[0].trackerList, undefined);
    }

    // The unchanged list is a no-op on row daemons and still one write on list daemons.
    sets.length = 0;
    const same = await setTrackers(client, caps, [1], current);
    if (caps.trackerList) assert.equal(sets.length, 1);
    else {
      assert.equal(sets.length, 0);
      assert.equal(same.requests, 1, "only the read");
    }
    assert.deepEqual(await setTrackers(client, caps, [], current), { mode: caps.trackerList ? "trackerList" : "rows", requests: 0 });
  });
}
