/**
 * Thin HTTP client for the consumer-side example tests.
 *
 * The test plays the role of a service integrating with the (simulated) API: it
 * makes contract calls through the Specmatic stub URL and can carry control
 * headers (X-Potemkin-*, Idempotency-Key) THROUGH the stub to force known states.
 * Supports both Stripe-style form-encoded requests and JSON.
 */

export interface ConsumerResponse {
  readonly status: number;
  readonly headers: Headers;
  /** Parsed JSON body when the response is JSON, else null. */
  readonly body: unknown;
  /** Raw response text. */
  readonly text: string;
}

export interface RequestOptions {
  /** application/x-www-form-urlencoded body (Stripe-style). */
  readonly form?: Record<string, unknown>;
  /** application/json body. */
  readonly json?: unknown;
  /** Query-string parameters. */
  readonly query?: Record<string, string | number | boolean | undefined>;
  /** Extra request headers — e.g. X-Potemkin-* / Idempotency-Key. */
  readonly headers?: Record<string, string>;
}

/** Encode a flat object as application/x-www-form-urlencoded, with one level of
 *  bracket notation for nested objects (e.g. Stripe `metadata[key]=value`). */
function encodeForm(form: Record<string, unknown>): string {
  const parts: string[] = [];
  const add = (k: string, v: unknown): void => {
    if (v === undefined || v === null) return;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  };
  for (const [key, value] of Object.entries(form)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [sub, subVal] of Object.entries(value as Record<string, unknown>)) {
        add(`${key}[${sub}]`, subVal);
      }
    } else {
      add(key, value);
    }
  }
  return parts.join('&');
}

function buildUrl(baseUrl: string, path: string, query?: RequestOptions['query']): string {
  const url = new URL(path, baseUrl);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export class ConsumerClient {
  constructor(private readonly baseUrl: string) {}

  async request(method: string, path: string, opts: RequestOptions = {}): Promise<ConsumerResponse> {
    const headers: Record<string, string> = { Accept: 'application/json', ...(opts.headers ?? {}) };
    let body: string | undefined;
    if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.json);
    } else if (opts.form !== undefined) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = encodeForm(opts.form);
    }

    const res = await fetch(buildUrl(this.baseUrl, path, opts.query), { method, headers, body });
    const text = await res.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try { parsed = JSON.parse(text); } catch { parsed = null; }
    }
    return { status: res.status, headers: res.headers, body: parsed, text };
  }

  get(path: string, opts?: RequestOptions): Promise<ConsumerResponse> {
    return this.request('GET', path, opts);
  }

  post(path: string, opts?: RequestOptions): Promise<ConsumerResponse> {
    return this.request('POST', path, opts);
  }

  delete(path: string, opts?: RequestOptions): Promise<ConsumerResponse> {
    return this.request('DELETE', path, opts);
  }
}
