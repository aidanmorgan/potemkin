import type { Intent, JsonObject } from '../types.js';

export interface EventCatalogEntry {
  readonly type: string;                              // event type key
  readonly payloadTemplate: Record<string, string>;   // map fieldName → CEL expression
}

export interface BehaviorRule {
  readonly name: string;
  readonly match: { readonly intent: Intent; readonly condition: string };
  readonly emit: string;                              // event catalog key
  readonly dispatchCommands?: readonly SecondaryCommandSpec[];
}

export interface SecondaryCommandSpec {
  readonly boundary: string;
  readonly intent: Intent;
  readonly targetId: string;                          // CEL expression resolving to a string
  readonly payload?: Record<string, string>;          // CEL expressions
}

export interface ReducerRule {
  readonly on: string;                                // event catalog key
  readonly assign?: Record<string, string>;           // dot-path → CEL expression
  readonly append?: Record<string, string>;           // array path → CEL expression
}

export interface IdentityConfig {
  readonly creation?: { readonly generate?: string }; // e.g. '$uuidv7()'
}

export interface BoundaryConfig {
  readonly boundary: string;                          // logical namespace
  readonly contractPath: string;                      // OpenAPI route
  readonly fallbackOverride: boolean;
  readonly identity?: IdentityConfig;
  readonly queryMapping?: Record<string, string>;
  readonly behaviors: readonly BehaviorRule[];
  readonly reducers: readonly ReducerRule[];
  readonly eventCatalog: readonly EventCatalogEntry[];
  readonly initialization?: readonly JsonObject[];
}

export interface CompiledDsl {
  readonly boundaries: readonly BoundaryConfig[];
  readonly byContractPath: Record<string, BoundaryConfig>;
  readonly byBoundaryName: Record<string, BoundaryConfig>;
}
