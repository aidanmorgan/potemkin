/**
 * schema-runtime-type-mismatch.integration.test.ts
 *
 * Integration test: a reducer patch sets a wrong-typed value (a string into a
 * numeric `balance`). The projection-time runtime type guard rejects it during
 * shadow projection with InternalExecutionError code SCHEMA_TYPE_MISMATCH, so
 * the unit of work aborts before any event is committed.
 */

import { bootSystem, type BootedSystem } from '../../src/engine/boot.js';
import { executeUnitOfWork } from '../../src/engine/uow.js';
import { loadOpenApi } from '../../src/contract/loader.js';
import { compileDsl } from '../../src/dsl/parser.js';
import { InternalExecutionError } from '../../src/errors.js';
import { nextUuidv7 } from '../../src/ids/uuidv7.js';

// ---------------------------------------------------------------------------
// Inline OpenAPI with a numeric 'balance' field
// ---------------------------------------------------------------------------
const ACCOUNT_OPENAPI = `
openapi: "3.0.3"
info:
  title: Account Type Mismatch Test
  version: "1.0.0"
paths:
  /accounts:
    post:
      operationId: createAccount
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Account"
      responses:
        "201":
          description: Account created
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Account"
        "500":
          description: Internal error
          content:
            application/json:
              schema:
                type: object
components:
  schemas:
    Account:
      type: object
      properties:
        id:
          type: string
        balance:
          type: number
      required:
        - id
        - balance
`;

// DSL whose reducer patch sets a string literal into the numeric 'balance'
// field — a type mismatch caught by contract validation of the projected entity.
const TYPE_MISMATCH_DSL = `
boundary: Account
contract_path: /accounts
fallback_override: false
identity:
  creation:
    generate: "$uuidv7()"
event_catalog:
  - type: AccountCreated
    payload_template:
      id: "command.targetId"
      balance: "command.payload.balance"
behaviors:
  - name: create-account
    match:
      intent: creation
      condition: "true"
    emit: AccountCreated
reducers:
  - on: AccountCreated
    patches:
      - { op: replace, path: /id, value: "event.payload.id" }
      - { op: replace, path: /balance, value: "'NOT_A_NUMBER'" }
`;

// A good DSL for sanity check
const GOOD_ACCOUNT_DSL = `
boundary: Account
contract_path: /accounts
fallback_override: false
identity:
  creation:
    generate: "$uuidv7()"
event_catalog:
  - type: AccountCreated
    payload_template:
      id: "command.targetId"
      balance: "command.payload.balance"
behaviors:
  - name: create-account
    match:
      intent: creation
      condition: "true"
    emit: AccountCreated
reducers:
  - on: AccountCreated
    patches:
      - { op: replace, path: /id, value: "event.payload.id" }
      - { op: replace, path: /balance, value: "event.payload.balance" }
`;

describe('schema-runtime-type-mismatch.integration: wrong-typed CEL assignment throws InternalExecutionError', () => {
  it('assigning a string to a numeric field throws InternalExecutionError', async () => {
    const openapi = await loadOpenApi(ACCOUNT_OPENAPI);
    const sys = await bootSystem({
      openapi,
      compiledDsl: await compileDsl([{ name: 'account', yaml: TYPE_MISMATCH_DSL }]),
    });

    await expect(
      executeUnitOfWork({
        command: {
          commandId: nextUuidv7(),
          boundary: 'Account',
          intent: 'creation',
          targetId: nextUuidv7(),
          payload: { balance: 100 },
          queryParams: {},
          httpMethod: 'POST',
          path: '/accounts',
          origin: 'inbound',
          depth: 0,
        },
        dsl: sys.dsl,
        graph: sys.graph,
        events: sys.events,
        cel: sys.cel,
        validator: sys.validator,
        schemaRegistry: sys.schemaRegistry,
      }),
    ).rejects.toBeInstanceOf(InternalExecutionError);
  });

  it('the InternalExecutionError details include code SCHEMA_TYPE_MISMATCH', async () => {
    const openapi = await loadOpenApi(ACCOUNT_OPENAPI);
    const sys = await bootSystem({
      openapi,
      compiledDsl: await compileDsl([{ name: 'account', yaml: TYPE_MISMATCH_DSL }]),
    });

    try {
      await executeUnitOfWork({
        command: {
          commandId: nextUuidv7(),
          boundary: 'Account',
          intent: 'creation',
          targetId: nextUuidv7(),
          payload: { balance: 100 },
          queryParams: {},
          httpMethod: 'POST',
          path: '/accounts',
          origin: 'inbound',
          depth: 0,
        },
        dsl: sys.dsl,
        graph: sys.graph,
        events: sys.events,
        cel: sys.cel,
        validator: sys.validator,
        schemaRegistry: sys.schemaRegistry,
      });
      fail('Expected InternalExecutionError');
    } catch (err) {
      expect(err).toBeInstanceOf(InternalExecutionError);
      const execErr = err as InternalExecutionError;
      // The error message or details should contain the mismatch code
      const hasCode =
        execErr.message.includes('SCHEMA_TYPE_MISMATCH') ||
        JSON.stringify(execErr.details).includes('SCHEMA_TYPE_MISMATCH');
      expect(hasCode).toBe(true);
    }
  });

  it('no events are appended to the store when a type mismatch aborts the UoW', async () => {
    const openapi = await loadOpenApi(ACCOUNT_OPENAPI);
    const sys = await bootSystem({
      openapi,
      compiledDsl: await compileDsl([{ name: 'account', yaml: TYPE_MISMATCH_DSL }]),
    });

    const sizeBefore = sys.events.size();

    await expect(
      executeUnitOfWork({
        command: {
          commandId: nextUuidv7(),
          boundary: 'Account',
          intent: 'creation',
          targetId: nextUuidv7(),
          payload: { balance: 100 },
          queryParams: {},
          httpMethod: 'POST',
          path: '/accounts',
          origin: 'inbound',
          depth: 0,
        },
        dsl: sys.dsl,
        graph: sys.graph,
        events: sys.events,
        cel: sys.cel,
        validator: sys.validator,
        schemaRegistry: sys.schemaRegistry,
      }),
    ).rejects.toBeInstanceOf(InternalExecutionError);

    expect(sys.events.size()).toBe(sizeBefore);
  });

  it('a correct numeric assignment succeeds', async () => {
    const openapi = await loadOpenApi(ACCOUNT_OPENAPI);
    const sys = await bootSystem({
      openapi,
      compiledDsl: await compileDsl([{ name: 'account', yaml: GOOD_ACCOUNT_DSL }]),
    });

    const result = await executeUnitOfWork({
      command: {
        commandId: nextUuidv7(),
        boundary: 'Account',
        intent: 'creation',
        targetId: nextUuidv7(),
        payload: { balance: 999.99 },
        queryParams: {},
        httpMethod: 'POST',
        path: '/accounts',
        origin: 'inbound',
        depth: 0,
      },
      dsl: sys.dsl,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      schemaRegistry: sys.schemaRegistry,
    });

    expect(result.status).toBe(201);
  });
});
