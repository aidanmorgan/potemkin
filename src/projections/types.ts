/**
 * Derived Projection types — REQ-88 through REQ-90
 */

import type { JsonObject } from '../types.js';

/**
 * Runtime state map for a single derived projection.
 * Key = derived entity key (e.g. customerId); Value = accumulated state.
 */
export type DerivedStateMap = Map<string, JsonObject>;

/**
 * Registry of all derived projections' state maps, keyed by projection name.
 */
export type DerivedProjectionRegistry = Map<string, DerivedStateMap>;
