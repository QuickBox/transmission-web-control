/**
 * Session data layer: the full `session-get` (the only input `caps.has()` may
 * be built from), the fields-limited poll, `session-set` with feature
 * detection, `session-stats`, `free-space` and `port-test`.
 *
 * Requests use the upstream legacy spelling; the client converts for JSON-RPC
 * and hands back camelCase. Pure helpers are exported so the write rules are
 * testable without a transport.
 */

import { toCamelKey } from "./client.js?v=__QBV__";
import { VERSION_SESSION_KEYS } from "./caps.js?v=__QBV__";

/**
 * What the 5 s poll asks for on daemons that accept `fields`: the footer chips
 * (alt-speed, speed limits). Never the version keys.
 */
export const SESSION_POLL_FIELDS = Object.freeze([
  "alt-speed-enabled",
  "alt-speed-down",
  "alt-speed-up",
  "speed-limit-down",
  "speed-limit-down-enabled",
  "speed-limit-up",
  "speed-limit-up-enabled",
  "peer-port",
  "download-dir",
]);

/** Keys the daemon reports but never accepts in `session-set`. */
export const READ_ONLY_SESSION_KEYS = Object.freeze([
  ...VERSION_SESSION_KEYS,
  "blocklist-size",
  "config-dir",
  "download-dir-free-space",
  "session-id",
  "units",
  "version",
]);

export const ENCRYPTION_VALUES = Object.freeze(["required", "preferred", "tolerated"]);

/** The 4.1 transport selector and the pair of flags it supersedes. */
export const PREFERRED_TRANSPORTS_KEY = "preferred_transports";
const LEGACY_TRANSPORT_KEYS = Object.freeze(["utp-enabled", "tcp-enabled"]);

const READ_ONLY = new Set(READ_ONLY_SESSION_KEYS.map(toCamelKey));
const LEGACY_TRANSPORTS = new Set(LEGACY_TRANSPORT_KEYS.map(toCamelKey));

function sameValue(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => sameValue(a[k], b[k]));
  }
  return Object.is(a, b);
}

/** Full session object; the one input `buildCaps` and `caps.has()` work from. */
export function getSession(client) {
  return client.call("session-get");
}

/**
 * The periodic session read. On daemons with `sessionFields` only the footer
 * keys travel; older daemons return the whole object. Either way the result is
 * a partial to merge over the stored session, never a replacement for it.
 */
export function pollSession(client, caps) {
  return caps && caps.sessionFields
    ? client.call("session-get", { fields: [...SESSION_POLL_FIELDS] })
    : client.call("session-get");
}

export function getStats(client) {
  return client.call("session-stats");
}

/**
 * Build the `session-set` arguments from a patch written in the upstream
 * spelling. Rules, in order:
 *  - read-only keys are dropped;
 *  - a key the daemon never reported is dropped (feature detection, `caps.has`);
 *  - when the daemon reports `preferred_transports`, the legacy `utp-enabled` /
 *    `tcp-enabled` flags are dropped so the two never get written together;
 *  - an `encryption` value outside the three known strings is dropped, so a
 *    daemon-side custom value is never overwritten;
 *  - a value equal to what the session already holds is dropped.
 *
 * @param {import("./caps.js").Caps} caps
 * @param {object} session normalised current session
 * @param {object} patch upstream-spelled keys
 * @returns {object} upstream-spelled arguments, possibly empty
 */
export function sessionSetArgs(caps, session, patch) {
  const current = session && typeof session === "object" ? session : {};
  const hasPreferred = Boolean(caps && caps.has(PREFERRED_TRANSPORTS_KEY));
  const out = {};
  for (const [key, value] of Object.entries(patch ?? {})) {
    const camel = toCamelKey(key);
    if (READ_ONLY.has(camel)) continue;
    if (caps && !caps.has(key)) continue;
    if (hasPreferred && LEGACY_TRANSPORTS.has(camel)) continue;
    if (camel === "encryption" && !ENCRYPTION_VALUES.includes(value)) continue;
    if (camel in current && sameValue(current[camel], value)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Write settings. Resolves to the arguments actually sent (empty object when
 * nothing needed writing, in which case no request is made).
 */
export async function setSession(client, caps, session, patch) {
  const args = sessionSetArgs(caps, session, patch);
  if (Object.keys(args).length > 0) await client.call("session-set", args);
  return args;
}

function toInt(value) {
  if (typeof value === "number") return Number.isInteger(value) ? value : Math.trunc(value);
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number.parseInt(value, 10);
    return Number.isInteger(n) ? n : null;
  }
  return null;
}

/**
 * @param {string} path
 * @returns {Promise<{ path: string, sizeBytes: number|null, totalSize: number|null }>}
 *   `totalSize` is reported by 4.x only
 */
export async function getFreeSpace(client, path) {
  const result = await client.call("free-space", { path });
  return {
    path: typeof result.path === "string" ? result.path : path,
    sizeBytes: toInt(result.sizeBytes),
    totalSize: toInt(result.totalSize),
  };
}

/**
 * @typedef {{ protocol: "ipv4"|"ipv6"|"any", open: boolean|null, unavailable: boolean }} PortTestResult
 *   `open: null` when the daemon answered without a verdict; `unavailable`
 *   when the probe itself failed (a daemon without IPv6 refuses the IPv6 test)
 */

function portVerdict(result) {
  const v = result ? result.portIsOpen : undefined;
  return typeof v === "boolean" ? v : null;
}

/**
 * Probe the peer port. Daemons with `portTestByProtocol` are asked once per
 * protocol (two chips); older daemons answer once for whatever they listen on.
 * The protocols are judged on their own: one failing probe is reported as
 * `unavailable` and never hides the other's verdict. When every probe fails
 * the first error is thrown.
 *
 * @returns {Promise<PortTestResult[]>}
 */
export async function testPort(client, caps) {
  if (caps && caps.portTestByProtocol) {
    const protocols = ["ipv4", "ipv6"];
    const settled = await Promise.allSettled(protocols.map((ip_protocol) => client.call("port-test", { ip_protocol })));
    const failed = settled.find((r) => r.status === "rejected");
    if (failed && settled.every((r) => r.status === "rejected")) throw failed.reason;
    return settled.map((r, i) => ({
      protocol: protocols[i],
      open: r.status === "fulfilled" ? portVerdict(r.value) : null,
      unavailable: r.status === "rejected",
    }));
  }
  const result = await client.call("port-test");
  return [{ protocol: "any", open: portVerdict(result), unavailable: false }];
}
