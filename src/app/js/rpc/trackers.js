/**
 * Tracker editing. The UI edits the announce list as tiered text (one URL per
 * line, a blank line starts a new tier). Daemons with `caps.trackerList`
 * (4.0+) take that text whole through `trackerList`; 2.94 and 3.00 only
 * know per-row `trackerAdd` / `trackerRemove` / `trackerReplace`, so the list
 * is diffed against what the torrent currently has.
 */

/** `"a\nb\n\nc"` -> `[["a","b"],["c"]]`; whitespace trimmed, duplicates dropped. */
export function parseTrackerList(text) {
  const tiers = [];
  let tier = [];
  const seen = new Set();
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") {
      if (tier.length > 0) tiers.push(tier);
      tier = [];
      continue;
    }
    if (seen.has(line)) continue;
    seen.add(line);
    tier.push(line);
  }
  if (tier.length > 0) tiers.push(tier);
  return tiers;
}

/** Inverse of `parseTrackerList`. */
export function formatTrackerList(tiers) {
  return (tiers ?? [])
    .filter((tier) => Array.isArray(tier) && tier.length > 0)
    .map((tier) => tier.join("\n"))
    .join("\n\n");
}

/**
 * Tiers from a torrent's normalised `trackers` (or raw `trackers` rows with
 * `announce` and `tier`), in tier order.
 */
export function tiersFromTrackers(trackers) {
  const byTier = new Map();
  for (const t of trackers ?? []) {
    if (!t || typeof t.announce !== "string" || t.announce === "") continue;
    const tier = Number.isInteger(t.tier) ? t.tier : 0;
    if (!byTier.has(tier)) byTier.set(tier, []);
    byTier.get(tier).push(t.announce);
  }
  return [...byTier.keys()].sort((a, b) => a - b).map((k) => byTier.get(k));
}

/**
 * Per-row changes that turn `current` into `tiers`. Unchanged URLs are left
 * alone; a dropped URL and an added URL are paired into one `trackerReplace`
 * (the row keeps its id and tier); leftovers become removes and adds.
 *
 * @param {{ id: number, announce: string, tier?: number }[]} current
 * @param {string[][]} tiers
 * @returns {{ add: string[], remove: number[], replace: [number, string][] }}
 */
export function diffTrackers(current, tiers) {
  const wanted = new Set(tiers.flat());
  const have = new Map();
  for (const t of current ?? []) {
    if (t && Number.isInteger(t.id) && typeof t.announce === "string") have.set(t.announce, t.id);
  }
  const dropped = [...have.entries()].filter(([url]) => !wanted.has(url)).map(([, id]) => id);
  const added = [...wanted].filter((url) => !have.has(url));
  const replace = [];
  while (dropped.length > 0 && added.length > 0) {
    replace.push([dropped.shift(), added.shift()]);
  }
  return { add: added, remove: dropped, replace };
}

/**
 * Replace the announce list of each torrent in `ids`.
 *
 * @param {{ call(method: string, args: object): Promise<object> }} client
 * @param {import("./caps.js").Caps} caps
 * @param {number[]} ids
 * @param {string|string[][]} list tiered text or tiers
 * @returns {Promise<{ mode: "trackerList"|"rows", requests: number }>}
 */
export async function setTrackers(client, caps, ids, list) {
  const tiers = typeof list === "string" ? parseTrackerList(list) : (list ?? []).map((t) => [...t]);
  const targets = [...new Set(ids ?? [])].filter(Number.isInteger);
  if (targets.length === 0) return { mode: caps && caps.trackerList ? "trackerList" : "rows", requests: 0 };

  if (caps && caps.trackerList) {
    await client.call("torrent-set", { ids: targets, trackerList: formatTrackerList(tiers) });
    return { mode: "trackerList", requests: 1 };
  }

  // Row-level daemons: read each torrent's trackers, then send one torrent-set
  // per torrent carrying only the non-empty change lists. A daemon that only
  // knows add/remove puts every added URL in its own tier.
  const result = await client.call("torrent-get", { ids: targets, fields: ["id", "trackers"] });
  const rows = Array.isArray(result.torrents) ? result.torrents : [];
  let requests = 1;
  for (const row of rows) {
    if (!row || !targets.includes(row.id)) continue;
    const { add, remove, replace } = diffTrackers(row.trackers, tiers);
    const args = { ids: [row.id] };
    if (replace.length > 0) args.trackerReplace = replace.flat();
    if (add.length > 0) args.trackerAdd = add;
    if (remove.length > 0) args.trackerRemove = remove;
    if (Object.keys(args).length === 1) continue;
    await client.call("torrent-set", args);
    requests += 1;
  }
  return { mode: "rows", requests };
}
