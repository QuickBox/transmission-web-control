/**
 * Error text for a notice. A request that never reached the daemon, or was
 * refused at the door, carries the browser's or the client's English wording;
 * those map to the translated connection messages. Anything else is the
 * daemon's own message and is shown as received.
 */

/**
 * @param {(key: string) => string} t
 * @param {unknown} err
 * @returns {string}
 */
export function errorMessage(t, err) {
  const status = err && typeof err === 'object' ? err.status : undefined;
  if (status === 0) return t('core.connection.offline');
  if (status === 401 || status === 403) return t('core.connection.unauthorized');
  if (err instanceof TypeError) return t('core.connection.offline');
  if (err && typeof err === 'object' && err.message) return String(err.message);
  return String(err);
}
