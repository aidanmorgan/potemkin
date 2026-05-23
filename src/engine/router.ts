import type { Intent } from '../types.js';
import type { BoundaryConfig } from '../dsl/types.js';
import { ContractViolationError } from '../errors.js';

export interface IntentTranslationInput {
  readonly method: string;
  readonly boundary: BoundaryConfig;
}

/**
 * Translate an HTTP method to an Intent given the boundary configuration.
 *
 * Rules (SMT-verified, design §4.1 step 2):
 *  - GET                          → `query`
 *  - POST + identity.creation set → `creation`
 *  - POST (no identity.creation)  → `mutation`
 *  - PUT / PATCH / DELETE         → `mutation`
 *  - Unknown method               → ContractViolationError (400)
 */
export function translateIntent(input: IntentTranslationInput): Intent {
  const upper = input.method.toUpperCase();

  switch (upper) {
    case 'GET':
      return 'query';

    case 'POST':
      return input.boundary.identity?.creation !== undefined ? 'creation' : 'mutation';

    case 'PUT':
    case 'PATCH':
    case 'DELETE':
      return 'mutation';

    default:
      throw new ContractViolationError(`Unsupported HTTP method ${input.method}`);
  }
}
