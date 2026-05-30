/**
 * pattern-match-and-project.integration.test.ts
 *
 * Cross-subsystem integration: submit a command through executeUnitOfWork and assert:
 *  - Events appended to the EventStore.
 *  - State graph mutated to reflect the new entity.
 *  - Sequence version incremented.
 */

import { bootSystem, type BootedSystem } from '../../src/engine/boot.js';
import { executeUnitOfWork } from '../../src/engine/uow.js';
import { resetSystem } from '../../src/engine/reset.js';
import { loadFixture } from '../fixtures/index.js';
import { nextUuidv7 } from '../../src/ids/uuidv7.js';
import type { Command } from '../../src/types.js';

describe('pattern-match-and-project.integration', () => {
  let sys: BootedSystem;

  beforeEach(async () => {
    const fixture = await loadFixture();
    sys = await bootSystem(fixture);
  });

  afterEach(() => {
    resetSystem(sys);
  });

  function makeCreateLeadCommand(overrides: Partial<Command> = {}): Command {
    const id = nextUuidv7();
    return {
      commandId: nextUuidv7(),
      boundary: 'Lead',
      intent: 'creation',
      targetId: id,
      payload: {
        companyName: 'Test Corp',
        contactName: 'Test User',
        phone: '+61 2 9000 1234',
        email: 'test@testcorp.com',
        source: 'WEBSITE',
      },
      queryParams: {},
      httpMethod: 'POST',
      path: '/leads',
      origin: 'inbound',
      depth: 0,
      ...overrides,
    };
  }

  it('executing a creation command appends exactly 1 event to the event store', async () => {
    const initialSize = sys.events.size();
    const cmd = makeCreateLeadCommand();

    await executeUnitOfWork({
      command: cmd,
      dsl: sys.dsl,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      openapi: sys.openapi,
      schemaRegistry: sys.schemaRegistry,
      logger: sys.logger,
      tracer: sys.tracer,
      metrics: sys.metrics,
    });

    expect(sys.events.size()).toBe(initialSize + 1);
  });

  it('the committed event has the correct boundary and aggregateId', async () => {
    const cmd = makeCreateLeadCommand();

    const result = await executeUnitOfWork({
      command: cmd,
      dsl: sys.dsl,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      openapi: sys.openapi,
      schemaRegistry: sys.schemaRegistry,
      logger: sys.logger,
      tracer: sys.tracer,
      metrics: sys.metrics,
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.boundary).toBe('Lead');
    expect(result.events[0]!.aggregateId).toBe(cmd.targetId);
  });

  it('state graph is mutated to contain the new entity after command execution', async () => {
    const cmd = makeCreateLeadCommand();

    await executeUnitOfWork({
      command: cmd,
      dsl: sys.dsl,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      openapi: sys.openapi,
      schemaRegistry: sys.schemaRegistry,
      logger: sys.logger,
      tracer: sys.tracer,
      metrics: sys.metrics,
    });

    const entity = sys.graph.get(cmd.targetId!);
    expect(entity).not.toBeNull();
    expect(entity!['companyName']).toBe('Test Corp');
    expect(entity!['source']).toBe('WEBSITE');
  });

  it('sequence version for the new aggregate is incremented to 1', async () => {
    const cmd = makeCreateLeadCommand();

    await executeUnitOfWork({
      command: cmd,
      dsl: sys.dsl,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      openapi: sys.openapi,
      schemaRegistry: sys.schemaRegistry,
      logger: sys.logger,
      tracer: sys.tracer,
      metrics: sys.metrics,
    });

    const seqVersion = sys.events.currentSequenceVersion(cmd.targetId!);
    expect(seqVersion).toBe(1);
  });

  it('execution result has status 201 for a creation command', async () => {
    const cmd = makeCreateLeadCommand();

    const result = await executeUnitOfWork({
      command: cmd,
      dsl: sys.dsl,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      openapi: sys.openapi,
      schemaRegistry: sys.schemaRegistry,
      logger: sys.logger,
      tracer: sys.tracer,
      metrics: sys.metrics,
    });

    expect(result.status).toBe(201);
  });

  it('state graph total size increases by 1 after a creation command', async () => {
    const before = sys.graph.size();
    const cmd = makeCreateLeadCommand();

    await executeUnitOfWork({
      command: cmd,
      dsl: sys.dsl,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      openapi: sys.openapi,
      schemaRegistry: sys.schemaRegistry,
      logger: sys.logger,
      tracer: sys.tracer,
      metrics: sys.metrics,
    });

    expect(sys.graph.size()).toBe(before + 1);
  });
});
