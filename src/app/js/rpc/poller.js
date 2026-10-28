/**
 * The polling loop. One tick = the recently-active torrent delta (with a
 * base-field refetch for ids seen for the first time), the footer session
 * fields and the session stats, written into the store as NEW values (the
 * store notifies on identity change, so Maps are rebuilt, never mutated).
 * `start()` and `refreshAll()` read everything: the full torrent list and the
 * full session, so the stored session always holds every key.
 *
 * Ticks never overlap: a tick requested while one is running joins it. The
 * next tick is scheduled only after the current one settles, so a slow daemon
 * stretches the cadence instead of stacking requests. Polling pauses while the
 * injected visibility source says the page is hidden and resumes with an
 * immediate tick when it becomes visible again.
 *
 * Timers and visibility are injected so this file has no DOM dependency.
 */

import { RpcError } from "./client.js?v=__QBV__";
import { RECENTLY_ACTIVE, fetchTorrents } from "./torrents.js?v=__QBV__";
import { getSession, getStats, pollSession } from "./session.js?v=__QBV__";

export const DEFAULT_INTERVAL_SECONDS = 5;
export const MIN_INTERVAL_SECONDS = 1;

/** Prefs key the interval is read from, in seconds. */
export const INTERVAL_PREF = "pollInterval";

/** A visibility source that never hides: for tests and non-browser hosts. */
export const ALWAYS_VISIBLE = Object.freeze({
  isHidden: () => false,
  subscribe: () => () => {},
});

function intervalMs(prefs) {
  const raw = prefs ? prefs[INTERVAL_PREF] : undefined;
  const n = typeof raw === "number" ? raw : Number.parseInt(raw, 10);
  const seconds = Number.isFinite(n) && n >= MIN_INTERVAL_SECONDS ? n : DEFAULT_INTERVAL_SECONDS;
  return seconds * 1000;
}

/**
 * The store's `connection` value for a failed request: `unauthorized` on a
 * 401/403, `offline` for anything else.
 * @param {unknown} err
 * @param {number} [now] timestamp for `since`
 */
export function connectionFailure(err, now = Date.now()) {
  const status = err instanceof RpcError ? err.status : 0;
  return {
    state: status === 401 || status === 403 ? "unauthorized" : "offline",
    error: err && err.message ? String(err.message) : "request failed",
    since: now,
  };
}

/**
 * @typedef {object} Poller
 * @property {() => Promise<void>} start full fetch, then poll on the interval
 * @property {() => void} stop
 * @property {() => Promise<void>} tick one incremental poll now (joins a running one)
 * @property {() => Promise<void>} refreshAll one full fetch now (drops torrents the daemon no longer lists)
 * @property {(ids: number[]) => Promise<void>} refreshTorrents re-read these ids with the full field set
 * @property {() => boolean} isRunning
 * @property {() => boolean} isPaused true while hidden
 */

/**
 * @param {{
 *   client: { call(method: string, args?: object): Promise<object> },
 *   caps: import("./caps.js").Caps,
 *   store: { get(): any, set(patch: object): void },
 *   visibility?: { isHidden(): boolean, subscribe(fn: () => void): () => void },
 *   timers?: { setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout },
 *   now?: () => number,
 * }} deps
 * @returns {Poller}
 */
export function createPoller({ client, caps, store, visibility = ALWAYS_VISIBLE, timers, now = Date.now }) {
  const clock = timers ?? { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  let running = false;
  let primed = false;
  let timer = null;
  let inflight = null;
  let unsubscribe = null;

  function setConnection(next) {
    const current = store.get().connection;
    if (current && current.state === next.state && current.error === next.error) return;
    store.set({ connection: next });
  }

  async function pullTorrents(full) {
    const state = store.get();
    const options = full ? { replace: true } : { ids: RECENTLY_ACTIVE, poll: true };
    let { torrents, added } = await fetchTorrents(client, caps, state.torrents, options);
    if (!full && added.length > 0) {
      // A recently-active row for an unseen id carries only the poll fields.
      ({ torrents } = await fetchTorrents(client, caps, torrents, { ids: added }));
    }
    return torrents;
  }

  async function run(full) {
    try {
      const [torrents, sessionPatch, stats] = await Promise.all([
        pullTorrents(full),
        full ? getSession(client) : pollSession(client, caps),
        getStats(client),
      ]);
      const current = store.get();
      store.set({
        torrents,
        session: { ...current.session, ...sessionPatch },
        stats,
      });
      primed = true;
      setConnection({ state: "online", error: null, since: now() });
    } catch (err) {
      setConnection(connectionFailure(err, now()));
    }
  }

  function poll(full) {
    if (inflight) return inflight;
    inflight = run(full).finally(() => {
      inflight = null;
      schedule();
    });
    return inflight;
  }

  /**
   * Re-read `ids` with the full field set and merge them as new objects, so a
   * write to an idle torrent (which `recently-active` never reports) reaches
   * the store at once. Serialised with the poll: it waits for an in-flight
   * job, and a tick asked for while it runs joins it.
   */
  function refreshTorrents(ids) {
    const targets = [...new Set(Array.isArray(ids) ? ids : [])].filter(Number.isInteger);
    if (targets.length === 0) return Promise.resolve();
    const previous = inflight ? inflight.catch(() => {}) : Promise.resolve();
    const job = previous
      .then(async () => {
        const { torrents } = await fetchTorrents(client, caps, store.get().torrents, { ids: targets });
        store.set({ torrents });
      })
      .catch((err) => setConnection(connectionFailure(err, now())));
    const held = job.finally(() => {
      if (inflight === held) inflight = null;
    });
    inflight = held;
    return held;
  }

  function clearTimer() {
    if (timer !== null) {
      clock.clearTimeout(timer);
      timer = null;
    }
  }

  function schedule() {
    clearTimer();
    if (!running || visibility.isHidden()) return;
    timer = clock.setTimeout(() => {
      timer = null;
      return poll(!primed);
    }, intervalMs(store.get().prefs));
  }

  function onVisibility() {
    if (!running) return;
    if (visibility.isHidden()) {
      clearTimer();
      return;
    }
    if (timer === null && !inflight) poll(!primed);
  }

  return Object.freeze({
    start() {
      if (running) return inflight ?? Promise.resolve();
      running = true;
      unsubscribe = visibility.subscribe(onVisibility);
      return poll(true);
    },
    stop() {
      running = false;
      clearTimer();
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    },
    tick: () => poll(!primed),
    refreshAll: () => poll(true),
    refreshTorrents,
    isRunning: () => running,
    isPaused: () => running && visibility.isHidden(),
  });
}

/**
 * What every successful torrent write calls: refresh the written ids through
 * the app's poller so the change shows without waiting for a poll that may
 * never report an idle torrent. Resolves at once when no poller is mounted.
 * @param {{ poller?: { refreshTorrents: (ids: number[]) => Promise<void> } }} ctx
 * @param {number[]} ids
 */
export function refreshAfterWrite(ctx, ids) {
  return ctx && ctx.poller && typeof ctx.poller.refreshTorrents === "function"
    ? ctx.poller.refreshTorrents(ids)
    : Promise.resolve();
}
