# Project-level feature ownership

`potemkin.yml` contains two kinds of project configuration. Runtime-owned
settings select and compile Potemkin authoring inputs. Specmatic-plugin-owned
settings control contract serving, forwarding, fixtures, overlays, and project
reporting.

The shared authoring descriptor exposes this boundary as
`ScenarioModel.projectFeatures`. It reports whether a feature is configured,
its owner, and the surfaces that validate or consume it. It intentionally does
not copy plugin configuration values into generated SDK bindings or runtime
simulation definitions; this keeps credentials and transport controls outside
the simulation model.

| Feature                            | Owner            | Schema/LSP | Runtime effect                             |
| ---------------------------------- | ---------------- | ---------- | ------------------------------------------ |
| `modules`, `openapi`, `typescript` | Potemkin runtime | yes        | selects contract and authoring inputs      |
| `specmatic`                        | Specmatic plugin | yes        | contract discovery and forwarding          |
| `plugin`                           | Specmatic plugin | yes        | transport, resilience, discovery, and auth |
| `seeds`                            | Specmatic plugin | yes        | forwarded Specmatic fixtures               |
| `workflow`                         | Specmatic plugin | yes        | forwarded request-id extraction/use        |
| `overlay`                          | Specmatic plugin | yes        | contract overlay applied by Specmatic      |
| `governance`                       | Specmatic plugin | yes        | Specmatic reporting and success criteria   |

Plugin-owned blocks are supported authoring configuration and are covered by
the forwarding E2E fixtures, but they are not simulation-definition fields.
Changing them refreshes the language-service project snapshot without changing
the Node runtime model.
