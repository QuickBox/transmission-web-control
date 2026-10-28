/**
 * Torrent data layer: field lists per capability, `torrent-get` decoding
 * (object and `format:"table"`), the recently-active merge, state derivation,
 * tracker/folder/label aggregation and search.
 *
 * Everything here is pure: it takes normalised RPC results (camelCase, see
 * `client.js`) and returns plain data for the store. No DOM, no timers.
 */

import { toCamelKey } from "./client.js?v=__QBV__";

/** Raw `status` integers reported by the daemon. */
export const STATUS = Object.freeze({
  STOPPED: 0,
  CHECK_WAIT: 1,
  CHECK: 2,
  DOWNLOAD_WAIT: 3,
  DOWNLOAD: 4,
  SEED_WAIT: 5,
  SEED: 6,
});

/** The seven display states. Tracker warnings are a flag, not a state. */
export const STATE = Object.freeze({
  STOPPED: "stopped",
  QUEUED: "queued",
  CHECKING: "checking",
  DOWNLOADING: "downloading",
  SEEDING: "seeding",
  FINISHED: "finished",
  ERROR: "error",
});

export const STATES = Object.freeze(Object.values(STATE));

export const RECENTLY_ACTIVE = "recently-active";

const BASE_FIELDS = Object.freeze([
  "id",
  "hashString",
  "name",
  "status",
  "error",
  "errorString",
  "totalSize",
  "sizeWhenDone",
  "leftUntilDone",
  "percentDone",
  "recheckProgress",
  "rateDownload",
  "rateUpload",
  "eta",
  "uploadRatio",
  "uploadedEver",
  "downloadedEver",
  "peersConnected",
  "peersGettingFromUs",
  "peersSendingToUs",
  "downloadDir",
  "addedDate",
  "doneDate",
  "activityDate",
  "queuePosition",
  "isFinished",
  "trackerStats",
]);

/** Fields that change while a torrent runs; the poll asks only for these. */
const POLL_FIELDS = Object.freeze([
  "id",
  "name",
  "status",
  "error",
  "errorString",
  "totalSize",
  "sizeWhenDone",
  "leftUntilDone",
  "percentDone",
  "recheckProgress",
  "rateDownload",
  "rateUpload",
  "eta",
  "uploadRatio",
  "uploadedEver",
  "downloadedEver",
  "peersConnected",
  "peersGettingFromUs",
  "peersSendingToUs",
  "doneDate",
  "activityDate",
  "queuePosition",
  "isFinished",
  "trackerStats",
]);

/** Fields only some daemons know; requested when the matching cap is open. */
const GATED_FIELDS = Object.freeze([{ field: "labels", cap: "nativeLabels" }]);

/**
 * The field list for `torrent-get`, in the upstream legacy spelling (the client
 * converts for JSON-RPC).
 *
 * @param {import("./caps.js").Caps} caps
 * @param {{ poll?: boolean, extra?: string[] }} [options]
 * @returns {string[]}
 */
export function torrentFields(caps, options = {}) {
  const fields = new Set(options.poll ? POLL_FIELDS : BASE_FIELDS);
  for (const { field, cap } of GATED_FIELDS) {
    if (caps && caps[cap]) fields.add(field);
  }
  for (const field of options.extra ?? []) fields.add(field);
  return [...fields];
}

/**
 * Build the `torrent-get` arguments.
 *
 * @param {import("./caps.js").Caps} caps
 * @param {{ ids?: number[]|string, poll?: boolean, extra?: string[] }} [options]
 *   `ids: "recently-active"` asks for the incremental delta (plus `removed`)
 */
export function torrentGetArgs(caps, options = {}) {
  const args = { fields: torrentFields(caps, options) };
  if (options.ids !== undefined) args.ids = options.ids;
  if (caps && caps.tableFormat) args.format = "table";
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

/** Integer or 0: for counters and sizes the daemon always reports. */
function intOrZero(value) {
  return toInt(value) ?? 0;
}

/** Rounded integer or 0: speed fields were briefly floats on 4.1.0. */
function roundedOrZero(value) {
  const n = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function floatOrZero(value) {
  const n = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

/** Peer counts the tracker did not report (`-1`) stay `null`, never 0. */
function peerCount(value) {
  const n = toInt(value);
  return n === null || n < 0 ? null : n;
}

function stringOr(value, fallback) {
  return typeof value === "string" ? value : fallback;
}

/**
 * `format:"table"` returns a header row followed by value rows; expand them
 * back into objects. Object-format rows pass through untouched.
 */
export function decodeTorrentRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const [first] = rows;
  if (!Array.isArray(first)) return rows.filter((row) => row && typeof row === "object");
  const header = first.map(toCamelKey);
  const out = [];
  for (let r = 1; r < rows.length; r += 1) {
    const values = rows[r];
    if (!Array.isArray(values)) continue;
    const row = {};
    for (let c = 0; c < header.length; c += 1) row[header[c]] = values[c];
    out.push(row);
  }
  return out;
}

/**
 * Host used to group a tracker in the sidebar: the announce URL's hostname.
 * Unparseable announce strings group under the raw string.
 */
export function trackerHost(announce) {
  if (typeof announce !== "string" || announce === "") return "";
  try {
    return new URL(announce).hostname || announce;
  } catch {
    return announce;
  }
}

function normalizeTracker(stat) {
  const announce = stringOr(stat.announce, "");
  return {
    id: toInt(stat.id),
    tier: intOrZero(stat.tier),
    host: trackerHost(announce),
    announce,
    scrape: stringOr(stat.scrape, ""),
    announceState: toInt(stat.announceState),
    lastAnnounceSucceeded: stat.lastAnnounceSucceeded === true,
    lastAnnounceResult: stringOr(stat.lastAnnounceResult, ""),
    lastAnnounceTime: intOrZero(stat.lastAnnounceTime),
    nextAnnounceTime: intOrZero(stat.nextAnnounceTime),
    seederCount: peerCount(stat.seederCount),
    leecherCount: peerCount(stat.leecherCount),
    downloaderCount: peerCount(stat.downloaderCount),
    downloadCount: peerCount(stat.downloadCount),
  };
}

/** Max of the known counts; `null` when no tracker reported one. */
function maxKnown(trackers, key) {
  let max = null;
  for (const t of trackers) {
    const n = t[key];
    if (n !== null && (max === null || n > max)) max = n;
  }
  return max;
}

/**
 * Derive the display state from the raw status, error and completion.
 *
 * @param {{ status: number, error: number, isFinished?: boolean, percentDone?: number, leftUntilDone?: number, sizeWhenDone?: number }} t
 * @returns {string} one of `STATES`
 */
export function deriveState(t) {
  if (intOrZero(t.error) !== 0) return STATE.ERROR;
  switch (intOrZero(t.status)) {
    case STATUS.CHECK:
      return STATE.CHECKING;
    case STATUS.CHECK_WAIT:
    case STATUS.DOWNLOAD_WAIT:
    case STATUS.SEED_WAIT:
      return STATE.QUEUED;
    case STATUS.DOWNLOAD:
      return STATE.DOWNLOADING;
    case STATUS.SEED:
      return STATE.SEEDING;
    default: {
      const complete =
        t.isFinished === true ||
        (intOrZero(t.sizeWhenDone) > 0 && intOrZero(t.leftUntilDone) === 0) ||
        floatOrZero(t.percentDone) >= 1;
      return complete ? STATE.FINISHED : STATE.STOPPED;
    }
  }
}

/**
 * Tracker warning text: the latest failed announce result, `""` when every
 * tracker's last announce succeeded (or nothing was reported).
 */
function trackerWarning(trackers) {
  const failed = trackers.filter((t) => t.lastAnnounceTime > 0 && !t.lastAnnounceSucceeded && t.lastAnnounceResult);
  if (failed.length === 0 || failed.length < trackers.length) return "";
  return failed.reduce((a, b) => (b.lastAnnounceTime > a.lastAnnounceTime ? b : a)).lastAnnounceResult;
}

/**
 * @typedef {object} Torrent
 * @property {number} id
 * @property {string} hash
 * @property {string} name
 * @property {number} status raw daemon status (0..6)
 * @property {string} state one of `STATES`
 * @property {number} error raw error code, 0 = none
 * @property {string} errorString
 * @property {string} warning tracker warning text, `""` when none
 * @property {number} totalSize
 * @property {number} sizeWhenDone
 * @property {number} leftUntilDone
 * @property {number} percentDone 0..1
 * @property {number} recheckProgress 0..1
 * @property {number} rateDownload bytes/s
 * @property {number} rateUpload bytes/s
 * @property {number} eta seconds, negative = unknown/not applicable
 * @property {number} uploadRatio
 * @property {number} uploadedEver
 * @property {number} downloadedEver
 * @property {number} peersConnected
 * @property {number} peersGettingFromUs
 * @property {number} peersSendingToUs
 * @property {number|null} seederCount `null` when no tracker reported it
 * @property {number|null} leecherCount `null` when no tracker reported it
 * @property {string} downloadDir
 * @property {number} addedDate unix seconds
 * @property {number} doneDate unix seconds, 0 when not done
 * @property {number} activityDate unix seconds
 * @property {number} queuePosition
 * @property {boolean} isFinished
 * @property {string[]} labels empty on daemons without native labels
 * @property {object[]} trackers normalised `trackerStats`
 * @property {string[]} trackerHosts distinct hosts, in tier order
 */

/**
 * Normalise one decoded `torrent-get` row into the store shape. Missing fields
 * fall back to neutral values so a partial (poll) row never throws.
 *
 * @param {object} raw
 * @param {Torrent} [previous] the stored torrent for a partial row
 * @returns {Torrent}
 */
export function normalizeTorrent(raw, previous) {
  const row = previous ? { ...previous, ...raw } : raw;
  const trackers = Array.isArray(row.trackerStats)
    ? row.trackerStats.filter((s) => s && typeof s === "object").map(normalizeTracker)
    : previous
      ? previous.trackers
      : [];
  const seen = new Set();
  const trackerHosts = [];
  for (const t of trackers) {
    if (t.host && !seen.has(t.host)) {
      seen.add(t.host);
      trackerHosts.push(t.host);
    }
  }
  const labels = Array.isArray(row.labels)
    ? row.labels.filter((l) => typeof l === "string")
    : previous
      ? previous.labels
      : [];
  const status = intOrZero(row.status);
  const base = {
    id: intOrZero(row.id),
    hash: stringOr(row.hashString, previous ? previous.hash : ""),
    name: stringOr(row.name, ""),
    status,
    error: intOrZero(row.error),
    errorString: stringOr(row.errorString, ""),
    totalSize: intOrZero(row.totalSize),
    sizeWhenDone: intOrZero(row.sizeWhenDone),
    leftUntilDone: intOrZero(row.leftUntilDone),
    percentDone: floatOrZero(row.percentDone),
    recheckProgress: floatOrZero(row.recheckProgress),
    rateDownload: roundedOrZero(row.rateDownload),
    rateUpload: roundedOrZero(row.rateUpload),
    eta: toInt(row.eta) ?? -1,
    uploadRatio: floatOrZero(row.uploadRatio),
    uploadedEver: intOrZero(row.uploadedEver),
    downloadedEver: intOrZero(row.downloadedEver),
    peersConnected: intOrZero(row.peersConnected),
    peersGettingFromUs: intOrZero(row.peersGettingFromUs),
    peersSendingToUs: intOrZero(row.peersSendingToUs),
    seederCount: maxKnown(trackers, "seederCount"),
    leecherCount: maxKnown(trackers, "leecherCount"),
    downloadDir: stringOr(row.downloadDir, ""),
    addedDate: intOrZero(row.addedDate),
    doneDate: intOrZero(row.doneDate),
    activityDate: intOrZero(row.activityDate),
    queuePosition: intOrZero(row.queuePosition),
    isFinished: row.isFinished === true,
    labels,
    trackers,
    trackerHosts,
  };
  base.state = deriveState(base);
  base.warning = trackerWarning(trackers);
  return base;
}

/**
 * Decode a normalised `torrent-get` result into `{ torrents, removed }`.
 *
 * @param {{ torrents?: unknown[], removed?: unknown[] }} result
 * @returns {{ rows: object[], removed: number[] }}
 */
export function decodeTorrentGet(result) {
  const source = result && typeof result === "object" ? result : {};
  const rows = decodeTorrentRows(source.torrents);
  const removed = Array.isArray(source.removed)
    ? source.removed.map(toInt).filter((id) => id !== null)
    : [];
  return { rows, removed };
}

/**
 * Merge a `torrent-get` result into the store map. Returns a new Map plus the
 * ids that were added, updated and removed, so the caller can refetch base
 * fields for torrents it has never seen (a recently-active row carries only
 * poll fields).
 *
 * @param {Map<number, Torrent>} current
 * @param {{ torrents?: unknown[], removed?: unknown[] }} result
 * @param {{ replace?: boolean }} [options] `replace: true` drops torrents the
 *   result did not mention (a full, non-incremental fetch)
 * @returns {{ torrents: Map<number, Torrent>, added: number[], updated: number[], removed: number[] }}
 */
export function mergeTorrents(current, result, options = {}) {
  const { rows, removed } = decodeTorrentGet(result);
  const next = options.replace ? new Map() : new Map(current);
  const added = [];
  const updated = [];
  for (const raw of rows) {
    const id = toInt(raw.id);
    if (id === null) continue;
    const previous = current.get(id);
    next.set(id, normalizeTorrent(raw, previous));
    (previous ? updated : added).push(id);
  }
  const removedIds = [];
  for (const id of removed) {
    if (next.delete(id)) removedIds.push(id);
  }
  return { torrents: next, added, updated, removed: removedIds };
}

/**
 * Fetch torrents through the client and merge them.
 *
 * @param {{ call(method: string, args: object): Promise<object> }} client
 * @param {import("./caps.js").Caps} caps
 * @param {Map<number, Torrent>} current
 * @param {{ ids?: number[]|string, poll?: boolean, extra?: string[], replace?: boolean }} [options]
 */
export async function fetchTorrents(client, caps, current, options = {}) {
  const result = await client.call("torrent-get", torrentGetArgs(caps, options));
  const replace = options.replace ?? (options.ids === undefined);
  return mergeTorrents(current, result, { replace });
}

function bump(map, key, torrent) {
  const entry = map.get(key) ?? { key, count: 0, size: 0 };
  entry.count += 1;
  entry.size += torrent.totalSize;
  map.set(key, entry);
}

/**
 * Sidebar aggregates.
 *
 * @param {Iterable<Torrent>} torrents
 * @returns {{
 *   count: number, totalSize: number,
 *   states: Record<string, number>, active: number, warning: number,
 *   trackers: Map<string, { key: string, count: number, size: number }>,
 *   folders: Map<string, { key: string, count: number, size: number }>,
 *   labels: Map<string, { key: string, count: number, size: number }>,
 *   rateDownload: number, rateUpload: number
 * }}
 */
export function aggregate(torrents) {
  const states = Object.fromEntries(STATES.map((s) => [s, 0]));
  const out = {
    count: 0,
    totalSize: 0,
    states,
    active: 0,
    warning: 0,
    trackers: new Map(),
    folders: new Map(),
    labels: new Map(),
    rateDownload: 0,
    rateUpload: 0,
  };
  for (const t of torrents) {
    out.count += 1;
    out.totalSize += t.totalSize;
    states[t.state] += 1;
    if (t.rateDownload > 0 || t.rateUpload > 0) out.active += 1;
    if (t.warning) out.warning += 1;
    out.rateDownload += t.rateDownload;
    out.rateUpload += t.rateUpload;
    for (const host of t.trackerHosts) bump(out.trackers, host, t);
    if (t.downloadDir) bump(out.folders, t.downloadDir, t);
    for (const label of t.labels) bump(out.labels, label, t);
  }
  return out;
}

/**
 * Case-insensitive substring search over name, hash, labels, tracker hosts
 * and download directory. Whitespace-separated terms must all match.
 *
 * @param {Iterable<Torrent>} torrents
 * @param {string} query
 * @returns {Torrent[]}
 */
export function searchTorrents(torrents, query) {
  const terms = String(query ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const all = [...torrents];
  if (terms.length === 0) return all;
  return all.filter((t) => {
    const haystack = [t.name, t.hash, t.downloadDir, ...t.labels, ...t.trackerHosts].join("\n").toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}
