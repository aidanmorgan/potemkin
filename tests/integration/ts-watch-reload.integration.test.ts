/**
 * C6 — TypeScript watch-mode hot reload.
 *
 * When typescript.watch is true (and NODE_ENV !== 'production'), boot starts a
 * watcher whose onSwap atomic-replaces the SDK reducer registry on the
 * BootedSystem. The StateGraph survives the swap. Adding a reducer file for a
 * previously-unhandled event makes that event mutate state after the next
 * debounced rescan. watch:true + NODE_ENV=production fails fast with
 * BOOT_ERR_WATCH_IN_PRODUCTION.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';

import { bootSystem, type BootedSystem } from '../../src/engine/boot.js';
import { createGateway } from '../../src/http/gateway.js';
import { loadOpenApi } from '../../src/contract/loader.js';
import { BootError } from '../../src/errors.js';
import { registry as sdkRegistry } from '../../src/sdk/index.js';
import { registerTeardown } from '../_support/testTeardown.js';

const OPENAPI = {
  openapi: '3.0.3',
  info: { title: 'Gizmo', version: '1.0.0' },
  paths: {
    '/gizmos': {
      post: {
        operationId: 'createGizmo',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } },
        },
        responses: { '201': { description: 'created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Gizmo' } } } } },
      },
    },
    '/gizmos/{id}/tag': {
      patch: {
        operationId: 'tagGizmo',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['tag'], properties: { tag: { type: 'string' } } } } },
        },
        responses: {
          '200': { description: 'tagged', content: { 'application/json': { schema: { $ref: '#/components/schemas/Gizmo' } } } },
          '404': { description: 'nf', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
  },
  components: {
    schemas: {
      Gizmo: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'name'],
        properties: { id: { type: 'string' }, name: { type: 'string' }, tag: { type: 'string' } },
      },
      GizmoTag: { $ref: '#/components/schemas/Gizmo' },
      Error: { type: 'object', required: ['error'], properties: { error: { type: 'string' }, message: { type: 'string' } } },
    },
  },
};

const POTEMKIN_YAML = `
version: 1
specmatic: ./specmatic.yaml
modules:
  - "dsl/**/*.yaml"
typescript:
  scan:
    - include: ["scripts/**/*.ts"]
  watch: true
  watchDebounceMs: 60
`;

const GIZMO_DSL = `
boundary: Gizmo
contract_path: /gizmos
identity:
  creation:
    generate: $uuidv7()
event_catalog:
  - type: GizmoCreated
    payload_template:
      id: "command.targetId"
      name: "command.payload.name"
behaviors:
  - name: createGizmo
    match:
      operationId: createGizmo
      condition: "true"
    emit: GizmoCreated
`;

const GIZMO_TAG_DSL = `
boundary: GizmoTag
contract_path: /gizmos/{id}/tag
event_catalog:
  - type: GizmoTagged
    payload_template:
      tag: "command.payload.tag"
behaviors:
  - name: tagGizmo
    match:
      operationId: tagGizmo
      condition: "true"
    emit: GizmoTagged
`;

const GIZMO_CREATED_REDUCER = `
import { reducer, replace } from '@potemkin/sdk';
export const onGizmoCreated = reducer(
  { boundary: 'Gizmo', event: 'GizmoCreated' },
  (_s, event) => {
    const e = event;
    return [replace('/id', e.payload.id), replace('/name', e.payload.name)];
  },
  'scripts/gizmoCreated.ts',
);
`;

// Added at runtime to demonstrate hot reload — registers a reducer for the
// previously-unhandled GizmoTagged event on the GizmoTag boundary.
const GIZMO_TAGGED_REDUCER = `
import { reducer, replace } from '@potemkin/sdk';
export const onGizmoTagged = reducer(
  { boundary: 'GizmoTag', event: 'GizmoTagged' },
  (_s, event) => [replace('/tag', event.payload.tag)],
  'scripts/gizmoTagged.ts',
);
`;

async function makeFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'potemkin-watch-'));
  await fs.mkdir(path.join(root, 'dsl'), { recursive: true });
  await fs.mkdir(path.join(root, 'scripts'), { recursive: true });
  await fs.writeFile(path.join(root, 'potemkin.yaml'), POTEMKIN_YAML, 'utf8');
  await fs.writeFile(path.join(root, 'specmatic.yaml'), 'version: 3\n', 'utf8');
  await fs.writeFile(path.join(root, 'dsl', 'gizmo.yaml'), GIZMO_DSL, 'utf8');
  await fs.writeFile(path.join(root, 'dsl', 'gizmo-tag.yaml'), GIZMO_TAG_DSL, 'utf8');
  await fs.writeFile(path.join(root, 'scripts', 'gizmoCreated.ts'), GIZMO_CREATED_REDUCER, 'utf8');
  return root;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('C6: watch:true hot-reloads the reducer registry; StateGraph survives', () => {
  it('a reducer file added at runtime starts mutating state after the rescan', async () => {
    const root = await makeFixture();
    const openapi = await loadOpenApi(OPENAPI as object);
    const sys: BootedSystem = await bootSystem({
      openapi,
      potemkinConfigPath: path.join(root, 'potemkin.yaml'),
    });
    expect(sys.tsWatcher).toBeDefined();
    registerTeardown(() => sys.tsWatcher?.stop());

    const agent = request(createGateway(sys));

    // Create a gizmo — the GizmoCreated TS reducer (present at boot) fires.
    const created = await agent.post('/gizmos').send({ name: 'Original' }).expect(201);
    const id = created.body.id as string;
    expect(created.body.name).toBe('Original');

    // Before the GizmoTagged reducer exists, tagging applies no patches: the
    // tag field stays absent (state unchanged by the event).
    await agent.patch(`/gizmos/${id}/tag`).send({ tag: 'before' }).expect(200);
    let state = sys.graph.get(id);
    expect(state!['tag']).toBeUndefined();
    // StateGraph still holds the create fields.
    expect(state!['name']).toBe('Original');

    // Add a reducer file for GizmoTagged at runtime and wait for the watcher.
    await fs.writeFile(path.join(root, 'scripts', 'gizmoTagged.ts'), GIZMO_TAGGED_REDUCER, 'utf8');

    // Poll the registry until the swap lands (debounce + rescan + transpile).
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !sys.tsReducerRegistry.get('GizmoTag', 'GizmoTagged')) {
      await delay(50);
    }
    expect(sys.tsReducerRegistry.get('GizmoTag', 'GizmoTagged')).toBeDefined();

    // Now tagging applies the freshly-loaded reducer's patch.
    await agent.patch(`/gizmos/${id}/tag`).send({ tag: 'after' }).expect(200);
    state = sys.graph.get(id);
    expect(state!['tag']).toBe('after');
    // StateGraph survived the registry swap — the original create fields remain.
    expect(state!['id']).toBe(id);
    expect(state!['name']).toBe('Original');

    await sys.tsWatcher!.stop();
    await sdkRegistry.reset();
  }, 20000);
});

describe('C6: watch:true + NODE_ENV=production fails fast', () => {
  const prev = process.env['NODE_ENV'];
  afterEach(() => {
    if (prev === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = prev;
  });

  it('throws BOOT_ERR_WATCH_IN_PRODUCTION', async () => {
    const root = await makeFixture();
    process.env['NODE_ENV'] = 'production';
    const openapi = await loadOpenApi(OPENAPI as object);
    let caught: BootError | null = null;
    try {
      await bootSystem({ openapi, potemkinConfigPath: path.join(root, 'potemkin.yaml') });
    } catch (e) {
      caught = e instanceof BootError ? e : null;
    }
    expect(caught?.code).toBe('BOOT_ERR_WATCH_IN_PRODUCTION');
  });
});
