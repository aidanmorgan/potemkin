import type { Intent, JsonObject } from '../types.js';

export interface EventCatalogEntry {
  readonly type: string;                              // event type key
  readonly payloadTemplate: Record<string, string>;   // map fieldName → CEL expression
  /** REQ-65: optional OpenAPI $ref path for runtime payload schema validation */
  readonly schemaRef?: string;
}

/** REQ-61: named guard evaluated before match.condition; failure → 422 */
export interface RequiresGuard {
  readonly name: string;
  readonly condition: string;     // CEL boolean (was "expression" in design.md — using "condition" per task spec)
  readonly errorCode: string;
  readonly errorMessage: string;
}

/** REQ-64: conditional event emission entry */
export interface EmitWhenEntry {
  readonly when: string;   // CEL boolean
  readonly emit: string;   // event catalog key
}

export interface BehaviorRule {
  readonly name: string;
  readonly match: {
    readonly intent: Intent;
    readonly condition: string;
    /** REQ-61 */
    readonly requires?: readonly RequiresGuard[];
  };
  /** Primary event to emit (optional when emitWhen is present). REQ-64 mutual exclusion with emitWhen. */
  readonly emit?: string;
  /** REQ-64: conditional multi-event emission */
  readonly emitWhen?: readonly EmitWhenEntry[];
  readonly dispatchCommands?: readonly SecondaryCommandSpec[];
  /** REQ-62: CEL expression evaluated post-projection; false → abort UoW */
  readonly postcondition?: string;
}

export interface SecondaryCommandSpec {
  readonly boundary: string;
  readonly intent: Intent;
  readonly targetId: string;                          // CEL expression resolving to a string
  readonly payload?: Record<string, string>;          // CEL expressions
  /** REQ-63: optional gate — false means skip this secondary command */
  readonly condition?: string;
}

export interface ReducerRule {
  readonly on: string;                                // event catalog key
  readonly assign?: Record<string, string>;           // dot-path → CEL expression
  readonly append?: Record<string, string>;           // array path → CEL expression
}

export interface IdentityConfig {
  readonly creation?: { readonly generate?: string }; // e.g. '$uuidv7()'
}

/** REQ-66: named TypeScript module declared in a boundary config */
export interface ScriptDeclaration {
  readonly name: string;
  readonly code: string;   // TypeScript source (field is "code" in YAML; design uses "source" but task says "code")
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
  /** REQ-66: optional inline TypeScript scripts */
  readonly scripts?: readonly ScriptDeclaration[];
}

export interface CompiledDsl {
  readonly boundaries: readonly BoundaryConfig[];
  readonly byContractPath: Record<string, BoundaryConfig>;
  readonly byBoundaryName: Record<string, BoundaryConfig>;
  /** REQ-68: script registry built at boot time, attached to CompiledDsl */
  readonly scriptRegistry?: import('../scripts/types.js').ScriptRegistry;
}
