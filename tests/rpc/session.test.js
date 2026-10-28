import { test } from "node:test";
import assert from "node:assert/strict";

import { DIALECT, createClient } from "../../src/app/js/rpc/client.js?v=__QBV__";
import { buildCaps } from "../../src/app/js/rpc/caps.js?v=__QBV__";
import {
  ENCRYPTION_VALUES,
  PREFERRED_TRANSPORTS_KEY,
  READ_ONLY_SESSION_KEYS,
  SESSION_POLL_FIELDS,
  getFreeSpace,
  getSession,
  getStats,
  pollSession,
  sessionSetArgs,
  setSession,
  testPort,
} from "../../src/app/js/rpc/session.js?v=__QBV__";
import { fixtureVersions, loadFixtures, okResponse, recordedTransport } from "../fixtures/load.js";

const RECORDED_VERSIONS = fixtureVersions().filter((v) => loadFixtures({ version: v, recorded: true }).length > 0);
assert.ok(RECORDED_VERSIONS.length >= 5, "recorded fixtures for every version");

/** Client + caps for one recorded daemon, with synthetic answers for the write methods. */
async function daemon(version) {
  const sent = [];
  const { transport, dialect } = recordedTransport(version, {
    "session-set": (body) => {
      sent.push(body);
      return okResponse(dialect, body);
    },
    "port-test": (body) => {
      sent.push(body);
      return okResponse(dialect, body, dialect === DIALECT.JSONRPC ? { port_is_open: true } : { "port-is-open": true });
    },
  });
  const client = createClient({ transport, dialect });
  const session = await getSession(client);
  const caps = buildCaps(session, { dialect });
  const args = (body) => (dialect === DIALECT.JSONRPC ? body.params : body.arguments);
  return { client, caps, session, dialect, transport, sent, args };
}

test("constants: the poll never asks for version keys; read-only set is upstream-spelled", () => {
  for (const f of SESSION_POLL_FIELDS) assert.doesNotMatch(f, /version/);
  assert.ok(READ_ONLY_SESSION_KEYS.includes("rpc-version-semver"));
  assert.deepEqual(ENCRYPTION_VALUES, ["required", "preferred", "tolerated"]);
});

for (const version of RECORDED_VERSIONS) {
  test(`${version}: full session-get feeds caps and has()`, async () => {
    const { session, caps } = await daemon(version);
    assert.equal(typeof session.downloadDir, "string");
    assert.equal(typeof session.version, "string");
    assert.equal(caps.has("download-dir"), true);
    assert.equal(caps.has("alt-speed-enabled"), true);
    assert.equal(caps.has(PREFERRED_TRANSPORTS_KEY), caps.semverMajor >= 6);
    assert.equal(caps.has("default-trackers"), caps.rpc >= 17 || caps.semverMajor >= 6);
  });

  test(`${version}: pollSession asks for the footer fields on daemons that take them`, async () => {
    const { client, caps, transport, args, dialect } = await daemon(version);
    const partial = await pollSession(client, caps);
    const body = transport.calls.at(-1).body;
    const requested = args(body).fields;
    if (caps.sessionFields) {
      assert.ok(Array.isArray(requested), "fields sent");
      const spelled = dialect === DIALECT.JSONRPC ? SESSION_POLL_FIELDS.map((f) => f.replace(/-/g, "_")) : [...SESSION_POLL_FIELDS];
      assert.deepEqual(requested, spelled);
      for (const f of requested) assert.doesNotMatch(f, /version/);
    } else {
      assert.equal(requested, undefined, "2.94 gets the whole session");
      assert.equal(typeof partial.downloadDir, "string");
    }
    assert.equal(typeof partial.altSpeedEnabled, "boolean", "the recorded poll body answers the alt-speed chip");
  });

  test(`${version}: session-stats normalises both stat blocks`, async () => {
    const { client } = await daemon(version);
    const stats = await getStats(client);
    assert.ok(Number.isInteger(stats.torrentCount));
    assert.ok(Number.isInteger(stats.activeTorrentCount));
    assert.ok(Number.isInteger(stats.pausedTorrentCount));
    assert.ok(Number.isInteger(stats.cumulativeStats.secondsActive));
    assert.ok(Number.isInteger(stats.currentStats.uploadedBytes));
    assert.equal(stats["cumulative-stats"], undefined, "no kebab key survives");
  });

  test(`${version}: free-space returns bytes, total only where the daemon reports it`, async () => {
    const { client, caps } = await daemon(version);
    const out = await getFreeSpace(client, "/home/user/twc-fixtures/data");
    assert.equal(out.path, "/home/user/twc-fixtures/data");
    assert.ok(Number.isInteger(out.sizeBytes) && out.sizeBytes > 0);
    if (caps.rpc >= 17 || caps.semverMajor >= 6) assert.ok(Number.isInteger(out.totalSize) && out.totalSize > out.sizeBytes);
    else assert.equal(out.totalSize, null);
  });

  test(`${version}: sessionSetArgs applies the write rules against the real session`, async () => {
    const { caps, session } = await daemon(version);
    const has41 = caps.semverMajor >= 6;
    const has40 = caps.rpc >= 17 || has41;

    assert.deepEqual(sessionSetArgs(caps, session, { "speed-limit-down": session.speedLimitDown + 1 }), {
      "speed-limit-down": session.speedLimitDown + 1,
    });
    assert.deepEqual(sessionSetArgs(caps, session, { "speed-limit-down": session.speedLimitDown }), {}, "unchanged value dropped");
    assert.deepEqual(sessionSetArgs(caps, session, { "rpc-version": 99, version: "x", "session-id": "y", units: {} }), {}, "read-only dropped");

    const transports = sessionSetArgs(caps, session, { "utp-enabled": !session.utpEnabled, [PREFERRED_TRANSPORTS_KEY]: ["utp"] });
    if (has41) {
      assert.deepEqual(transports, { [PREFERRED_TRANSPORTS_KEY]: ["utp"] }, "4.1 writes only preferred_transports");
    } else {
      assert.deepEqual(transports, { "utp-enabled": !session.utpEnabled }, "older daemons write utp-enabled");
    }
    // tcp-enabled exists on 4.0.x as well; below 4.1 it is written like any other present key.
    const expectTransports = has41 ? {} : { "utp-enabled": !session.utpEnabled };
    if (!has41 && caps.has("tcp-enabled") && session.tcpEnabled !== false) expectTransports["tcp-enabled"] = false;
    assert.deepEqual(sessionSetArgs(caps, session, { "utp-enabled": !session.utpEnabled, "tcp-enabled": false }), expectTransports);

    assert.deepEqual(sessionSetArgs(caps, session, { encryption: "custom-value" }), {}, "unknown encryption kept on the daemon");
    assert.deepEqual(sessionSetArgs(caps, session, { encryption: session.encryption }), {}, "echoing the current value writes nothing");
    const other = ENCRYPTION_VALUES.find((v) => v !== session.encryption);
    assert.deepEqual(sessionSetArgs(caps, session, { encryption: other }), { encryption: other });

    assert.deepEqual(sessionSetArgs(caps, session, { "default-trackers": "udp://t.example:1/announce" }), has40 ? { "default-trackers": "udp://t.example:1/announce" } : {});
    assert.deepEqual(sessionSetArgs(caps, session, { sequential_download: !session.sequentialDownload }), has41 ? { sequential_download: !session.sequentialDownload } : {});
    assert.deepEqual(sessionSetArgs(caps, session, { "no-such-key": 1 }), {});
  });

  test(`${version}: setSession sends only what changed and skips the request when nothing did`, async () => {
    const { client, caps, session, sent, args } = await daemon(version);
    const none = await setSession(client, caps, session, { "speed-limit-up": session.speedLimitUp, "rpc-version": 1 });
    assert.deepEqual(none, {});
    assert.equal(sent.length, 0, "no request for an empty patch");
    const some = await setSession(client, caps, session, { "speed-limit-up": session.speedLimitUp + 5, "alt-speed-enabled": !session.altSpeedEnabled });
    assert.equal(sent.length, 1);
    assert.deepEqual(some, { "speed-limit-up": session.speedLimitUp + 5, "alt-speed-enabled": !session.altSpeedEnabled });
    const wire = args(sent[0]);
    assert.equal(Object.keys(wire).length, 2);
  });

  test(`${version}: port-test is per protocol on 4.1, single otherwise`, async () => {
    const { client, caps, sent, args } = await daemon(version);
    const out = await testPort(client, caps);
    const probes = sent.filter((b) => /port.test/.test(b.method));
    if (caps.portTestByProtocol) {
      assert.equal(probes.length, 2);
      assert.deepEqual(probes.map((b) => args(b).ip_protocol).sort(), ["ipv4", "ipv6"]);
      assert.deepEqual(out, [
        { protocol: "ipv4", open: true, unavailable: false },
        { protocol: "ipv6", open: true, unavailable: false },
      ]);
    } else {
      assert.equal(probes.length, 1);
      assert.equal(args(probes[0]).ip_protocol, undefined);
      assert.deepEqual(out, [{ protocol: "any", open: true, unavailable: false }]);
    }
  });
}

test("port-test: one failing protocol is unavailable and keeps the other's verdict", async () => {
  const caps = { portTestByProtocol: true };
  const calls = [];
  const client = {
    async call(method, args) {
      calls.push(args.ip_protocol);
      if (args.ip_protocol === "ipv6") throw new Error("Couldn't test port: No Response (0)");
      return { portIsOpen: false };
    },
  };
  assert.deepEqual(await testPort(client, caps), [
    { protocol: "ipv4", open: false, unavailable: false },
    { protocol: "ipv6", open: null, unavailable: true },
  ]);
  assert.deepEqual(calls.sort(), ["ipv4", "ipv6"], "both probes were sent");
});

test("port-test: every probe failing rejects with the first error", async () => {
  const failing = { async call() { throw new Error("daemon unreachable"); } };
  await assert.rejects(testPort(failing, { portTestByProtocol: true }), /daemon unreachable/);
  await assert.rejects(testPort(failing, { portTestByProtocol: false }), /daemon unreachable/);
});

test("sessionSetArgs tolerates a missing session and caps", () => {
  const caps = buildCaps({ speedLimitDown: 1, encryption: "preferred" }, { dialect: DIALECT.LEGACY });
  assert.deepEqual(sessionSetArgs(caps, null, { "speed-limit-down": 2 }), { "speed-limit-down": 2 });
  assert.deepEqual(sessionSetArgs(caps, undefined, { encryption: "tolerated" }), { encryption: "tolerated" });
  assert.deepEqual(sessionSetArgs(caps, {}, undefined), {});
});
