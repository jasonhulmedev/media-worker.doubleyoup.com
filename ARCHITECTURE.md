# media-worker architecture

## Flow

```
                         ┌────────────────────────────────────────────┐
  browser/app request    │ media-worker (Cloudflare Worker)           │        R2
 ───────────────────────►│                                            │
  GET/HEAD <host>/<path> │ 1. method check (405 if not GET/HEAD)      │
                         │ 2. decode + normalize path                 │
                         │    (400 on bad %-encoding,                 │
                         │     404 on ".." segment)                   │
                         │                                            │
                         │ 3. host === SHARED_HOST ?                  │
                         │      yes → key = path; slug = path[0]      │
                         │      no  → HOSTMAP.get(host) -> slug       │
                         │            (404 if no mapping)             │
                         │            key = "<slug>/" + path          │
                         │ 4. 404 if key empty or slug fails          │
                         │    ^[a-z0-9-]{1,46}$                       │
                         │ 5. key or site path starts with            │
                         │    "trash/" → 404 (soft delete)            │
                         │ 6. 500 if R2_ACCOUNT_ID / R2_S3_KEY /      │
                         │    R2_S3_SECRET unset                      │
                         │ 7. buckets =                               │
                         │      1. "doubleyoup-media-<slug>"          │
                         │      2. MEDIA_BUCKET (shared, only on a    │
                         │         404/401/403 from #1; none if       │
                         │         MEDIA_BUCKET is "none"/"off")      │
                         └───────────────┬────────────────────────────┘
                                         │ 8. SigV4-signed S3 GET/HEAD (Range +
                                         │    If-* forwarded AND signed) — once
                                         │    per attempted bucket
                                         ▼
                              ┌─────────────────────────────────┐
                              │ R2 account S3 endpoint →        │
                              │ doubleyoup-media-<slug>, else   │
                              │ shared bucket (path-style)      │
                              └──────────┬──────────────────────┘
                                         │ 9. R2 HTTP status (200/206/304/412/404/…)
                                         ▼
                         ┌────────────────────────────────────────────┐
                         │ build response (status mapped back):       │
                         │  - 404              -> 404                 │
                         │  - 304 / 412        -> same, no body       │
                         │  - 206              -> 206 + Content-Range │
                         │  - 200              -> 200                 │
                         │  - anything else    -> bare 500            │
                         │ always: CORS *; on 200/206/304/412 also    │
                         │ etag, content-type (stored or extension    │
                         │ fallback), cache-control (upstream, else   │
                         │ immutable); 404 gets public, max-age=60    │
                         └────────────────────────────────────────────┘
```

Step numbers match the diagram and the order in `fetch()` in `src/index.js`.

1. **Method gate** — only `GET`/`HEAD`; anything else is a 405.
2. **Path normalization** — `decodeURIComponent` + strip leading slashes; bad
   %-encoding is a 400, and a `..` segment anywhere in the path is rejected as a 404
   (defense-in-depth; R2 keys are opaque strings and can't actually traverse).
3. **Host routing** — exactly two shapes, decided by comparing the lowercased
   `Host` against `SHARED_HOST`:
   - **shared** (`media.doubleyoup.com`): the path's first segment is already
     the slug, so the R2 key is the path unchanged. No KV read.
   - **branded** (any other host, attached via Cloudflare for SaaS): look the
     host up in the `HOSTMAP` KV namespace to get a slug; no entry is a 404.
     The key becomes `<slug>/<path>`. Every branded request pays this one KV read,
     including a request that a later step refuses.
4. **Key and slug check** — an empty key is a 404, and so is a slug that fails
   `SLUG_PATTERN` (`^[a-z0-9-]{1,46}$`, so `doubleyoup-media-<slug>` stays within
   R2's 63-character bucket-name limit).
5. **Soft delete gate** (hub#222) — `isTrashRequest` refuses the request with the
   plain 404 when the resolved key or the site path (the key without its `<slug>/`
   prefix) starts with `trash/`. It runs after routing and slug validation, and
   before the first R2 read. See [Soft delete](#soft-delete).
6. **Credential check** — if `R2_ACCOUNT_ID`, `R2_S3_KEY` or `R2_S3_SECRET` is unset,
   the Worker logs one `console.error` line and returns a bare 500.
7. **Bucket order** — `bucketAttemptOrder` returns the primary bucket
   `doubleyoup-media-<slug>` and, as the fallback, `MEDIA_BUCKET` (default
   `doubleyoup-media`). `MEDIA_BUCKET = "none"` or `"off"` turns the fallback off (an
   agency copy has no shared bucket), and a fallback name equal to the primary is not
   tried twice.
8. **R2 read (per-site bucket via SigV4, shared bucket as fallback)** — the object is
   read with a **SigV4-signed S3 GET/HEAD** against the account S3 endpoint
   (`<R2_ACCOUNT_ID>.r2.cloudflarestorage.com/<bucket>/<key>`, path-style, region
   `auto`, service `s3`) using one account-scoped, Object-Read-ONLY R2 credential
   (Worker secrets `R2_S3_KEY`/`R2_S3_SECRET`). The client's
   `Range`/`If-Match`/`If-None-Match`/`If-Modified-Since`/`If-Unmodified-Since`
   headers are both forwarded to R2 AND included in the signature (R2 can reject
   response-affecting headers that arrive unsigned), so R2 applies the HTTP
   conditional/range semantics itself. There is **no static R2 binding**.

   There are at most **two bucket attempts per request**, primary always first.
   If the primary answers **404** (bucket/object not migrated yet) or **401/403** (the
   read credential cannot see that bucket), the identical signed request is replayed
   against the **shared fallback bucket**; the two buckets use the same
   `<slug>/<path>` key, so sites can be migrated one at a time with no Worker deploy.
   Every other primary status — including 5xx — is returned as-is so a real upstream
   failure is never masked (`shouldFallbackToSharedBucket`). The fallback's own
   response is not re-interpreted, so a 401/403 from it becomes a 500 rather than a
   cached 404. Cost of the fallback is one extra R2 round-trip per Worker-reaching
   request for an unmigrated site (a per-slug "migrated" flag in KV would remove it;
   not built).

   Two `console.warn` lines make the fallback observable in `wrangler tail`, since a
   fallback 404 is otherwise indistinguishable from a missing object:
   `fallback-auth-denied` (primary returned 401/403 — a broken per-site read credential
   masked by the shared bucket) and `not-found-in-both-buckets` (primary 404 + fallback
   404). Nothing is logged on primary-200 or on primary-404 → fallback-200.
9. **Response assembly** (`buildClientResponse`) — R2's HTTP status (from whichever
   bucket answered last) is mapped straight back: `404` (`NoSuchKey`/`NoSuchBucket`)
   → 404; `304`/`412` → that status with no body; `206` → 206 re-emitting
   `Content-Range`/`Content-Length`; `200` → full body; any other status (403 bad
   creds, 5xx) → a generic 500 (one `console.warn` line, no upstream body/detail
   leaked). Every response, errors included, gets `access-control-allow-origin: *`.
   A 404 gets `cache-control: public, max-age=60`. A 200/206/304/412 also gets the
   upstream `etag`, a `content-type` (from R2's stored content-type or a fallback
   table keyed on file extension, `EXT_CONTENT_TYPES`), `accept-ranges: bytes`,
   `access-control-expose-headers`, and a `cache-control` (upstream's, else `public,
   max-age=31536000, immutable`).

Every path is wrapped in a top-level try/catch that returns a bare 500 —
`fetch()` never throws and never leaks internals to the client.

## Soft delete

Deleted media moves to `trash/<date>/<key>` (hub#222) and must not stay public.
`isTrashRequest(key, sitePath)` in `src/index.js` refuses two shapes with the plain
404 and the 60s negative cache:

- the resolved key starts with `trash/` — a root-level trash key, reachable on the
  shared host as `/trash/<date>/<slug>/<file>` (where `trash` sits in the slug
  position);
- the site path starts with `trash/` — trash inside the site's own namespace:
  `/<slug>/trash/...` on the shared host, `/trash/...` on a branded host.

The check runs after host routing and slug validation (step 5 above), so a branded
trash request still costs its `HOSTMAP` read, and an unmapped host or a bad slug is
a 404 before the gate runs. It runs before the first R2 read, so a trash request
never reaches either bucket. Tests: `test/bucket-selection.test.js` and
`test/fallback-flow.test.js`.

## Bindings

| Binding          | Type          | Source of truth                                                    |
| ---------------- | ------------- | -------------------------------------------------------------------- |
| `R2_S3_KEY` / `R2_S3_SECRET` | Worker secrets | one **account-scoped, Object-Read-ONLY** R2 S3 credential used to SigV4-sign reads of the shared bucket AND every per-site `doubleyoup-media-<slug>` bucket. Never held in a tenant container (that's the per-site *write* credential, which is bucket-scoped). Set via `wrangler secret put`. The deployed key is account-scoped (2026-08-20). A bucket-scoped key would make every per-site read fail. |
| `R2_ACCOUNT_ID`  | Worker secret | the Cloudflare account id in the R2 S3 endpoint host `<id>.r2.cloudflarestorage.com`. Must stay a secret: `wrangler deploy` removes a plain var that is not in `[vars]`. |
| `HOSTMAP`        | KV namespace  | `hostname -> slug`; written by `orchestrator.doubleyoup.com`'s domain automation when a branded media host is onboarded (or manually via `wrangler kv key put`) |
| `SHARED_HOST`    | plaintext var | the one host treated as "path already has the slug" (`media.doubleyoup.com`) |
| `MEDIA_BUCKET`   | plaintext var | the **fallback** (shared/legacy) bucket tried when the per-site bucket 404/401/403s; defaults to `doubleyoup-media`; `none` or `off` turns the fallback off (agency copy). Never overrides the per-site primary. |

There is **no static R2 binding** — each site's media lives in its own bucket
`doubleyoup-media-<slug>` (H1 per-site isolation), derived from the resolved slug
and read over the account S3 endpoint, with the shared bucket as the fallback until
that site is migrated. Each site's `doubleyoup-media` mu-plugin writes its own bucket
with a bucket-scoped credential; this Worker only reads.

## Where this sits in the platform

This Worker is the read side of a write path owned entirely elsewhere:

- **Writer**: each WordPress site's `doubleyoup-media` mu-plugin signs and
  PUTs media objects directly into its own `doubleyoup-media-<slug>` R2 bucket
  under `<slug>/<path>` (hand-rolled SigV4 — no Worker involved in the write),
  using a per-site, bucket-scoped write credential so a leak is contained to one
  tenant.
- **Onboarding a branded host**: `orchestrator.doubleyoup.com` registers the
  Cloudflare custom hostname (Cloudflare for SaaS / TLS) and writes the
  `HOSTMAP` KV entry as part of site/domain setup. This Worker never talks to
  `orchestrator` or `app` at request time — `HOSTMAP` is the only coupling,
  and it's asynchronous (KV write happens once, ahead of any request).
- **Shared host**: this Worker serves `media.doubleyoup.com` through a Worker route
  (2026-08-27). The bucket comes from the path's first segment. Unmigrated slugs, such
  as local-Docker sites, fall back to the shared bucket.

## Statelessness

No database, no in-memory state across requests — every request is fully
resolved from the incoming `Host`/path plus a single KV read (branded hosts
only) and one or two R2 reads (primary, then the fallback when it applies).
Nothing here persists between invocations except whatever Cloudflare's own edge
cache does independently of this code.
