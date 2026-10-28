/**
 * Transmission RPC client.
 *
 * Speaks two wire dialects behind one surface:
 *  - "legacy": `{method, arguments, tag}` with kebab/camel keys (RPC 15 to 17,
 *    Transmission 2.94 to 4.0.x)
 *  - "jsonrpc": JSON-RPC 2.0 with snake_case method and keys (Transmission
 *    4.1.0+, announced by the `X-Transmission-Rpc-Version` header on the 409)
 *
 * Callers always write method names and argument keys in the legacy spelling
 * documented by upstream (`torrent-get`, `download-dir`, `percentDone`); the
 * client converts them for JSON-RPC. Every response is normalised to camelCase
 * before it is returned, so the rest of the app sees exactly one shape no
 * matter which daemon answered.
 */

export const DIALECT = Object.freeze({
  LEGACY: "legacy",
  JSONRPC: "jsonrpc",
});

export const SESSION_HEADER = "X-Transmission-Session-Id";
export const RPC_VERSION_HEADER = "X-Transmission-Rpc-Version";

const DEFAULT_TIMEOUT_MS = 30_000;
const RECENTLY_ACTIVE_LEGACY = "recently-active";
const RECENTLY_ACTIVE_SNAKE = "recently_active";

/** Snake-case keys whose canonical camelCase form is not a plain capitalisation. */
const CAMEL_OVERRIDES = Object.freeze({
  is_utp: "isUTP",
  "is-utp": "isUTP",
});

export class RpcError extends Error {
  /**
   * @param {number} status HTTP status, 0 when no response arrived (network,
   *   timeout, abort)
   * @param {string} message
   * @param {{ code?: number, method?: string }} [extra]
   */
  constructor(status, message, extra = {}) {
    super(message);
    this.name = "RpcError";
    this.status = status;
    if (extra.code !== undefined) this.code = extra.code;
    if (extra.method !== undefined) this.method = extra.method;
  }

  toJSON() {
    return { status: this.status, message: this.message };
  }
}

/** `trackerStats` / `download-dir` / `peer-limit` -> `tracker_stats` / `download_dir` / `peer_limit`. */
export function toSnakeKey(key) {
  return String(key)
    .replace(/-/g, "_")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

/** `tracker_stats` / `download-dir` / `peer_limit` -> `trackerStats` / `downloadDir` / `peerLimit`. */
export function toCamelKey(key) {
  const raw = String(key);
  const override = CAMEL_OVERRIDES[raw];
  if (override) return override;
  if (!/[-_]/.test(raw)) return raw;
  return raw.replace(/[-_]+([a-zA-Z0-9])/g, (_, c) => c.toUpperCase());
}

/**
 * Deep-convert every object key with `convert`. Arrays are walked; primitives
 * are returned as-is. Used for both wire directions.
 */
export function mapKeys(value, convert) {
  if (Array.isArray(value)) return value.map((item) => mapKeys(item, convert));
  if (value === null || typeof value !== "object") return value;
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    out[convert(key)] = mapKeys(inner, convert);
  }
  return out;
}

/**
 * Convert a legacy-spelled request into the JSON-RPC wire shape: snake_case
 * keys, snake_case entries in `fields`, and the `recently_active` sentinel.
 */
export function toJsonRpcParams(args) {
  const params = mapKeys(args ?? {}, toSnakeKey);
  if (Array.isArray(params.fields)) {
    params.fields = params.fields.map(toSnakeKey);
  }
  if (params.ids === RECENTLY_ACTIVE_LEGACY) {
    params.ids = RECENTLY_ACTIVE_SNAKE;
  }
  return params;
}

/** Normalise a response payload (either dialect) into the one camelCase shape. */
export function normalizeResult(payload) {
  return mapKeys(payload ?? {}, toCamelKey);
}

function isTimeoutError(err) {
  return err && (err.name === "TimeoutError" || err.name === "AbortError");
}

/**
 * @typedef {object} ClientOptions
 * @property {string} [url] RPC endpoint, default `../rpc` (same-origin, behind
 *   the nginx `location /transmission/`)
 * @property {(input: string, init: RequestInit) => Promise<Response>} [transport]
 *   fetch-compatible function; tests inject a fake, the browser default wraps
 *   the global `fetch` in an arrow so it keeps its receiver
 * @property {number} [timeout] per-request timeout in ms
 * @property {string|null} [authorization] explicit `Authorization` header for
 *   non-proxied installs; omitted by default so the browser's cached Basic
 *   credential is reused through `credentials: "same-origin"`
 * @property {"legacy"|"jsonrpc"|null} [dialect] force a dialect instead of
 *   deriving it from the 409 handshake
 */

export class RpcClient {
  #url;
  #transport;
  #timeout;
  #authorization;
  #sessionId = null;
  #dialect;
  #dialectForced;
  #rpcVersionHeader = null;
  #handshake = null;
  #seq = 0;

  /** @param {ClientOptions} [options] */
  constructor(options = {}) {
    this.#url = options.url ?? "../rpc";
    this.#transport = options.transport ?? ((...a) => fetch(...a));
    this.#timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    this.#authorization = options.authorization ?? null;
    this.#dialectForced = options.dialect === DIALECT.LEGACY || options.dialect === DIALECT.JSONRPC;
    this.#dialect = this.#dialectForced ? options.dialect : DIALECT.LEGACY;
  }

  get url() {
    return this.#url;
  }

  /** `"legacy"` until the 409 handshake says otherwise (or the option forces it). */
  get dialect() {
    return this.#dialect;
  }

  /** Raw `X-Transmission-Rpc-Version` header from the 409, `null` when absent. */
  get rpcVersionHeader() {
    return this.#rpcVersionHeader;
  }

  get sessionId() {
    return this.#sessionId;
  }

  get hasSession() {
    return this.#sessionId !== null;
  }

  /**
   * Obtain a session id. Concurrent callers share the one in-flight request;
   * the daemon answers 409 with the id (and, on 4.1+, the RPC version header).
   */
  handshake() {
    if (!this.#handshake) {
      this.#handshake = this.#performHandshake().finally(() => {
        this.#handshake = null;
      });
    }
    return this.#handshake;
  }

  async #performHandshake() {
    const response = await this.#post("{}");
    if (response.status === 409) {
      this.#adoptSession(response);
      if (!this.#sessionId) {
        throw new RpcError(409, "Transmission answered 409 without a session id");
      }
      return this.#sessionId;
    }
    if (!response.ok) {
      throw new RpcError(response.status, `Transmission RPC handshake failed (HTTP ${response.status})`);
    }
    // A proxy that injects the session id itself: nothing to adopt.
    return this.#sessionId;
  }

  #adoptSession(response) {
    const id = response.headers.get(SESSION_HEADER);
    if (id) this.#sessionId = id;
    const version = response.headers.get(RPC_VERSION_HEADER);
    if (version !== null && version !== "") this.#rpcVersionHeader = version;
    if (!this.#dialectForced) {
      this.#dialect = this.#rpcVersionHeader ? DIALECT.JSONRPC : DIALECT.LEGACY;
    }
  }

  /**
   * Call an RPC method. `method` and `args` use the legacy spelling; the
   * result is the normalised camelCase `arguments`/`result` object.
   *
   * @param {string} method e.g. `"torrent-get"`
   * @param {object} [args]
   * @returns {Promise<object>}
   */
  async call(method, args = {}) {
    if (!this.hasSession) await this.handshake();
    const id = ++this.#seq;
    let response = await this.#post(this.#encode(method, args, id));
    if (response.status === 409) {
      this.#adoptSession(response);
      if (!this.#sessionId) {
        throw new RpcError(409, "Transmission answered 409 without a session id", { method });
      }
      response = await this.#post(this.#encode(method, args, id));
      if (response.status === 409) {
        throw new RpcError(409, "Transmission rejected the session id twice", { method });
      }
    }
    if (!response.ok) {
      throw new RpcError(response.status, `Transmission RPC ${method} failed (HTTP ${response.status})`, { method });
    }
    let body;
    try {
      body = await response.json();
    } catch {
      throw new RpcError(response.status, `Transmission RPC ${method} returned a non-JSON body`, { method });
    }
    return this.#decode(method, body);
  }

  #encode(method, args, id) {
    if (this.#dialect === DIALECT.JSONRPC) {
      return JSON.stringify({
        jsonrpc: "2.0",
        method: method.replace(/-/g, "_"),
        params: toJsonRpcParams(args),
        id,
      });
    }
    return JSON.stringify({ method, arguments: args ?? {}, tag: id });
  }

  #decode(method, body) {
    if (this.#dialect === DIALECT.JSONRPC) {
      if (body && body.error) {
        const code = Number.parseInt(body.error.code, 10);
        throw new RpcError(200, String(body.error.message ?? "JSON-RPC error"), {
          method,
          code: Number.isInteger(code) ? code : undefined,
        });
      }
      return normalizeResult(body ? body.result : {});
    }
    if (!body || body.result !== "success") {
      const message = body && typeof body.result === "string" ? body.result : "unknown RPC failure";
      throw new RpcError(200, message, { method });
    }
    return normalizeResult(body.arguments);
  }

  async #post(payload) {
    const headers = { "Content-Type": "application/json" };
    if (this.#sessionId) headers[SESSION_HEADER] = this.#sessionId;
    if (this.#authorization) headers.Authorization = this.#authorization;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeout);
    try {
      return await this.#transport(this.#url, {
        method: "POST",
        credentials: "same-origin",
        headers,
        body: payload,
        signal: controller.signal,
      });
    } catch (err) {
      if (isTimeoutError(err)) {
        throw new RpcError(0, `Transmission RPC request timed out after ${this.#timeout} ms`);
      }
      throw new RpcError(0, err && err.message ? err.message : "Transmission RPC request failed");
    } finally {
      clearTimeout(timer);
    }
  }
}

/** @param {ClientOptions} [options] */
export function createClient(options) {
  return new RpcClient(options);
}
