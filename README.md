# media-worker.doubleyoup.com

Cloudflare Worker that serves the `doubleyoup-media` R2 bucket as public,
cacheable media — the sole read path for every site's offloaded media on the
doubleyoup platform. Handles two host shapes with one R2 key scheme
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
`Content-Range`) by passing `request.headers` straight through to R2's own
`onlyIf`/`range` option handling. A long immutable `Cache-Control` is set on
hits, a short one on 404s (so a bad/unknown path or host doesn't hammer
KV/R2 on every repeat request), and every response — including errors —
carries permissive read CORS since this only ever serves public assets.

## Bindings (`wrangler.toml`)

| Binding       | Type         | Purpose                                                          |
| ------------- | ------------ | ----------------------------------------------------------------- |
| `BUCKET`      | R2 bucket    | `doubleyoup-media` — one object per file, key = `<slug>/<path>`  |
| `HOSTMAP`     | KV namespace | branded hostname → slug lookup                                   |
| `SHARED_HOST` | var          | the shared host (`media.doubleyoup.com`) whose path already starts with the slug |

## Local dev

```
npm install
npm run dev        # wrangler dev
```

`wrangler dev` runs the Worker locally against local R2/KV emulation (add
`--remote` to hit the real bucket/namespace instead).

## Deploy

1. Create the R2 bucket (skip if it already exists):
   ```
   wrangler r2 bucket create doubleyoup-media
   ```
2. Create the KV namespace and paste the returned `id` into the
   `[[kv_namespaces]]` block in `wrangler.toml` (replacing
   `REPLACE_WITH_KV_ID` — this id is per-account and not committed pre-filled):
   ```
   wrangler kv namespace create HOSTMAP
   ```
3. Confirm `SHARED_HOST` under `[vars]` matches the shared media host.
4. Deploy:
   ```
   npm run deploy      # wrangler deploy
   ```
5. In the Cloudflare dashboard, enable **Cloudflare for SaaS** (Custom
   Hostnames) on the zone and set its fallback origin / Worker route so that
   branded `media.<customer>` hostnames route to this Worker. Leave the
   shared `media.doubleyoup.com` host on a direct R2 custom domain — don't
   also route the Worker there; pick one path per host.

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
