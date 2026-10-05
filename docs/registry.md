# Running the registry

The registry is the Next.js app in `apps/web`. It serves the website and the `/api/v1` API
that the CLI talks to. By default it stores metadata in an embedded Postgres database (PGlite)
and packages in a content-addressed folder, so no external services are required. With
`DATABASE_URL` and `BLOB_READ_WRITE_TOKEN` set it uses a hosted Postgres (Neon) and Vercel
Blob instead; see [Deploying](#deploying).

## Run it locally

```bash
npm install
npm run seed -w apps/web      # creates two publishers and the starter skills
npm run dev -w apps/web       # http://localhost:3000
```

The seed writes each new publisher token to `<data dir>/seed-tokens.txt` (add
`-- --print-tokens` to print them instead). Keep the `agenthub-team` token if you want to
publish from the website, then delete the file. The seed refuses to run with
`NODE_ENV=production` unless `AGENTHUB_SEED_FORCE=1` is set. Run it while the server is
stopped: the embedded database allows one process at a time.

Point the CLI at it:

```bash
agenthub config set registry http://localhost:3000
agenthub search testing
agenthub install web-testing
```

For a production-style run:

```bash
npm run build -w apps/web
npm run start -w apps/web
```

## Settings

| Variable | Purpose |
|---|---|
| `AGENTHUB_DATA_DIR` | Where data lives. Default: `apps/web/.data` (`pglite/` for the database, `artifacts/` for packages, `seed-tokens.txt`). |
| `DATABASE_URL` | Hosted Postgres (Neon) connection string, preferably the pooled one. Replaces the embedded database. The schema is created on first use. |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob token. Replaces the local package folder. |
| `AGENTHUB_BLOB_ACCESS` | `private` (default) or `public`: must match how the Blob store was created. |
| `AGENTHUB_ADMIN_TOKEN` | Enables administration. At least 32 characters. Without it, admin pages and routes answer 503. |
| `AGENTHUB_SESSION_SECRET` | Optional, at least 32 characters. Signs admin sessions and publisher sign-in cookies. Defaults to keys derived from the admin token and the GitHub client secret. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub OAuth app for publisher sign-in (see [Enable GitHub sign-in](deploy-vercel.md#enable-github-sign-in)). Without both, sign-in is off and `/api/auth/*` answer 503. |
| `AGENTHUB_PUBLIC_URL` | The registry's public origin, e.g. `https://agenthub-registry.vercel.app`. Required for GitHub sign-in on any host other than `localhost`. |
| `AGENTHUB_TRUST_PROXY` | Number of trusted reverse proxies in front of the app (for example `1`; on Vercel, `1`). Rate limiting then uses the address appended by the outermost trusted proxy. Leave it unset when the app is reached directly: client-supplied `X-Forwarded-For` is then ignored and anonymous traffic shares one rate-limit bucket per route group. |
| `AGENTHUB_SCAN_TIMEOUT_MS` | Time budget for validating and scanning one upload (default 15000). Uploads that exceed it are rejected. |
| `AGENTHUB_SCAN_CONCURRENCY` | Uploads scanned at the same time (default 2). Extra uploads queue briefly, then get 429. |
| `AGENTHUB_SECURITY_CONTACT` | Contact shown in the footer and on the Guidelines page. |

`apps/web/.env.example` lists every setting with a short explanation.

Generate secrets with a password manager or:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Never commit secrets. Use your host's secret store.

## Administration

Open `/admin` and sign in with the admin token. From there you can:

- review quarantined releases, with their findings;
- approve a release (a reason is required), revoke it, or scan it again;
- create publishers. The publisher token is shown once.

Publishers can also sign in with GitHub (when configured). The first sign-in creates an
unverified publisher named after the GitHub login (with a suffix when the name is taken); the
account is tied to the numeric GitHub id, so a renamed login keeps its publisher. Signed-in
publishers publish from the site without a token and create, list and revoke named CLI tokens
in the dashboard. Only token hashes are stored; the GitHub access token is never stored.

Revocation is final: a revoked version cannot be approved or rescanned back to active, and a
new upload whose content matches a revoked or quarantined version is held for review.
Publishers can be suspended and their tokens rotated through
`POST /api/v1/admin/publishers/manage` with `{ "displayName", "action": "rotate-token" | "disable" | "enable" | "verify" | "unverify" }`.
Rotating revokes every token of the publisher and issues one new token.

### Name protection

Names stay flat (no namespaces). The first publish of a new name is checked
(`apps/web/src/lib/names.ts`); a hit is held, not rejected: the version is quarantined and the
review queue shows a **Name review** row with the reason and the colliding skill.

- **Reserved names** (`agenthub`, `admin`, `api`, `registry`, `official`, vendor and agent
  names such as `anthropic`, `openai`, `claude`, `claude-code`, `codex`, `cursor`, `github`,
  and route words such as `login`, `publish`, `dashboard`) are held for every publisher,
  verified or not: `name-review: reserved name`.
- **Lookalikes** of a name another publisher owns are held: `name-review: looks like <name>`.
  Names are compared after lowercasing, removing `-` `_` `.`, folding `0→o 1/i→l 3→e 4→a 5→s
  7→t rn→m vv→w cl→d`, dropping affixes (`-cli`, `-skill`, `-tool`, `-js`, `-py`,
  `official-`, …) and plurals, and sorting words; or by Damerau-Levenshtein distance ≤ 1 from
  5 characters (≤ 2 from 10). A publisher's own names never collide with each other.
- **Approving** any version of a held skill (reason required) approves the name; later versions
  publish normally. **Revoking every version** retires the name (`name_tombstones`): another
  publisher gets 409, the original publisher may publish again (still scanned).

Limits: findings stored per scan are capped at 500 (blocking findings first, with full
counts kept); a stored README is capped at 256 KiB; each skill accepts at most 50 new
versions a day and each publisher 200.

## API

All JSON responses are `{ "ok": true, "data": … }` or
`{ "ok": false, "error": { "code", "message" } }`.

| Method | Route | Purpose | Auth |
|---|---|---|---|
| GET | `/api/v1/skills?q=&agent=&category=` | Search | none |
| GET | `/api/v1/skills/:slug` | Skill detail | none |
| GET | `/api/v1/skills/:slug/versions` | All versions, with status | none |
| GET | `/api/v1/skills/:slug/resolve?agent=&version=&channel=` | Highest matching active version | none |
| GET | `/api/v1/skills/:slug/download/:version` | Package bytes, with `X-Archive-Digest` and `X-Content-Digest` | none |
| POST | `/api/v1/publish` | Publish a `.skillpkg` | publisher token |
| POST | `/api/v1/skills/:slug/scan` | Scan a version again | admin token |
| POST | `/api/v1/skills/:slug/revoke` | Revoke a version | admin token |
| POST | `/api/v1/skills/:slug/status` | Approve or quarantine a version | admin token |
| POST | `/api/v1/admin/publishers` | Create a publisher | admin token |
| POST | `/api/v1/admin/publishers/manage` | Rotate tokens, suspend, re-enable or verify a publisher | admin token |
| GET | `/api/auth/github/start`, `/api/auth/github/callback` | GitHub sign-in (browser) | none |
| POST | `/api/auth/signout` | End the publisher session (same-origin form) | session |

Search results and skill detail carry optional fields for client warnings: `publisher.verified`,
`firstPublishedAt` (ISO time the name was first published) and
`nameReview: { status: "clear" | "held", reason? }`. Publish responses carry `nameReview` too.

`/versions` accepts `limit` and `offset` (up to 1000 per page). Only the latest or requested
version carries its full findings list; other versions carry counts.

Quarantined versions answer 403 on download; revoked versions answer 410.

## Deploying

**Vercel (free, no domain):** follow [Deploy the registry on Vercel](deploy-vercel.md). It uses
Neon for the database and Vercel Blob for packages, and covers seeding, checks and the limits
of the free plans.

**Your own server:** the app runs anywhere Node.js 22+ runs. With no `DATABASE_URL` and no
`BLOB_READ_WRITE_TOKEN` it needs a persistent disk for `AGENTHUB_DATA_DIR`.

1. Build with `npm run build -w apps/web` and start with `npm run start -w apps/web`. The build
   first bundles the package scanner into `apps/web/dist/scan-worker.mjs`, which the server
   runs in worker threads.
2. Put it behind HTTPS. The CLI refuses plain `http://` for anything except `localhost`.
3. Set `AGENTHUB_ADMIN_TOKEN`, and `AGENTHUB_TRUST_PROXY=1` if a reverse proxy sits in front.
4. Back up the data folder (or the Postgres database and Blob store). Packages are immutable,
   so incremental backups stay small.

The seed refuses to write to a hosted database or Blob store unless `AGENTHUB_SEED_FORCE=1` is
set; `npm run seed -w apps/web -- --env-file <file>` reads the settings from a file.

## Tests

```bash
npx vitest run apps/web           # unit tests
npm run build -w apps/web
npm run test:e2e -w apps/web      # browser tests (uses the installed Microsoft Edge)
```
