# Potemkin VS Code support

This extension starts the unified `potemkin-language-server` for YAML and TypeScript documents.

## Use it in a Potemkin project

1. Install the runtime package in the project that contains `potemkin.yml`:

   ```sh
   pnpm add potemkin
   # or: npm install potemkin
   ```

2. Build the language-server package and the VS Code extension from a local
   checkout:

   ```sh
   pnpm run package:language-server
   pnpm run package:vscode
   ```

   Install the generated `.artifacts/potemkin-*.tgz` into the project that
   contains `potemkin.yml`, then install the generated `.vsix` with **Extensions:
   Install from VSIX...**. For extension-only development, run the extension in
   a development host:

   ```sh
   pnpm install
   pnpm build
   code --extensionDevelopmentPath=/absolute/path/to/potemkin/editors/vscode /absolute/path/to/project
   ```

3. Open the project root—the folder containing `potemkin.yml`. The extension
   automatically uses the project's local `node_modules/.bin/potemkin-language-server`.

The optional workspace settings below are useful when the configuration file
has a non-default name or when developing against a local Potemkin checkout:

```json
{
  "potemkin.configPath": "config/potemkin.yml",
  "potemkin.languageServer.command": "/absolute/path/to/project/node_modules/.bin/potemkin-language-server"
}
```

Leave `potemkin.languageServer.command` empty for the normal workspace-local
installation. The command must be an executable language-server process; do
not add `pnpm exec` as a single command string.

The server watches the open documents in memory, merges them with the configured OpenAPI and scenario sources, and publishes diagnostics, event/operation completions, and cross-language definitions. It also refreshes the ignored `.potemkin/` declarations and YAML schema automatically.

The language server writes generated files to `.potemkin/` at the language
server process working directory by default:

- `openapi.d.ts` — OpenAPI operation and schema types;
- `potemkin-sdk.d.ts` — typed event and operation registries;
- `potemkin.schema.json` — YAML authoring schema for editor validation.

After installation, open a YAML or TypeScript authoring file and confirm that
completion offers a configured operation or event. Edit an event name in YAML;
the generated declarations under `.potemkin/` and diagnostics should update
without restarting VS Code. The CLI and TypeScript plugin retain their own
`gen-src/` default unless an output directory is configured explicitly.
