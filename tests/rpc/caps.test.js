import { test } from "node:test";
import assert from "node:assert/strict";

import { DIALECT, createClient } from "../../src/app/js/rpc/client.js?v=__QBV__";
import { UNKNOWN_CAPS, buildCaps, parseSemver } from "../../src/app/js/rpc/caps.js?v=__QBV__";
import { fixtureTransport, loadFixtures, requestArgs } from "../fixtures/load.js";

const GATES = ["nativeLabels", "tableFormat", "sessionFields", "trackerList", "sequential", "portTestByProtocol"];

/** Expected gate table per RPC integer (semver major 6 = 4.1). */
function expectedGates(rpc, semverMajor) {
  return {
    nativeLabels: rpc >= 16,
    tableFormat: rpc >= 16,
    sessionFields: rpc >= 16,
    trackerList: rpc >= 17,
    sequential: semverMajor >= 6,
    portTestByProtocol: semverMajor >= 6,
  };
}

function pickGates(caps) {
  return Object.fromEntries(GATES.map((g) => [g, caps[g]]));
}

async function capsFromFixture(fx) {
  const client = createClient({ transport: fixtureTransport(fx.data), dialect: fx.data.dialect });
  const session = await client.call(fx.data.method, requestArgs(fx.data));
  return buildCaps(session, { dialect: client.dialect });
}

test("parseSemver", () => {
  assert.deepEqual(parseSemver("6.0.1"), { major: 6, minor: 0, patch: 1 });
  assert.deepEqual(parseSemver(" 5.3.0 "), { major: 5, minor: 3, patch: 0 });
  assert.equal(parseSemver("6"), null);
  assert.equal(parseSemver(18), null);
  assert.equal(parseSemver(undefined), null);
});

test("UNKNOWN_CAPS closes every gate", () => {
  assert.equal(UNKNOWN_CAPS.rpc, 0);
  assert.equal(UNKNOWN_CAPS.semver, null);
  assert.equal(UNKNOWN_CAPS.dialect, DIALECT.LEGACY);
  for (const g of GATES) assert.equal(UNKNOWN_CAPS[g], false, g);
  assert.equal(UNKNOWN_CAPS.has("download-dir"), false);
  assert.ok(Object.isFrozen(UNKNOWN_CAPS));
});

test("legacy: rpc comes from rpcVersion, semver is optional", () => {
  const c15 = buildCaps({ rpcVersion: 15, version: "2.94 (d8e60ee44f)" }, { dialect: DIALECT.LEGACY });
  assert.equal(c15.rpc, 15);
  assert.equal(c15.semver, null);
  assert.equal(c15.semverMajor, 0);
  assert.equal(c15.daemonVersion, "2.94 (d8e60ee44f)");
  assert.deepEqual(pickGates(c15), expectedGates(15, 0));

  const c17 = buildCaps({ rpcVersion: "17", rpcVersionSemver: "5.3.0" }, { dialect: DIALECT.LEGACY });
  assert.equal(c17.rpc, 17);
  assert.equal(c17.semver, "5.3.0");
  assert.deepEqual(pickGates(c17), expectedGates(17, 5));
});

test("JSON-RPC: the deprecated integer is never read; semver major 6 means RPC 18", () => {
  const caps = buildCaps({ rpcVersion: 99, rpcVersionSemver: "6.0.1" }, { dialect: DIALECT.JSONRPC });
  assert.equal(caps.rpc, 18);
  assert.equal(caps.jsonRpc, true);
  assert.equal(caps.dialect, DIALECT.JSONRPC);
  assert.deepEqual(pickGates(caps), expectedGates(18, 6));

  const noSemver = buildCaps({ rpcVersion: 18 }, { dialect: DIALECT.JSONRPC });
  assert.equal(noSemver.rpc, 0, "without semver the JSON-RPC daemon version is unknown");
  for (const g of GATES) assert.equal(noSemver[g], false, g);
});

test("has(): feature detection accepts upstream and camelCase spellings", () => {
  const caps = buildCaps({ defaultTrackers: "", scriptTorrentAddedEnabled: false, downloadDir: "/d" }, { dialect: DIALECT.LEGACY });
  assert.equal(caps.has("default-trackers"), true);
  assert.equal(caps.has("defaultTrackers"), true);
  assert.equal(caps.has("script_torrent_added_enabled"), true);
  assert.equal(caps.has("preferred-transports"), false);
  assert.equal(caps.has("download-dir-free-space"), false);
});

test("malformed input never throws", () => {
  for (const session of [null, undefined, 3, "x", []]) {
    const caps = buildCaps(session, { dialect: DIALECT.LEGACY });
    assert.equal(caps.rpc, 0);
  }
  assert.equal(buildCaps({ rpcVersion: "abc" }, undefined).rpc, 0);
  assert.equal(buildCaps({ rpcVersion: 16.5 }, { dialect: DIALECT.LEGACY }).rpc, 0);
});

const sessionFixtures = loadFixtures({ method: "session-get" });
assert.ok(sessionFixtures.length >= 5, "session-get fixtures present");

for (const fx of sessionFixtures) {
  test(`fixture ${fx.version}/${fx.name}${fx.recorded ? " (recorded)" : ""}: caps match the version table`, async () => {
    const caps = await capsFromFixture(fx);
    const expect = fx.data.expect ?? {};
    const rpc = fx.data.dialect === DIALECT.JSONRPC ? 18 : expect.rpc;
    if (rpc !== undefined) assert.equal(caps.rpc, rpc);
    if (expect.semver !== undefined) assert.equal(caps.semver, expect.semver);
    if (expect.daemonVersion !== undefined) assert.equal(caps.daemonVersion, expect.daemonVersion);
    assert.equal(caps.dialect, fx.data.dialect);
    assert.equal(caps.jsonRpc, fx.data.dialect === DIALECT.JSONRPC);
    assert.deepEqual(pickGates(caps), expectedGates(caps.rpc, caps.semverMajor));
    assert.equal(caps.has("download-dir"), true);
    assert.equal(caps.has("default-trackers"), caps.rpc >= 17, "default-trackers appears with 4.0");
    assert.equal(caps.has("preferred-transports"), caps.semverMajor >= 6, "preferred_transports appears with 4.1");
  });
}

test("4.1.3: legacy and JSON-RPC session-get yield the same caps apart from the dialect", async () => {
  const legacy = loadFixtures({ version: "rpc-41-legacy", name: "session-get" })[0];
  const jsonrpc = loadFixtures({ version: "rpc-41-jsonrpc", name: "session-get" })[0];
  assert.ok(legacy && jsonrpc, "both 4.1.3 fixtures present");
  const a = { ...(await capsFromFixture(legacy)) };
  const b = { ...(await capsFromFixture(jsonrpc)) };
  for (const c of [a, b]) {
    delete c.has;
    delete c.dialect;
    delete c.jsonRpc;
  }
  assert.deepEqual(a, b);
});
