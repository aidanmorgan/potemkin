/** Source-neutral request-control contracts shared by authoring and HTTP adapters. */

export type ErrorClass =
  | 'timeout'
  | 'throttle'
  | 'outage'
  | 'bad_gateway'
  | 'conflict'
  | 'auth'
  | 'forbidden';

/** Complete transport-neutral request controls used by direct and HTTP callers. */
export interface RequestControls {
  readonly dryRun?: boolean;
  readonly includeEvents?: boolean;
  readonly echo?: boolean;
  readonly seed?: string;
  readonly clockOffsetMs?: number;
  readonly skipSagas?: boolean;
  readonly skipWebhooks?: boolean;
  readonly skipReactions?: boolean;
  readonly skipProjections?: boolean;
  readonly skipDispatch?: boolean;
  readonly bulkTransactional?: boolean;
  readonly maxCascadeDepth?: number;
  readonly causedBy?: string;
  readonly readAtVersion?: number;
  readonly replayEvent?: string;
  readonly responseFormat?: ResponseFormat;
  readonly paginationStyle?: PaginationStyle;
  readonly maskFields?: readonly string[];
  readonly skipRequestValidation?: boolean;
  readonly skipResponseValidation?: boolean;
  readonly allowAdditionalProperties?: boolean;
  readonly traceId?: string;
  readonly spanName?: string;
  readonly logLevel?: LogLevel;
  readonly metricTag?: Readonly<{ key: string; value: string }>;
  readonly useFault?: string;
  readonly featureFlag?: string;
  readonly rateLimit?: boolean;
  readonly signal?: string;
  readonly forceResponse?: string;
  readonly scenario?: string;
  readonly forceStatus?: number;
  readonly errorClass?: ErrorClass;
  readonly forceLatencyMs?: number;
  readonly jitterMs?: Readonly<{ min: number; max: number }>;
  readonly dropConnectionMs?: number;
  readonly successRate?: number;
  readonly retryAfterSeconds?: number;
  readonly bodyTruncateBytes?: number;
}

export interface TransparencyControls {
  readonly dryRun?: boolean;
  readonly includeEvents?: boolean;
  readonly echo?: boolean;
  readonly seed?: string;
  readonly clockOffsetMs?: number;
}

export interface SideEffectControls {
  readonly skipSagas?: boolean;
  readonly skipWebhooks?: boolean;
  readonly skipProjections?: boolean;
  readonly skipReactions?: boolean;
  readonly skipDispatch?: boolean;
  readonly maxCascadeDepth?: number;
  readonly bulkTransactional?: boolean;
}

export interface IdentityControls {
  readonly actorOverride?: string;
  readonly causedBy?: string;
  readonly impersonate?: string;
}

export interface TimeTravelControls {
  readonly readAtVersion?: number;
  readonly replayEvent?: string;
}

export type ResponseFormat = 'hal' | 'jsonapi' | 'plain';
export type PaginationStyle = 'envelope' | 'raw' | 'link-header';

export interface FormatControls {
  readonly responseFormat?: ResponseFormat;
  readonly paginationStyle?: PaginationStyle;
  readonly maskFields?: readonly string[];
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ObservabilityControls {
  readonly traceId?: string;
  readonly spanName?: string;
  readonly logLevel?: LogLevel;
  readonly metricTag?: { readonly key: string; readonly value: string };
}

export interface ValidationControls {
  readonly skipRequestValidation?: boolean;
  readonly skipResponseValidation?: boolean;
  readonly allowAdditionalProperties?: boolean;
}

export interface ControlHeaders {
  readonly transparency: TransparencyControls;
  readonly sideEffects: SideEffectControls;
  readonly identity: IdentityControls;
  readonly timeTravel: TimeTravelControls;
  readonly format: FormatControls;
  readonly observability: ObservabilityControls;
  readonly validation: ValidationControls;
}

export type PartialControlHeaders = {
  readonly transparency?: TransparencyControls;
  readonly sideEffects?: SideEffectControls;
  readonly identity?: IdentityControls;
  readonly timeTravel?: TimeTravelControls;
  readonly format?: FormatControls;
  readonly observability?: ObservabilityControls;
  readonly validation?: ValidationControls;
};
