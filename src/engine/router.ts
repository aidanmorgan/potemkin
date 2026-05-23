import type { Intent } from '../types.js';
import type { BoundaryConfig } from '../dsl/types.js';

export interface IntentTranslationInput {
  method: string;
  boundary: BoundaryConfig;
}

/**
 * Translate an HTTP method to an Intent given the boundary configuration.
 *
 * Rules (SMT-verified):
 *  - GET                          → `query`
 *  - POST + identity.creation set → `creation`
 *  - POST (no identity.creation)  → `mutation`
 *  - PUT / PATCH / DELETE         → `mutation`
 */
export function translateIntent(input: IntentTranslationInput): Intent {
  throw new Error('NotImplemented: engine/router.translateIntent');
}
