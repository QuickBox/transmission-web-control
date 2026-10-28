/**
 * Torrent labels. Daemons with `caps.nativeLabels` (3.00+) hold them
 * server-side and share them with every other client; 2.94 has no such field,
 * so labels live in the browser, keyed by torrent hash.
 *
 * Storage is injected (anything with `getItem` / `setItem` / `removeItem`),
 * so this file never touches the DOM. The previous UI kept its labels inside
 * its own config blob; that blob is read once into our key and left in place.
 */

/** Our storage key: `{ [hash]: string[] }`. */
export const LOCAL_LABELS_KEY = "qb-transmission.labels";
/** Set once the browser-held labels have been copied to the daemon. */
export const LABELS_IMPORTED_KEY = "qb-transmission.labelsImported";
/** Set once the previous UI's labels were copied into `LOCAL_LABELS_KEY`. */
export const LABELS_MIGRATED_KEY = "qb-transmission.labelsMigrated";
/** The previous UI's config blob; its `labelMaps` is `{ [hash]: string[] }`. */
export const LEGACY_CONFIG_KEY = "transmission-web-control.system";

const HASH_RE = /^[0-9a-f]{40}$/i;

function cleanLabels(labels) {
  const out = [];
  for (const raw of Array.isArray(labels) ? labels : []) {
    if (typeof raw !== "string") continue;
    const label = raw.trim();
    if (label !== "" && !out.includes(label)) out.push(label);
  }
  return out;
}

function readJson(storage, key) {
  try {
    const raw = storage.getItem(key);
    return typeof raw === "string" && raw !== "" ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** `{ [hash]: string[] }` with every entry validated; junk is dropped. */
function readMap(storage, key, pick = (v) => v) {
  const raw = pick(readJson(storage, key));
  const map = new Map();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return map;
  for (const [hash, labels] of Object.entries(raw)) {
    const clean = cleanLabels(labels);
    if (HASH_RE.test(hash) && clean.length > 0) map.set(hash.toLowerCase(), clean);
  }
  return map;
}

function writeMap(storage, map) {
  const obj = {};
  for (const [hash, labels] of map) if (labels.length > 0) obj[hash] = labels;
  storage.setItem(LOCAL_LABELS_KEY, JSON.stringify(obj));
}

function mergeLabels(a, b) {
  return cleanLabels([...(a ?? []), ...(b ?? [])]);
}

/**
 * @typedef {object} LabelStore
 * @property {"native"|"local"} mode
 * @property {(torrent: { labels?: string[], hash?: string }) => string[]} read
 * @property {(torrents: { id: number, hash: string }[], labels: string[]) => Promise<void>} write
 *   replace the labels of each torrent
 * @property {(torrents: Iterable<{ labels?: string[], hash?: string }>) => string[]} allLabels
 *   distinct labels in use, sorted
 * @property {() => Map<string, string[]>} localEntries browser-held labels by hash
 * @property {() => number} migrateLegacy copy the previous UI's labels into our key once
 * @property {(torrents: Map<number, { hash: string }>) => { count: number, ids: number[] }} importOffer
 *   on native daemons: browser-held labels that match a live torrent and were never imported
 * @property {(torrents: Map<number, { hash: string, labels?: string[] }>) => Promise<{ imported: number }>} importLocal
 *   copy those labels to the daemon (merged with what it has), then mark imported; the local copy stays
 */

/**
 * @param {{ client: { call(method: string, args: object): Promise<object> }, caps: import("./caps.js").Caps, storage: { getItem(k: string): string|null, setItem(k: string, v: string): void, removeItem(k: string): void } }} deps
 * @returns {LabelStore}
 */
export function createLabelStore({ client, caps, storage }) {
  const native = Boolean(caps && caps.nativeLabels);

  function localEntries() {
    return readMap(storage, LOCAL_LABELS_KEY);
  }

  function migrateLegacy() {
    if (storage.getItem(LABELS_MIGRATED_KEY) === "1") return 0;
    const legacy = readMap(storage, LEGACY_CONFIG_KEY, (cfg) => (cfg && typeof cfg === "object" ? cfg.labelMaps : null));
    const ours = localEntries();
    let copied = 0;
    for (const [hash, labels] of legacy) {
      if (!ours.has(hash)) {
        ours.set(hash, labels);
        copied += 1;
      }
    }
    if (copied > 0) writeMap(storage, ours);
    storage.setItem(LABELS_MIGRATED_KEY, "1");
    return copied;
  }

  function read(torrent) {
    if (!torrent) return [];
    if (native) return cleanLabels(torrent.labels);
    const hash = typeof torrent.hash === "string" ? torrent.hash.toLowerCase() : "";
    return hash ? (localEntries().get(hash) ?? []) : [];
  }

  async function write(torrents, labels) {
    const clean = cleanLabels(labels);
    const targets = (torrents ?? []).filter((t) => t && Number.isInteger(t.id));
    if (targets.length === 0) return;
    if (native) {
      await client.call("torrent-set", { ids: targets.map((t) => t.id), labels: clean });
      return;
    }
    const map = localEntries();
    for (const t of targets) {
      if (typeof t.hash !== "string" || !HASH_RE.test(t.hash)) continue;
      if (clean.length === 0) map.delete(t.hash.toLowerCase());
      else map.set(t.hash.toLowerCase(), clean);
    }
    writeMap(storage, map);
  }

  function allLabels(torrents) {
    const set = new Set();
    for (const t of torrents ?? []) for (const l of read(t)) set.add(l);
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  function matches(torrents) {
    const local = localEntries();
    const ids = [];
    for (const [id, t] of torrents ?? new Map()) {
      if (t && typeof t.hash === "string" && local.has(t.hash.toLowerCase())) ids.push(id);
    }
    return { local, ids };
  }

  function importOffer(torrents) {
    if (!native || storage.getItem(LABELS_IMPORTED_KEY) === "1") return { count: 0, ids: [] };
    const { ids } = matches(torrents);
    return { count: ids.length, ids };
  }

  async function importLocal(torrents) {
    if (!native) return { imported: 0 };
    const { local, ids } = matches(torrents);
    let imported = 0;
    for (const id of ids) {
      const t = torrents.get(id);
      const merged = mergeLabels(t.labels, local.get(t.hash.toLowerCase()));
      await client.call("torrent-set", { ids: [id], labels: merged });
      imported += 1;
    }
    storage.setItem(LABELS_IMPORTED_KEY, "1");
    return { imported };
  }

  return Object.freeze({
    mode: native ? "native" : "local",
    read,
    write,
    allLabels,
    localEntries,
    migrateLegacy,
    importOffer,
    importLocal,
  });
}

/** In-memory storage with the injected shape, for tests and for browsers that refuse storage. */
export function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      map.set(k, String(v));
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}
