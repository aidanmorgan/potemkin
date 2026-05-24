/**
 * REQ-84: Actor extraction from Authorization header
 */
import { extractActor } from '../../../src/identity/actorExtractor';

describe('identity/actorExtractor', () => {
  it('returns null for undefined header', () => {
    expect(extractActor(undefined)).toBeNull();
  });

  it('returns null for empty header', () => {
    expect(extractActor('')).toBeNull();
  });

  it('returns null for non-Bearer header', () => {
    expect(extractActor('Basic dXNlcjpwYXNz')).toBeNull();
  });

  it('parses a simple actor with scopes', () => {
    const actor = extractActor('Bearer alice:admin,trader');
    expect(actor).toEqual({ id: 'alice', scopes: ['admin', 'trader'] });
  });

  it('parses an actor with a single scope', () => {
    const actor = extractActor('Bearer bob:viewer');
    expect(actor).toEqual({ id: 'bob', scopes: ['viewer'] });
  });

  it('parses an actor with no scopes (no colon)', () => {
    const actor = extractActor('Bearer alice');
    expect(actor).toEqual({ id: 'alice', scopes: [] });
  });

  it('trims whitespace from scopes', () => {
    const actor = extractActor('Bearer alice: admin , trader ');
    expect(actor?.scopes).toEqual(['admin', 'trader']);
  });

  it('filters empty scope segments', () => {
    const actor = extractActor('Bearer alice:admin,,trader');
    expect(actor?.scopes).toEqual(['admin', 'trader']);
  });

  it('returns null for Bearer with empty token', () => {
    expect(extractActor('Bearer ')).toBeNull();
  });
});
