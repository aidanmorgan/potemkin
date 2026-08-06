import { parse } from 'yaml';
import { prepareMixedYaml } from '../../../src/parser/mixed';
import type { ComponentDefinition } from '../../../src/authoring/types';
import { componentName } from '../../../src/domain/references';

describe('mixed YAML preparation', () => {
  it('preserves non-object include entries while extracting TypeScript components', () => {
    const component: ComponentDefinition = {
      name: componentName('payments'),
      instantiate: () => ({}),
    };

    const prepared = prepareMixedYaml(
      {
        modules: [
          {
            name: 'orders.yaml',
            yaml: 'boundary: orders\ninclude:\n  - null\n  - component: payments\n',
          },
        ],
      },
      new Map([[component.name, component]]),
    );

    expect(prepared.includes).toEqual([{ boundary: 'orders', component }]);
    expect(parse(prepared.input.modules[0]?.yaml ?? '')).toEqual({
      boundary: 'orders',
      include: [null],
    });
  });

  it('preserves YAML merge keys while extracting TypeScript components', () => {
    const component: ComponentDefinition = {
      name: componentName('payments'),
      instantiate: () => ({}),
    };

    const prepared = prepareMixedYaml(
      {
        modules: [
          {
            name: 'orders.yaml',
            yaml: `
defaults: &defaults
  include:
    - component: payments
boundary: orders
<<: *defaults
`,
          },
        ],
      },
      new Map([[component.name, component]]),
    );

    expect(prepared.includes).toEqual([{ boundary: 'orders', component }]);
    expect(parse(prepared.input.modules[0]?.yaml ?? '')).toMatchObject({
      boundary: 'orders',
      defaults: { include: [{ component: 'payments' }] },
    });
    expect(parse(prepared.input.modules[0]?.yaml ?? '')).not.toHaveProperty('include');
  });

  it('retains js-yaml-compatible scalar semantics when rewriting modules', () => {
    const component: ComponentDefinition = {
      name: componentName('payments'),
      instantiate: () => ({}),
    };

    const prepared = prepareMixedYaml(
      {
        modules: [
          {
            name: 'orders.yaml',
            yaml: `
boundary: orders
include:
  - component: payments
  - name: 'yes'
    enabled: true
`,
          },
        ],
      },
      new Map([[component.name, component]]),
    );

    expect(parse(prepared.input.modules[0]?.yaml ?? '')).toEqual({
      boundary: 'orders',
      include: [{ name: 'yes', enabled: true }],
    });
  });

  it('preserves useful line diagnostics for malformed mixed YAML', () => {
    const component: ComponentDefinition = {
      name: componentName('payments'),
      instantiate: () => ({}),
    };

    expect(() =>
      prepareMixedYaml(
        {
          modules: [
            {
              name: 'orders.yaml',
              yaml: 'boundary: orders\ninclude:\n  - component: payments\n    component: duplicate\n',
            },
          ],
        },
        new Map([[component.name, component]]),
      ),
    ).toThrow(/line 4, column 5/);
  });
});
