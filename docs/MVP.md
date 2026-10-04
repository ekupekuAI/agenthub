# Universal Agent Skills Hub

> Converted from `Universal_Agent_Skills_Hub_MVP_Technical_Spec.docx` (build pack, 28 Sep 2026). Citation markers removed; content otherwise unchanged.

MVP Technical Specification and Implementation Plan

Version 1.0 | 28 September 2026

> **Build stance**
>
> Build a local-first CLI plus a minimal hosted registry. Do not build a giant marketplace first. Prove that one canonical skill package can move safely between agents with compatibility and rollback.

## 1. MVP definition

The MVP is a production-shaped proof of the architecture, not a toy directory. It must demonstrate the complete loop: discover → resolve → verify → install → use → check → update → rollback across multiple agent clients.

## 2. Recommended stack

| Layer | Choice | Reason |
|---|---|---|
| CLI | TypeScript + Node.js + Commander | Matches the developer ecosystem, cross-platform distribution and the package-management mental model. |
| Web | Next.js App Router + TypeScript | Fast iteration, server routes, strong ecosystem and easy deployment. |
| API | Next.js route handlers for MVP | Avoid unnecessary service fragmentation at the start. |
| Database | PostgreSQL + Drizzle ORM | Relational metadata, version queries and migrations with TypeScript types. |
| Object storage | S3-compatible storage | Skill archives are binary artifacts and should not live in database rows. |
| Validation worker | Node.js worker / queue | Asynchronous scanning and package validation. |
| Auth | Email/OAuth optional for publishers | Anonymous browsing/install should remain possible; publishing requires identity. |
| Testing | Vitest + Playwright | Unit/integration plus browser verification. |
| Deployment | Vercel for web/API + managed Postgres + S3-compatible storage | Low ops overhead for a personal project; replaceable later. |

## 3. Repository structure

```text
agenthub/
├── apps/
│   └── web/                      # Next.js registry UI + API
├── packages/
│   ├── cli/                      # agenthub CLI
│   ├── core/                     # shared types, resolver, manifest parser
│   ├── adapters/                 # claude, codex, cursor, vscode
│   ├── scanner/                  # static package scanner
│   └── test-fixtures/             # safe + malicious fixture skills
├── registry/
│   ├── schema/                   # DB migrations / seed data
│   └── seed/                     # curated skills
├── docs/
│   ├── PRD.md
│   ├── MVP.md
│   └── RESEARCH.md
├── .github/workflows/
└── package.json
```

## 4. Canonical metadata model

```text
# SKILL.md remains the portable core
---
name: web-testing
description: Run reliable end-to-end web tests and troubleshoot failures.
license: MIT
compatibility: Requires Node.js 20+ and a browser runner.
---

# Web Testing
...
```

Recommended registry metadata stored separately in the database: publisher_id, package_name, version, source_kind, source_uri, archive_digest, skill_format_version, target_agents, adapter_requirements, runtime_requirements, permissions, scan_status, release_notes, created_at and revoked_at.

## 5. Database schema

| Table | Important columns | Purpose |
|---|---|---|
| users | id, email, role | Publisher/admin identity |
| publishers | id, user_id, display_name, verified_at | Human/org publishing identity |
| skills | id, slug, name, summary, category | Logical skill identity |
| skill_versions | id, skill_id, version, digest, storage_key, status | Immutable release metadata |
| skill_targets | skill_version_id, agent_id, mode, min_version, max_version | Compatibility declarations |
| agents | id, slug, detector_version | Known supported clients |
| requirements | skill_version_id, kind, name, constraint | Runtime/tool/MCP requirements |
| security_scans | skill_version_id, scanner_version, status, findings_json | Security evidence |
| install_events | id, skill_version_id, agent, action, result, timestamp | Aggregate usage and debugging signal |
| revocations | skill_version_id, reason, created_at | Emergency package withdrawal |

## 6. Resolver algorithm

1. Parse requested skill identifier and optional version constraint.
2. Query registry for non-revoked versions.
3. Detect local agent environments and versions.
4. Filter versions by target agent compatibility.
5. Filter by local runtime requirements only when those requirements are known.
6. Apply user channel policy: stable by default; beta only when explicitly enabled.
7. Prefer latest compatible version, unless lockfile pins an exact version.
8. Return a resolution plan before writing files in --dry-run mode.

```text
resolve(skill, env, policy):
  candidates = registry.list_versions(skill, status="active")
  candidates = filter_agent_compatibility(candidates, env.agents)
  candidates = filter_runtime_requirements(candidates, env.runtime_snapshot)
  candidates = filter_channel(candidates, policy.channel)
  return choose_highest_compatible(candidates, policy.pin)
```

## 7. Local state and lockfile

```text
.agenthub/
├── config.json
├── agenthub.lock
├── cache/
└── snapshots/

agenthub.lock
{
  "lockfileVersion": 1,
  "skills": {
    "web-testing": {
      "version": "1.3.0",
      "digest": "sha256:...",
      "registry": "https://registry.example",
      "installedTargets": ["cursor", "codex"],
      "installedAt": "..."
    }
  }
}
```

## 8. CLI contract

| Command | Behavior |
|---|---|
| agenthub doctor | Detect agents, versions, directories, runtimes and broken installs. |
| agenthub search <query> | Search registry. Supports --agent, --category, --json. |
| agenthub info <skill> | Show metadata, versions, trust and compatibility. |
| agenthub install <skill> | Resolve, verify, install and lock. |
| agenthub install ./file.skillpkg | Install local package for offline development. |
| agenthub list | List installed skills and status. |
| agenthub remove <skill> | Remove package using recorded ownership manifest. |
| agenthub update --check | Show pending updates without mutation. |
| agenthub update <skill> | Update one skill with snapshot + rollback. |
| agenthub update --safe | Update all eligible skills. |
| agenthub rollback <skill> | Restore the previous snapshot. |
| agenthub verify <skill> | Recompute digest and validate local package. |
| agenthub config | View/set registry and policy settings. |

## 9. Adapter contract

```text
interface AgentAdapter {
  id: string;
  detect(): Promise<AgentEnvironment | null>;
  targets(): Promise<InstallTarget[]>;
  canInstall(skill: SkillPackage): CompatibilityResult;
  install(skill: SkillPackage, target: InstallTarget): Promise<InstallReceipt>;
  remove(receipt: InstallReceipt): Promise<void>;
  verify(receipt: InstallReceipt): Promise<VerificationResult>;
}
```

For the MVP, adapters should primarily implement filesystem placement because the canonical skill standard already uses directory-based discovery. Current Cursor documentation explicitly lists project and user skill locations and states that Cursor also loads Claude and Codex directories for compatibility. VS Code likewise documents project and personal skill locations and an extension contribution point.

## 10. Agent detection

```text
1. Detect executable presence where safe (PATH lookup).
2. Detect known config directories.
3. Read version using supported CLI command only when documented/stable.
4. Prefer filesystem evidence over process assumptions.
5. Return confidence: high / medium / low.
6. Never modify files during detection.
```

## 11. Security scanner MVP

The scanner should inspect the archive before installation. It is not an antivirus engine. Its job is to identify high-signal risks and produce explainable findings.

| Finding | Detection |
|---|---|
| Shell execution | Look for shell child process APIs, shell scripts and commands that invoke interpreters. |
| Network access | Detect fetch/http clients, curl/wget, sockets and package download commands. |
| Secret access | Detect environment variable access, .env reads and credential directory references. |
| Dynamic code | Detect eval, Function constructor, runtime code download and obfuscated payloads. |
| Persistence | Flag writes to startup/config/credential locations outside the skill target directory. |
| Remote dependency | Flag URLs, git dependencies and install scripts that pull executable code. |
| Prompt injection signals | Flag instructions asking the agent to ignore system/user instructions, expose secrets or weaken safety controls. |
| Large/binary anomalies | Flag unexpected executables or suspicious file types. |

Existing supply-chain tooling provides useful patterns, but the MVP should not claim parity with Snyk or Socket. Snyk performs SCA and continuous monitoring, while Socket analyzes behavior and risk signals around packages. The skill scanner should focus on the narrower threat model of agent-skill packages.

## 12. Registry API

| Method | Route | Purpose |
|---|---|---|
| GET | /api/v1/skills?q=&agent=&category= | Search |
| GET | /api/v1/skills/:slug | Skill detail |
| GET | /api/v1/skills/:slug/versions | Version list |
| GET | /api/v1/skills/:slug/resolve?agent=&version= | Resolve compatible release |
| GET | /api/v1/skills/:slug/download/:version | Signed/hashed package download |
| POST | /api/v1/publish | Create a release from an uploaded package |
| POST | /api/v1/skills/:slug/scan | Request/re-run scan |
| POST | /api/v1/skills/:slug/revoke | Admin emergency revoke |

## 13. Publish flow

1. Author runs agenthub pack ./my-skill.
2. CLI validates SKILL.md against the open standard and platform metadata schema.
3. CLI creates deterministic archive and SHA-256 digest.
4. Author uploads package and metadata.
5. Registry stores immutable artifact and creates pending release.
6. Scan worker runs static checks and package lint tests.
7. Admin or policy engine promotes release to active when checks pass.
8. Publish page shows version, compatibility, requirements and scan findings.

## 14. Update protocol

```text
check → resolve → preview → download → verify → snapshot → install → verify → commit
                                                │
                                                └──────────────► rollback on failure
```

The update UX should resemble a package manager. Dependabot and Renovate show the value of version-aware automation and testing gates, while the key difference here is that the artifact being updated is an agent skill package rather than a software dependency.

## 15. Test plan

| Layer | Tests |
|---|---|
| Unit | SKILL.md parser, semver resolver, manifest validation, digest verification, scanner rules |
| Integration | Registry API, object storage, database migrations, resolver queries |
| Adapter | Install/remove/verify in fixture directories for Windows/macOS/Linux path patterns |
| E2E | Search → install → list → update → rollback |
| Security fixtures | Malicious prompt, secret access, dynamic download, obfuscated script, benign complex skill |
| Compatibility | Matrix test across supported agent versions and unsupported versions |

## 16. Definition of done for MVP

1. One command installs the same skill into at least three supported agent environments from the registry.
2. No manual editing of agent configuration is required for supported native/path integrations.
3. Install and update operations are transactionally recorded in a lockfile.
4. Corrupted or revoked packages cannot be installed.
5. At least one rollback path is tested and demonstrated.
6. CLI and registry have JSON output/API contracts suitable for future automation.
7. Curated documentation explains the security model and how to author a safe skill.
8. All core paths pass automated tests and browser QA.

## 17. Build order

1. Create monorepo and CI.
2. Implement canonical SkillPackage parser + validator.
3. Implement local filesystem adapter abstraction.
4. Implement agent detectors and Cursor/Codex/Claude Code/VS Code targets.
5. Implement local CLI with install/list/remove/doctor.
6. Implement local package cache and lockfile.
7. Implement web registry database and search API.
8. Implement artifact storage and publish flow.
9. Add scanner worker and seeded malicious fixtures.
10. Connect CLI to hosted resolver/download endpoints.
11. Implement update, snapshot and rollback.
12. Build web search/detail/publish/admin views.
13. Run E2E matrix and security fixture tests.
14. Write final quickstart and troubleshooting guide.

## 18. Implementation operating instructions

> **Instruction to the implementation agent**
>
> Treat this document as an engineering contract. Do not silently widen the MVP. When an agent-specific behavior is uncertain, isolate it behind an adapter and record the uncertainty in a compatibility test rather than hard-coding assumptions.

## Research sources

Anthropic: Agent Skills | https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills | Origin and rationale for Agent Skills; notes the format was released as an open standard.

Agent Skills specification | https://agentskills.io/specification | Canonical format details for SKILL.md and bundled resources.

OpenAI: Skills | https://developers.openai.com/api/docs/guides/tools-skills | OpenAI documentation on reusable skills, local/hosted execution and versioned bundles.

Cursor: Agent Skills | https://prod.cursor.com/docs/skills | Current Cursor support, discovery locations and interoperability details.

VS Code: Agent Skills | https://code.visualstudio.com/docs/agent-customization/agent-skills | Current VS Code/Copilot support and extension contribution model.

GitHub: Adding agent skills to Copilot | https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills | Current Copilot skill locations and package structure.

skills.sh | https://www.skills.sh/ | Existing cross-agent skills directory/CLI demonstrating demand for discovery and installation.

MCP | https://modelcontextprotocol.io/ | Protocol for exposing tools/resources/prompts to compatible AI applications.

npm audit | https://docs.npmjs.com/cli/audit.html | Reference for dependency vulnerability auditing and remediation.

GitHub Dependabot | https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-version-updates | Reference for dependency version updates and security updates.

Renovate | https://docs.renovatebot.com/ | Reference for dependency update automation and automerge workflow.

Snyk Open Source | https://snyk.io/product/open-source-security-management/ | Reference for SCA, prioritization, monitoring and remediation.

Socket | https://socket.dev/security | Reference for supply-chain behavior analysis and package risk signals.
