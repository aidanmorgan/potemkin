/**
 * Unit tests for `reactions:` boot-time validation (R1).
 *
 * Coverage:
 *  - One fully-valid reaction declared in a boundary file
 *  - One valid reaction declared in the global file (with explicit boundary)
 *  - Rejection: missing `on`
 *  - Rejection: missing `emit`
 *  - Rejection: non-string `target`
 *  - Rejection: invalid `intent` value
 *  - Rejection: malformed `when` CEL expression
 *  - Rejection: malformed `target` CEL expression
 *  - Rejection: malformed `payload` CEL value
 *  - Rejection: global-file reaction with no `boundary`
 */

import { validateBoundaryConfig, validateGlobalConfig } from '../../../src/dsl/schema';
import { BootError } from '../../../src/errors';

const minimalBoundaryBase = {
  boundary: 'Campaign',
  contract_path: '/campaigns',
  behaviors: [],
  reducers: [],
  event_catalog: [],
};

describe('reactions — boundary-file: valid reaction', () => {
  it('parses a fully-specified reaction into ReactionRule on the BoundaryConfig', () => {
    const cfg = validateBoundaryConfig({
      ...minimalBoundaryBase,
      reactions: [
        {
          name: 'record-conversion-on-campaign',
          on: 'Lead:LeadConverted',
          when: "event.payload.campaignId != null",
          emit: 'CampaignConversionRecorded',
          intent: 'mutation',
          target: 'event.payload.campaignId',
          payload: { leadId: 'event.aggregateId' },
        },
      ],
    });

    expect(cfg.reactions).toHaveLength(1);
    const r = cfg.reactions![0]!;
    expect(r.name).toBe('record-conversion-on-campaign');
    expect(r.on).toBe('Lead:LeadConverted');
    expect(r.when).toBe("event.payload.campaignId != null");
    expect(r.boundary).toBe('Campaign');
    expect(r.emit).toBe('CampaignConversionRecorded');
    expect(r.intent).toBe('mutation');
    expect(r.target).toBe('event.payload.campaignId');
    expect(r.payload).toEqual({ leadId: 'event.aggregateId' });
  });
});

describe('reactions — global file: valid reaction with explicit boundary', () => {
  it('parses a reaction in the global config when boundary is explicitly set', () => {
    const cfg = validateGlobalConfig({
      reactions: [
        {
          on: 'Lead:LeadConverted',
          boundary: 'Campaign',
          emit: 'CampaignConversionRecorded',
        },
      ],
    });

    expect(cfg.reactions).toHaveLength(1);
    const r = cfg.reactions![0]!;
    expect(r.on).toBe('Lead:LeadConverted');
    expect(r.boundary).toBe('Campaign');
    expect(r.emit).toBe('CampaignConversionRecorded');
  });
});

describe('reactions — rejection: missing on', () => {
  it('throws BOOT_ERR_DSL_SYNTAX naming "on" when on is absent', () => {
    expect(() =>
      validateBoundaryConfig({
        ...minimalBoundaryBase,
        reactions: [{ emit: 'CampaignConversionRecorded' }],
      }),
    ).toThrow(BootError);
  });

  it('error message names the "on" field', () => {
    let err: unknown;
    try {
      validateBoundaryConfig({
        ...minimalBoundaryBase,
        reactions: [{ emit: 'CampaignConversionRecorded' }],
      });
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toContain('"on"');
  });
});

describe('reactions — rejection: missing emit', () => {
  it('throws BOOT_ERR_DSL_SYNTAX naming "emit" when emit is absent', () => {
    expect(() =>
      validateBoundaryConfig({
        ...minimalBoundaryBase,
        reactions: [{ on: 'Lead:LeadConverted' }],
      }),
    ).toThrow(BootError);
  });

  it('error message names the "emit" field', () => {
    let err: unknown;
    try {
      validateBoundaryConfig({
        ...minimalBoundaryBase,
        reactions: [{ on: 'Lead:LeadConverted' }],
      });
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toContain('"emit"');
  });
});

describe('reactions — rejection: non-string target', () => {
  it('throws BOOT_ERR_DSL_SYNTAX naming the target field when target is a number', () => {
    let err: unknown;
    try {
      validateBoundaryConfig({
        ...minimalBoundaryBase,
        reactions: [{ on: 'Lead:LeadConverted', emit: 'CampaignConversionRecorded', target: 42 }],
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BootError);
    expect((err as BootError).code).toBe('BOOT_ERR_DSL_SYNTAX');
    expect((err as Error).message).toContain('target');
  });
});

describe('reactions — rejection: invalid intent', () => {
  it('throws BOOT_ERR_DSL_SYNTAX when intent is not mutation or creation', () => {
    expect(() =>
      validateBoundaryConfig({
        ...minimalBoundaryBase,
        reactions: [{ on: 'Lead:LeadConverted', emit: 'CampaignConversionRecorded', intent: 'query' }],
      }),
    ).toThrow(BootError);
  });

  it('error message names the intent field and lists allowed values', () => {
    let err: unknown;
    try {
      validateBoundaryConfig({
        ...minimalBoundaryBase,
        reactions: [{ on: 'Lead:LeadConverted', emit: 'CampaignConversionRecorded', intent: 'deletion' }],
      });
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toContain('intent');
    expect((err as Error).message).toContain('mutation');
    expect((err as Error).message).toContain('creation');
  });
});

describe('reactions — rejection: malformed when CEL', () => {
  it('throws BOOT_ERR_DSL_SYNTAX naming the when field when when contains invalid CEL', () => {
    let err: unknown;
    try {
      validateBoundaryConfig({
        ...minimalBoundaryBase,
        reactions: [
          { on: 'Lead:LeadConverted', emit: 'CampaignConversionRecorded', when: '=== not valid CEL ===' },
        ],
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BootError);
    expect((err as BootError).code).toBe('BOOT_ERR_DSL_SYNTAX');
    expect((err as Error).message).toContain('when');
  });
});

describe('reactions — rejection: malformed target CEL', () => {
  it('throws BOOT_ERR_DSL_SYNTAX naming the target field when target contains invalid CEL', () => {
    let err: unknown;
    try {
      validateBoundaryConfig({
        ...minimalBoundaryBase,
        reactions: [
          { on: 'Lead:LeadConverted', emit: 'CampaignConversionRecorded', target: '=== not valid CEL ===' },
        ],
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BootError);
    expect((err as BootError).code).toBe('BOOT_ERR_DSL_SYNTAX');
    expect((err as Error).message).toContain('target');
  });
});

describe('reactions — rejection: malformed payload CEL', () => {
  it('throws BOOT_ERR_DSL_SYNTAX naming the payload field when a payload value contains invalid CEL', () => {
    let err: unknown;
    try {
      validateBoundaryConfig({
        ...minimalBoundaryBase,
        reactions: [
          { on: 'Lead:LeadConverted', emit: 'CampaignConversionRecorded', payload: { leadId: '=== bad CEL ===' } },
        ],
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BootError);
    expect((err as BootError).code).toBe('BOOT_ERR_DSL_SYNTAX');
    expect((err as Error).message).toContain('payload');
  });
});

describe('reactions — rejection: global-file reaction missing boundary', () => {
  it('throws BOOT_ERR_DSL_SYNTAX when boundary is absent in global config', () => {
    expect(() =>
      validateGlobalConfig({
        reactions: [{ on: 'Lead:LeadConverted', emit: 'CampaignConversionRecorded' }],
      }),
    ).toThrow(BootError);
  });

  it('error message mentions boundary', () => {
    let err: unknown;
    try {
      validateGlobalConfig({
        reactions: [{ on: 'Lead:LeadConverted', emit: 'CampaignConversionRecorded' }],
      });
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toContain('boundary');
  });
});
