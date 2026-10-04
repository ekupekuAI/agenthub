# Universal Agent Skills Hub

> Converted from `Universal_Agent_Skills_Hub_PRD.docx` (build pack, 28 Sep 2026). Citation markers removed; content otherwise unchanged.

Product Requirements Document

Version 1.0 | 28 September 2026

> **Product thesis**
>
> Build a universal package manager and trust layer for AI-agent skills. Adopt the open Agent Skills format, then solve discovery, installation, compatibility, security review, dependency awareness, and safe updates across multiple agent clients.

## 1. Executive summary

Universal Agent Skills Hub is a personal developer tool and platform that lets a user discover, install, manage, update, and validate reusable AI-agent skills across multiple compatible coding agents and AI IDEs. The product should feel like a package manager for agent capabilities, not another prompt marketplace.

The product will not attempt to modify or embed code inside proprietary IDE binaries. Instead, it will use the native skill discovery and extension mechanisms exposed by each client. Where clients support the same open Agent Skills directory format, the platform writes the skill package into the correct directory. Where a client requires another integration path, the platform uses an adapter or MCP bridge.

The first release targets developers using Claude Code, Codex, Cursor and VS Code/GitHub Copilot. Current platform documentation confirms these environments expose skill mechanisms based on SKILL.md folders or compatible locations. Cursor also documents loading skills from Claude and Codex directories, which materially reduces the initial adapter burden.

## 2. Problem

- AI agents are capable, but specialized workflows still depend on manually copied instructions, scripts, references and project-specific knowledge.
- Skill discovery is fragmented across vendor docs, repositories, marketplaces and community collections.
- Users must understand where each agent expects skills to live and which formats or integration mechanisms it accepts.
- Installing a skill is only half the problem. A skill may depend on runtime versions, external commands, MCP servers or scripts that are unsafe, missing or incompatible.
- Updates are primitive. The user often has no clear view of what changed, whether the new version is compatible, or whether a skill is trusted enough to update automatically.
- Existing dependency tooling proves that developers value versioning, security analysis and safe update workflows, but most of that infrastructure targets software packages rather than AI-agent skill packages.

## 3. Vision

Make agent capabilities installable like software packages: searchable, versioned, portable, validated, compatible, and easy to update.

## 4. Goals and non-goals

| Goals | Non-goals |
|---|---|
| One command to search and install a skill | Building a new AI model |
| Cross-agent portability through adapters/native locations | Reverse-engineering proprietary IDE internals |
| Clear compatibility and dependency reporting | Replacing MCP as a protocol |
| Security and trust metadata before installation | Guaranteeing that every community skill is safe |
| Safe, explainable updates | Fully automatic breaking-change remediation in MVP |
| Private/proprietary registry option for later use | Forcing skills to be hosted on GitHub |

## 5. Target users

| User | Need | Primary job to be done |
|---|---|---|
| Solo developer | Reduce setup friction | Find a reliable skill and install it into the current agent in seconds. |
| AI-heavy power user | Use several agents interchangeably | Keep one skill set available across tools without manual duplication. |
| Skill author | Distribute a capability | Publish one package with compatibility and security metadata. |
| Team lead | Control capabilities | Maintain approved internal skills and predictable versions. |
| Platform/security engineer | Reduce supply-chain risk | Audit scripts, dependencies and permissions before allowing installation. |

## 6. Core product concepts

| Concept | Definition |
|---|---|
| Skill | A directory containing SKILL.md plus optional scripts, references, assets and other resources. |
| Registry | The service that indexes skill metadata, versions, manifests, hashes, compatibility and trust state. |
| Adapter | Agent-specific installation/runtime logic that maps a canonical package into a client-supported mechanism. |
| Skill lock | A local manifest recording exact installed versions and integrity hashes. |
| Trust record | Evidence about source, scan results, publisher identity, permissions and provenance. |
| Update channel | Stable, beta or pinned update policy for a skill. |
| Capability requirement | A declared dependency such as node, python, docker, git, browser, or MCP server. |

## 7. MVP user journeys

1. Install CLI. Run agenthub doctor. The CLI detects supported agents and local capabilities.
2. Run agenthub search web-testing. Review description, supported agents, version, trust state and requirements.
3. Run agenthub install web-testing. Resolver chooses a compatible package version and adapter.
4. CLI installs into a native user or project skill location and writes agenthub.lock.
5. Run agenthub doctor to see broken requirements, incompatible clients and integrity mismatches.
6. Run agenthub update --check. Review available versions and compatibility notes.
7. Run agenthub update --safe to update only packages that pass declared compatibility constraints and integrity checks.

## 8. Functional requirements

| ID | Area | Requirement |
|---|---|---|
| FR-01 | Skill discovery | Search by name, category, tags, description and supported agent. |
| FR-02 | Skill detail | Show version, publisher, compatibility, requirements, permissions, files summary, trust state and changelog. |
| FR-03 | Install | Resolve the best compatible release, download package, verify hash/signature, install through adapter and record lock state. |
| FR-04 | Remove | Remove only files owned by the skill according to the local manifest. |
| FR-05 | List | List installed skills with agent, source, version, status and update state. |
| FR-06 | Doctor | Detect agents, directories, required runtimes, missing dependencies, corrupted files and stale metadata. |
| FR-07 | Update check | Check registry for newer releases without mutating the environment. |
| FR-08 | Safe update | Update only when compatibility policy passes; preserve rollback metadata. |
| FR-09 | Locking | Persist exact version, package digest, registry source and install target. |
| FR-10 | Security scan | Analyze metadata and scripts for suspicious behavior and dangerous permissions. |
| FR-11 | Compatibility | Model support by client, version range and installation mode: native, adapter or MCP. |
| FR-12 | Local/private registry | Allow the CLI to point to a registry URL or local package directory in development. |
| FR-13 | Offline install | Install from a previously downloaded package by digest or local file path. |
| FR-14 | Audit trail | Record install, update, remove and rollback events locally. |

## 9. Non-functional requirements

| Area | Requirement | MVP target |
|---|---|---|
| Performance | Search response from hosted registry | p95 < 800 ms for API-only search |
| Install | Cached package installation | < 5 s for a small skill on normal broadband |
| Reliability | Transactional install | No partially recorded install state; failures are recoverable |
| Security | Integrity | SHA-256 digest required before activation |
| Security | Least privilege | Skills declare external commands and network requirements |
| Privacy | Local-first operation | Source code is not uploaded by the CLI |
| Portability | OS | Windows, macOS, Linux |
| Observability | CLI logs | Human-readable default, JSON with --json |
| Accessibility | Web registry | Keyboard navigable, high-contrast compliant |

## 10. Product architecture

```text
                         ┌──────────────────────────┐
                         │      SkillHub Web        │
                         │ Search / Detail / Auth   │
                         └─────────────┬────────────┘
                                       │ HTTPS
                         ┌─────────────▼────────────┐
                         │       Registry API       │
                         │ resolver + metadata     │
                         └───────┬─────────┬────────┘
                                 │         │
                    ┌────────────▼─┐   ┌──▼────────────────┐
                    │ PostgreSQL    │   │ Object Storage    │
                    │ metadata      │   │ skill archives    │
                    └───────────────┘   └───────────────────┘
                                 ▲
                                 │
                         ┌───────┴─────────┐
                         │  Scan pipeline   │
                         │ lint / security  │
                         └──────────────────┘

Developer machine
┌──────────────────────────────────────────────────────────────┐
│ agenthub CLI                                                   │
│ detect → resolve → verify → install → lock → doctor → update │
└───────────────┬──────────────────────────────────────────────┘
                │
        ┌───────┼───────────────┐
        ▼       ▼       ▼       ▼
 Claude Code  Codex   Cursor   VS Code/Copilot
      adapter  adapter native   adapter/native
```

> **Important implementation boundary**
>
> Do not try to "embed" skills into an IDE binary. The product integrates at the official extension, skill-directory, CLI, or MCP boundary exposed by each client. The registry is the control plane; the local CLI is the installation/data-plane component.

## 11. Skill package contract

```text
my-skill/
├── SKILL.md                 # required
├── references/              # optional, loaded on demand
├── scripts/                 # optional executable helpers
├── assets/                  # optional templates/assets
├── tests/                   # optional author tests
└── agenthub.yaml            # platform metadata, optional but recommended
```

The platform should remain compatible with the standard SKILL.md structure. The registry may maintain additional metadata outside the skill itself rather than polluting the canonical file. The Agent Skills specification defines a required SKILL.md and optional scripts, references and assets, with progressive loading intended to control context usage.

## 12. Compatibility model

| Level | Meaning | Example |
|---|---|---|
| Native | Client directly discovers the canonical skill package. | Cursor, Codex, Claude Code, VS Code paths where supported. |
| Path adapter | Same SKILL.md, different directory or project/user scope. | Copy or link into the correct client directory. |
| Format adapter | Client requires a transformed representation. | Convert canonical metadata/instructions into a client-specific rules format. |
| MCP bridge | Expose capabilities through MCP when the skill requires live tools. | Skill instructions + an MCP server/tool dependency. |
| Unsupported | No safe supported integration. | CLI can still export package for manual use. |

## 13. Safe update mechanism

1. Resolve newer versions using semver and declared client/runtime compatibility.
2. Fetch release metadata and changelog summary before package bytes.
3. Run security/trust policy checks.
4. Download to a temporary cache and verify digest.
5. Create a snapshot of the current installed package.
6. Atomically replace the skill directory.
7. Run post-install validation.
8. If validation fails, restore the prior snapshot and mark the update as failed.

## 14. Security model

Skills are not trusted merely because they are Markdown. Skills may bundle executable scripts and can instruct an agent to perform actions with real permissions. The platform must treat skill packages as a supply-chain artifact. This aligns with existing package-security practice: npm audit surfaces known dependency vulnerabilities, while Socket analyzes package behavior and supply-chain signals such as install scripts, obfuscation and privileged API use.

| Control | MVP implementation |
|---|---|
| Integrity | SHA-256 digest of every downloaded archive and installed file manifest |
| Static scan | Detect shell execution, network calls, credential access, obfuscation, dynamic downloads and suspicious URLs |
| Manifest | List commands, runtimes, network and filesystem expectations |
| Publisher trust | Verified publisher flag, source URL, release provenance |
| Sandbox test | Execute author tests in an isolated CI runner where feasible |
| User consent | Explicit warning before installing skills with executable scripts or elevated requirements |
| Rollback | Keep last known-good package locally |

## 15. Web application requirements

| Screen | Purpose | MVP components |
|---|---|---|
| Home/Search | Discover skills | Search box, filters, featured categories, recent updates |
| Skill detail | Evaluate before install | README summary, compatibility matrix, trust badge, requirements, versions, changelog |
| Publish | Submit skill package | Upload archive, metadata, scan status |
| Dashboard | Manage own skills | Published skills, releases, scan state |
| Registry admin | Moderation | Quarantine, approve, revoke, inspect scans |

## 16. Success metrics

| Metric | Definition | Initial target |
|---|---|---|
| Time to first skill | From CLI install to successful agent availability | < 2 minutes |
| Install success rate | Installs that finish and pass doctor validation | > 95% |
| Cross-agent reuse | Installs performed on 2+ client types | > 20% of active users |
| Update safety | Updates rolled back because of validation failure | < 2% |
| Security detection | Known seeded malicious fixtures blocked | 100% of MVP fixtures |
| Retention signal | Users who install at least 3 skills in 30 days | Track, do not gate launch |

## 17. Roadmap

| Phase | Scope |
|---|---|
| 0. Prototype | Local CLI, package parser, native installation into 2 agents, lockfile, doctor. |
| 1. MVP | Hosted registry, search, publish, 4 client integrations, security scan, update/rollback. |
| 2. Beta | Private registries, teams, signed releases, better compatibility resolver, skill test harness. |
| 3. Platform | Marketplace UX, publisher verification, analytics, policy engine, enterprise controls. |

## 18. Risks and mitigations

| Risk | Why it matters | Mitigation |
|---|---|---|
| Agent vendors change paths or behavior | Breaks installers | Versioned adapters, doctor checks, integration fixtures, capability probing. |
| Malicious skills | Can influence agents or execute code | Mandatory scans, provenance, explicit consent, quarantine, rollback. |
| Marketplace quality collapse | Large catalog becomes noisy | Curated MVP, quality signals, verified publishers, test evidence. |
| Low differentiation | Skills.sh and other registries exist | Focus on compatibility, trust, updates and private distribution. |
| Format fragmentation | Not every agent implements the standard equally | Canonical package + adapters, never vendor-specific as source of truth. |
| Context bloat | Too many skills can hurt agent behavior | Keep descriptions concise and rely on progressive loading. |

## 19. Launch acceptance criteria

1. Fresh Windows, macOS and Linux machines can install the CLI.
2. CLI detects Claude Code, Codex, Cursor and VS Code-compatible skill locations when present.
3. At least 10 curated skills can be searched, installed, removed, updated and rolled back.
4. Every install produces a lock entry with version and integrity digest.
5. At least 5 security fixture skills are correctly blocked or warned according to policy.
6. One skill can be installed into at least three supported agent environments without manual file editing.
7. The web registry clearly distinguishes package metadata, runtime requirements and trust evidence.
8. A first-time developer can follow the getting-started guide without understanding Agent Skills internals.

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
