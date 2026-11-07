# media-worker.doubleyoup.com

Cloudflare Worker serving each site's own `doubleyoup-media-<slug>` R2 bucket
for the shared host and branded per-site hostnames, with a fallback to the
shared legacy bucket for sites not migrated yet. This is the read path for media
in the platform R2 account (H1 per-site isolation). An agency cell serves its
media from its own copy of this Worker (see [Agency copy](#agency-copy-hub43)).
There is no static R2 binding: the bucket names are
derived from the resolved slug and read with a SigV4-signed S3 GET using one
account-scoped, Object-Read-ONLY R2 credential (Worker secrets). Handles two
host shapes with one R2 key scheme (`<slug>/<path>`):

1. **Shared host** — `media.doubleyoup.com/<slug>/<path>`. Served via a Worker
   route (2026-08-27). The slug is already the first path segment, so the R2 key is
   just the path.
2. **Branded per-site hostnames** — `media.<customer-domain>/<path>`, attached
   to this Worker via Cloudflare for SaaS. The hostname is resolved to a slug
   through the `HOSTMAP` KV namespace (`hostname -> slug`), then the same
   `<slug>/<path>` key is served.

This is a **Cloudflare Worker**, not a Node service — no server process, no
constellation container, no BullMQ. It deploys from `main` through Workers
Builds (see [Deploy](#deploy)) and runs on Cloudflare's edge.

Only `GET`/`HEAD` are accepted (405 otherwise). Responses honor conditional
requests (`If-None-Match` → 304) and `Range` requests (→ 206 with
`Content-Range`) by forwarding — and signing — those headers on the S3 GET so R2
applies the semantics itself and returns the status this Worker maps back. A long
immutable `Cache-Control` is set on
hits, a short one on 404s (so a bad/unknown path or host doesn't hammer
KV/R2 on every repeat request), and every response — including errors —
carries permissive read CORS since this only ever serves public assets.

## Soft delete (hub#222)

Deleted media moves to `trash/<date>/<key>` instead of being hard-deleted, and a
deleted file must not stay public. The Worker refuses any request whose resolved
R2 key or site path starts with `trash/` — `/<slug>/trash/...` and `/trash/...`
on the shared host, `/trash/...` on a branded host — with the same plain 404 and
short negative cache as any missing object. The check runs after host routing and
slug validation (so a branded host still pays its `HOSTMAP` read) and before the
first R2 read: a trash request never reaches either the per-site or the shared
bucket. See `isTrashRequest` in `src/index.js`.

## Bucket resolution (per-site first, shared-bucket fallback)

Sites are migrated into their own bucket **one at a time**, so every request may try
two buckets, in this order:

| Attempt | Bucket | When |
| ------- | ------ | ---- |
| 1 (primary)  | `doubleyoup-media-<slug>` | always |
| 2 (fallback) | `MEDIA_BUCKET`, default `doubleyoup-media` | only if the primary answered **404, 401 or 403** |

- **404** on the primary means the per-site bucket doesn't exist yet (`NoSuchBucket`)
  or the object hasn't been copied into it (`NoSuchKey`).
- **401/403** on the primary means the read credential cannot see that bucket. With
  the deployed account-scoped key (below) this should not happen; fall-through keeps
  unmigrated sites serving if it does, and the `fallback-auth-denied` log line makes
  it visible (see [Debugging in prod](#debugging-in-prod)).
- **Any other primary status** (200/206/304/412, and every 5xx) is returned as-is: a
  real upstream failure is never masked by a second lookup.
- The fallback response is **not** re-interpreted: 404 there is the client's 404 (with
  the 60s negative cache), and 401/403 there is a 500, so a genuinely broken credential
  stays visible instead of turning into cached "not found".
- Cost: an unmigrated site pays one extra R2 round-trip per request that reaches the
  Worker. A per-slug "migrated" flag in KV would remove it — deliberately not built.
- Migration caveat: while a site's old objects still exist in the shared bucket, they
  stay publicly readable through the fallback. Deleting an object from the per-site
  bucket does **not** stop it being served until the shared-bucket copy is deleted too,
  so the copy-then-delete migration has to finish the delete.
- The response cache is keyed on the public URL (`<host>/<slug>/<path>`), never on
  which bucket answered, and the two buckets hold byte-identical objects under the same
  key — so a site migrating mid-cache is safe; the only staleness is a negative 404
  cached for up to 60s just before the object lands.

`MEDIA_BUCKET` names the **fallback** bucket only; it can never pin or override the
per-site primary. Retiring the fallback once every site is migrated means removing the
second attempt in `src/index.js` (`bucketAttemptOrder`), not just unsetting the var.

## Bindings (`wrangler.toml`)

| Binding                      | Type           | Purpose                                                          |
| ---------------------------- | -------------- | ----------------------------------------------------------------- |
| `R2_S3_KEY` / `R2_S3_SECRET` | Worker secrets | one account-scoped, **Object-Read-ONLY** R2 S3 credential used to SigV4-sign reads of the shared bucket **and** every per-site `doubleyoup-media-<slug>` bucket (`wrangler secret put`) |
| `R2_ACCOUNT_ID`              | Worker secret  | Cloudflare account id in the R2 S3 endpoint host `<id>.r2.cloudflarestorage.com` |
| `HOSTMAP`                    | KV namespace   | branded hostname → slug lookup                                   |
| `SHARED_HOST`                | var            | the shared host (`media.doubleyoup.com`) whose path already starts with the slug |
| `MEDIA_BUCKET`               | var            | the **fallback** (shared/legacy) bucket name; defaults to `doubleyoup-media` when unset |

### The read credential is account-scoped

The deployed `R2_S3_KEY`/`R2_S3_SECRET` is an account-scoped, Object-Read-only R2 key
(set 2026-08-20). It reads the shared bucket and every `doubleyoup-media-<slug>`
bucket. Do not replace it with a bucket-scoped key: with one, every primary
(per-site) lookup is an auth denial. The fallback hides that for unmigrated sites,
but a migrated site's objects are no longer in the shared bucket, so they 404.

## Local dev

```
npm install
npm run dev        # wrangler dev
npm test           # node's built-in test runner (no framework, no network)
```

`wrangler dev` runs the Worker locally against local R2/KV emulation (add
`--remote` to hit the real bucket/namespace instead).

`npm test` covers the bucket attempt order + fallback status rules and the trash-key
check (pure functions exported from `src/index.js`) and drives the whole request
handler with the R2 S3 endpoint stubbed at `globalThis.fetch` — no Workers runtime,
no credentials.

## Deploy

The platform Worker `doubleyoup-media` deploys from `main` through Cloudflare Workers
Builds. Settings in the doubleyoup Cloudflare account:

| Setting                   | Value                     |
| ------------------------- | ------------------------- |
| Production branch         | `main`                    |
| Root directory            | `/`                       |
| Build command             | `npm install && npm test` |
| Deploy command            | `npx wrangler deploy`     |
| Builds for other branches | off                       |

A merge into `main` is live in about a minute. Only the release PR from `dev` merges
into `main`; agent merges into `dev` deploy nothing. A failing `npm test` stops the
deploy. The build uses `npm install` because the repo has no lockfile (hub#236).

`wrangler deploy` keeps the Worker secrets and replaces the plain vars with `[vars]` of
`wrangler.toml`. `R2_ACCOUNT_ID`, `R2_S3_KEY` and `R2_S3_SECRET` must stay secrets: a
plain var that is not in `[vars]` is removed by the next deploy, and every read then
fails.

An agency copy in an agency's own Cloudflare account is not connected. Deploy it by
hand from its own copy (see [Agency copy](#agency-copy-hub43)).

### First setup in a new account

1. Create the KV namespace and paste the returned `id` into the
   `[[kv_namespaces]]` block in `wrangler.toml` (replacing
   `REPLACE_WITH_KV_ID` — this id is per-account and not committed pre-filled):
   ```
   wrangler kv namespace create HOSTMAP
   ```
2. Add the three secrets:
   ```
   wrangler secret put R2_ACCOUNT_ID  # Cloudflare account id
   wrangler secret put R2_S3_KEY      # account-scoped R2 token access key id (Object Read only)
   wrangler secret put R2_S3_SECRET   # its secret access key
   ```
3. Confirm `SHARED_HOST` under `[vars]` matches the shared media host.
4. Run the first `wrangler deploy` by hand, then connect the repo with Workers Builds
   using the settings above.
5. In the Cloudflare dashboard, enable **Cloudflare for SaaS** (Custom
   Hostnames) on the zone and set its fallback origin / Worker route so that
   branded `media.<customer>` hostnames route to this Worker.

The shared host `media.doubleyoup.com` routes through this Worker by a Workers route
(2026-08-27), not by a direct-R2 custom-domain binding. A direct binding would serve
only the shared bucket, so it could not serve a migrated site's objects, which are
only in its per-site bucket.

### Onboarding a branded host

Create the Cloudflare custom hostname, then add the KV mapping:

```
wrangler kv key put --binding=HOSTMAP media.<customer-domain> <slug>
```

The orchestrator does this automatically as part of site onboarding
(`orchestrator.doubleyoup.com`'s domain automation); the command above is for
manual/one-off use.

## Agency copy (hub#43)

An agency runs its OWN copy of this Worker in its own Cloudflare account, so its media is served from its own
buckets and the platform holds no key to them. Use `wrangler.agency.toml.example` as the starting point.

1. Fork or copy this repo into the agency's account. Copy `wrangler.agency.toml.example` to `wrangler.toml`.
2. Set `SHARED_HOST` and the route pattern to one host on the agency zone, for example `media.<agency zone>`.
   Keep it to one label under the zone so the Universal SSL certificate covers it.
3. Keep `MEDIA_BUCKET = "none"`. It turns the shared fallback bucket off (the agency has no such bucket).
4. In the agency's R2 dashboard create an Object-Read-ONLY key that is ACCOUNT-WIDE (Object Read on ALL buckets of the account), not a list of buckets. A new site's bucket `doubleyoup-media-<slug>` is then covered without a change to the key. A key that names buckets makes the Worker answer 500 for every object of a new site (an R2 403 becomes an internal error here). The orchestrator checks this after it provisions a new site: it asks for an object that cannot exist and only a 404 passes (hub#43 M7). Set the three secrets with
   `wrangler secret put R2_ACCOUNT_ID`, `R2_S3_KEY` and `R2_S3_SECRET`.
5. Deploy by hand with `wrangler deploy`. Check one object: `curl -sI https://<host>/<slug>/<key>`.
6. Move a site with `npm run media-relocate` in the orchestrator (dry run first). It copies the objects into the
   agency bucket `doubleyoup-media-<slug>`, switches the site's constants to this host, and verifies.

The path is `/<slug>/<key>`, the same as the shared host, so the site's `DOUBLEYOUP_R2_PREFIX` stays the slug.

### HOSTMAP is required on an agency copy (hub#133)

The `HOSTMAP` KV namespace is **required** on an agency copy: any non-shared host
is resolved to a slug through `env.HOSTMAP` before a bucket is read, and the
agency copy exists to serve branded hosts. There is no branded-host read path
without it. Title the namespace `HOSTMAP`, or set its id as `MEDIA_HOSTMAP_KV_ID`
on the agency-orchestrator Worker.

- The platform writes `<branded media host>` → R2 prefix entries into it through
  the agency Worker.
- Per-customer branded hosts (`media.<customer domain>`) reach this Worker
  through a per-hostname Workers route (`media.<customer domain>/*`) in the
  agency zone — never a `*/*` route (see "Why a SPECIFIC route, never `*/*`" in
  recipes/branded-media.md). The route's script name comes from
  `MEDIA_WORKER_SCRIPT` (default `doubleyoup-media`) on the agency-orchestrator
  Worker.
- **No per-site direct R2 custom-domain binding** (`<slug>-media.<agency zone>`,
  Jason's decision 3, 2026-11-03): a binding that points straight at a bucket
  bypasses this Worker, so it never gets the `trash/` refusal (hub#222) and
  serves a deleted file for up to its cache TTL. The Workers-route path above
  replaces it; unbind any existing `<slug>-media.<agency zone>` custom domains
  from the R2 dashboard once their site is verified on this Worker (a documented
  step, never automatic).

This needs three more scopes on the agency's existing `CF_DNS_API_TOKEN` (widen
the one token; do not create a second one):

| Scope                              | Why                                                 |
| ---------------------------------- | --------------------------------------------------- |
| Zone → SSL and Certificates: Edit  | the Cloudflare-for-SaaS custom-hostname certificate |
| Zone → Workers Routes: Edit        | the per-hostname Workers routes                     |
| Account → Workers KV Storage: Edit | the HOSTMAP entries                                 |

### Per-agency enablement runbook

One-time setup per agency; every value below is a placeholder:

1. **Widen the token.** Add the three scopes above to the agency's
   `CF_DNS_API_TOKEN` (SSL and Certificates / Workers Routes / Workers KV
   Storage).
2. **Confirm Cloudflare for SaaS.** On the agency zone, Custom Hostnames is on
   with fallback origin `host.<agency zone>`.
3. **Create + bind HOSTMAP.**
   ```
   wrangler kv namespace create HOSTMAP
   ```
   Paste the id into the `[[kv_namespaces]]` block of the agency `wrangler.toml`
   and redeploy the agency media Worker by hand.
4. **Point the orchestrator at it.** Set `MEDIA_WORKER_SCRIPT` (default
   `doubleyoup-media`) and `MEDIA_HOSTMAP_KV_ID` (the new namespace id) on the
   agency-orchestrator Worker.
5. **Re-run the onboarding self-check** on the agency-orchestrator Worker; it
   must come back green before any branded host is routed.

One media host per agency: `media.<agency zone>`. `npm run media-relocate` in the orchestrator refuses any other
host for an agency cell. A NEW site on an agency cell is provisioned on this host and on the agency's bucket from
the start (orchestrator and app flag `AGENCY_MEDIA_ENABLED=1`, default off). Turn that flag on only after this
Worker is deployed and serving the host.

## Debugging in prod

```
npm run tail        # wrangler tail — live request log from the deployed Worker
```

Healthy traffic logs nothing (including the primary-404 → fallback-200 path every
unmigrated site takes). Two `console.warn` lines are emitted on the fallback path, and
they are the triage signal:

| Line | Meaning |
| ---- | ------- |
| `[media-worker] fallback-auth-denied status=<401\|403> slug=… primary_bucket=… key=…` | the read credential cannot see the per-site bucket. The deployed key is account-scoped, so a steady stream of these lines means a site's per-site read is broken (missing, unscoped or revoked key) and the shared bucket is hiding that failure. |
| `[media-worker] not-found-in-both-buckets slug=… key=… primary_bucket=… fallback_bucket=…` | the object exists in neither bucket — a genuine 404, not an auth problem. |

If a *migrated* site 404s or 500s, check the read credential first: a bucket-scoped
key makes the per-site lookup fail and the shared bucket (which no longer holds the
object once it's been moved) answers 404.
