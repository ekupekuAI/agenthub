# Universal Agent Skills Hub

> Converted from `Universal_Agent_Skills_Hub_Research.docx` (build pack, 28 Sep 2026). Citation markers removed; content otherwise unchanged.

Research, Competitive Landscape and Feasibility Report

Version 1.0 | 28 September 2026

> **Research conclusion**
>
> The underlying format is now an ecosystem standard, so the opportunity is not to invent another format. The differentiating layer is the package-management infrastructure around that format: compatibility, provenance, security, updates and private distribution.

## 1. Research question

Can a personal project become a practical universal distribution layer for AI-agent skills across multiple IDEs and coding agents, without being tied to a single vendor or public GitHub repository?

## 2. What changed in the ecosystem

Agent Skills began as an Anthropic initiative and was released as an open standard in December 2025. The canonical specification describes a folder with SKILL.md plus optional scripts, references and assets, with progressive disclosure so agents do not need the full skill contents in context at startup.

By 2026, official documentation from OpenAI, Cursor, VS Code and GitHub Copilot documents support for the Agent Skills pattern or compatible SKILL.md locations. This materially validates the cross-agent premise.

## 3. Current landscape

| Product/project | Core strength | Relevant to this idea | Gap relative to proposed hub |
|---|---|---|---|
| Agent Skills standard | Portable package format | Defines the portable skill artifact | Does not itself provide a complete multi-client package manager. |
| skills.sh | Discovery + CLI distribution | Already demonstrates search/install/update across agents | The user experience and catalog can overlap heavily; differentiation must be deeper than directory/search. |
| MCP | Portable tool/resource protocol | Useful for live tools and integrations | Not a replacement for static skill packages or package management. |
| Cursor | Native skills + compatibility paths | Shows clients can discover skills from standard folders | Vendor-specific product, not a neutral registry/control plane. |
| VS Code/Copilot | Skills + extension contribution | Shows skills can be distributed through extensions | Again tied to the host product and its policies. |
| Dependabot | Version/security update automation | Proves safe update UX is valuable | Focuses on software dependencies, not agent skills. |
| Renovate | Highly configurable dependency updates | Useful conceptual model for update policy | Not specialized for AI-agent capabilities. |
| Snyk | SCA, monitoring, risk prioritization | Security architecture inspiration | Broad code/dependency security rather than skill-specific trust. |
| Socket | Behavioral package supply-chain analysis | Strong inspiration for skill scanner | Analyzes software package supply chain, not agent skill semantics. |

## 4. Existing distribution evidence

skills.sh currently advertises a CLI command that installs SKILL.md packages into agent environments and provides separate pages for Cursor, Codex and Claude Code. Its FAQ also describes packs, updates and a multi-agent ecosystem. This is direct evidence that the basic "skills package manager" model is already being tested in the market.

> **Strategic implication**
>
> Do not compete on "we also have a skill directory." Build on the standard and differentiate through trust, compatibility evidence, private registries, deterministic packaging, rollback, and developer tooling.

## 5. How skills actually enter agents

| Mechanism | How it works | What the project should do |
|---|---|---|
| Native/path discovery | Agent scans one or more directories for SKILL.md | Install directly to documented locations. |
| Extension contribution | Host extension declares skill resources | Provide optional extension packaging later, especially for VS Code. |
| MCP | Agent connects to server and receives tools/resources/prompts | Use only when a skill needs live external capability. |
| Format conversion | Client expects a different customization type | Implement adapters only when required; preserve canonical source package. |

Cursor currently documents project and user skill locations and says it can discover skills from Claude and Codex directories for compatibility. VS Code documents project/personal locations and an extension contribution point. OpenAI documents reusable skills using SKILL.md and versioned bundles. These make a local filesystem installer a credible MVP strategy rather than a workaround.

## 6. Competitive pressure matrix

| Capability | Agent Skills | skills.sh | MCP | Proposed Hub |
|---|---|---|---|---|
| Portable package format | Yes | Uses it | No, different abstraction | Uses standard |
| Search/discovery | Docs/community | Strong | Server discovery | Strong + filters |
| Install/update UX | Client-specific | Strong | Connection setup | Unified CLI |
| Compatibility resolver | Limited/client-specific | Basic distribution | Protocol compatibility | Core feature |
| Package integrity | Format-level only | Varies | Transport/server trust | Core feature |
| Static security scan | No | Not primary | Not primary | Core feature |
| Rollback | Not inherent | Limited | N/A | Core feature |
| Private registry | Possible to build | Available in some forms | Server can be private | Core feature |
| Dependency awareness | Optional | Skill-specific | Tool/server dependencies | First-class metadata |
| Agent adapters | Standard focus | Install-focused | Protocol focus | Core abstraction |

## 7. Feasibility analysis

| Question | Assessment | Evidence / reasoning |
|---|---|---|
| Can one skill be portable? | Yes, for skills-compatible agents | The same SKILL.md package is explicitly designed for cross-product reuse. |
| Can the CLI install it automatically? | Yes | Current products use filesystem-based skill discovery; skills.sh demonstrates CLI installation. |
| Can it support non-native agents? | Sometimes | Requires adapter, extension or MCP path; no universal injection method exists. |
| Can updates be safe? | Partially | Versioning, integrity checks, compatibility rules and rollback can make updates controlled. Full behavior equivalence is not guaranteed. |
| Can skills be privately hosted? | Yes | Registry architecture can be separated from artifact storage and public discovery. |
| Can security be automated? | Partially | Static analysis can catch high-signal risks, but no scanner can prove a skill is safe. |

## 8. Why MCP should not be the primary architecture

MCP is excellent when the agent needs live tools or resources. It is not necessary for a pure instruction bundle. OpenAI itself describes skills and MCP as complementary: the skill teaches a workflow around tools, while the MCP server provides live information and controlled actions.

Therefore the product should use a hybrid model: static skill package first, MCP dependency only where a workflow genuinely requires external actions or live state.

## 9. Security research implications

A skill registry creates a supply-chain problem. The registry must assume malicious or low-quality packages will eventually appear. Existing package security systems provide useful ideas: npm audit reports known dependency vulnerabilities, Dependabot automates version/security updates, Snyk monitors dependencies continuously, and Socket examines package behavior such as install scripts and privileged APIs.

| Threat | Example | Mitigation |
|---|---|---|
| Instruction injection | Skill asks agent to ignore higher-level instructions | Static rule + human-readable warning + trust score |
| Credential theft | Script reads environment secrets | Scan env access + explicit permission declaration |
| Malicious download | Script fetches and executes remote code | Block or warn on dynamic download/execution |
| Typosquatting | Lookalike skill name | Publisher verification + naming collision detection |
| Dependency compromise | Skill pins malicious library | Dependency scan and provenance |
| Silent update drift | New version changes behavior materially | Immutable releases + changelog + preview + rollback |
| Registry compromise | Artifact replaced server-side | Content addressing, signatures, immutable storage, audit log |

## 10. Business and sustainability

For a personal project, monetization is optional. The practical goal is to prove the architecture and build a portfolio-quality developer tool. If the project later evolves into a product, the natural paid layers are private registries, team policy, signed releases, audit logs, organization controls, managed scanning and enterprise support.

## 11. Differentiation thesis

```text
Weak positioning:
"A marketplace of AI skills."

Stronger positioning:
"A universal package manager and trust layer for agent capabilities."

Moat candidates:
1. Compatibility graph + real integration tests
2. Skill supply-chain security and provenance
3. Deterministic packaging + lockfiles + rollback
4. Private registries and policy controls
5. Adapter ecosystem across agents
6. Quality/evidence data from real installs and tests
```

## 12. What should NOT be built

- A custom skill syntax that duplicates the open standard.
- An IDE plugin for every agent before the CLI proves demand.
- An enormous catalog of copied community skills.
- An AI-generated trust score without evidence.
- Automatic updates that silently change agent behavior.
- An MCP server for every skill regardless of whether live tools are needed.

## 13. Validation experiments

| Experiment | Method | Success signal |
|---|---|---|
| Cross-agent install | Take one skill and install it into Claude Code, Codex, Cursor and VS Code | Same package becomes available without hand-editing. |
| Compatibility failure | Create a skill requiring Node >=22 and test on Node 20 | Resolver blocks or explains incompatibility. |
| Malicious fixture | Create a harmless test skill containing secret-read/network-exec patterns | Scanner produces expected findings. |
| Update rollback | Publish v1 and v2 where v2 fails a test | CLI restores v1 and records rollback. |
| Beginner test | Give docs to a developer unfamiliar with Agent Skills | They install a skill without additional help. |
| Private registry | Run registry locally and install from it | CLI works with custom registry URL and offline cache. |

## 14. Recommendation for the personal project

Proceed, but narrow the initial promise. The project becomes technically and strategically interesting when it proves a unified workflow around a standard that already has ecosystem support. The project is not a replacement for Agent Skills, MCP, or dependency managers. It is the infrastructure that connects those pieces into a package-management experience for agent capabilities.

## 15. Research sources

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
