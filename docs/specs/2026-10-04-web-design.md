# agenthub web — design system

Concept: **the ledger**. agenthub is a trust product, so the site reads like a well-made
security ledger: editorial serif headlines, precise monospace evidence, one signal color that
means "verified". It should feel closer to Linear, Vercel and Stripe than to an admin
dashboard. Dark-first, with a warm paper light theme.

## 1. Principles

1. **Evidence is the hero.** Digests, findings and permissions are shown as designed objects
   (the trust receipt), not as rows in a generic table.
2. **One signal color.** Lime means trusted/verified and is the only brand accent. Amber and
   red are reserved for WARN and BLOCK. No gradients-for-decoration, no purple.
3. **Real product, not illustration.** The hero shows the real CLI output. Feature cards show
   real artifacts (a lockfile entry, a plan, a finding).
4. **Quiet motion.** Motion explains (typing, reveal, state change). Nothing loops forever
   except the terminal cursor and the CTA shimmer. `prefers-reduced-motion` renders final
   states immediately.
5. **Accessible by default.** WCAG AA contrast, visible focus ring, full keyboard paths,
   44px touch targets, no information by color alone (every status has a word and an icon).

## 2. Tokens (`app/globals.css`, Tailwind v4 `@theme`)

Theme is set by `data-theme="dark|light"` on `<html>`; default follows
`prefers-color-scheme`; a header toggle stores the choice in a cookie.

| Token | Dark | Light |
|---|---|---|
| `--bg` | `#0B0C0E` | `#FAFAF7` |
| `--surface-1` | `#111316` | `#FFFFFF` |
| `--surface-2` | `#16191D` | `#F3F3EE` |
| `--surface-3` | `#1C2025` | `#EAEAE3` |
| `--border` | `#262B31` | `#E3E3DC` |
| `--border-strong` | `#353B43` | `#CFCFC6` |
| `--text` | `#ECEEF0` | `#14161A` |
| `--text-muted` | `#A3ABB5` | `#4A515B` |
| `--text-subtle` | `#7C8591` | `#667080` |
| `--signal` (fills, dots, glow) | `#C5F04A` | `#C5F04A` |
| `--on-signal` | `#0B0C0E` | `#14161A` |
| `--signal-ink` (text, links, icons) | `#C5F04A` | `#3F6212` |
| `--info` | `#7CC4FA` | `#075985` |
| `--warn` | `#F5B544` | `#92400E` |
| `--block` | `#FF7A85` | `#B4233A` |
| `--ring` | `#C5F04A` | `#3F6212` |

Status tints: `color-mix(in oklab, var(--warn) 14%, transparent)` for backgrounds,
`… 40%` for borders.

- Radius: 6 (chips), 10 (inputs, buttons), 14 (cards), 20 (hero terminal, receipt).
- Shadow (dark): `0 1px 0 0 rgb(255 255 255 / 0.04) inset, 0 12px 40px -12px rgb(0 0 0 / 0.6)`.
- Spacing: 4px base; section rhythm 96px desktop / 56px mobile; content width 1120px,
  prose 720px.
- Background texture: a 24px dot grid at 6% opacity, masked by a radial fade, on the hero and
  page headers only.

## 3. Typography (`next/font/google`, self-hosted, no external requests at run time)

| Role | Font | Use |
|---|---|---|
| Display | Instrument Serif (400, italic) | h1, h2, receipt title. Italic for the one emphasized word. |
| UI | Geist (400–600) | Body, navigation, buttons, forms |
| Mono | Geist Mono (400–500) | Commands, digests, versions, findings, labels in small caps style |

Scale: h1 `clamp(2.6rem, 6vw, 4.6rem)/1.02`, tracking `-0.02em`; h2 `clamp(1.9rem, 3.4vw, 2.6rem)/1.1`;
h3 20/28 semibold (Geist); body 16/26; small 14/22; mono 13.5/22. Eyebrow labels: mono, 12px,
uppercase, tracking `0.12em`, `--text-subtle`. Headlines use `text-wrap: balance`.

## 4. Components (`src/components/ui/*`)

| Component | Notes |
|---|---|
| `Button` | variants `primary` (signal fill, dark text), `secondary` (surface-2 + border), `ghost`, `danger`; sizes sm/md/lg; loading state; 150ms color, 120ms `scale(0.98)` on press |
| `ShimmerButton` | hero CTA only: a light travels around the border (adapted from Magic UI) |
| `CopyCommand` | mono pill `$ agenthub install <slug>` with copy button, "Copied" state for 1.5s, `aria-live` |
| `Terminal` | window chrome + sequenced typing/reveal lines (adapted from Magic UI); tabs to switch scenarios; pauses off-screen |
| `DecisionBadge` | INFO / WARN / BLOCK and ALLOW / CONFIRM chips: icon + word + tint |
| `StatusBadge` | active / quarantined / revoked |
| `VerifiedMark` | signal check-seal for verified publishers, with tooltip text |
| `AgentStrip` | four monogram tiles (`CC`, `CX`, `CU`, `VS`) with names in `title`/`aria-label`; supported = signal outline, unsupported = dimmed + strikethrough label. No vendor logos. |
| `DigestChip` | `sha256:9f2c…e1` mono chip; click copies the full digest |
| `SpotlightCard` | card with a cursor-following radial highlight on the border (pointer devices only) |
| `TrustReceipt` | see §5 |
| `FindingRow` | decision chip, rule id (mono), `file:line`, evidence in a code strip, declared yes/no |
| `CommandPalette` | Ctrl/⌘K; searches `/api/v1/skills`; arrow keys, Enter, Esc; focus trap; recent pages; shows verdict + agents per result |
| `Field`, `Input`, `Textarea`, `Select`, `Dropzone` | visible labels, helper and error text under the field, `aria-describedby` |
| `Table` | sticky header, mono for data columns, row hover; becomes stacked cards under 640px |
| `Callout` | note / warning / danger, used in Guidelines |
| `Reveal`, `Stagger` | scroll-in primitives (opacity + 12px rise, 400ms, ease-out; stagger 60ms) |
| `ThemeToggle`, `SiteHeader`, `SiteFooter`, `SkipLink` | header is translucent with backdrop blur and a hairline that appears on scroll |

Icons: inline SVG (Lucide paths), 1.5px stroke, `aria-hidden` unless they carry meaning.

## 5. Signature pieces

**Hero terminal.** Plays the real install flow: command typed, plan and targets revealed,
`INFO` lines, `✔ Installed … into 4 agents`. A second tab plays a blocked install
(`BLOCK secrets.read …`, exit code 3). A third tab plays `update` → `rollback`.

**Trust receipt** (skill detail, publish result, admin review). A receipt-shaped panel:
perforated top edge, mono rows with dotted leaders (`content digest ………… sha256:…`), scanner
version and date, a verdict stamp rotated −6° (`ALLOWED`, `NEEDS CONFIRMATION`, `BLOCKED`,
`REVOKED`), then permissions (declared) and findings grouped by decision. Digests copy on
click.

**Bento features** (home). Six spotlight cards, asymmetric grid, each with a live artifact:
scan findings, a permission declaration, a rollback timeline, a lockfile entry, the
two-folder agent map, registry storage by digest.

**Compatibility map** (home + detail). The two skill folders as nodes, four agents as tiles,
lines showing which agent reads which folder.

## 6. Pages

| Page | Composition |
|---|---|
| `/` | Header · hero (eyebrow, serif h1, lede, ShimmerButton "Browse skills" + CopyCommand, terminal) · proof strip (4 mono stats: agents, scanner rules, seeded skills, "0 scripts executed at install") · search with agent/category filters + results grid of skill cards · bento features · compatibility map · how it works (4 steps) · guidelines CTA · footer |
| `/skills/[slug]` | Breadcrumb · title row (mono name, version select, status, verified mark) · CopyCommand · two columns: README (safe renderer, prose) / sticky side rail (trust receipt summary, AgentStrip, requirements, publisher, digests) · full findings · permissions · versions table · release notes |
| `/publish` | Explainer steps · token field + Dropzone · result as trust receipt |
| `/dashboard` | Token gate · skills list with versions, status, verdict |
| `/admin` | Login card · tabs: review queue (cards with receipt + approve/revoke/rescan dialogs requiring a reason) · publishers (create → token shown once in a CopyCommand) |
| `/guidelines` | Docs layout: sticky TOC with scrollspy, prose column, callouts, policy table, rule table, command examples in CopyCommand |
| `not-found`, `error` | On-brand, with search |

## 7. Motion (`motion/react`)

Wrap the app in `MotionConfig reducedMotion="user"`. Durations: micro 120–180ms, reveal
400ms, palette 180ms (scale 0.98 → 1 + fade), exits 30% faster than enters. Springs only for
pointer-driven hover (stiffness 300, damping 26). Animate `transform` and `opacity` only.

## 8. Constraints

- Strict CSP stays: no external scripts, images or fonts at run time; any inline script
  carries the request nonce; never `dangerouslySetInnerHTML` for skill content.
- Server components by default; client components only for interactive pieces.
- Works at 375, 768, 1024 and 1440px with no horizontal scroll.
- Copy: plain, specific, confident. Sentence case. No "AI-powered" language; say what the
  product does.
