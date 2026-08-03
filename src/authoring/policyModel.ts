import type { MatchContext, PostCommitContext, RuntimeRequest } from "../model/runtime.js";
import type { Actor, JsonValue } from "../types.js";

/** Authentication policy authored directly by a TypeScript configuration. */
export interface AuthDefinition {
  readonly mode?: "simple" | "jwt" | "session";
  readonly authenticate?: (input: Readonly<RuntimeRequest>) => Readonly<Actor> | undefined;
  readonly authorize?: (input: Readonly<MatchContext>, scopes: readonly string[]) => boolean;
  readonly jwt?: Readonly<{
    readonly secret: string;
    readonly algorithm?: "HS256";
    readonly issuer?: string;
    readonly audience?: string;
    readonly requiredClaims?: Readonly<Record<string, string>>;
    readonly subjectClaim?: string;
    readonly scopesClaim?: string;
  }>;
  readonly session?: Readonly<{
    readonly cookieName?: string;
    readonly ttlSeconds?: number;
    readonly csrf?: boolean;
    readonly csrfHeader?: string;
    readonly loginPath?: string;
    readonly logoutPath?: string;
  }>;
}

export interface IdempotencyDefinition {
  readonly enabled: boolean;
  readonly ttlSeconds: number;
  readonly hashIncludesBody: boolean;
}

export interface SecurityHeadersDefinition {
  readonly enabled?: boolean;
  readonly hsts?: boolean;
  readonly includeSubDomains?: boolean;
  readonly nosniff?: boolean;
  readonly frameDeny?: boolean;
  readonly referrerPolicy?: string;
  readonly customHeaders?: Readonly<Record<string, string>>;
}

export interface HateoasDefinition {
  readonly enabled?: boolean;
  readonly baseUrl?: string;
  readonly selfLinks?: boolean;
}

export interface VersionDefinition {
  readonly version: string;
  readonly prefix: string;
  readonly default?: boolean;
}

export interface VersioningDefinition {
  readonly enabled?: boolean;
  readonly versions?: readonly Readonly<VersionDefinition>[];
}

export interface FallbackRuleDefinition {
  readonly match: Readonly<{
    readonly path?: string;
    /** Transport method matcher; unlike an operation reference it is not an identifier. */
    readonly method?: string;
    readonly inContract?: boolean;
  }>;
  readonly respond: Readonly<{
    readonly status: number;
    readonly body?: JsonValue;
    readonly headers?: Readonly<Record<string, string>>;
  }>;
}

export interface FallbackDefinition {
  readonly rules?: readonly FallbackRuleDefinition[];
  readonly default?: Readonly<{
    readonly status: number;
    readonly body?: JsonValue;
    readonly headers?: Readonly<Record<string, string>>;
  }>;
}

export interface ControlDefaultsDefinition {
  readonly transparency?: Readonly<{
    readonly dryRun?: boolean;
    readonly includeEvents?: boolean;
    readonly echo?: boolean;
    readonly seed?: string;
    readonly clockOffsetMs?: number;
  }>;
  readonly sideEffects?: Readonly<{
    readonly skipSagas?: boolean;
    readonly skipWebhooks?: boolean;
    readonly skipReactions?: boolean;
    readonly skipProjections?: boolean;
    readonly skipDispatch?: boolean;
    readonly maxCascadeDepth?: number;
    readonly bulkTransactional?: boolean;
  }>;
  readonly identity?: Readonly<{ readonly causedBy?: string }>;
  readonly timeTravel?: Readonly<{
    readonly readAtVersion?: number;
    readonly replayEvent?: string;
  }>;
  readonly format?: Readonly<{
    readonly responseFormat?: "hal" | "jsonapi" | "plain";
    readonly paginationStyle?: "envelope" | "raw" | "link-header";
    readonly maskFields?: readonly string[];
  }>;
  readonly observability?: Readonly<{
    readonly traceId?: string;
    readonly spanName?: string;
    readonly logLevel?: "debug" | "info" | "warn" | "error";
    readonly metricTag?: Readonly<{ readonly key: string; readonly value: string }>;
  }>;
  readonly validation?: Readonly<{
    readonly skipRequestValidation?: boolean;
    readonly skipResponseValidation?: boolean;
    readonly allowAdditionalProperties?: boolean;
  }>;
  readonly chaos?: Readonly<{
    readonly featureFlag?: string;
    readonly useFault?: string;
    readonly rateLimit?: boolean;
    readonly signal?: string;
    readonly forceResponse?: string;
    readonly scenario?: string;
    readonly forceStatus?: number;
    readonly errorClass?:
      | "timeout"
      | "throttle"
      | "outage"
      | "bad_gateway"
      | "conflict"
      | "auth"
      | "forbidden";
    readonly forceLatencyMs?: number;
    readonly jitterMs?: Readonly<{ readonly min: number; readonly max: number }>;
    readonly dropConnectionMs?: number;
    readonly successRate?: number;
    readonly retryAfterSeconds?: number;
    readonly bodyTruncateBytes?: number;
  }>;
}

export interface LifecycleDefinition {
  readonly boot?: () => void | Promise<void>;
  readonly validation?: () => void | Promise<void>;
  readonly initialization?: () => void | Promise<void>;
  readonly request?: (input: Readonly<MatchContext>) => void | Promise<void>;
  readonly projection?: (input: Readonly<PostCommitContext>) => void | Promise<void>;
  readonly commit?: (input: Readonly<PostCommitContext>) => void | Promise<void>;
  readonly postCommit?: (input: Readonly<PostCommitContext>) => void | Promise<void>;
  readonly reset?: () => void | Promise<void>;
  readonly shutdown?: () => void | Promise<void>;
}

export interface CoverageDefinition {
  readonly strict?: boolean;
  readonly initialStates?: readonly string[];
  readonly terminalStates?: readonly string[];
  readonly operations?: readonly string[];
  readonly suppressStates?: readonly string[];
}
