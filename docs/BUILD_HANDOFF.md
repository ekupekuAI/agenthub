# Universal Agent Skills Hub

> Converted from the build handoff document (build pack, 28 Sep 2026). Citation markers removed; content otherwise unchanged.

End-to-End Build Handoff

Version 1.0 | 28 September 2026

> **Use this as the execution prompt**
>
> Give the implementation team this document together with the PRD, MVP Technical Spec and Research report. The objective is an end-to-end working repository, not a design mockup.

## 1. Mission

Build Universal Agent Skills Hub end to end as a production-shaped personal project. It is a universal package manager and trust layer for AI-agent skills. The canonical skill artifact is the open Agent Skills format. The product adds discovery, compatibility, safe installation, security scanning, versioning, updates, rollback and private registry support.

## 2. Non-negotiable product decisions

- Use SKILL.md as the canonical skill format. Do not invent a competing format.
- Keep the registry separate from GitHub. GitHub may be an import/source option later, not the system of record.
- Do not reverse-engineer or inject into IDE internals. Integrate through documented skill directories, extension contribution points, CLI surfaces or MCP.
- CLI is the primary product surface for MVP. The web app is the registry/control plane.
- Every installed package must be versioned and integrity-verified.
- Every executable skill package must pass security policy checks before installation unless the user explicitly overrides the policy in a development mode.
- Updates must support preview, snapshots and rollback.
- Keep all agent-specific behavior behind adapters.

## 3. Required deliverables

1. Working monorepo with apps/web and packages/cli/core/adapters/scanner.
2. Hosted or local registry API with PostgreSQL schema and seed data.
3. Object-storage artifact upload/download path.
4. CLI commands: doctor, search, info, install, install-local, list, remove, verify, update --check, update, update --safe, rollback, config.
5. Adapters/detectors for Claude Code, Codex, Cursor and VS Code/Copilot.
6. SKILL.md parser and validator.
7. Compatibility resolver and lockfile.
8. Security scanner with seeded malicious and benign fixtures.
9. Web pages for search, skill detail, publish and basic administration.
10. E2E tests plus browser tests.
11. Getting started, skill authoring, security and troubleshooting docs.
12. Docker/local development instructions and CI.

## 4. Required development behavior

1. Before coding, inspect the current official documentation for each target agent and confirm current skill locations/behavior.
2. Use the open Agent Skills specification as the source of truth for SKILL.md structure.
3. Keep vendor-specific assumptions isolated and testable.
4. When an integration cannot be verified, implement a safe adapter stub and a clearly documented capability state rather than pretending support.
5. Prefer small composable packages and typed interfaces.
6. Never upload user source code to the registry for the purpose of installing or scanning a skill.
7. Use deterministic archives and SHA-256 digests.
8. Write migration-safe code. No magic global state.
9. Every major feature needs at least one automated test and one failure-path test.
10. Run lint, typecheck, unit tests, integration tests and browser tests before declaring complete.

## 5. Implementation sequence

1. Bootstrap monorepo, package manager, linting, formatting, typecheck and CI.
2. Implement shared types and SKILL.md parser.
3. Implement local package packer and digest calculator.
4. Implement local adapters and agent detection.
5. Implement local CLI with filesystem install/remove/verify and lockfile.
6. Create fixture skills and E2E tests for local installation.
7. Create Next.js registry and PostgreSQL schema.
8. Implement artifact storage and search APIs.
9. Implement publish and scan workflow.
10. Connect CLI resolver/download to registry.
11. Implement update preview, snapshot, atomic replace and rollback.
12. Implement web UX.
13. Run real compatibility verification against installed clients where possible.
14. Polish docs and developer onboarding.

## 6. CLI acceptance examples

```text
# diagnostics
agenthub doctor

# discovery
agenthub search "web testing" --agent cursor
agenthub info web-testing

# install
agenthub install web-testing

# inspect state
agenthub list
agenthub verify web-testing

# updates
agenthub update --check
agenthub update web-testing
agenthub update --safe

# recovery
agenthub rollback web-testing
```

## 7. Required UX principles

| Principle | Expected behavior |
|---|---|
| Explain before modifying | Install/update shows target agent, destination, version and trust findings. |
| Safe by default | Revoked, corrupted or policy-blocked packages do not activate. |
| Fast path | Common install takes one command after the CLI is configured. |
| Visible failure | Error messages name the exact adapter, path, requirement or trust issue. |
| Reversible | Update creates a prior snapshot before mutation. |
| JSON friendly | Every important command supports structured output for future agent automation. |

## 8. Security acceptance tests

1. Block a package containing a script that reads a fake secret file.
2. Flag a package that downloads and executes remote content.
3. Flag instructions asking the agent to expose secrets or disable protections.
4. Reject a digest mismatch.
5. Reject a revoked version.
6. Preserve and restore a prior version when post-install validation fails.
7. Ensure the CLI never writes outside declared install targets during normal operations.

## 9. What to do when an agent is uncertain

Do not guess. Query the official documentation or use a local fixture if available. If support cannot be confirmed, mark the adapter as experimental, keep the canonical package untouched, and make the limitation explicit in both CLI output and docs.

## 10. Final completion report

When finished, produce a concise engineering report containing: architecture implemented, commands that work, supported agents and tested versions, known limitations, security findings, test counts, local setup steps, deployment steps, and the five most valuable next improvements.

## 11. Research references to consult before implementation

Anthropic: Agent Skills | https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills

Agent Skills specification | https://agentskills.io/specification

OpenAI: Skills | https://developers.openai.com/api/docs/guides/tools-skills

Cursor: Agent Skills | https://prod.cursor.com/docs/skills

VS Code: Agent Skills | https://code.visualstudio.com/docs/agent-customization/agent-skills

GitHub: Adding agent skills to Copilot | https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills

skills.sh | https://www.skills.sh/

MCP | https://modelcontextprotocol.io/
