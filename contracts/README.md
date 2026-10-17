# contracts

The wire contract between the Python plugin and the Worker, defined once and used by both languages.

Planned contents:

- **Schemas** for the control API, the MCP gateway, wake tickets and error codes. These are the source of truth.
- **Exported JSON Schema**, from which the Python models are generated.
- **Golden fixtures**: example requests and responses that both test suites parse. CI fails if the generated Python models drift from the schemas.

Owned by the scaffolding workstream. Other workstreams propose changes through it.
