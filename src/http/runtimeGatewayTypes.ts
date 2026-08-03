import type { AllowedOrigins } from "./cors.js";
import type { RuntimeFault } from "../model/runtime.js";

/** Optional infrastructure supplied by the application composition root. */
export interface RuntimeGatewayExtensions {
  /** Transport metadata and security values are supplied by the host. */
  readonly version?: string;
  readonly routesTtlSeconds?: number;
  readonly adminToken?: string;
  readonly allowedOrigins?: AllowedOrigins;
  readonly parseFaultRegistration?: (value: unknown) => {
    readonly rule: RuntimeFault;
    readonly ttlMs?: number;
  };
  /** Reload the active configuration-backed source graph. */
  readonly reloadConfiguration?: () => Promise<unknown>;
}
