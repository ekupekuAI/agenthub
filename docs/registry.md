# Running the registry

The registry is the Next.js app in `apps/web`. It serves the website and the `/api/v1` API
that the CLI talks to. It stores metadata in an embedded Postgres database (PGlite) and
packages in a content-addressed folder. No external services are required.

## Run it locally

```bash
npm install
npm run seed -w apps/web      # creates two publishers and the starter skills
npm run dev -w apps/web       # http://localhost:3000
```

The seed prints each publisher token once. Keep the `agenthub-team` token if you want to
publish from the website. Run the seed while the server is stopped: the embedded database
allows one process at a time.

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
| `AGENTHUB_DATA_DIR` | Where data lives. Default: `apps/web/.data` (`pglite/` for the database, `artifacts/` for packages). |
| `AGENTHUB_ADMIN_TOKEN` | Enables administration. At least 32 characters. Without it, admin pages and routes answer 503. |
| `AGENTHUB_SESSION_SECRET` | Optional, at least 32 characters. Signs admin sessions. Defaults to a key derived from the admin token. |
| `AGENTHUB_TRUST_PROXY` | Set to `1` only behind a reverse proxy that overwrites `X-Forwarded-For`. Rate limiting then uses the client address from that header. |
| `AGENTHUB_SECURITY_CONTACT` | Contact shown in the footer and on the Guidelines page. |

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

Quarantined versions answer 403 on download; revoked versions answer 410.

## Deploying

The app runs anywhere Node.js 22+ runs with a persistent disk for `AGENTHUB_DATA_DIR`.

1. Build with `npm run build -w apps/web` and start with `npm run start -w apps/web`.
2. Put it behind HTTPS. The CLI refuses plain `http://` for anything except `localhost`.
3. Set `AGENTHUB_ADMIN_TOKEN`, and `AGENTHUB_TRUST_PROXY=1` if a reverse proxy sits in front.
4. Back up the data folder. Packages are immutable, so incremental backups stay small.

Serverless platforms without a persistent disk need a hosted Postgres and an object store in
place of the embedded database and the local artifact folder. The storage layer is behind an
`ArtifactStore` interface and the database behind Drizzle, so both can be swapped without
touching the API.

## Tests

```bash
npx vitest run apps/web           # unit tests
npm run build -w apps/web
npm run test:e2e -w apps/web      # browser tests (uses the installed Microsoft Edge)
```
