/**
 * Inline banking fixture that provides a minimal equivalent of the canonical
 * `tests/fixtures/index.ts` (written by the fixtures parallel agent).
 *
 * When the fixtures agent's `tests/fixtures/index.ts` is merged, the acceptance
 * and integration tests import from there instead.  Until then, this file acts
 * as the thin local stand-in.
 *
 * Specification (from task brief):
 *  - OpenAPI defines `/customers` (Customer schema) and `/loans` (LoanAccount schema).
 *  - Initial customers: id `00000000-0000-7000-8000-000000000001` (Acme Coffee, LOW)
 *                       id `00000000-0000-7000-8000-000000000002` (Beta Builders, MED)
 *  - No initial LoanAccounts.
 *
 * Architecture note on paths and boundary names:
 *  Each OpenAPI `contract_path` maps to exactly one DSL boundary (unique name).
 *  The schema registry maps boundary names to `components.schemas.{boundaryName}`.
 *  We therefore duplicate the Customer/LoanAccount schemas under sub-path names
 *  (CustomerById, LoanById, LoanDisburse, LoanRepay) so each DSL boundary has a
 *  matching component schema.  `fallback_override: true` is used on sub-path
 *  boundaries where we want generic CRUD semantics without explicit behavior rules.
 */

import type { BootInput } from '../../../src/engine/boot.js';
import { loadOpenApi } from '../../../src/contract/loader.js';

// ---------------------------------------------------------------------------
// Inline OpenAPI specification
// ---------------------------------------------------------------------------

const BANKING_OPENAPI_YAML = `
openapi: "3.0.3"
info:
  title: Banking Fixture API
  version: "1.0.0"
paths:
  /customers:
    get:
      operationId: listCustomers
      parameters:
        - name: riskBand
          in: query
          required: false
          schema:
            type: string
        - name: limit
          in: query
          required: false
          schema:
            type: integer
        - name: offset
          in: query
          required: false
          schema:
            type: integer
      responses:
        "200":
          description: List of customers
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: "#/components/schemas/Customer"
    post:
      operationId: createCustomer
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/CustomerInput"
      responses:
        "201":
          description: Created customer
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Customer"
        "400":
          description: Contract violation
          content:
            application/json:
              schema:
                type: object
        "409":
          description: Entity conflict
          content:
            application/json:
              schema:
                type: object
  /customers/{id}:
    get:
      operationId: getCustomer
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        "200":
          description: Customer
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Customer"
        "404":
          description: Not found
          content:
            application/json:
              schema:
                type: object
  /loans:
    get:
      operationId: listLoans
      parameters:
        - name: customerId
          in: query
          required: false
          schema:
            type: string
        - name: limit
          in: query
          required: false
          schema:
            type: integer
        - name: offset
          in: query
          required: false
          schema:
            type: integer
      responses:
        "200":
          description: List of loans
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: "#/components/schemas/LoanAccount"
    post:
      operationId: createLoan
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/LoanInput"
      responses:
        "201":
          description: Created loan
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/LoanAccount"
        "400":
          description: Contract violation
          content:
            application/json:
              schema:
                type: object
        "404":
          description: Customer not found
          content:
            application/json:
              schema:
                type: object
  /loans/{id}:
    get:
      operationId: getLoan
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        "200":
          description: Loan account
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/LoanAccount"
        "404":
          description: Not found
          content:
            application/json:
              schema:
                type: object
  /loans/{id}/disburse:
    post:
      operationId: disburseLoan
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      requestBody:
        required: false
        content:
          application/json:
            schema:
              type: object
      responses:
        "200":
          description: Disbursed loan
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/LoanAccount"
        "404":
          description: Not found
          content:
            application/json:
              schema:
                type: object
  /loans/{id}/repay:
    post:
      operationId: repayLoan
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
              type: object
              properties:
                amount:
                  type: number
              required:
                - amount
      responses:
        "200":
          description: Updated loan after repayment
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/LoanAccount"
        "404":
          description: Not found
          content:
            application/json:
              schema:
                type: object
components:
  schemas:
    Customer:
      type: object
      properties:
        id:
          type: string
        name:
          type: string
        riskBand:
          type: string
        createdAt:
          type: string
        loanIds:
          type: array
          items:
            type: string
      required:
        - id
        - name
        - riskBand
    CustomerById:
      type: object
      properties:
        id:
          type: string
        name:
          type: string
        riskBand:
          type: string
        createdAt:
          type: string
        loanIds:
          type: array
          items:
            type: string
      required:
        - id
        - name
        - riskBand
    CustomerInput:
      type: object
      properties:
        name:
          type: string
        riskBand:
          type: string
      required:
        - name
        - riskBand
    LoanAccount:
      type: object
      properties:
        id:
          type: string
        customerId:
          type: string
        principal:
          type: number
        balance:
          type: number
        status:
          type: string
        openedAt:
          type: string
        transactions:
          type: array
          items:
            type: object
            properties:
              type:
                type: string
              amount:
                type: number
              at:
                type: string
      required:
        - id
        - customerId
        - principal
        - balance
        - status
    LoanById:
      type: object
      properties:
        id:
          type: string
        customerId:
          type: string
        principal:
          type: number
        balance:
          type: number
        status:
          type: string
        openedAt:
          type: string
        transactions:
          type: array
          items:
            type: object
            properties:
              type:
                type: string
              amount:
                type: number
              at:
                type: string
      required:
        - id
        - customerId
        - principal
        - balance
        - status
    LoanDisburse:
      type: object
      properties:
        id:
          type: string
        customerId:
          type: string
        principal:
          type: number
        balance:
          type: number
        status:
          type: string
        openedAt:
          type: string
        transactions:
          type: array
          items:
            type: object
            properties:
              type:
                type: string
              amount:
                type: number
              at:
                type: string
      required:
        - id
        - customerId
        - principal
        - balance
        - status
    LoanRepay:
      type: object
      properties:
        id:
          type: string
        customerId:
          type: string
        principal:
          type: number
        balance:
          type: number
        status:
          type: string
        openedAt:
          type: string
        transactions:
          type: array
          items:
            type: object
            properties:
              type:
                type: string
              amount:
                type: number
              at:
                type: string
      required:
        - id
        - customerId
        - principal
        - balance
        - status
    LoanInput:
      type: object
      properties:
        customerId:
          type: string
        principal:
          type: number
      required:
        - customerId
        - principal
`;

// ---------------------------------------------------------------------------
// Inline DSL modules
// ---------------------------------------------------------------------------

// /customers  — collection: creation + list query
const CUSTOMER_DSL_YAML = `
boundary: Customer
contract_path: /customers
fallback_override: true
identity:
  creation:
    generate: "$uuidv7()"
query_mapping:
  riskBand: "state.riskBand == param"
initialization:
  - id: "00000000-0000-7000-8000-000000000001"
    name: "Acme Coffee"
    riskBand: "LOW"
    createdAt: "1970-01-01T00:00:00.000Z"
    loanIds: []
  - id: "00000000-0000-7000-8000-000000000002"
    name: "Beta Builders"
    riskBand: "MED"
    createdAt: "1970-01-01T00:00:00.000Z"
    loanIds: []
event_catalog:
  - type: CustomerCreated
    payload_template:
      id: "command.targetId"
      name: "command.payload.name"
      riskBand: "command.payload.riskBand"
      createdAt: "$now()"
      loanIds: "[]"
  - type: LoanAttachedToCustomer
    payload_template:
      loanId: "command.payload.loanId"
behaviors:
  - name: create-customer
    match:
      intent: creation
      condition: "true"
    emit: CustomerCreated
  - name: attach-loan
    match:
      intent: mutation
      condition: "true"
    emit: LoanAttachedToCustomer
reducers:
  - on: CustomerCreated
    assign:
      id: "event.payload.id"
      name: "event.payload.name"
      riskBand: "event.payload.riskBand"
      createdAt: "event.payload.createdAt"
      loanIds: "[]"
  - on: LoanAttachedToCustomer
    append:
      loanIds: "event.payload.loanId"
`;

// /customers/{id}  — single entity read (fallback_override handles GET)
const CUSTOMER_BY_ID_DSL_YAML = `
boundary: CustomerById
contract_path: /customers/{id}
fallback_override: true
event_catalog: []
behaviors: []
reducers: []
`;

// /loans  — collection: creation + list query
const LOAN_DSL_YAML = `
boundary: LoanAccount
contract_path: /loans
fallback_override: false
identity:
  creation:
    generate: "$uuidv7()"
event_catalog:
  - type: LoanCreated
    payload_template:
      id: "command.targetId"
      customerId: "command.payload.customerId"
      principal: "command.payload.principal"
      balance: "command.payload.principal"
      status: "'OPEN'"
      openedAt: "$now()"
      transactions: "[]"
behaviors:
  - name: create-loan
    match:
      intent: creation
      condition: "true"
    emit: LoanCreated
    dispatch_commands:
      - boundary: Customer
        intent: mutation
        target_id: "command.payload.customerId"
        payload:
          loanId: "command.targetId"
reducers:
  - on: LoanCreated
    assign:
      id: "event.payload.id"
      customerId: "event.payload.customerId"
      principal: "event.payload.principal"
      balance: "event.payload.balance"
      status: "event.payload.status"
      openedAt: "event.payload.openedAt"
      transactions: "[]"
`;

// /loans/{id}  — single entity read
const LOAN_BY_ID_DSL_YAML = `
boundary: LoanById
contract_path: /loans/{id}
fallback_override: true
event_catalog: []
behaviors: []
reducers: []
`;

// /loans/{id}/disburse  — mutation: set status ACTIVE
const LOAN_DISBURSE_DSL_YAML = `
boundary: LoanDisburse
contract_path: /loans/{id}/disburse
fallback_override: false
event_catalog:
  - type: LoanDisbursed
    payload_template:
      status: "'ACTIVE'"
behaviors:
  - name: disburse-loan
    match:
      intent: mutation
      condition: "true"
    emit: LoanDisbursed
reducers:
  - on: LoanDisbursed
    assign:
      status: "event.payload.status"
`;

// /loans/{id}/repay  — mutation: reduce balance, append transaction, maybe SETTLE
const LOAN_REPAY_DSL_YAML = `
boundary: LoanRepay
contract_path: /loans/{id}/repay
fallback_override: false
event_catalog:
  - type: LoanRepaid
    payload_template:
      amount: "command.payload.amount"
behaviors:
  - name: repay-loan
    match:
      intent: mutation
      condition: "true"
    emit: LoanRepaid
reducers:
  - on: LoanRepaid
    assign:
      balance: "state.balance - event.payload.amount"
      status: "(state.balance - event.payload.amount) <= 0 ? 'SETTLED' : state.status"
    append:
      transactions: "{'type': 'repayment', 'amount': event.payload.amount, 'at': event.timestamp}"
`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BankingFixture extends BootInput {
  readonly customerIds: {
    readonly acmeCoffee: string;
    readonly betaBuilders: string;
  };
}

export async function loadBankingFixture(): Promise<BankingFixture> {
  const openapi = await loadOpenApi(BANKING_OPENAPI_YAML);

  const dslModules = [
    { name: 'customer', yaml: CUSTOMER_DSL_YAML },
    { name: 'customerById', yaml: CUSTOMER_BY_ID_DSL_YAML },
    { name: 'loan', yaml: LOAN_DSL_YAML },
    { name: 'loanById', yaml: LOAN_BY_ID_DSL_YAML },
    { name: 'loanDisburse', yaml: LOAN_DISBURSE_DSL_YAML },
    { name: 'loanRepay', yaml: LOAN_REPAY_DSL_YAML },
  ];

  return {
    openapi,
    dslModules,
    customerIds: {
      acmeCoffee: '00000000-0000-7000-8000-000000000001',
      betaBuilders: '00000000-0000-7000-8000-000000000002',
    },
  };
}
