import { boundaryName, contractPath, pathSegment } from '../../src/domain/references.js';
import request from 'supertest';
import { loadOpenApi } from '../../src/contract/loader.js';
import { createRuntimeGateway } from '../../src/http/runtimeGateway.js';
import { bootRuntime, type RuntimeSystem } from '../../src/runtime/system.js';
import { createDefaultRuntimeHost } from '../../src/runtime/host.js';
import { bootYamlRuntime } from '../../src/parser/runtime.js';
import { compileProgram } from '../../src/authoring/compiler.js';
import { boundary, simulation } from '../../src/authoring/builders.js';

const OPENAPI = `
openapi: "3.0.3"
info: { title: Response shaping parity, version: "1.0.0" }
paths:
  /items:
    get:
      operationId: listItems
      responses:
        "200":
          description: Items
          content:
            application/json:
              schema:
                oneOf:
                  - type: array
                    items: { $ref: "#/components/schemas/Item" }
                  - type: object
                    required: [items, totalCount, offset, limit, hasMore]
                    properties:
                      items: { type: array, items: { $ref: "#/components/schemas/Item" } }
                      totalCount: { type: integer }
                      offset: { type: integer }
                      limit: { type: integer }
                      hasMore: { type: boolean }
components:
  schemas:
    Item:
      type: object
      required: [id, name, secret]
      properties:
        id: { type: string }
        name: { type: string }
        secret: { type: string }
`;

const INITIALIZATION = [
  { id: 'item-a', name: 'Alpha', secret: 'a-secret' },
  { id: 'item-b', name: 'Beta', secret: 'b-secret' },
] as const;

const YAML = `
boundary: Item
contract_path: /items
initialization:
  - { id: item-a, name: Alpha, secret: a-secret }
  - { id: item-b, name: Beta, secret: b-secret }
`;

function typescriptDefinition() {
  return simulation()
    .boundary(
      boundary(boundaryName('Item'), contractPath(pathSegment('items')))
        .initialization(...INITIALIZATION)
        .build(),
    )
    .build();
}

async function bootPair(): Promise<[RuntimeSystem, RuntimeSystem]> {
  const openapi = await loadOpenApi(OPENAPI);
  return Promise.all([
    bootYamlRuntime({
      host: createDefaultRuntimeHost(),
      openapi,
      yamlProgram: { modules: [{ name: 'items.yaml', yaml: YAML }] },
    }),
    bootRuntime({
      host: createDefaultRuntimeHost(),
      openapi,
      programFactory: ({ dependencies }) =>
        compileProgram(typescriptDefinition(), { dependencies, openapi }),
    }),
  ]);
}

describe('runtime response shaping parity', () => {
  it('keeps validation-shaped data, pagination styles, alternate formats, and masks equivalent', async () => {
    const [yamlSystem, typescriptSystem] = await bootPair();
    try {
      const yamlApp = createRuntimeGateway(yamlSystem);
      const typescriptApp = createRuntimeGateway(typescriptSystem);
      const requestShapes = async (app: ReturnType<typeof createRuntimeGateway>) => {
        const raw = await request(app).get('/items').set('X-Potemkin-Pagination-Style', 'raw');
        const envelope = await request(app)
          .get('/items?limit=1')
          .set('X-Potemkin-Pagination-Style', 'envelope');
        const links = await request(app)
          .get('/items?limit=1')
          .set('X-Potemkin-Pagination-Style', 'link-header');
        const hal = await request(app).get('/items').set('X-Potemkin-Response-Format', 'hal');
        const jsonapi = await request(app)
          .get('/items')
          .set('X-Potemkin-Response-Format', 'jsonapi');
        const masked = await request(app).get('/items').set('X-Potemkin-Mask', 'secret');
        return { raw, envelope, links, hal, jsonapi, masked };
      };
      const [yaml, typescript] = await Promise.all([
        requestShapes(yamlApp),
        requestShapes(typescriptApp),
      ]);

      expect(typescript.raw.body).toEqual(yaml.raw.body);
      expect(yaml.raw.body).toEqual(INITIALIZATION);
      expect(typescript.envelope.body).toEqual(yaml.envelope.body);
      expect(yaml.envelope.body).toMatchObject({
        items: [INITIALIZATION[0]],
        totalCount: 2,
        offset: 0,
        limit: 1,
        hasMore: true,
      });
      expect(typescript.links.body).toEqual(yaml.links.body);
      expect(yaml.links.headers['x-total-count']).toBe('2');
      expect(yaml.links.headers.link).toContain('rel="next"');
      expect(typescript.hal.body).toEqual(yaml.hal.body);
      expect(yaml.hal.body).toMatchObject({
        _embedded: { items: INITIALIZATION },
        _links: { self: { href: '/items' } },
      });
      expect(typescript.jsonapi.body).toEqual(yaml.jsonapi.body);
      expect(yaml.jsonapi.body).toEqual({
        data: INITIALIZATION.map(({ id, name, secret }) => ({
          type: 'Item',
          id,
          attributes: { name, secret },
        })),
      });
      expect(typescript.masked.body).toEqual(yaml.masked.body);
      expect(yaml.masked.body).toEqual([
        { id: 'item-a', name: 'Alpha', secret: '[MASKED]' },
        { id: 'item-b', name: 'Beta', secret: '[MASKED]' },
      ]);
      expect((await request(yamlApp).get('/_admin/state')).body.entities['item-a'].secret).toBe(
        'a-secret',
      );
      expect(
        (await request(typescriptApp).get('/_admin/state')).body.entities['item-a'].secret,
      ).toBe('a-secret');
    } finally {
      await Promise.all([yamlSystem.dispose(), typescriptSystem.dispose()]);
    }
  });
});
