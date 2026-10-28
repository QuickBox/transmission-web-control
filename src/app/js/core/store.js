/**
 * App state: one frozen snapshot, replaced on every `set`, with per-key
 * subscribers.
 *
 * Replace, never mutate: a subscriber fires when a key's value changes
 * identity, so `torrents` (Map) and `selection` (Set) must be written as new
 * instances (`set({ selection: new Set(next) })`). Mutating the stored Map in
 * place notifies nobody.
 */

/**
 * @typedef {'all'|'active'|'downloading'|'seeding'|'stopped'|'checking'|'queued'|'error'|'warning'} StatusFilter
 * @typedef {{ status: StatusFilter, label: string|null, tracker: string|null, folder: string|null, search: string }} Filter
 * @typedef {{ state: 'connecting'|'online'|'offline'|'unauthorized', error: string|null, since: number }} Connection
 * @typedef {{
 *   torrents: Map<number, object>,
 *   order: number[],
 *   filter: Filter,
 *   selection: Set<number>,
 *   focused: number|null,
 *   session: Record<string, unknown>,
 *   stats: Record<string, unknown>,
 *   prefs: Record<string, unknown>,
 *   connection: Connection,
 * }} State
 * @typedef {keyof State} StoreKey
 * @typedef {{
 *   get: () => Readonly<State>,
 *   set: (patch: Partial<State>) => void,
 *   subscribe: (key: StoreKey|'*', fn: (value: any, state: Readonly<State>, changed: StoreKey[]) => void) => () => void,
 * }} Store
 */

export const STORE_KEYS = Object.freeze([
  'torrents', 'order', 'filter', 'selection', 'focused',
  'session', 'stats', 'prefs', 'connection',
]);

/** @returns {State} */
export function initialState() {
  return {
    torrents: new Map(),
    order: [],
    filter: { status: 'all', label: null, tracker: null, folder: null, search: '' },
    selection: new Set(),
    focused: null,
    session: {},
    stats: {},
    prefs: {},
    connection: { state: 'connecting', error: null, since: 0 },
  };
}

/**
 * @param {Partial<State>} [seed] Values that replace the initial ones.
 * @returns {Store}
 */
export function createStore(seed = {}) {
  assertKeys(seed);
  let state = Object.freeze({ ...initialState(), ...seed });
  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map();

  function get() {
    return state;
  }

  function set(patch) {
    assertKeys(patch);
    const changed = [];
    for (const key of Object.keys(patch)) {
      if (!Object.is(state[key], patch[key])) changed.push(key);
    }
    if (changed.length === 0) return;
    state = Object.freeze({ ...state, ...patch });
    const snapshot = state;
    for (const key of changed) notify(key, snapshot[key], snapshot, changed);
    notify('*', changed, snapshot, changed);
  }

  function subscribe(key, fn) {
    if (key !== '*' && !STORE_KEYS.includes(key)) {
      throw new TypeError(`store: unknown key "${key}"`);
    }
    if (typeof fn !== 'function') throw new TypeError('store: subscriber is not a function');
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key).add(fn);
    return () => listeners.get(key)?.delete(fn);
  }

  function notify(key, value, snapshot, changed) {
    const fns = listeners.get(key);
    if (!fns) return;
    for (const fn of [...fns]) {
      try {
        fn(value, snapshot, changed);
      } catch (err) {
        if (typeof globalThis.reportError === 'function') globalThis.reportError(err);
        else console.error(err);
      }
    }
  }

  return { get, set, subscribe };
}

function assertKeys(patch) {
  if (patch === null || typeof patch !== 'object') {
    throw new TypeError('store: patch must be an object');
  }
  for (const key of Object.keys(patch)) {
    if (!STORE_KEYS.includes(key)) throw new TypeError(`store: unknown key "${key}"`);
  }
}
