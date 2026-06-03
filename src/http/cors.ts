/**
 * Shared CORS origin-admission helpers used by both the HTTP gateway and the
 * forwarding response pipeline. Single source of truth — each call site
 * previously carried its own copy with identical logic.
 */

/**
 * Resolve the CORS allowed-origin value for a request.
 *  - ALLOWED_ORIGINS env var: comma-separated list of allowed origins.
 *  - Default: '*' (allow all origins — appropriate for a local simulation server).
 * When the list is restricted, the request Origin is reflected when it is in
 * the list; otherwise the first entry is returned as a fallback.
 */
export function getAllowedOrigin(requestOrigin: string | undefined): string {
  const raw = process.env['ALLOWED_ORIGINS'] ?? '*';
  if (raw === '*') return '*';
  const allowed = raw.split(',').map((s) => s.trim());
  if (requestOrigin && allowed.includes(requestOrigin)) return requestOrigin;
  return allowed[0] ?? '*';
}

/**
 * Returns true when the given requestOrigin is admitted by the ALLOWED_ORIGINS
 * allowlist for purposes of credentialed-request reflection.
 *
 * Two cases are admitted:
 *  - ALLOWED_ORIGINS is '*' (the sim default): any specific origin is allowed.
 *    Browsers reject `Access-Control-Allow-Origin: *` with credentials, so we
 *    must reflect the specific origin in this case.
 *  - ALLOWED_ORIGINS is a restricted list and requestOrigin is in it.
 *
 * When requestOrigin is undefined, there is no origin to reflect regardless.
 */
export function isOriginAdmitted(requestOrigin: string | undefined): boolean {
  if (!requestOrigin) return false;
  const raw = process.env['ALLOWED_ORIGINS'] ?? '*';
  if (raw === '*') return true;
  const allowed = raw.split(',').map((s) => s.trim());
  return allowed.includes(requestOrigin);
}
