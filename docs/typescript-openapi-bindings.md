# Automatic TypeScript OpenAPI bindings

Potemkin generates declaration-only OpenAPI bindings, a generated SDK event registry, and a combined YAML JSON Schema into `gen-src/`. The directory is ignored by git and is recreated from the contract and scenario files, so generated files are never part of the simulation authoring API or runtime model.

For complete cross-language support, use the unified language server. It watches open YAML and TypeScript buffers in memory, merges them with the configured OpenAPI and scenario sources, and publishes diagnostics, completions, and definitions from one graph. Unlike the CLI and TypeScript plugin, the language server writes its generated files to `.potemkin/` relative to the directory from which the server process is launched:

```sh
potemkin-language-server
```

The server is also available as `potemkin language-server`. The VS Code client is in `editors/vscode`; IntelliJ can register the same stdio server using the setup in `editors/intellij/README.md`. No generated source command is required while an editor is connected.

From a local checkout, build the installable artifacts with:

```sh
pnpm run package:language-server
pnpm run package:vscode
```

The npm tarball and VS Code extension are written to `.artifacts/`. Install the
tarball in the simulation project; both VS Code and IntelliJ then launch the
same project-local `potemkin-language-server` binary.

## IDE setup

Add the Potemkin TypeScript language-service plugin to the project `tsconfig.json`:

```json
{
  "compilerOptions": {
    "plugins": [
      {
        "name": "potemkin/typescript-plugin",
        "configPath": "./potemkin.yml"
      }
    ]
  }
}
```

The plugin discovers `potemkin.yml`, generates the OpenAPI declarations in `gen-src`, and watches the contract and configuration. Both generated declarations are registered as TypeScript external files, so they can be imported without adding generated files to `include`:

```ts
import type {
  Operation,
  OperationId,
  Path,
  Request,
  Response,
  Schema,
  SchemaName,
} from 'potemkin/openapi';
import { eventType } from 'potemkin/sdk';

type Id = OperationId;
type CreateAgentRequest = Request<'createAgent'>;
type GetAgentResponse = Response<'getAgent', 200>;
type CreateAgentOperation = Operation<'createAgent'>;
type AgentPath = Extract<Path, '/agents'>;
type AgentSchema = Schema<Extract<SchemaName, 'Agent'>>;
const created = eventType('AgentCreated');
```

`potemkin-sdk.d.ts` augments the real SDK module rather than replacing it. When the scenario contains known events, `eventType("UnknownEvent")` is a TypeScript error and the event payload fields are available through `ScenarioEventRegistry`/`ScenarioEvents`. Generated `ScenarioPathRegistry` and `ScenarioSchemaRegistry` expose the same project-scoped path and schema names, while operation entries link request and response declarations back to the OpenAPI module.

The same watcher generates `.potemkin/potemkin.schema.json` for language-server clients. It combines OpenAPI paths, operationIds, and component names with event catalogs found in the Potemkin boundary/component YAML files. As a result, event references such as `behaviors[].emit`, `reducers[].on`, and `reactions[].on` are offered as completions and checked against the current simulation model.

For VS Code with the YAML language-support extension, associate the generated schema once in workspace settings:

```json
{
  "yaml.schemas": {
    "./.potemkin/potemkin.schema.json": ["potemkin.yml", "**/dsl/**/*.yaml", "**/dsl/**/*.yml"]
  }
}
```

For IntelliJ IDEA, register the unified stdio language server first. The generated JSON Schema mapping described above remains a useful fallback for IDEs or files that do not use the LSP client; it is updated whenever either the OpenAPI document or a Potemkin YAML module changes.

Use the project TypeScript language service in VS Code and IntelliJ IDEA. If an IDE does not load third-party TypeScript plugins, the same shared watcher can be used as an IDE-managed background task:

```sh
potemkin generate-types ./potemkin.yml --watch
```

A one-shot generation is also available for CI or a local type-check command:

```sh
potemkin generate-types ./potemkin.yml
```

The generator uses `openapi-typescript` for contract-to-TypeScript transformation and Eta for the Potemkin declaration-module template. The OpenAPI source document is kept separate from the dereferenced runtime document so reusable components and `$ref` relationships remain available to the type generator.
