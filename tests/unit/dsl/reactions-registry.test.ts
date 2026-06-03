/**
 * Unit tests for the R2 reaction registry + cross-reference validation.
 *
 * Coverage:
 *  - buildReactionRegistry resolves rules by qualified "Boundary:EventType" key
 *  - buildReactionRegistry resolves rules by bare "EventType" key
 *  - Multiple reactions on the same trigger key are grouped together
 *  - Registry is absent (empty) when there are no reactions
 *  - compileDsl builds and attaches reactionsByTrigger to the CompiledDsl
 *  - BOOT_ERR_DSL_REFERENCE: emit names event absent from the reacting boundary catalog
 *  - BOOT_ERR_DSL_REFERENCE: on names event no boundary emits (bare trigger)
 *  - BOOT_ERR_DSL_REFERENCE: boundary names an unknown boundary
 *  - BOOT_ERR_DSL_REFERENCE: qualified trigger names an unknown trigger boundary
 *  - BOOT_ERR_DSL_REFERENCE: qualified trigger event not in that boundary's catalog
 *  - Existing boundaries with no reactions compile without error (empty registry)
 *  - xaze: fired-set id disambiguation — distinct reactions never collide on the
 *    fired-set key (the key is the (boundary,on,emit,target,when) tuple, not the name),
 *    so a reused reaction name (legal under composition) does not silently miss-fire
 */

import { buildReactionRegistry, validateReactionCrossReferences, compileDsl } from '../../../src/dsl/parser';
import { deriveReactionId } from '../../../src/engine/reactions';
import { BootError } from '../../../src/errors';
import type { ReactionRule, BoundaryConfig } from '../../../src/dsl/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeReaction(overrides: Partial<ReactionRule> & Pick<ReactionRule, 'on' | 'emit' | 'boundary'>): ReactionRule {
  return { ...overrides };
}

/** Minimal BoundaryConfig suitable for byBoundaryName lookups. */
function makeBC(boundary: string, eventTypes: string[]): BoundaryConfig {
  return {
    boundary,
    contractPath: `/${boundary.toLowerCase()}`,
    fallbackOverride: false,
    behaviors: [],
    reducers: [],
    eventCatalog: eventTypes.map((type) => ({ type, payloadTemplate: {} })),
  };
}

const leadBC = makeBC('Lead', ['LeadCreated', 'LeadConverted']);
const campaignBC = makeBC('Campaign', ['CampaignConversionRecorded', 'CampaignClosed']);

const byBoundaryName: Record<string, BoundaryConfig> = {
  Lead: leadBC,
  Campaign: campaignBC,
};

// ── buildReactionRegistry ─────────────────────────────────────────────────────

describe('buildReactionRegistry — qualified key', () => {
  it('resolves a reaction by its qualified "Boundary:EventType" trigger key', () => {
    const reaction = makeReaction({ on: 'Lead:LeadConverted', emit: 'CampaignConversionRecorded', boundary: 'Campaign' });
    const registry = buildReactionRegistry([reaction]);
    const bucket = registry.get('Lead:LeadConverted');
    expect(bucket).toBeDefined();
    expect(bucket).toHaveLength(1);
    expect(bucket![0]).toBe(reaction);
  });
});

describe('buildReactionRegistry — bare key', () => {
  it('resolves a reaction by its bare "EventType" trigger key', () => {
    const reaction = makeReaction({ on: 'LeadConverted', emit: 'CampaignConversionRecorded', boundary: 'Campaign' });
    const registry = buildReactionRegistry([reaction]);
    const bucket = registry.get('LeadConverted');
    expect(bucket).toBeDefined();
    expect(bucket).toHaveLength(1);
    expect(bucket![0]).toBe(reaction);
  });
});

describe('buildReactionRegistry — multiple reactions on same trigger', () => {
  it('groups multiple reactions that share the same on key into one bucket', () => {
    const r1 = makeReaction({ on: 'Lead:LeadConverted', emit: 'CampaignConversionRecorded', boundary: 'Campaign' });
    const r2 = makeReaction({ on: 'Lead:LeadConverted', emit: 'CampaignClosed', boundary: 'Campaign' });
    const registry = buildReactionRegistry([r1, r2]);
    const bucket = registry.get('Lead:LeadConverted');
    expect(bucket).toHaveLength(2);
    expect(bucket).toContain(r1);
    expect(bucket).toContain(r2);
  });

  it('keeps separate buckets for different trigger keys', () => {
    const r1 = makeReaction({ on: 'Lead:LeadConverted', emit: 'CampaignConversionRecorded', boundary: 'Campaign' });
    const r2 = makeReaction({ on: 'LeadCreated', emit: 'CampaignConversionRecorded', boundary: 'Campaign' });
    const registry = buildReactionRegistry([r1, r2]);
    expect(registry.get('Lead:LeadConverted')).toHaveLength(1);
    expect(registry.get('LeadCreated')).toHaveLength(1);
  });
});

describe('buildReactionRegistry — empty input', () => {
  it('returns an empty map when no reactions are provided', () => {
    const registry = buildReactionRegistry([]);
    expect(registry.size).toBe(0);
  });
});

// ── validateReactionCrossReferences — success paths ──────────────────────────

describe('validateReactionCrossReferences — valid reactions', () => {
  it('does not throw for a valid qualified-trigger reaction', () => {
    const reaction = makeReaction({ on: 'Lead:LeadConverted', emit: 'CampaignConversionRecorded', boundary: 'Campaign' });
    expect(() => validateReactionCrossReferences([reaction], byBoundaryName)).not.toThrow();
  });

  it('does not throw for a valid bare-trigger reaction', () => {
    const reaction = makeReaction({ on: 'LeadConverted', emit: 'CampaignConversionRecorded', boundary: 'Campaign' });
    expect(() => validateReactionCrossReferences([reaction], byBoundaryName)).not.toThrow();
  });
});

// ── validateReactionCrossReferences — failure: unknown reacting boundary ──────

describe('validateReactionCrossReferences — unknown reacting boundary', () => {
  it('throws BOOT_ERR_DSL_REFERENCE when the reacting boundary is not in byBoundaryName', () => {
    const reaction = makeReaction({ on: 'Lead:LeadConverted', emit: 'SomeEvent', boundary: 'NonExistent' });
    expect(() => validateReactionCrossReferences([reaction], byBoundaryName)).toThrow(BootError);
  });

  it('error message names the unknown boundary', () => {
    const reaction = makeReaction({ on: 'Lead:LeadConverted', emit: 'SomeEvent', boundary: 'Ghost' });
    let err: unknown;
    try {
      validateReactionCrossReferences([reaction], byBoundaryName);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(BootError);
    expect((err as BootError).code).toBe('BOOT_ERR_DSL_REFERENCE');
    expect((err as Error).message).toContain('Ghost');
  });
});

// ── validateReactionCrossReferences — failure: emit not in reacting catalog ───

describe('validateReactionCrossReferences — emit not in reacting boundary catalog', () => {
  it('throws BOOT_ERR_DSL_REFERENCE when emit names an event absent from the reacting boundary', () => {
    const reaction = makeReaction({ on: 'Lead:LeadConverted', emit: 'UnknownEvent', boundary: 'Campaign' });
    expect(() => validateReactionCrossReferences([reaction], byBoundaryName)).toThrow(BootError);
  });

  it('error code is BOOT_ERR_DSL_REFERENCE and message names the missing event', () => {
    const reaction = makeReaction({ on: 'Lead:LeadConverted', emit: 'MissingEvent', boundary: 'Campaign' });
    let err: unknown;
    try {
      validateReactionCrossReferences([reaction], byBoundaryName);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(BootError);
    expect((err as BootError).code).toBe('BOOT_ERR_DSL_REFERENCE');
    expect((err as Error).message).toContain('MissingEvent');
    expect((err as Error).message).toContain('Campaign');
  });
});

// ── validateReactionCrossReferences — failure: bare trigger not found ─────────

describe('validateReactionCrossReferences — bare trigger event not emitted by any boundary', () => {
  it('throws BOOT_ERR_DSL_REFERENCE when no boundary emits the bare trigger event', () => {
    const reaction = makeReaction({ on: 'OrphanEvent', emit: 'CampaignConversionRecorded', boundary: 'Campaign' });
    expect(() => validateReactionCrossReferences([reaction], byBoundaryName)).toThrow(BootError);
  });

  it('error message names the unresolvable event type', () => {
    const reaction = makeReaction({ on: 'OrphanEvent', emit: 'CampaignConversionRecorded', boundary: 'Campaign' });
    let err: unknown;
    try {
      validateReactionCrossReferences([reaction], byBoundaryName);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(BootError);
    expect((err as BootError).code).toBe('BOOT_ERR_DSL_REFERENCE');
    expect((err as Error).message).toContain('OrphanEvent');
  });
});

// ── validateReactionCrossReferences — failure: qualified trigger boundary unknown ──

describe('validateReactionCrossReferences — qualified trigger names unknown boundary', () => {
  it('throws BOOT_ERR_DSL_REFERENCE when the trigger boundary does not exist', () => {
    const reaction = makeReaction({ on: 'Ghost:SomeEvent', emit: 'CampaignConversionRecorded', boundary: 'Campaign' });
    expect(() => validateReactionCrossReferences([reaction], byBoundaryName)).toThrow(BootError);
  });

  it('error message names the missing trigger boundary', () => {
    const reaction = makeReaction({ on: 'Ghost:SomeEvent', emit: 'CampaignConversionRecorded', boundary: 'Campaign' });
    let err: unknown;
    try {
      validateReactionCrossReferences([reaction], byBoundaryName);
    } catch (e) { err = e; }
    expect((err as Error).message).toContain('Ghost');
  });
});

// ── validateReactionCrossReferences — failure: qualified trigger event not in catalog ──

describe('validateReactionCrossReferences — qualified trigger event not in trigger boundary catalog', () => {
  it('throws BOOT_ERR_DSL_REFERENCE when the trigger event type is absent from that boundary', () => {
    const reaction = makeReaction({ on: 'Lead:NonExistentEvent', emit: 'CampaignConversionRecorded', boundary: 'Campaign' });
    expect(() => validateReactionCrossReferences([reaction], byBoundaryName)).toThrow(BootError);
  });

  it('error message names the missing event type and boundary', () => {
    const reaction = makeReaction({ on: 'Lead:NoSuchEvent', emit: 'CampaignConversionRecorded', boundary: 'Campaign' });
    let err: unknown;
    try {
      validateReactionCrossReferences([reaction], byBoundaryName);
    } catch (e) { err = e; }
    expect((err as Error).message).toContain('NoSuchEvent');
    expect((err as Error).message).toContain('Lead');
  });
});

// ── compileDsl integration ────────────────────────────────────────────────────

const LEAD_YAML = `
boundary: Lead
contract_path: /leads
behaviors: []
reducers:
  - on: LeadConverted
event_catalog:
  - type: LeadConverted
    payload_template: {}
`;

const CAMPAIGN_WITH_REACTION_YAML = `
boundary: Campaign
contract_path: /campaigns
behaviors: []
reducers:
  - on: CampaignConversionRecorded
event_catalog:
  - type: CampaignConversionRecorded
    payload_template: {}
reactions:
  - name: record-conversion
    on: "Lead:LeadConverted"
    emit: CampaignConversionRecorded
    boundary: Campaign
`;

const MINIMAL_BOUNDARY_YAML = `
boundary: Thing
contract_path: /things
behaviors: []
reducers: []
event_catalog: []
`;

describe('compileDsl — reactionsByTrigger attached', () => {
  it('attaches reactionsByTrigger to the compiled DSL when reactions are present', async () => {
    const dsl = await compileDsl([
      { name: 'lead', yaml: LEAD_YAML },
      { name: 'campaign', yaml: CAMPAIGN_WITH_REACTION_YAML },
    ]);
    expect(dsl.reactionsByTrigger).toBeDefined();
    const bucket = dsl.reactionsByTrigger!.get('Lead:LeadConverted');
    expect(bucket).toHaveLength(1);
    expect(bucket![0]!.emit).toBe('CampaignConversionRecorded');
  });

  it('reactionsByTrigger is absent (undefined) when no boundaries declare reactions', async () => {
    const dsl = await compileDsl([{ name: 'thing', yaml: MINIMAL_BOUNDARY_YAML }]);
    expect(dsl.reactionsByTrigger).toBeUndefined();
  });
});

describe('compileDsl — reaction cross-reference validation at compile time', () => {
  it('throws BOOT_ERR_DSL_REFERENCE when emit names an event not in the reacting boundary catalog', async () => {
    const yaml = `
boundary: Campaign
contract_path: /campaigns
behaviors: []
reducers: []
event_catalog:
  - type: CampaignConversionRecorded
    payload_template: {}
reactions:
  - on: "Campaign:CampaignConversionRecorded"
    emit: NonExistentEvent
    boundary: Campaign
`;
    await expect(compileDsl([{ name: 'campaign', yaml }])).rejects.toThrow(BootError);
  });

  it('throws BOOT_ERR_DSL_REFERENCE when on trigger event is not emitted by any boundary', async () => {
    const yaml = `
boundary: Campaign
contract_path: /campaigns
behaviors: []
reducers: []
event_catalog:
  - type: CampaignConversionRecorded
    payload_template: {}
reactions:
  - on: OrphanEvent
    emit: CampaignConversionRecorded
    boundary: Campaign
`;
    await expect(compileDsl([{ name: 'campaign', yaml }])).rejects.toThrow(BootError);
  });

  it('throws BOOT_ERR_DSL_REFERENCE when the reacting boundary is unknown', async () => {
    const globalYaml = `
reactions:
  - on: "Campaign:CampaignConversionRecorded"
    emit: SomeEvent
    boundary: UnknownBoundary
`;
    const campaignYaml = `
boundary: Campaign
contract_path: /campaigns
behaviors: []
reducers: []
event_catalog:
  - type: CampaignConversionRecorded
    payload_template: {}
`;
    await expect(compileDsl([{ name: 'campaign', yaml: campaignYaml }], globalYaml)).rejects.toThrow(BootError);
  });
});

// ── xaze: fired-set id disambiguation (collision-free across distinct reactions) ──
//
// deriveReactionId keys the per-UoW fired-set off the reaction's distinguishing
// shape (boundary, on, emit, target, when), NOT its name. Two genuinely distinct
// reactions therefore never collide — even when they share a name, which happens
// legitimately when a named component reaction is instantiated more than once.

describe('xaze: deriveReactionId — distinct reactions never collide on the fired-set key', () => {
  it('gives two reactions that share a name but differ in trigger distinct ids', () => {
    const r1 = makeReaction({ name: 'notify', on: 'Document:DocumentCreated', emit: 'NotificationCreated', boundary: 'Notification' });
    const r2 = makeReaction({ name: 'notify', on: 'Draft:DocumentCreated', emit: 'NotificationCreated', boundary: 'Notification' });
    expect(deriveReactionId(r1)).not.toBe(deriveReactionId(r2));
  });

  it('gives two reactions that share name + trigger but differ in target distinct ids', () => {
    const r1 = makeReaction({ name: 'fanout', on: 'Lead:LeadConverted', emit: 'CampaignClosed', boundary: 'Campaign', target: 'event.payload.campaignId' });
    const r2 = makeReaction({ name: 'fanout', on: 'Lead:LeadConverted', emit: 'CampaignClosed', boundary: 'Campaign', target: 'event.payload.parentCampaignId' });
    expect(deriveReactionId(r1)).not.toBe(deriveReactionId(r2));
  });

  it('gives two reactions that differ only in their when gate distinct ids', () => {
    const r1 = makeReaction({ name: 'gate', on: 'Lead:LeadConverted', emit: 'CampaignClosed', boundary: 'Campaign', when: 'event.payload.tier == "gold"' });
    const r2 = makeReaction({ name: 'gate', on: 'Lead:LeadConverted', emit: 'CampaignClosed', boundary: 'Campaign', when: 'event.payload.tier == "silver"' });
    expect(deriveReactionId(r1)).not.toBe(deriveReactionId(r2));
  });

  it('gives the same id to a reaction firing again on the same shape (true-cycle dedup)', () => {
    const r1 = makeReaction({ name: 'cycle', on: 'A:E', emit: 'F', boundary: 'B', target: 'event.aggregateId' });
    const r2 = makeReaction({ name: 'different-label', on: 'A:E', emit: 'F', boundary: 'B', target: 'event.aggregateId' });
    // Identical distinguishing shape → identical id, so a cycle is suppressed
    // regardless of label. This is the deliberate dedup behaviour.
    expect(deriveReactionId(r1)).toBe(deriveReactionId(r2));
  });

  it('does not throw at boot when two reactions share a name (composition reuse is legal)', () => {
    const r1 = makeReaction({ name: 'reused', on: 'Lead:LeadConverted', emit: 'CampaignClosed', boundary: 'Campaign' });
    const r2 = makeReaction({ name: 'reused', on: 'Lead:LeadCreated', emit: 'CampaignConversionRecorded', boundary: 'Campaign' });
    expect(() => validateReactionCrossReferences([r1, r2], byBoundaryName)).not.toThrow();
  });
});

describe('compileDsl — existing fixtures with no reactions compile cleanly', () => {
  it('compiles a boundary with no reactions without error and no reactionsByTrigger', async () => {
    const dsl = await compileDsl([{ name: 'thing', yaml: MINIMAL_BOUNDARY_YAML }]);
    expect(dsl.reactionsByTrigger).toBeUndefined();
    expect(dsl.reactions).toBeUndefined();
    expect(dsl.boundaries).toHaveLength(1);
  });
});

describe('compileDsl — global config reactions included in registry', () => {
  it('merges global-config reactions into reactionsByTrigger alongside boundary reactions', async () => {
    const boundaryYaml = `
boundary: Lead
contract_path: /leads
behaviors: []
reducers:
  - on: LeadConverted
event_catalog:
  - type: LeadConverted
    payload_template: {}
`;
    const campaignBoundaryYaml = `
boundary: Campaign
contract_path: /campaigns
behaviors: []
reducers:
  - on: CampaignConversionRecorded
event_catalog:
  - type: CampaignConversionRecorded
    payload_template: {}
`;
    const globalYaml = `
reactions:
  - name: from-global
    on: "Lead:LeadConverted"
    emit: CampaignConversionRecorded
    boundary: Campaign
`;
    const dsl = await compileDsl(
      [{ name: 'lead', yaml: boundaryYaml }, { name: 'campaign', yaml: campaignBoundaryYaml }],
      globalYaml,
    );
    expect(dsl.reactionsByTrigger).toBeDefined();
    const bucket = dsl.reactionsByTrigger!.get('Lead:LeadConverted');
    expect(bucket).toBeDefined();
    expect(bucket!.some((r) => r.name === 'from-global')).toBe(true);
  });
});
