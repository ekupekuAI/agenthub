# Deploy the registry on Vercel (free, no domain needed)

This guide puts the registry (`apps/web`) online at `https://<project>.vercel.app` using only
free plans:

- **Vercel** (Hobby plan) runs the website and the `/api/v1` API.
- **Neon** (Free plan) holds the database (hosted Postgres).
- **Vercel Blob** (included in Hobby) holds the uploaded `.skillpkg` packages.

You do not need a domain name, a credit card, Docker or a server. Plan on about 30 minutes.

## Before you start

- The repository is on GitHub (your own account or organization).
- Node.js 22 or newer and npm on your computer, and a local clone of the repository
  (`npm ci` at the repository root has been run once).
- A password manager or another safe place for three secrets: the database connection
  string, the admin token and the first publisher token.

Read [Limits of the free plans](#limits-of-the-free-plans) once before you rely on this setup.

## 1. Create the database on Neon

1. Go to <https://neon.com> and select **Sign up**. Signing up with GitHub is the quickest.
2. On the "Create project" screen:
   - **Project name**: `agenthub`.
   - **Postgres version**: leave the default.
   - **Cloud provider / Region**: AWS, **US East (N. Virginia)** `us-east-1`. Vercel runs
     functions in Washington, D.C. (`iad1`) by default; keeping both close makes every
     request faster. If you change one, change the other (see step 3.6).
   - Select **Create project**.
3. On the project dashboard, select **Connect** (top right).
4. In the dialog:
   - **Branch**: `production` (or `main`), **Database**: `neondb`, **Role**: the default
     owner role.
   - Turn **Connection pooling** on. The host name in the string now contains `-pooler`.
   - Select **Show password**, then **Copy snippet** for the plain connection string. It looks
     like `postgresql://neondb_owner:…@ep-…-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require`.
5. Store that string in your password manager. This is your `DATABASE_URL`. Anyone who has
   it can read and change the whole registry.

You do not create any tables: the registry creates them itself on its first request (it is
safe when several copies start at the same time).

## 2. Create two secrets

Run this twice on your computer and keep both outputs in your password manager:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

- The first value is your **admin token** (`AGENTHUB_ADMIN_TOKEN`). It signs you in to
  `/admin`.
- The second is the **session secret** (`AGENTHUB_SESSION_SECRET`).

## 3. Create the Vercel project

1. Go to <https://vercel.com/signup>, choose **Hobby**, and continue with GitHub.
2. On the dashboard select **Add New…** → **Project**.
3. Under **Import Git Repository**, find the agenthub repository and select **Import**. (If it
   is not listed, select **Adjust GitHub App Permissions** and give Vercel access to it.)
4. On the **Configure Project** screen:
   - **Project Name**: this becomes your address, `https://<project-name>.vercel.app`. Pick
     something unique such as `agenthub-registry-yourname`.
   - **Framework Preset**: Next.js.
   - **Root Directory**: select **Edit**, choose `apps/web`, then **Continue**.
   - **Build and Output Settings**: leave them alone. `apps/web/vercel.json` already sets the
     install command (`npm ci` at the repository root) and the build command
     (`npm run build -w apps/web`, which first bundles the package scanner).
   - **Environment Variables**: add these (name on the left, value on the right; select
     **Add** after each):

     | Name | Value |
     |---|---|
     | `DATABASE_URL` | the Neon connection string from step 1 |
     | `AGENTHUB_ADMIN_TOKEN` | the admin token from step 2 |
     | `AGENTHUB_SESSION_SECRET` | the session secret from step 2 |
     | `AGENTHUB_TRUST_PROXY` | `1` |
     | `AGENTHUB_SECURITY_CONTACT` | an e-mail address people can report problems to |

   - Select **Deploy**. The first build takes a few minutes. It succeeds, but the site shows
     errors until the next two steps are done: there is nowhere to store packages yet.
5. Open the project (**Continue to Dashboard**), then **Settings** in the project sidebar:
   - **Build and Deployment** → **Node.js Version**: `24.x` (or `22.x`). Select **Save**.
   - **Build and Deployment** → **Root Directory**: check that **Include files outside the
     root directory in the Build Step** is **Enabled** (the app uses packages from
     `packages/`). Select **Save** if you changed it.
6. Still in **Settings** → **Functions**:
   - **Fluid Compute** should be on (the default for new projects).
   - **Function Region**: Washington, D.C., USA (`iad1`), or the region closest to the Neon
     region you chose.

`AGENTHUB_TRUST_PROXY=1` is right for Vercel: Vercel replaces any `X-Forwarded-For` header a
client sends with the address it saw, so the registry can rate-limit each client separately.
Leave it unset only when nothing sits in front of the app.

## 4. Add the package store (Vercel Blob)

1. In the project, open **Storage** in the sidebar and select **Create Database** (or
   **Create Storage**), then choose **Blob** and **Continue**.
2. Set the access to **Private**. (Private keeps quarantined and revoked packages unreachable
   except through the registry, which checks their status first.)
3. Name it `agenthub-packages` and select **Create**.
4. When asked which environments get the token, keep **Production** and **Preview** and also
   tick **Development** (you need it for step 6). Select **Connect**.

Vercel adds `BLOB_READ_WRITE_TOKEN` (and `BLOB_STORE_ID`) to the project for you. If you
created the store as **Public** instead, also add `AGENTHUB_BLOB_ACCESS` = `public`.

## 5. Redeploy

Environment changes only apply to new deployments.

1. Open **Deployments** in the sidebar.
2. On the newest deployment select **⋯** → **Redeploy** → **Redeploy**.
3. When it shows **Ready**, open `https://<project-name>.vercel.app`. The home page loads,
   with no skills yet.

## 6. Seed the registry from your computer

The seed creates two publishers (`agenthub-team`, verified, and `fixture-lab`), publishes the
starter skills, and publishes three deliberately unsafe test skills so the moderation queue
has something in it. It runs on your computer and writes straight to Neon and Vercel Blob.

1. Get the Blob token: **Storage** → `agenthub-packages` → the **.env.local** tab (or
   **Quickstart**) → **Show secret** → copy the `BLOB_READ_WRITE_TOKEN=…` line. (With the
   Vercel CLI you can instead run `vercel env pull` in `apps/web`.)
2. Create the file `apps/web/.env.seed.local` (Git ignores it) with:

   ```bash
   DATABASE_URL=postgresql://…your Neon string…
   BLOB_READ_WRITE_TOKEN=vercel_blob_rw_…
   AGENTHUB_SEED_FORCE=1
   ```

   `AGENTHUB_SEED_FORCE=1` confirms that you mean to write to the hosted registry; without it
   the seed refuses. Add `AGENTHUB_BLOB_ACCESS=public` if your store is public.
3. From the repository root run:

   ```bash
   npm run seed -w apps/web -- --env-file .env.seed.local
   ```

   It prints `database: postgresql://ep-…-pooler…` and `packages: Vercel Blob`, then one line
   per skill. Running it again is safe: existing publishers and versions are skipped.
4. Publisher tokens are **not** printed. They are in `apps/web/.data/seed-tokens.txt`. Copy the
   `agenthub-team` token into your password manager (you need it to publish), then delete
   `seed-tokens.txt` and `.env.seed.local`.

## 7. Check that it works

1. Open `https://<project-name>.vercel.app`: the starter skills are listed.
2. Open `https://<project-name>.vercel.app/api/v1/skills?q=testing`: you see JSON with
   `"ok":true` and `web-testing` in the results.
3. Open `/admin`, sign in with the admin token. The review queue lists `secret-reader` and
   `download-exec` as quarantined (they were blocked by the scanner, as they should be).
4. Point the CLI at the registry and install something:

   ```bash
   agenthub config set registry https://<project-name>.vercel.app -g
   agenthub search testing
   agenthub install web-testing
   ```

5. Publish a test release: open `/publish`, paste the `agenthub-team` token, and upload a
   `.skillpkg` built with `agenthub pack ./my-skill`. Or with the API:

   ```bash
   curl -X POST "https://<project-name>.vercel.app/api/v1/publish" \
     -H "Authorization: Bearer $AGENTHUB_TOKEN" \
     -H "Content-Type: application/octet-stream" \
     --data-binary @my-skill-1.0.0.skillpkg
   ```

If something fails, open **Logs** in the project sidebar. Messages from the registry start
with `[agenthub]`, for example `DATABASE_URL is not set` or `BLOB_READ_WRITE_TOKEN is not set`
(add the variable, then redeploy), or `package scanner: bundled worker …` (the scanner
started normally).

## Updating

Every push to the default branch deploys automatically; pushes to other branches create
preview deployments that use the same database and package store. Database changes in a new
version are applied automatically on its first request.

## Limits of the free plans

Checked in October 2026; the providers change their plans, so confirm on their pricing pages.

**Vercel Hobby**

- **Personal, non-commercial use only.** A registry for a company or a paid product needs the
  Pro plan.
- **Uploads are limited to 4.5 MB** per request by the platform (the registry itself accepts
  up to 10 MiB). Larger packages are rejected by Vercel with `413 FUNCTION_PAYLOAD_TOO_LARGE`
  before they reach the registry. Downloads are streamed, so they are not affected.
- **Time per request**: with Fluid Compute (the default) functions may run up to 300 seconds;
  the publish and rescan endpoints are set to 60 seconds, which covers a cold start plus the
  15-second scan budget (`AGENTHUB_SCAN_TIMEOUT_MS`).
- Functions get 2 GB of memory and 1 vCPU. Hobby usage has fixed monthly allowances; going
  over them is never billed, but Vercel limits the project until the allowance resets or you
  upgrade.
- Rate limits are kept in each function instance's memory. Vercel runs several instances
  under load, so the limits are per instance, not global.

**Vercel Blob (Hobby)**

- 1 GB stored, 10,000 simple operations (reads that miss the cache), 2,000 advanced
  operations (uploads) and 10 GB data transfer per month.
- When a limit is exceeded, Blob stops working for the project until 30 days have passed:
  installs and publishes fail. You are not charged.
- Each publish is one upload; each install reads the package once.

**Neon Free**

- 1 GB of database storage per project, 100 compute hours per project per month and 5 GB of
  network egress per month.
- The database sleeps after 5 minutes without queries. The first request after a pause takes
  a second or two longer while it wakes up.

## Security notes

- Keep `DATABASE_URL`, `BLOB_READ_WRITE_TOKEN`, the admin token and publisher tokens out of
  Git, chat and screenshots. If one leaks: reset the Neon role password (Neon → **Roles**),
  rotate the Blob token (store → **Settings**), change `AGENTHUB_ADMIN_TOKEN` in Vercel and
  redeploy, or rotate a publisher token in `/admin`.
- Packages are stored under content addresses (`sha256/<digest>.skillpkg`), are never
  overwritten, and are re-hashed on every read. With a public store, a package is reachable by
  anyone who knows its digest, including quarantined and revoked ones; use a private store.
- Preview deployments share the production database and store. Do not give untrusted people
  access to your Vercel project.
