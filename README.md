# media-worker.doubleyoup.com

Cloudflare Worker that serves each site's **own** R2 bucket
(`doubleyoup-media-<slug>`) as public, cacheable media — the sole read path for
every site's offloaded media on the doubleyoup platform (H1 per-site isolation).
There is no static R2 binding: the bucket is derived from the resolved slug and
read with a SigV4-signed S3 GET using one account-scoped, Object-Read-ONLY R2
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

## Bindings (`wrangler.toml`)

| Binding                      | Type           | Purpose                                                          |
| ---------------------------- | -------------- | ----------------------------------------------------------------- |
| `R2_S3_KEY` / `R2_S3_SECRET` | Worker secrets | one account-scoped, **Object-Read-ONLY** R2 S3 credential used to SigV4-sign reads of every per-site `doubleyoup-media-<slug>` bucket (`wrangler secret put`) |
| `R2_ACCOUNT_ID`              | var            | Cloudflare account id in the R2 S3 endpoint host `<id>.r2.cloudflarestorage.com` |
| `HOSTMAP`                    | KV namespace   | branded hostname → slug lookup                                   |
| `SHARED_HOST`                | var            | the shared host (`media.doubleyoup.com`) whose path already starts with the slug |

## Local dev

```
npm install
npm run dev        # wrangler dev
```

`wrangler dev` runs the Worker locally against local R2/KV emulation (add
`--remote` to hit the real bucket/namespace instead).

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
(a) the per-site `doubleyoup-media-<slug>` buckets existing + migrated and (b)
re-routing `media.doubleyoup.com` off its current direct-R2-custom-domain binding
onto this Worker (a zone change, per-slug flippable during migration). Until then
the shared host keeps serving the single legacy bucket directly and only branded
hostnames route here.

### Onboarding a branded host

Create the Cloudflare custom hostname, then add the KV mapping:

```
wrangler kv key put --binding=HOSTMAP media.<customer-domain> <slug>
```

The orchestrator does this automatically as part of site onboarding
(`orchestrator.doubleyoup.com`'s domain automation); the command above is for
manual/one-off use.

## Debugging in prod

```
npm run tail        # wrangler tail — live request log from the deployed Worker
```

No test suite in this repo.
