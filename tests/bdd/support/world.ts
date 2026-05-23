import { setWorldConstructor, World, setDefaultTimeout } from '@cucumber/cucumber';
import type { IWorldOptions } from '@cucumber/cucumber';
import supertest from 'supertest';
import type { Test } from 'supertest';
import { bootSystem, resetSystem, createGateway } from '../../../src/index.js';
import type { BootedSystem, BootInput } from '../../../src/engine/boot.js';
import type { JsonValue, JsonObject } from '../../../src/types.js';
import type { Express } from 'express';
import { loadOpenApi } from '../../../src/contract/loader.js';
import type { OpenApiDoc } from '../../../src/contract/loader.js';

setDefaultTimeout(15_000);

// ---------------------------------------------------------------------------
// Inline minimal banking fixture OpenAPI spec
// ---------------------------------------------------------------------------
export const BANKING_OPENAPI_YAML = `
openapi: "3.0.3"
info:
  title: Banking Simulator
  version: "1.0.0"
paths:
  /customers/{id}:
    post:
      operationId: createCustomer
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/Customer'
      responses:
        '201':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Customer'
    get:
      operationId: getCustomer
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Customer'
    patch:
      operationId: updateCustomer
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
        - name: If-Match
          in: header
          required: false
          schema:
            type: string
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/Customer'
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Customer'
  /loans/{id}:
    post:
      operationId: createLoan
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/LoanAccount'
      responses:
        '201':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/LoanAccount'
    get:
      operationId: getLoan
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/LoanAccount'
    patch:
      operationId: updateLoan
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
        - name: If-Match
          in: header
          required: false
          schema:
            type: string
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/LoanAccount'
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/LoanAccount'
components:
  schemas:
    Customer:
      type: object
      properties:
        id:
          type: string
        name:
          type: string
        email:
          type: string
        status:
          type: string
          enum: [active, inactive]
        balance:
          type: number
        fullName:
          type: string
          x-derived: "state.name"
      additionalProperties: true
    LoanAccount:
      type: object
      properties:
        id:
          type: string
        customerId:
          type: string
        amount:
          type: number
        status:
          type: string
          enum: [pending, active, closed]
        tags:
          type: array
          items:
            type: string
      additionalProperties: true
`;

// ---------------------------------------------------------------------------
// Inline DSL modules for banking simulation
// ---------------------------------------------------------------------------
export const CUSTOMER_DSL_YAML = `
boundary: Customer
contract_path: /customers/{id}
fallback_override: true
identity:
  creation:
    generate: "$uuidv7()"
behaviors:
  - name: get-customer
    match:
      intent: query
      condition: "true"
    emit: CustomerQueried
  - name: create-customer
    match:
      intent: creation
      condition: "true"
    emit: CustomerCreated
  - name: update-customer
    match:
      intent: mutation
      condition: "true"
    emit: CustomerUpdated
event_catalog:
  - type: CustomerQueried
    payload_template:
      noop: "'queried'"
  - type: CustomerCreated
    payload_template:
      id: "command.targetId"
      name: "payload.name"
      email: "payload.email"
      status: "'active'"
  - type: CustomerUpdated
    payload_template:
      id: "state.id"
      name: "'name' in payload ? payload.name : state.name"
      email: "'email' in payload ? payload.email : state.email"
      status: "'status' in payload ? payload.status : state.status"
reducers:
  - on: CustomerQueried
    assign:
      noop: "event.payload.noop"
  - on: CustomerCreated
    assign:
      id: "event.payload.id"
      name: "event.payload.name"
      email: "event.payload.email"
      status: "event.payload.status"
  - on: CustomerUpdated
    assign:
      name: "event.payload.name"
      email: "event.payload.email"
      status: "event.payload.status"
initialization:
  - id: "customer-seed-001"
    name: "Alice"
    email: "alice@example.com"
    status: "active"
`;

// Keep for backward compatibility — not used in shared boot
export const CUSTOMER_COLLECTION_DSL_YAML_UNUSED = '';

export const CUSTOMER_COLLECTION_DSL_YAML = CUSTOMER_DSL_YAML; // alias — kept for step imports

export const LOAN_DSL_YAML = `
boundary: LoanAccount
contract_path: /loans/{id}
fallback_override: false
identity:
  creation:
    generate: "$uuidv7()"
query_mapping:
  status: "state.status == param"
behaviors:
  - name: create-loan
    match:
      intent: creation
      condition: "true"
    emit: LoanCreated
  - name: activate-loan
    match:
      intent: mutation
      condition: "payload.status == 'active'"
    emit: LoanActivated
  - name: close-loan
    match:
      intent: mutation
      condition: "payload.status == 'closed'"
    emit: LoanClosed
  - name: update-loan-amount
    match:
      intent: mutation
      condition: "'amount' in payload"
    emit: LoanUpdated
event_catalog:
  - type: LoanCreated
    payload_template:
      id: "command.targetId"
      customerId: "payload.customerId"
      amount: "payload.amount"
      status: "'pending'"
  - type: LoanActivated
    payload_template:
      id: "state.id"
      status: "'active'"
  - type: LoanClosed
    payload_template:
      id: "state.id"
      status: "'closed'"
  - type: LoanUpdated
    payload_template:
      id: "state.id"
      amount: "payload.amount"
      status: "state.status"
reducers:
  - on: LoanCreated
    assign:
      id: "event.payload.id"
      customerId: "event.payload.customerId"
      amount: "event.payload.amount"
      status: "event.payload.status"
  - on: LoanActivated
    assign:
      status: "event.payload.status"
  - on: LoanClosed
    assign:
      status: "event.payload.status"
  - on: LoanUpdated
    assign:
      amount: "event.payload.amount"
      status: "event.payload.status"
initialization:
  - id: "loan-seed-001"
    customerId: "customer-seed-001"
    amount: 50000
    status: "pending"
`;

export const LOAN_COLLECTION_DSL_YAML = `
boundary: LoanCollection
contract_path: /loans
fallback_override: true
query_mapping:
  status: "state.status == param"
behaviors:
  - name: list-loans
    match:
      intent: query
      condition: "true"
    emit: LoanListQueried
event_catalog:
  - type: LoanListQueried
    payload_template:
      result: "'listed'"
reducers:
  - on: LoanListQueried
    assign:
      result: "event.payload.result"
initialization:
  - id: "loan-seed-001"
    customerId: "customer-seed-001"
    amount: 50000
    status: "pending"
  - id: "loan-seed-002"
    customerId: "customer-seed-001"
    amount: 20000
    status: "active"
`;

// ---------------------------------------------------------------------------
// SimWorld: shared Cucumber World for the BDD suite
// ---------------------------------------------------------------------------

export interface LastResponse {
  status: number;
  body: JsonValue;
  headers: Record<string, string>;
}

let _sharedSystem: BootedSystem | undefined;
let _sharedApp: Express | undefined;
let _sharedOpenapi: OpenApiDoc | undefined;

export class SimWorld extends World {
  sys?: BootedSystem;
  app?: Express;
  lastResponse?: LastResponse;
  lastError?: unknown;
  ctx: Record<string, unknown> = {};

  constructor(options: IWorldOptions) {
    super(options);
  }

  async ensureBooted(): Promise<void> {
    if (this.sys && this.app) return;

    if (_sharedSystem && _sharedApp) {
      this.sys = _sharedSystem;
      this.app = _sharedApp;
      return;
    }

    const openapi = await loadOpenApi(BANKING_OPENAPI_YAML);
    _sharedOpenapi = openapi;

    const sys = await bootSystem({
      openapi,
      dslModules: [
        { name: 'customer', yaml: CUSTOMER_DSL_YAML },
        { name: 'loan', yaml: LOAN_DSL_YAML },
      ],
    });

    const app = createGateway(sys);

    _sharedSystem = sys;
    _sharedApp = app;

    this.sys = sys;
    this.app = app;
  }

  async resetState(): Promise<void> {
    if (this.sys) {
      resetSystem(this.sys);
    }
  }

  async bootWithCustomDsl(openapiYaml: string, dslModules: { name: string; yaml: string }[]): Promise<void> {
    const openapi = await loadOpenApi(openapiYaml);
    const sys = await bootSystem({ openapi, dslModules });
    this.sys = sys;
    this.app = createGateway(sys);
  }

  async sendHttp(
    method: string,
    path: string,
    body?: JsonValue,
    headers?: Record<string, string>,
  ): Promise<void> {
    if (!this.app) throw new Error('System not booted');

    const agent = supertest(this.app);
    const m = method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';

    let req = agent[m](path).set('Content-Type', 'application/json');

    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        req = req.set(k, v);
      }
    }

    if (body !== undefined && body !== null) {
      req = req.send(JSON.stringify(body));
    }

    const res = await req;

    this.lastResponse = {
      status: res.status,
      body: res.body as JsonValue,
      headers: res.headers as Record<string, string>,
    };
  }

  getEvents(): readonly import('../../../src/types.js').DomainEvent[] {
    if (!this.sys) return [];
    return this.sys.events.all();
  }

  getState(id: string): JsonObject | null {
    if (!this.sys) return null;
    return this.sys.graph.get(id);
  }

  getEventCount(): number {
    if (!this.sys) return 0;
    return this.sys.events.size();
  }

  getEntityCount(): number {
    if (!this.sys) return 0;
    return this.sys.graph.size();
  }
}

setWorldConstructor(SimWorld);
