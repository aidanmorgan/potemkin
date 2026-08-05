# Public API and adapter inventory

`public-api-inventory.json` is the checked-in public-surface record. The
`verify:public-api` gate validates it against `package.json` and the TypeScript
module graph, including every named export from each package facade.

The package facades are the only supported external API surfaces. Their owners
are foundation contracts (`.`), YAML/project compilation (`./parser`,
`./project`), the source-neutral model (`./model`), runtime composition
(`./runtime`), HTTP and OpenAPI adapters (`./http`, `./contract`), the authoring
SDK (`./sdk`), generation (`./generation`), and editor adapters
(`./language-server`, `./typescript-plugin`).

The inventory also records the two executable bins, all composition roots, and
the canonical owner of every adapter boundary. No legacy subpath, compatibility
barrel, or implementation-only module is part of the package export set.
