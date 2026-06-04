/**
 * identity.creation.generate is evaluated through the shared expression pipeline,
 * so a boundary can mint a custom, domain-shaped id with a CEL expression or a
 * registered ts: @Script extension — there is no `$uuidv7()`-only special case.
 */
import { resolveCreationTargetId } from '../../../src/engine/patternMatcher';
import { createCelEvaluator } from '../../../src/cel/evaluator';
import { createLogger } from '../../../src/observability/logger';

const cel = createCelEvaluator();
const logger = createLogger({ name: 'creation-id-test' });
const base = { boundary: 'Acct', cel, scriptRegistry: undefined, now: () => new Date(0).toISOString(), logger };

describe('resolveCreationTargetId — creation id is a generic expression', () => {
  it('evaluates a custom CEL expression into a domain-shaped id', () => {
    const id = resolveCreationTargetId({ ...base, generate: '"acct_" + $uuidv7().replace("-", "")', payload: {} });
    expect(id.startsWith('acct_')).toBe(true);
    expect(id).not.toContain('-');
  });

  it('still supports the plain $uuidv7() form (no special-casing)', () => {
    const id = resolveCreationTargetId({ ...base, generate: '$uuidv7()', payload: {} });
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
  });

  it('can read the request payload (e.g. an external id as the aggregate key)', () => {
    const id = resolveCreationTargetId({ ...base, generate: '"cus_" + payload.ref', payload: { ref: 'abc123' } });
    expect(id).toBe('cus_abc123');
  });

  it('throws when the expression does not produce a non-empty string', () => {
    expect(() => resolveCreationTargetId({ ...base, generate: '42', payload: {} })).toThrow(/non-empty string/);
  });
});
