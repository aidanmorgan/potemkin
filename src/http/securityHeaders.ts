/**
 * Security response-header injection driven by the global `security_headers:`
 * block. Produces a flat map of header name → value to set on every response.
 *
 * Enabled by default when the block is present; set `enabled: false` to disable
 * without removing the block. Standard toggles (hsts/nosniff/frame_deny/
 * referrer_policy) map to their canonical headers; `custom_headers` are emitted
 * verbatim.
 */

import type { SecurityHeadersConfig } from '../dsl/types.js';

/** Default value for `Strict-Transport-Security` when `hsts` is enabled. */
const HSTS_VALUE = 'max-age=31536000; includeSubDomains';

export function buildSecurityHeaders(
  config: SecurityHeadersConfig | undefined,
): Record<string, string> {
  if (!config) return {};
  if (config.enabled === false) return {};

  const headers: Record<string, string> = {};
  if (config.hsts) headers['Strict-Transport-Security'] = HSTS_VALUE;
  if (config.nosniff) headers['X-Content-Type-Options'] = 'nosniff';
  if (config.frame_deny) headers['X-Frame-Options'] = 'DENY';
  if (config.referrer_policy) headers['Referrer-Policy'] = config.referrer_policy;
  if (config.custom_headers) {
    for (const [name, value] of Object.entries(config.custom_headers)) {
      headers[name] = value;
    }
  }
  return headers;
}
