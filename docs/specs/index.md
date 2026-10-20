# Specs

Plans, designs and decisions for this repo. Read this list before changing code, and open every spec whose `code` paths include files you will touch. Rules for writing and approving specs are in [0001](0001-repo-harness.md#d1-specs-system); new specs start from [`_template.md`](_template.md).

Newest first.

| ID                                    | Title                 | Status   | Governs                                                                                                              | Description                                                                                                               |
| ------------------------------------- | --------------------- | -------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| [0004](0004-test-suite-audit.md)      | Test suite audit      | proposed | `test/`                                                                                                              | Inventory every existing test, decide per suite what to keep, rewrite or delete, then rewrite to the AGENTS.md test rules |
| [0002](0002-known-defects-backlog.md) | Known defects backlog | approved | `src/VertexChatModelDispatcher.ts`, `src/providers/`, `src/ProxyGateway.ts`, `src/utils/retry.ts`, `src/models.json` | Unintended direct/proxy divergences and code defects, to be fixed one per PR after the 0001 harness exists                |
| [0001](0001-repo-harness.md)          | Repo harness          | approved | `AGENTS.md`, `docs/specs/`, `.github/`, `.husky/`, `package.json`, `test/`                                           | Specs, PR workflow, agent instructions, behavior gate, docs reset and the transport parity suite                          |
