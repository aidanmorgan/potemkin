/**
 * Specmatic compatibility surface — barrel exports.
 */

export type {
  ExpectationRequest,
  ExpectationResponse,
  Expectation,
  MatchResult,
  ExpectationStore,
} from './types.js';

export { createExpectationStore } from './expectationStore.js';

export {
  matchMethod,
  matchPath,
  matchHeaders,
  matchQueryParams,
  matchBody,
  deepEqual,
} from './matcher.js';

export { loadExpectationsFromDirectory } from './loader.js';

export { loadSpecmaticConfig } from './config.js';
export type { SpecmaticConfig } from './config.js';
