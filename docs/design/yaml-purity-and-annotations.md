# YAML purity and TypeScript configuration factories

YAML remains declarative: it contains boundaries, policies, CEL expressions, and
references to OpenAPI operations. TypeScript is loaded separately through the
configured scan globs. The two authoring paths meet at the canonical runtime
model.

## Factory discovery

The scanner parses selected TypeScript modules with the TypeScript AST and
invokes only static methods decorated with the exact `@PotemkinConfigure`
decorator imported from `potemkin/sdk`:

```typescript
import { PotemkinConfigure, defineHelper, simulation } from 'potemkin/sdk';

const sourceLabel = defineHelper('sourceLabel', (value: string) => value);

class SharedConfiguration {
  @PotemkinConfigure('shared')
  static create() {
    return simulation().helper(sourceLabel).build();
  }
}
```

The configured include/exclude globs identify entry modules. Relative imports
from an entry module may be loaded as dependencies, including files excluded
from discovery. An imported module is not itself a configuration factory unless
its static method has the canonical decorator and is discovered by the AST
scanner. Evaluated dependencies are also included in the watcher snapshot, so
changes to an imported excluded helper reload the runtime; an excluded file
that is not imported remains ignored.

## Shared helpers

`defineHelper` returns a typed callable and a source-independent helper
definition. Registering it with `.helper()` puts the definition
in the model. The YAML compiler receives those definitions before compiling CEL:

```yaml
event_catalog:
  - type: ThingCreated
    payload_template:
      source: 'sourceLabel(command.payload.source)'
```

There is no sentinel declaration. Helper names are CEL identifiers,
duplicate registrations fail canonical compilation, and helper results must be
JSON values. TypeScript callbacks may call the helper directly, while YAML CEL
uses its registered model name.

## Layering

```text
YAML parser + CEL ───────┐
                         ├─> model ─> runtime engine ─> HTTP gateway
TypeScript SDK + loader ─┘
```

The runtime receives the same boundary, policy, callback, reducer, and helper
shapes from either source. It does not branch on the authoring language. The
single `potemkin.yml` path is supplied through the CLI or environment; its YAML,
OpenAPI, and TypeScript globs are monitored and a change triggers a clear-and-
reload operation. `POST /_admin/force-reload` performs the operation immediately.
