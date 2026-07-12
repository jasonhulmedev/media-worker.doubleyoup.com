# Branded media host recipe (Cloudflare for SaaS + this Worker)

How a customer's `media.<their-domain>` serves a site's R2 media through this
Worker, on doubleyoup's **shared** `doubleyoup.com` Cloudflare zone. Worked example:
`media.rareepicgamer.zone` → slug `rareepicgamer-19f933`.

## Current state (bucket model)

The platform still runs the ONE shared bucket `doubleyoup-media` with keys
`<slug>/<path>` — NOT the per-site `doubleyoup-media-<slug>` buckets the H1 code
targets. So the Worker is pinned to the shared bucket with the `MEDIA_BUCKET` var
(`wrangler.toml [vars] MEDIA_BUCKET = "doubleyoup-media"`). Remove that var once
per-site buckets exist and are migrated; the Worker then derives
`doubleyoup-media-<slug>` per request. The `<slug>/<path>` key scheme is identical
either way.

Read credential = the **shared platform R2 key** (bucket-scoped, NOT read-only),
held as Worker secrets `R2_S3_KEY` / `R2_S3_SECRET` (+ `R2_ACCOUNT_ID`).
FOLLOW-ON: mint a dedicated Object-Read-ONLY R2 token and `wrangler secret put`
these two.

## Why a SPECIFIC route, never `*/*`

Cloudflare's docs recommend a `*/*` Worker route for SaaS zones. **Do not use it
here.** `doubleyoup.com` is a shared platform zone: `app`, `status`, `media`, and
every site host live in it. A `*/*` route sends ALL of them through this Worker,
which 404s any host that is neither `SHARED_HOST` nor a `HOSTMAP` entry → a
platform-wide outage. Negative "no-worker" routes per platform host are
unmaintainable (site hosts are created dynamically).

Instead, attach ONE specific route per branded host: `media.<customer>/*`. Blast
radius is that single hostname; it cannot affect `media.doubleyoup.com` or any
other host. If the route is not matched (see the customer-DNS caveat below),
traffic simply falls to the zone fallback origin `host.doubleyoup.com` and 404s —
fail-safe, no platform impact.

`media.doubleyoup.com` is intentionally NOT routed to this Worker; it stays on its
own direct `r2.dev` custom-domain binding and is unaffected by any of this.

## First-ever deploy (done for the doubleyoup account)

Run from a shell with `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` exported
(sourced from the constellation `.env`; never echo them).

1. Create the KV namespace, paste the id into `wrangler.toml [[kv_namespaces]]`:
   ```
   wrangler kv namespace create HOSTMAP        # -> id 8c2b24a66e79416f81f646f90683e5c4
   ```
2. `wrangler deploy` — publishes to `*.workers.dev` ONLY (no `[[routes]]` in the
   toml on purpose). URL: `https://doubleyoup-media.seoworker-api.workers.dev`.
3. Set the R2 secrets (values piped from `.env`, never printed):
   ```
   printf %s "$R2_ACCOUNT_ID"        | wrangler secret put R2_ACCOUNT_ID
   printf %s "$R2_ACCESS_KEY_ID"     | wrangler secret put R2_S3_KEY
   printf %s "$R2_SECRET_ACCESS_KEY" | wrangler secret put R2_S3_SECRET
   ```

### KV GOTCHA (cost hours — read this)

`wrangler kv key put/get/list` operate on **local miniflare state by default**.
The deployed Worker reads the **remote** namespace. You MUST pass `--remote`, or
the Worker sees `HOSTMAP.get()` → null and every branded request 404s while the
CLI cheerfully shows the key "present" (in local state).
```
wrangler kv key put  --remote --namespace-id <id> <hostname> <slug>
wrangler kv key list --remote --namespace-id <id>
```

## Onboard a branded host

```
HN=media.rareepicgamer.zone
SLUG=rareepicgamer-19f933
NS=8c2b24a66e79416f81f646f90683e5c4

# 1) HOSTMAP entry (REMOTE!). The branded URL has no slug; the Worker prepends this.
wrangler kv key put --remote --namespace-id "$NS" "$HN" "$SLUG"

# 2) Register the CF-for-SaaS custom hostname (idempotent). Origin is the zone
#    fallback (host.doubleyoup.com) — bypassed when the Worker route matches, and a
#    safe 404 if it doesn't. Stays ssl=pending until the customer CNAME validates.
curl -s -X POST -H "Authorization: Bearer $CF_TOKEN" -H 'Content-Type: application/json' \
  "https://api.cloudflare.com/client/v4/zones/$ZONE/custom_hostnames" \
  -d '{"hostname":"'"$HN"'","ssl":{"method":"http","type":"dv","settings":{"min_tls_version":"1.2"}},"custom_origin_server":"host.doubleyoup.com"}'

# 3) SPECIFIC Worker route (GATED — see below). NEVER "*/*".
curl -s -X POST -H "Authorization: Bearer $CF_TOKEN" -H 'Content-Type: application/json' \
  "https://api.cloudflare.com/client/v4/zones/$ZONE/workers/routes" \
  -d '{"pattern":"'"$HN"'/*","script":"doubleyoup-media"}'
```

### Step 3 is GATED on token scope

The current Cloudflare API token can create custom hostnames + KV + Worker scripts,
but **lacks `Workers Routes:Edit`** (POST/GET `/zones/{zone}/workers/routes` →
`Authentication error` 10000). Add that scope to the token (or create the route in
the dashboard: Workers Routes → Add route → `media.rareepicgamer.zone/*` →
`doubleyoup-media`) before the branded host can reach the Worker.

### Customer DNS caveat (bounded, fail-safe)

Whether a *specific* route is invoked for a SaaS custom hostname depends on the
customer's DNS proxy setting (CF docs: routing-by-custom-hostname vs
routing-by-CNAME-target). rareepicgamer's DNS is a plain external CNAME (apex/www
already CNAME to `host.doubleyoup.com`), so the specific route should be invoked.
Verify it in the end-to-end step after the customer adds the CNAME; if it is NOT
invoked, add a second specific route on the CNAME target host as well. Either way,
a miss just hits the fallback origin (404) — never the rest of the platform.

## THE CUSTOMER CNAME (what to put on the domains screen / send the owner)

| Name (host)              | Type  | Value / Target        | Proxy        |
| ------------------------ | ----- | --------------------- | ------------ |
| `media.rareepicgamer.zone` | CNAME | `host.doubleyoup.com` | (as offered) |

This is the SAME target `www.rareepicgamer.zone` and `lawnsbydavidandangela.au`
already use, so it is proven. doubleyoup does NOT touch the customer's DNS — the
customer adds this record. Once added, CF completes the HTTP DV cert for
`media.rareepicgamer.zone` and `status`/`ssl_status` flip to `active`.

## Pre-verification WITHOUT the customer CNAME (proves Worker+KV+bucket)

The branded host has no cert until the customer CNAMEs, and you cannot spoof the
`Host` header at `*.workers.dev` (CF edge returns 403 on a Host mismatch). So
exercise the branded codepath with a TEMPORARY workers.dev-host KV entry:
```
WHOST=doubleyoup-media.seoworker-api.workers.dev
wrangler kv key put --remote --namespace-id "$NS" "$WHOST" "$SLUG"     # temp
curl -sI https://$WHOST/2025/08/channels4_profile.jpg                  # -> 200 image/jpeg, bytes == media.doubleyoup.com
wrangler kv key delete --remote --namespace-id "$NS" "$WHOST"          # remove temp
```
Verified 2026-07-12 for `rareepicgamer-19f933`: branded path returned 200 /
image/jpeg / 4740 bytes / sha256 `ddd7382d…` — byte-identical to
`https://media.doubleyoup.com/rareepicgamer-19f933/2025/08/channels4_profile.jpg`.
Also 404 (unknown object), 206 (`Range: bytes=0-99` → `content-range: …/4740`),
HEAD 200, `If-None-Match` → 304, POST → 405.

## LIVE FLIP (supervised — NOT yet done)

Do this ONLY after: customer CNAME added → custom hostname `ssl_status=active` →
route created (token scope) → a real `https://media.rareepicgamer.zone/...` fetch
returns 200 with matching bytes.

The site reads its media base from a PHP constant (see the `doubleyoup-media`
mu-plugin `doubleyoup_r2_media_base()`):
- Unset (today): `https://media.doubleyoup.com/rareepicgamer-19f933` (shared host).
- Branded: `https://media.rareepicgamer.zone` (NO slug — the Worker prepends it).

Flip: as the site's OS user on the file node, edit
`/platform/rareepicgamer-19f933/wp-config-real.php` and add/point the constant:
```php
define('DOUBLEYOUP_R2_MEDIA_BASE', 'https://media.rareepicgamer.zone');
```
Then (optionally) rewrite existing content URLs:
`wp search-replace 'https://media.doubleyoup.com/rareepicgamer-19f933' 'https://media.rareepicgamer.zone' --precise --all-tables`.

Verify: load the site, confirm `<img>`/srcset point at `media.rareepicgamer.zone`
and return 200 with the right content-type; check a fresh upload round-trips.

Rollback: remove the `DOUBLEYOUP_R2_MEDIA_BASE` line (falls back to
`media.doubleyoup.com/<slug>`), reverse the search-replace if run. R2 objects and
the shared host are untouched by the flip, so rollback is immediate and lossless.

## Follow-ons

- Add `Workers Routes:Edit` to the CF token (unblocks step 3 / route automation).
- Mint an Object-Read-ONLY R2 token; re-`secret put` `R2_S3_KEY`/`R2_S3_SECRET`.
- Fold KV-entry + custom-hostname + route creation into the orchestrator's domain
  automation so branded media onboards with the site's other custom domains.
