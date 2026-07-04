# media-worker.doubleyoup.com

Cloudflare Worker that serves the `doubleyoup-media` R2 bucket as public,
cacheable media for:

- the shared host — `media.doubleyoup.com/<slug>/<path>` (R2 key = `<slug>/<path>`)
- branded per-site custom hostnames — `media.<customer-domain>/<path>`, attached
  to this Worker via Cloudflare for SaaS, where the hostname is resolved to a
  slug through the `HOSTMAP` KV namespace (`hostname -> slug`) and the same
  `<slug>/<path>` key is served.

Only `GET`/`HEAD` are accepted (405 otherwise). Responses honor conditional
requests (`If-None-Match` -> 304) and `Range` requests (-> 206 with
`Content-Range`), set a long immutable `Cache-Control` on hits and a short
one on 404s, and add permissive read CORS since this only ever serves public
assets.

## Bindings (`wrangler.toml`)

| Binding    | Type          | Purpose                                              |
| ---------- | ------------- | ----------------------------------------------------- |
| `BUCKET`   | R2 bucket     | `doubleyoup-media` — one object per file, key = `<slug>/<path>` |
| `HOSTMAP`  | KV namespace  | branded hostname -> slug lookup                       |
| `SHARED_HOST` | var        | the shared host (`media.doubleyoup.com`) whose path already starts with the slug |

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
   npm install
   npm run deploy
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

(The orchestrator does this automatically as part of site onboarding; the
command above is for manual/one-off use.)

## Local dev

```
npm run dev
```

`wrangler dev` runs the Worker locally against local R2/KV emulation (or
`--remote` to hit the real bucket/namespace).
