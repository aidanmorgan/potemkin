# Potemkin IntelliJ support

## Prerequisites

Install the Potemkin package in the project that contains `potemkin.yml`:

```sh
pnpm add potemkin
# or: npm install potemkin
```

For a local checkout, create the installable package first:

```sh
pnpm run package:language-server
npm install /absolute/path/to/potemkin/.artifacts/potemkin-<version>.tgz
```

Enable IntelliJ's Language Server Protocol support. Depending on the IDE
edition and version, this is supplied by the bundled LSP support or by the
**Language Server Protocol** plugin.

## Register the server

Open **Settings | Languages & Frameworks | Language Servers**, add a project
server, and use:

```text
Command: /absolute/path/to/project/node_modules/.bin/potemkin-language-server
Transport: stdio
Arguments: none
Working directory: the project root containing potemkin.yml
```

Register YAML (`*.yaml`, `*.yml`) and TypeScript (`*.ts`, `*.tsx`) as the
document languages and set the project root as the server root. The server
discovers `potemkin.yml` automatically.

If the IDE exposes LSP initialization options, use this JSON for a non-default
configuration path:

```json
{
  "configPath": "config/potemkin.yml",
  "outputDirectory": ".potemkin"
}
```

Omit `outputDirectory` to use `.potemkin/` relative to the directory from which
the language-server process is launched.

For a local Potemkin checkout without installing the tarball, run
`pnpm run build:language-server` and point the command directly at the built
`dist/src/language-server/server.js` executable. The build marks the server
entrypoint executable for IntelliJ's stdio launcher.

The same server provides cross-language diagnostics, completions, and definitions. The generated `.potemkin/openapi.d.ts`, `.potemkin/potemkin-sdk.d.ts`, and `.potemkin/potemkin.schema.json` remain ignored derived files; they are not added to source control.

## Verify the setup

Open a configured YAML boundary and a TypeScript authoring file. Completion
should offer configured operation IDs and event names. Change an event or
operation in an open document and confirm that diagnostics and the generated
files in `.potemkin/` update without restarting IntelliJ. The server uses stdio,
so if no diagnostics appear, first run the configured command in a terminal and
confirm it starts without writing non-protocol output to stdout.
