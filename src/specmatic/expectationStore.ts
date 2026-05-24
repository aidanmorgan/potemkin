/**
 * In-memory expectation store — LIFO registry of dynamic and file-sourced stubs.
 *
 * Insertion order is reversed on match so the most recently added expectation
 * wins (Specmatic's documented LIFO behaviour). The store is purely volatile
 * (consistent with req 40: volatile-state design).
 */

import type { JsonValue } from '../types.js';
import type {
  Expectation,
  ExpectationRequest,
  ExpectationResponse,
  ExpectationStore,
  MatchResult,
} from './types.js';
import { nextUuidv7 } from '../ids/uuidv7.js';
import {
  matchMethod,
  matchPath,
  matchHeaders,
  matchQueryParams,
  matchBody,
} from './matcher.js';

/**
 * Create a new in-memory expectation store.
 *
 * Thread-safety: JavaScript is single-threaded; no locking is required.
 * Concurrent async code sharing the same store sees consistent state due to
 * the synchronous nature of Map operations.
 */
export function createExpectationStore(): ExpectationStore {
  // Insertion-order Map: newest entries will be last.
  // We reverse the values array during match to achieve LIFO priority.
  const store = new Map<string, Expectation>();

  function add(
    req: ExpectationRequest,
    res: ExpectationResponse,
    options?: { transient?: boolean; source?: 'dynamic' | 'file'; filePath?: string },
  ): Expectation {
    const expectation: Expectation = {
      id: nextUuidv7(),
      request: req,
      response: res,
      createdAt: new Date().toISOString(),
      source: options?.source ?? 'dynamic',
      filePath: options?.filePath,
      transient: options?.transient ?? false,
    };
    store.set(expectation.id, expectation);
    return expectation;
  }

  function remove(id: string): boolean {
    return store.delete(id);
  }

  function clear(): void {
    store.clear();
  }

  function list(): readonly Expectation[] {
    return Array.from(store.values());
  }

  function size(): number {
    return store.size;
  }

  function match(req: {
    method: string;
    path: string;
    headers: Record<string, string>;
    query: Record<string, string | string[]>;
    body: JsonValue;
  }): MatchResult {
    // Reverse for LIFO: newest (last in Map) is tried first
    const candidates = Array.from(store.values()).reverse();
    const reasons: string[] = [];

    for (const candidate of candidates) {
      const r = candidate.request;
      const rejections: string[] = [];

      if (!matchMethod(r.method, req.method)) {
        rejections.push(`method mismatch: expected ${r.method}, got ${req.method}`);
      }
      if (!matchPath(r.path, req.path)) {
        rejections.push(`path mismatch: expected ${r.path}, got ${req.path}`);
      }
      if (!matchHeaders(r.headers, req.headers)) {
        rejections.push(`headers mismatch: matcher requires ${JSON.stringify(r.headers)}`);
      }
      if (!matchQueryParams(r.queryParameters, req.query)) {
        rejections.push(`query mismatch: matcher requires ${JSON.stringify(r.queryParameters)}`);
      }
      if (!matchBody(r.body, req.body)) {
        rejections.push(`body mismatch: expected ${JSON.stringify(r.body)}`);
      }

      if (rejections.length === 0) {
        return { matched: true, expectation: candidate, reasons: [] };
      }

      reasons.push(`[${candidate.id}] ${rejections.join('; ')}`);
    }

    return { matched: false, reasons };
  }

  return { add, remove, clear, list, match, size };
}
