# Docs

Reference documentation for OdinPMP. Setup, scripts and environment variables are in the root [README](../README.md).

- [Architecture](architecture.md): what runs, how the backend and frontend are built, and how data, events, files, AI and mail move.
- [CONTEXT.md](../CONTEXT.md): the glossary of Odin's terms.
- [Odin MCP server](mcp.md): setup, authentication and the tool catalog.
- [The Odin assistant](assistant.md): turns, tools, checks, confirmations, undo and settings.
- [AI prompts inventory](ai-prompts-inventory.md): every prompt the code sends, with its model and inputs. Tests check that it matches the code.
- Review packages, which put screens and prototypes in front of stakeholders:
  - [the package contract](requirements-gathering/package-spec.md)
  - [its schema](requirements-gathering/review-package.schema.json)
  - [example manifests](requirements-gathering/examples/)
  - [the guide for an agent building one](requirements-gathering/agent-guide.md)
  - [the starter and validator](../tools/review-package/README.md)

  The backend builds the downloadable package kit from these files.
