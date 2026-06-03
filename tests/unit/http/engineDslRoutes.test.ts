/**
 * Tests for global-config preservation in src/http/engineDslRoutes.ts.
 *
 * Problem: POST /_engine/dsl (boundary-only push) replaces sys.dsl with a
 * freshly compiled CompiledDsl that has NO globalYaml, so sagas / auth /
 * webhooks / faults / hateoas / versioning / securityHeaders / idempotency /
 * derivedProjections loaded from potemkin.yaml are silently erased.
 *
 * Fix: mergeGlobalConfig carries the existing global fields forward when the
 * push did not supply them.
 */

import { mergeGlobalConfig } from '../../../src/http/engineDslRoutes.js';
import type { CompiledDsl, SagaConfig, AuthConfig, WebhookConfig, FaultRule, ReactionRule, ReactionsByTrigger } from '../../../src/dsl/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function boundary(name: string, contractPath: string): CompiledDsl['boundaries'][number] {
  return {
    boundary: name,
    contractPath,
    fallbackOverride: false,
    behaviors: [],
    reducers: [],
    eventCatalog: [],
  };
}

function compiledDslFrom(boundaries: CompiledDsl['boundaries'][number][]): CompiledDsl {
  const byContractPath: Record<string, CompiledDsl['boundaries'][number]> = {};
  const byBoundaryName: Record<string, CompiledDsl['boundaries'][number]> = {};
  for (const b of boundaries) {
    byContractPath[b.contractPath] = b;
    byBoundaryName[b.boundary] = b;
  }
  return { boundaries, byContractPath, byBoundaryName };
}

const SAGA: SagaConfig = {
  name: 'test-saga',
  trigger: { boundary: 'Lead', intent: 'creation', condition: 'true' },
  steps: [],
};

const AUTH: AuthConfig = {
  mode: 'jwt',
  jwt: { secret: 'super-secret', algorithm: 'HS256' },
};

const WEBHOOK: WebhookConfig = {
  name: 'test-webhook',
  trigger: { boundary: 'Lead', intent: 'creation', condition: 'true' },
  url: 'https://example.com/hook',
};

const FAULT: FaultRule = {
  name: 'test-fault',
  match: { condition: 'true' },
  response: { status: 503 },
};

const REACTION: ReactionRule = {
  name: 'test-reaction',
  on: 'Lead:LeadCreated',
  boundary: 'Campaign',
  emit: 'CampaignTriggered',
  intent: 'creation',
};

const REACTIONS_BY_TRIGGER: ReactionsByTrigger = new Map([
  ['Lead:LeadCreated', [REACTION]],
]);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('mergeGlobalConfig — preserves global fields on boundary-only push', () => {
  it('returns all boundary fields from freshDsl', () => {
    const oldB = boundary('OldBoundary', '/old');
    const newB = boundary('NewBoundary', '/new');
    const existing: CompiledDsl = compiledDslFrom([oldB]);
    const fresh: CompiledDsl = compiledDslFrom([newB]);

    const merged = mergeGlobalConfig(fresh, existing);

    expect(merged.boundaries).toHaveLength(1);
    expect(merged.boundaries[0].boundary).toBe('NewBoundary');
    expect(merged.byBoundaryName['NewBoundary']).toBeDefined();
    expect(merged.byContractPath['/new']).toBeDefined();
    // Old boundary must NOT survive
    expect(merged.byBoundaryName['OldBoundary']).toBeUndefined();
    expect(merged.byContractPath['/old']).toBeUndefined();
  });

  it('carries sagas from existing dsl when fresh has none', () => {
    const existing: CompiledDsl = { ...compiledDslFrom([boundary('Lead', '/leads')]), sagas: [SAGA] };
    const fresh: CompiledDsl = compiledDslFrom([boundary('Lead', '/leads')]);

    const merged = mergeGlobalConfig(fresh, existing);

    expect(merged.sagas).toEqual([SAGA]);
  });

  it('does NOT override fresh sagas with existing when fresh has sagas', () => {
    const freshSaga: SagaConfig = { ...SAGA, name: 'fresh-saga' };
    const existing: CompiledDsl = { ...compiledDslFrom([boundary('Lead', '/leads')]), sagas: [SAGA] };
    const fresh: CompiledDsl = { ...compiledDslFrom([boundary('Lead', '/leads')]), sagas: [freshSaga] };

    const merged = mergeGlobalConfig(fresh, existing);

    expect(merged.sagas).toEqual([freshSaga]);
  });

  it('carries auth from existing dsl when fresh has none', () => {
    const existing: CompiledDsl = { ...compiledDslFrom([boundary('Lead', '/leads')]), auth: AUTH };
    const fresh: CompiledDsl = compiledDslFrom([boundary('Lead', '/leads')]);

    const merged = mergeGlobalConfig(fresh, existing);

    expect(merged.auth).toEqual(AUTH);
  });

  it('carries webhooks from existing dsl when fresh has none', () => {
    const existing: CompiledDsl = { ...compiledDslFrom([boundary('Lead', '/leads')]), webhooks: [WEBHOOK] };
    const fresh: CompiledDsl = compiledDslFrom([boundary('Lead', '/leads')]);

    const merged = mergeGlobalConfig(fresh, existing);

    expect(merged.webhooks).toEqual([WEBHOOK]);
  });

  it('carries global faults from existing dsl when fresh has none', () => {
    const existing: CompiledDsl = { ...compiledDslFrom([boundary('Lead', '/leads')]), faults: [FAULT] };
    const fresh: CompiledDsl = compiledDslFrom([boundary('Lead', '/leads')]);

    const merged = mergeGlobalConfig(fresh, existing);

    expect(merged.faults).toEqual([FAULT]);
  });

  it('carries hateoas from existing dsl when fresh has none', () => {
    const hateoas = { enabled: true, baseUrl: 'https://api.example.com' };
    const existing: CompiledDsl = { ...compiledDslFrom([boundary('Lead', '/leads')]), hateoas };
    const fresh: CompiledDsl = compiledDslFrom([boundary('Lead', '/leads')]);

    const merged = mergeGlobalConfig(fresh, existing);

    expect(merged.hateoas).toEqual(hateoas);
  });

  it('carries versioning from existing dsl when fresh has none', () => {
    const versioning = { enabled: true, versions: [{ version: 'v1', prefix: '/v1', default: true }] };
    const existing: CompiledDsl = { ...compiledDslFrom([boundary('Lead', '/leads')]), versioning };
    const fresh: CompiledDsl = compiledDslFrom([boundary('Lead', '/leads')]);

    const merged = mergeGlobalConfig(fresh, existing);

    expect(merged.versioning).toEqual(versioning);
  });

  it('carries securityHeaders from existing dsl when fresh has none', () => {
    const securityHeaders = { enabled: true, hsts: true, nosniff: true };
    const existing: CompiledDsl = { ...compiledDslFrom([boundary('Lead', '/leads')]), securityHeaders };
    const fresh: CompiledDsl = compiledDslFrom([boundary('Lead', '/leads')]);

    const merged = mergeGlobalConfig(fresh, existing);

    expect(merged.securityHeaders).toEqual(securityHeaders);
  });

  it('carries idempotency from existing dsl when fresh has none', () => {
    const idempotency = { enabled: true, ttlSeconds: 300, hashIncludesBody: true };
    const existing: CompiledDsl = { ...compiledDslFrom([boundary('Lead', '/leads')]), idempotency };
    const fresh: CompiledDsl = compiledDslFrom([boundary('Lead', '/leads')]);

    const merged = mergeGlobalConfig(fresh, existing);

    expect(merged.idempotency).toEqual(idempotency);
  });

  it('carries derivedProjections from existing dsl when fresh has none', () => {
    const derivedProjections = [{ name: 'LeadSummary', key: 'event.aggregateId', subscribe: ['Lead:LeadCreated'], reduce: [] }];
    const existing: CompiledDsl = { ...compiledDslFrom([boundary('Lead', '/leads')]), derivedProjections };
    const fresh: CompiledDsl = compiledDslFrom([boundary('Lead', '/leads')]);

    const merged = mergeGlobalConfig(fresh, existing);

    expect(merged.derivedProjections).toEqual(derivedProjections);
  });

  it('carries reactions from existing dsl when fresh has none', () => {
    const existing: CompiledDsl = { ...compiledDslFrom([boundary('Lead', '/leads')]), reactions: [REACTION] };
    const fresh: CompiledDsl = compiledDslFrom([boundary('Lead', '/leads')]);

    const merged = mergeGlobalConfig(fresh, existing);

    expect(merged.reactions).toEqual([REACTION]);
  });

  it('does NOT override fresh reactions with existing when fresh has reactions', () => {
    const freshReaction: ReactionRule = { ...REACTION, name: 'fresh-reaction' };
    const existing: CompiledDsl = { ...compiledDslFrom([boundary('Lead', '/leads')]), reactions: [REACTION] };
    const fresh: CompiledDsl = { ...compiledDslFrom([boundary('Lead', '/leads')]), reactions: [freshReaction] };

    const merged = mergeGlobalConfig(fresh, existing);

    expect(merged.reactions).toEqual([freshReaction]);
  });

  it('carries reactionsByTrigger from existing dsl when fresh has none', () => {
    const existing: CompiledDsl = { ...compiledDslFrom([boundary('Lead', '/leads')]), reactionsByTrigger: REACTIONS_BY_TRIGGER };
    const fresh: CompiledDsl = compiledDslFrom([boundary('Lead', '/leads')]);

    const merged = mergeGlobalConfig(fresh, existing);

    expect(merged.reactionsByTrigger).toBe(REACTIONS_BY_TRIGGER);
  });

  it('does NOT override fresh reactionsByTrigger with existing when fresh has reactionsByTrigger', () => {
    const freshTrigger: ReactionsByTrigger = new Map([['Lead:LeadCreated', [{ ...REACTION, name: 'fresh-r' }]]]);
    const existing: CompiledDsl = { ...compiledDslFrom([boundary('Lead', '/leads')]), reactionsByTrigger: REACTIONS_BY_TRIGGER };
    const fresh: CompiledDsl = { ...compiledDslFrom([boundary('Lead', '/leads')]), reactionsByTrigger: freshTrigger };

    const merged = mergeGlobalConfig(fresh, existing);

    expect(merged.reactionsByTrigger).toBe(freshTrigger);
  });

  it('preserves ALL global fields simultaneously (regression)', () => {
    const existing: CompiledDsl = {
      ...compiledDslFrom([boundary('Lead', '/leads')]),
      sagas: [SAGA],
      auth: AUTH,
      webhooks: [WEBHOOK],
      faults: [FAULT],
      hateoas: { enabled: true },
      versioning: { enabled: true },
      securityHeaders: { enabled: true },
      idempotency: { enabled: true, ttlSeconds: 60, hashIncludesBody: false },
      derivedProjections: [],
      reactions: [REACTION],
      reactionsByTrigger: REACTIONS_BY_TRIGGER,
    };
    const newBound = boundary('Campaign', '/campaigns');
    const fresh: CompiledDsl = compiledDslFrom([newBound]);

    const merged = mergeGlobalConfig(fresh, existing);

    // Boundary fields come from fresh
    expect(merged.boundaries[0].boundary).toBe('Campaign');
    // All global fields come from existing
    expect(merged.sagas).toEqual([SAGA]);
    expect(merged.auth).toEqual(AUTH);
    expect(merged.webhooks).toEqual([WEBHOOK]);
    expect(merged.faults).toEqual([FAULT]);
    expect(merged.hateoas).toEqual({ enabled: true });
    expect(merged.versioning).toEqual({ enabled: true });
    expect(merged.securityHeaders).toEqual({ enabled: true });
    expect(merged.idempotency).toEqual({ enabled: true, ttlSeconds: 60, hashIncludesBody: false });
    expect(merged.derivedProjections).toEqual([]);
    expect(merged.reactions).toEqual([REACTION]);
    expect(merged.reactionsByTrigger).toBe(REACTIONS_BY_TRIGGER);
  });

  it('is safe when existing dsl has no global fields', () => {
    const existing: CompiledDsl = compiledDslFrom([boundary('Lead', '/leads')]);
    const fresh: CompiledDsl = compiledDslFrom([boundary('Lead', '/leads')]);

    const merged = mergeGlobalConfig(fresh, existing);

    expect(merged.sagas).toBeUndefined();
    expect(merged.auth).toBeUndefined();
    expect(merged.webhooks).toBeUndefined();
    expect(merged.faults).toBeUndefined();
    expect(merged.hateoas).toBeUndefined();
    expect(merged.versioning).toBeUndefined();
    expect(merged.securityHeaders).toBeUndefined();
    expect(merged.idempotency).toBeUndefined();
    expect(merged.derivedProjections).toBeUndefined();
    expect(merged.reactions).toBeUndefined();
    expect(merged.reactionsByTrigger).toBeUndefined();
  });
});
