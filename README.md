# media-worker.doubleyoup.com

Cloudflare Worker that serves each site's **own** R2 bucket
(`doubleyoup-media-<slug>`) as public, cacheable media — the sole read path for
every site's offloaded media on the doubleyoup platform (H1 per-site isolation) —
falling back to the shared legacy bucket for sites not migrated yet (see
[Bucket resolution](#bucket-resolution-per-site-first-shared-bucket-fallback)).
There is no static R2 binding: the bucket names are derived from the resolved slug
and read with a SigV4-signed S3 GET using one account-scoped, Object-Read-ONLY R2
credential (Worker secrets). Handles two host shapes with one R2 key scheme
(`<slug>/<path>`):

1. **Shared host** — `media.doubleyoup.com/<slug>/<path>`. The slug is already
   the first path segment, so the R2 key is just the path.
2. **Branded per-site hostnames** — `media.<customer-domain>/<path>`, attached
   to this Worker via Cloudflare for SaaS. The hostname is resolved to a slug
   through the `HOSTMAP` KV namespace (`hostname -> slug`), then the same
   `<slug>/<path>` key is served.

This is a **Cloudflare Worker**, not a Node service — no server process, no
constellation container, no BullMQ. It's deployed with `wrangler` and runs on
Cloudflare's edge.

Only `GET`/`HEAD` are accepted (405 otherwise). Responses honor conditional
requests (`If-None-Match` → 304) and `Range` requests (→ 206 with
`Content-Range`) by forwarding — and signing — those headers on the S3 GET so R2
applies the semantics itself and returns the status this Worker maps back. A long
immutable `Cache-Control` is set on
hits, a short one on 404s (so a bad/unknown path or host doesn't hammer
KV/R2 on every repeat request), and every response — including errors —
carries permissive read CORS since this only ever serves public assets.

## Bucket resolution (per-site first, shared-bucket fallback)

Sites are migrated into their own bucket **one at a time**, so every request may try
two buckets, in this order:

| Attempt | Bucket | When |
| ------- | ------ | ---- |
| 1 (primary)  | `doubleyoup-media-<slug>` | always |
| 2 (fallback) | `MEDIA_BUCKET`, default `doubleyoup-media` | only if the primary answered **404, 401 or 403** |

- **404** on the primary means the per-site bucket doesn't exist yet (`NoSuchBucket`)
  or the object hasn't been copied into it (`NoSuchKey`).
- **401/403** on the primary means the read credential can't see that bucket — the
  state during the credential swap described below. Treating it as fall-through keeps
  every unmigrated site serving.
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
| `R2_ACCOUNT_ID`              | var/secret     | Cloudflare account id in the R2 S3 endpoint host `<id>.r2.cloudflarestorage.com` |
| `HOSTMAP`                    | KV namespace   | branded hostname → slug lookup                                   |
| `SHARED_HOST`                | var            | the shared host (`media.doubleyoup.com`) whose path already starts with the slug |
| `MEDIA_BUCKET`               | var            | the **fallback** (shared/legacy) bucket name; defaults to `doubleyoup-media` when unset |

### The read credential must become ACCOUNT-scoped before per-site buckets go live

The deployed `R2_S3_KEY`/`R2_S3_SECRET` today is the shared platform R2 key —
**bucket-scoped to `doubleyoup-media`** (and not read-only). With that key, every
primary (per-site) lookup is an auth denial that the fallback absorbs, so the Worker
keeps serving correctly, but **no migrated site can be read**. Before the first
per-site bucket goes live, mint an **account-scoped, Object-Read-only** R2 token
(readable across the shared bucket and every `doubleyoup-media-<slug>` bucket) and
`wrangler secret put` both values again.

## Local dev

```
npm install
npm run dev        # wrangler dev
npm test           # node's built-in test runner (no framework, no network)
```

`wrangler dev` runs the Worker locally against local R2/KV emulation (add
`--remote` to hit the real bucket/namespace instead).

`npm test` covers the bucket attempt order + fallback status rules (pure functions
exported from `src/index.js`) and drives the whole request handler with the R2 S3
endpoint stubbed at `globalThis.fetch` — no Workers runtime, no credentials.

## Deploy

1. Create the KV namespace and paste the returned `id` into the
   `[[kv_namespaces]]` block in `wrangler.toml` (replacing
   `REPLACE_WITH_KV_ID` — this id is per-account and not committed pre-filled):
   ```
   wrangler kv namespace create HOSTMAP
   ```
2. Set `R2_ACCOUNT_ID` under `[vars]` and add the read credential secrets:
   ```
   wrangler secret put R2_S3_KEY      # account-scoped R2 token access key id (Object Read only)
   wrangler secret put R2_S3_SECRET   # its secret access key
   ```
3. Confirm `SHARED_HOST` under `[vars]` matches the shared media host.
4. Deploy:
   ```
   npm run deploy      # wrangler deploy
   ```
5. In the Cloudflare dashboard, enable **Cloudflare for SaaS** (Custom
   Hostnames) on the zone and set its fallback origin / Worker route so that
   branded `media.<customer>` hostnames route to this Worker.

**Gated prerequisites (Jason) before the shared host is served here:** this Worker
targets the end state where it serves `media.doubleyoup.com` too, but that requires
re-routing `media.doubleyoup.com` off its current direct-R2-custom-domain binding
onto this Worker (a zone change, per-slug flippable during migration). Until then
the shared host keeps serving the single legacy bucket directly and only branded
hostnames route here. The per-site buckets are **no longer** a prerequisite for that
re-route — an unmigrated slug is served from the shared bucket by the fallback — but
the account-scoped read credential above is.

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
4. In the agency's R2 dashboard create an Object-Read-ONLY key for the media buckets. Set the three secrets with
   `wrangler secret put R2_ACCOUNT_ID`, `R2_S3_KEY` and `R2_S3_SECRET`.
5. `wrangler deploy`. Check one object: `curl -sI https://<host>/<slug>/<key>`.
6. Move a site with `npm run media-relocate` in the orchestrator (dry run first). It copies the objects into the
   agency bucket `doubleyoup-media-<slug>`, switches the site's constants to this host, and verifies.

The path is `/<slug>/<key>`, the same as the shared host, so the site's `DOUBLEYOUP_R2_PREFIX` stays the slug.
The existing per-site custom domains (`<slug>-media.<agency zone>`) bind a bucket directly and do not use this
Worker. Keep them serving until their site is switched to this host. After the switch is verified, unbind the
site's custom domain in the agency's R2 dashboard (a documented step, never automatic).

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
| `[media-worker] fallback-auth-denied status=<401\|403> slug=… primary_bucket=… key=…` | the read credential can't see the per-site bucket. Expected for every request while the deployed key is still bucket-scoped; **after** the account-scoped key is live, a persistent stream of these means a migrated site's read is broken (missing/unscoped/revoked key) and is being silently masked by the shared bucket. |
| `[media-worker] not-found-in-both-buckets slug=… key=… primary_bucket=… fallback_bucket=…` | the object exists in neither bucket — a genuine 404, not an auth problem. |

If a *migrated* site 404s or 500s, check the read credential first: a bucket-scoped
key makes the per-site lookup fail and the shared bucket (which no longer holds the
object once it's been moved) answers 404.
