/**
 * Helper utilities for building Specmatic-format JSON request/response pairs.
 *
 * Specmatic wire format uses hyphenated top-level keys:
 *   { "http-request": {...}, "http-response": {...} }
 *
 * This module provides typed builders and a supertest sugar helper.
 */

import type { Test } from 'supertest';
import type supertest from 'supertest';

/** The type returned by `request(app)` — the default export of the supertest module. */
type RequestFn = typeof supertest;

export interface SpecmaticExpectationBody {
  'http-request': {
    method: string;
    path: string;
    headers?: Record<string, string>;
    query?: Record<string, string | string[]>;
    body?: unknown;
  };
  'http-response': {
    status: number;
    headers?: Record<string, string>;
    body?: unknown;
  };
}

/**
 * Build a Specmatic-format expectation body from request + response halves.
 */
export function expectation(
  req: SpecmaticExpectationBody['http-request'],
  res: SpecmaticExpectationBody['http-response'],
): SpecmaticExpectationBody {
  return {
    'http-request': req,
    'http-response': res,
  };
}

/**
 * Sugar: POST an expectation to /_specmatic/expectations.
 * Returns the supertest Test promise (caller should await/chain).
 */
export function postExpectation(
  agent: ReturnType<RequestFn>,
  body: SpecmaticExpectationBody,
): Test {
  return agent
    .post('/_specmatic/expectations')
    .set('Content-Type', 'application/json')
    .send(body);
}

/**
 * Sugar: POST a transient stub to /_specmatic/http-stub.
 */
export function postTransientStub(
  agent: ReturnType<RequestFn>,
  body: SpecmaticExpectationBody,
): Test {
  return agent
    .post('/_specmatic/http-stub')
    .set('Content-Type', 'application/json')
    .send(body);
}
