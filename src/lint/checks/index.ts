/**
 * Registry of strict boot-time lint checks. Checks are added here as they land
 * (referential integrity, CEL references, required-field coverage, identity/state
 * completeness, coverage warnings). The boot runner executes every check in this
 * list against the fully-composed model.
 */
import type { LintCheck } from '../types.js';
import { coverageCheck } from './coverage.js';
import { identityCheck } from './identity.js';
import { referencesCheck } from './references.js';
import { requiredFieldsCheck } from './requiredFields.js';

export const ALL_CHECKS: readonly LintCheck[] = [
  identityCheck,
  referencesCheck,
  requiredFieldsCheck,
  coverageCheck,
];
