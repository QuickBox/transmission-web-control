import test from 'node:test';
import assert from 'node:assert/strict';
import { errorMessage } from '../../src/app/js/core/errors.js';

const t = (key) => `<${key}>`;

test('a request that never arrived or was refused reads as the translated connection message', () => {
  assert.equal(errorMessage(t, Object.assign(new Error('Failed to fetch'), { status: 0 })), '<core.connection.offline>');
  assert.equal(errorMessage(t, new TypeError('Failed to fetch')), '<core.connection.offline>');
  assert.equal(errorMessage(t, Object.assign(new Error('Transmission RPC handshake failed (HTTP 401)'), { status: 401 })), '<core.connection.unauthorized>');
  assert.equal(errorMessage(t, Object.assign(new Error('x'), { status: 403 })), '<core.connection.unauthorized>');
});

test('a daemon message is shown as received, and odd values never throw', () => {
  assert.equal(errorMessage(t, Object.assign(new Error('torrent is not running'), { status: 200 })), 'torrent is not running');
  assert.equal(errorMessage(t, new Error('boom')), 'boom');
  assert.equal(errorMessage(t, 'plain'), 'plain');
  assert.equal(errorMessage(t, undefined), 'undefined');
  assert.equal(errorMessage(t, null), 'null');
});
