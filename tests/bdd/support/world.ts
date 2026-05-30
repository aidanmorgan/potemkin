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
import { compileDsl } from '../../../src/dsl/parser.js';

setDefaultTimeout(15_000);

// ---------------------------------------------------------------------------
// Inline minimal CRM fixture OpenAPI spec (The Nuisance Bureau)
// ---------------------------------------------------------------------------
export const CRM_OPENAPI_YAML = `
openapi: "3.0.3"
info:
  title: The Nuisance Bureau CRM Simulator
  version: "1.0.0"
paths:
  /leads/{id}:
    post:
      operationId: createLead
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
              $ref: '#/components/schemas/Lead'
      responses:
        '201':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Lead'
    get:
      operationId: getLead
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
                $ref: '#/components/schemas/Lead'
    patch:
      operationId: updateLead
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
              $ref: '#/components/schemas/Lead'
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Lead'
  /opportunities/{id}:
    post:
      operationId: createOpportunity
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
              $ref: '#/components/schemas/Opportunity'
      responses:
        '201':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Opportunity'
    get:
      operationId: getOpportunity
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
                $ref: '#/components/schemas/Opportunity'
    patch:
      operationId: updateOpportunity
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
              $ref: '#/components/schemas/Opportunity'
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Opportunity'
components:
  schemas:
    Lead:
      type: object
      properties:
        id:
          type: string
        companyName:
          type: string
        contactName:
          type: string
        email:
          type: string
        status:
          type: string
          enum: [new, contacted, qualified, disqualified, converted]
        score:
          type: number
        fullContact:
          type: string
          x-derived: "state.contactName"
      additionalProperties: true
    Opportunity:
      type: object
      properties:
        id:
          type: string
        leadId:
          type: string
        value:
          type: number
        stage:
          type: string
          enum: [proposed, negotiating, won, lost]
        tags:
          type: array
          items:
            type: string
      additionalProperties: true
`;

// ---------------------------------------------------------------------------
// Inline DSL modules for CRM simulation (The Nuisance Bureau)
// ---------------------------------------------------------------------------
export const LEAD_DSL_YAML = `
boundary: Lead
contract_path: /leads/{id}
fallback_override: true
identity:
  creation:
    generate: "$uuidv7()"
behaviors:
  - name: get-lead
    match:
      operationId: getLead
      condition: "true"
    emit: LeadQueried
  - name: create-lead
    match:
      operationId: createLead
      condition: "true"
    emit: LeadCreated
  - name: update-lead
    match:
      operationId: updateLead
      condition: "true"
    emit: LeadUpdated
event_catalog:
  - type: LeadQueried
    payload_template:
      noop: "'queried'"
  - type: LeadCreated
    payload_template:
      id: "command.targetId"
      companyName: "payload.companyName"
      contactName: "payload.contactName"
      email: "payload.email"
      status: "'new'"
  - type: LeadUpdated
    payload_template:
      id: "state.id"
      companyName: "'companyName' in payload ? payload.companyName : state.companyName"
      contactName: "'contactName' in payload ? payload.contactName : state.contactName"
      email: "'email' in payload ? payload.email : state.email"
      status: "'status' in payload ? payload.status : state.status"
reducers:
  - on: LeadQueried
    patches:
      - { op: replace, path: /noop, value: "event.payload.noop" }
  - on: LeadCreated
    patches:
      - { op: replace, path: /id, value: "event.payload.id" }
      - { op: replace, path: /companyName, value: "event.payload.companyName" }
      - { op: replace, path: /contactName, value: "event.payload.contactName" }
      - { op: replace, path: /email, value: "event.payload.email" }
      - { op: replace, path: /status, value: "event.payload.status" }
  - on: LeadUpdated
    patches:
      - { op: replace, path: /companyName, value: "event.payload.companyName" }
      - { op: replace, path: /contactName, value: "event.payload.contactName" }
      - { op: replace, path: /email, value: "event.payload.email" }
      - { op: replace, path: /status, value: "event.payload.status" }
initialization:
  - id: "lead-seed-001"
    companyName: "Apex Solutions"
    contactName: "Alice"
    email: "alice@apex.example.com"
    status: "new"
`;

// Keep for backward compatibility — not used in shared boot
export const LEAD_COLLECTION_DSL_YAML_UNUSED = '';

export const LEAD_COLLECTION_DSL_YAML = LEAD_DSL_YAML; // alias — kept for step imports

export const OPPORTUNITY_DSL_YAML = `
boundary: Opportunity
contract_path: /opportunities/{id}
fallback_override: false
identity:
  creation:
    generate: "$uuidv7()"
query_mapping:
  stage: "state.stage == param"
behaviors:
  - name: create-opportunity
    match:
      operationId: createOpportunity
      condition: "true"
    emit: OpportunityCreated
  - name: negotiate-opportunity
    match:
      operationId: updateOpportunity
      condition: "payload.stage == 'negotiating'"
    emit: OpportunityNegotiating
  - name: close-opportunity
    match:
      operationId: updateOpportunity
      condition: "payload.stage == 'won'"
    emit: OpportunityWon
  - name: update-opportunity
    match:
      operationId: updateOpportunity
      condition: "'value' in payload"
    emit: OpportunityUpdated
event_catalog:
  - type: OpportunityCreated
    payload_template:
      id: "command.targetId"
      leadId: "payload.leadId"
      value: "payload.value"
      stage: "'proposed'"
  - type: OpportunityNegotiating
    payload_template:
      id: "state.id"
      stage: "'negotiating'"
  - type: OpportunityWon
    payload_template:
      id: "state.id"
      stage: "'won'"
  - type: OpportunityUpdated
    payload_template:
      id: "state.id"
      value: "payload.value"
      stage: "state.stage"
reducers:
  - on: OpportunityCreated
    patches:
      - { op: replace, path: /id, value: "event.payload.id" }
      - { op: replace, path: /leadId, value: "event.payload.leadId" }
      - { op: replace, path: /value, value: "event.payload.value" }
      - { op: replace, path: /stage, value: "event.payload.stage" }
  - on: OpportunityNegotiating
    patches:
      - { op: replace, path: /stage, value: "event.payload.stage" }
  - on: OpportunityWon
    patches:
      - { op: replace, path: /stage, value: "event.payload.stage" }
  - on: OpportunityUpdated
    patches:
      - { op: replace, path: /value, value: "event.payload.value" }
      - { op: replace, path: /stage, value: "event.payload.stage" }
initialization:
  - id: "opportunity-seed-001"
    leadId: "lead-seed-001"
    value: 50000
    stage: "proposed"
`;

export const OPPORTUNITY_COLLECTION_DSL_YAML = `
boundary: OpportunityCollection
contract_path: /opportunities
fallback_override: true
query_mapping:
  stage: "state.stage == param"
behaviors:
  - name: list-opportunities
    match:
      operationId: listOpportunities
      condition: "true"
    emit: OpportunityListQueried
event_catalog:
  - type: OpportunityListQueried
    payload_template:
      result: "'listed'"
reducers:
  - on: OpportunityListQueried
    patches:
      - { op: replace, path: /result, value: "event.payload.result" }
initialization:
  - id: "opportunity-seed-001"
    leadId: "lead-seed-001"
    value: 50000
    stage: "proposed"
  - id: "opportunity-seed-002"
    leadId: "lead-seed-001"
    value: 20000
    stage: "negotiating"
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

    const openapi = await loadOpenApi(CRM_OPENAPI_YAML);
    _sharedOpenapi = openapi;

    const sys = await bootSystem({
      openapi,
      compiledDsl: await compileDsl([
        { name: 'lead', yaml: LEAD_DSL_YAML },
        { name: 'opportunity', yaml: OPPORTUNITY_DSL_YAML },
      ]),
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
    const sys = await bootSystem({ openapi, compiledDsl: await compileDsl(dslModules) });
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
