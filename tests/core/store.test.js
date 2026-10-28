import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, STORE_KEYS } from '../../src/app/js/core/store.js';

test('initial state carries every contract key with the documented types', () => {
  const s = createStore().get();
  assert.deepEqual(Object.keys(s).sort(), [...STORE_KEYS].sort());
  assert.ok(s.torrents instanceof Map);
  assert.ok(s.selection instanceof Set);
  assert.deepEqual(s.order, []);
  assert.equal(s.focused, null);
  assert.equal(s.filter.status, 'all');
  assert.equal(s.connection.state, 'connecting');
  assert.ok(Object.isFrozen(s));
});

test('set notifies only keys whose value changed identity', () => {
  const store = createStore();
  const seen = [];
  store.subscribe('focused', (v) => seen.push(['focused', v]));
  store.subscribe('order', (v) => seen.push(['order', v]));
  const order = store.get().order;
  store.set({ focused: 3, order });
  store.set({ focused: 3 });
  assert.deepEqual(seen, [['focused', 3]]);
});

test('a new snapshot per set; subscribers see the full post-patch state', () => {
  const store = createStore();
  const before = store.get();
  let seenState;
  store.subscribe('selection', (v, state) => { seenState = state; });
  const selection = new Set([1, 2]);
  store.set({ selection, focused: 2 });
  assert.notEqual(store.get(), before);
  assert.equal(seenState.focused, 2);
  assert.equal(seenState.selection, selection);
});

test('mutating a stored Set in place notifies nobody (replace, never mutate)', () => {
  const store = createStore();
  let calls = 0;
  store.subscribe('selection', () => { calls += 1; });
  const sel = store.get().selection;
  sel.add(1);
  store.set({ selection: sel });
  assert.equal(calls, 0);
  store.set({ selection: new Set(sel) });
  assert.equal(calls, 1);
});

test('wildcard subscriber receives the changed keys once per set', () => {
  const store = createStore();
  const calls = [];
  store.subscribe('*', (changed) => calls.push(changed));
  store.set({ focused: 1, stats: { a: 1 } });
  assert.deepEqual(calls, [['focused', 'stats']]);
});

test('unsubscribe stops delivery, also when called during notification', () => {
  const store = createStore();
  let a = 0;
  let b = 0;
  const offA = store.subscribe('focused', () => { a += 1; offA(); });
  store.subscribe('focused', () => { b += 1; });
  store.set({ focused: 1 });
  store.set({ focused: 2 });
  assert.equal(a, 1);
  assert.equal(b, 2);
});

test('a throwing subscriber does not stop the others', (t) => {
  const store = createStore();
  const original = console.error;
  const errors = [];
  console.error = (e) => errors.push(e);
  t.after(() => { console.error = original; });
  let ran = false;
  store.subscribe('focused', () => { throw new Error('boom'); });
  store.subscribe('focused', () => { ran = true; });
  store.set({ focused: 9 });
  assert.equal(ran, true);
  assert.equal(errors.length, 1);
});

test('unknown keys are refused on set, subscribe and seed', () => {
  const store = createStore();
  assert.throws(() => store.set({ torrent: new Map() }), /unknown key "torrent"/);
  assert.throws(() => store.subscribe('nope', () => {}), /unknown key/);
  assert.throws(() => createStore({ extra: 1 }), /unknown key/);
  assert.throws(() => store.set(null), /patch must be an object/);
});
