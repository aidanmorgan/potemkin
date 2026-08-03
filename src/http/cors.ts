/**
 * Shared CORS origin-admission helpers used by both the HTTP gateway and the
 * forwarding response pipeline. Single source of truth — each call site
 * previously carried its own copy with identical logic.
 */

export type AllowedOrigins = "*" | readonly string[];

/**
 * Resolve the CORS allowed-origin value for a request.
 * When the list is restricted, the request Origin is reflected when it is in
 * the list; otherwise the first entry is returned as a fallback.
 */
export function getAllowedOrigin(
  requestOrigin: string | undefined,
  allowedOrigins: AllowedOrigins = "*",
): string {
  if (allowedOrigins === "*") return "*";
  const allowed = allowedOrigins;
  if (requestOrigin && allowed.includes(requestOrigin)) return requestOrigin;
  return allowed[0] ?? "*";
}

/**
 * Returns true when the given requestOrigin is admitted by the allowed-origin
 * list for purposes of credentialed-request reflection.
 *
 * Two cases are admitted:
 *  - '*' (the sim default): any specific origin is allowed.
 *    Browsers reject `Access-Control-Allow-Origin: *` with credentials, so we
 *    must reflect the specific origin in this case.
 *  - ALLOWED_ORIGINS is a restricted list and requestOrigin is in it.
 *
 * When requestOrigin is undefined, there is no origin to reflect regardless.
 */
export function isOriginAdmitted(
  requestOrigin: string | undefined,
  allowedOrigins: AllowedOrigins = "*",
): boolean {
  if (!requestOrigin) return false;
  return allowedOrigins === "*" || allowedOrigins.includes(requestOrigin);
}
