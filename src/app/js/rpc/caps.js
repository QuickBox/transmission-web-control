/**
 * Capability object: the single place that turns the daemon's version into
 * feature gates. Every other module reads `caps.*`, never the version fields.
 *
 * This is the only file that may read the version keys of `session-get`
 * (`rpc-version`, `rpc-version-semver` in the legacy dialect; `rpc_version`,
 * `rpc_version_semver` in JSON-RPC). The client has already normalised them to
 * `rpcVersion` / `rpcVersionSemver` by the time they arrive here.
 *
 * Version map: 2.94 = 15, 3.00 = 16, 4.0.x = 17, 4.1.x = 19 with semver 6.x.
 * Every semver-6 daemon is past every integer gate, so a gate opens when the
 * legacy integer reaches it OR the semver major is 6 or more; 4.1 features gate
 * on the semver major alone. On JSON-RPC the integer is deprecated and never
 * read, so `rpc` is 0 there and the semver carries the version.
 */

import { DIALECT, toCamelKey } from "./client.js?v=__QBV__";

function parseInt10(value) {
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) ? n : null;
}

/** `"6.0.1"` -> `{ major: 6, minor: 0, patch: 1 }`, `null` when malformed. */
export function parseSemver(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  if (!match) return null;
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
  };
}

/**
 * @typedef {object} Caps
 * @property {number} rpc legacy RPC integer (15, 16, 17, 19); 0 on JSON-RPC or when unknown
 * @property {string|null} semver `rpc-version-semver` as reported (4.0+)
 * @property {number} semverMajor 0 when no semver was reported
 * @property {"legacy"|"jsonrpc"} dialect wire dialect the client selected
 * @property {boolean} jsonRpc `dialect === "jsonrpc"`
 * @property {string|null} daemonVersion the `version` session string
 * @property {boolean} nativeLabels server-side `labels` (rpc >= 16 or semver 6+)
 * @property {boolean} tableFormat `torrent-get format:"table"` (rpc >= 16 or semver 6+)
 * @property {boolean} sessionFields `session-get` accepts `fields` (rpc >= 16 or semver 6+)
 * @property {boolean} trackerList `trackerList` replaces add/remove/replace (rpc >= 17 or semver 6+)
 * @property {boolean} sequential `sequential_download` (semver major >= 6)
 * @property {boolean} portTestByProtocol `port-test` takes `ip_protocol` (semver major >= 6)
 * @property {(sessionKey: string) => boolean} has feature detection on the
 *   session object for every Settings row (`caps.has("default-trackers")`)
 */

/**
 * Build the caps from a normalised `session-get` result.
 *
 * @param {object} session normalised (camelCase) session object
 * @param {{ dialect: "legacy"|"jsonrpc" }} wire
 * @returns {Caps}
 */
export function buildCaps(session, wire) {
  const source = session && typeof session === "object" ? session : {};
  const dialect = wire && wire.dialect === DIALECT.JSONRPC ? DIALECT.JSONRPC : DIALECT.LEGACY;
  const jsonRpc = dialect === DIALECT.JSONRPC;

  const semverParsed = parseSemver(source.rpcVersionSemver);
  const semver = semverParsed ? String(source.rpcVersionSemver).trim() : null;
  const semverMajor = semverParsed ? semverParsed.major : 0;

  // JSON-RPC deprecates the integer: never read it there.
  const rpc = jsonRpc ? 0 : (parseInt10(source.rpcVersion) ?? 0);
  const atLeast = (n) => rpc >= n || semverMajor >= 6;

  const keys = new Set(Object.keys(source));

  return Object.freeze({
    rpc,
    semver,
    semverMajor,
    dialect,
    jsonRpc,
    daemonVersion: typeof source.version === "string" ? source.version : null,
    nativeLabels: atLeast(16),
    tableFormat: atLeast(16),
    sessionFields: atLeast(16),
    trackerList: atLeast(17),
    sequential: semverMajor >= 6,
    portTestByProtocol: semverMajor >= 6,
    // Accepts the upstream spelling (`script-torrent-added-enabled`) or camelCase.
    has: (sessionKey) => keys.has(toCamelKey(sessionKey)),
  });
}

/** Caps for a daemon we have not reached yet: every gate closed. */
export const UNKNOWN_CAPS = buildCaps({}, { dialect: DIALECT.LEGACY });
