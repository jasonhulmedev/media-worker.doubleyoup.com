// doubleyoup media Worker — serves site media from PER-SITE R2 buckets for BOTH
// the shared host (media.doubleyoup.com/<slug>/…) and branded customer hostnames
// (media.<theirdomain>/… via Cloudflare for SaaS). One R2 object per file; the
// public URL differs, the R2 key does not.
//
// Slug + key resolution (UNCHANGED from the single-bucket era):
//   • shared host (SHARED_HOST): the slug is the first path segment — key = path.
//   • branded host: look the Host up in KV (HOSTMAP: hostname -> slug) and prepend
//     the slug — key = "<slug>/" + path.
//
// Bucket resolution (NEW): each site now has its OWN R2 bucket named
//   "doubleyoup-media-<slug>" (H1 per-site isolation). The Worker no longer has a
// static R2 binding to one shared bucket; instead it derives the bucket from the
// resolved slug and reads it with a SigV4-signed S3 GET against the account S3
// endpoint, using ONE account-scoped, Object-Read-ONLY R2 credential held as a
// Worker secret. A leaked/compromised per-site write credential can therefore only
// touch that one tenant's bucket, while this read path stays single-credential.
//
// PREREQUISITES before this Worker is live (Jason / migration, gated — NOT done here):
//   1. The Worker secrets R2_S3_KEY / R2_S3_SECRET (account-scoped Object-Read-ONLY)
//      and the R2_ACCOUNT_ID var must be set.
//   2. The per-site buckets "doubleyoup-media-<slug>" must already exist and hold the
//      migrated objects (Phase 2 provisioning + Phase 3 migration of the existing sites).
//   3. media.doubleyoup.com must be RE-ROUTED off its current direct-R2-custom-domain
//      binding and onto this Worker (a zone change; per-slug flippable during migration).
//   This file targets that end state; it does NOT implement the shared-host-vs-Worker
//   routing transition — that is a per-slug deploy/re-route step, not Worker logic.
//
// Conditional requests + Range: the client's Range / If-* headers are forwarded to
// R2 AND included in the SigV4 signature (R2 can reject headers that affect the
// response if they arrive unsigned), so R2 itself applies the HTTP semantics and
// returns the 200/206/304/412 we map straight back to the client.

const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const NOT_FOUND_CACHE = "public, max-age=60"; // small + cacheable, so a bad/unknown
// path or host doesn't hammer KV/R2 on every repeat request.
const ALLOWED_METHODS = "GET, HEAD";
const EXPOSED_HEADERS = "content-length, content-range, etag, accept-ranges";

// A slug becomes part of an R2 bucket name ("doubleyoup-media-<slug>") that this
// Worker fetches with the account read credential — validate its charset before
// trusting it, whether it came from the path (shared host) or KV (branded host).
// Mirrors the platform's slug rules (lowercase alnum + hyphen); also keeps the
// resulting bucket name inside R2's naming constraints. Capped at 46 so the derived
// bucket "doubleyoup-media-<slug>" (17-char prefix + slug) stays within R2's 63-char
// bucket-name limit; this matches app's uniqueSlug cap (<=46 chars).
const SLUG_PATTERN = /^[a-z0-9-]{1,46}$/;

// The R2 S3 endpoint uses SigV4 with region "auto" and service "s3" (path-style),
// exactly matching the doubleyoup-media mu-plugin's proven write-side signer.
const R2_REGION = "auto";
const R2_SERVICE = "s3";

// Range/conditional request headers we forward-and-sign. Kept sorted here for
// readability; the signer sorts the full signed set again regardless.
const CONDITIONAL_HEADER_NAMES = [
  "if-match",
  "if-modified-since",
  "if-none-match",
  "if-unmodified-since",
  "range",
];

// Fallback Content-Type by file extension — only used when the R2 object was
// stored without a content-type (the mu-plugin always sets one, but migrated /
// hand-uploaded objects may not).
const EXT_CONTENT_TYPES = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  pdf: "application/pdf",
  txt: "text/plain; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
};

const textEncoder = new TextEncoder();

function contentTypeForKey(key) {
  const dot = key.lastIndexOf(".");
  if (dot === -1) return "application/octet-stream";
  const ext = key.slice(dot + 1).toLowerCase();
  return EXT_CONTENT_TYPES[ext] || "application/octet-stream";
}

// Media is public, static, cross-origin-embeddable content — permissive read
// CORS on every response (including errors, so a broken <img>/<video> src
// fails with a clean 404 rather than an opaque CORS error in the console).
function baseHeaders() {
  return new Headers({ "access-control-allow-origin": "*" });
}

function notFound(method) {
  const headers = baseHeaders();
  headers.set("cache-control", NOT_FOUND_CACHE);
  return new Response(method === "HEAD" ? null : "Not found", { status: 404, headers });
}

function methodNotAllowed() {
  const headers = baseHeaders();
  headers.set("allow", ALLOWED_METHODS);
  return new Response("Method Not Allowed", { status: 405, headers });
}

function badRequest(method) {
  return new Response(method === "HEAD" ? null : "Bad request", { status: 400, headers: baseHeaders() });
}

// Never leak internals (stack traces, R2/S3 error detail, signing state) to the
// client — always a bare 500 with CORS so a broken embed still fails cleanly.
function internalError() {
  return new Response("Internal error", {
    status: 500,
    headers: { "access-control-allow-origin": "*" },
  });
}

// ── SigV4 helpers ─────────────────────────────────────────────────────────────

function toHex(bytes) {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

async function sha256Hex(message) {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(message));
  return toHex(new Uint8Array(digest));
}

async function hmacSha256(keyBytes, message) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, textEncoder.encode(message));
  return new Uint8Array(signature);
}

// RFC 3986 / AWS UriEncode, keeping "/" as path separators. encodeURIComponent
// already leaves the unreserved set + "!'()*" unescaped and emits upper-hex %XX,
// so we only need to additionally escape "!'()*" to land on exactly the AWS rule
// (unreserved = A-Za-z0-9-._~). This matches the mu-plugin's rawurlencode()
// write-side key encoding, so a key round-trips to the same stored object.
function encodeS3Path(pathSegments) {
  return pathSegments
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase(),
      ),
    )
    .join("/");
}

// SigV4 canonical header value: trim, then collapse internal whitespace runs to a
// single space — matching how S3/R2 canonicalizes the value it receives. Our
// signed conditional/range values (ETags, HTTP-dates, byte ranges) have no
// whitespace inside quoted strings, so this is lossless for them.
function canonicalizeHeaderValue(value) {
  return value.trim().replace(/\s+/g, " ");
}

// Build a SigV4-signed S3 GET/HEAD for one object in a per-site bucket. Returns
// the exact URL to fetch plus the header set to send. INVARIANT: the headers we
// SEND are exactly the headers we SIGNED (minus Host, which the runtime sets from
// the URL) and the wire path byte-matches the canonical URI — otherwise R2's
// signature check fails.
async function buildSignedR2Request({ method, accountId, accessKey, secretKey, bucket, key, clientHeaders }) {
  const host = `${accountId}.r2.cloudflarestorage.com`;

  const amzDate = new Date().toISOString().replace(/[:-]/g, "").replace(/\.\d{3}Z$/, "Z");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = await sha256Hex(""); // GET/HEAD carry no request body

  // Headers to both sign and send. host/x-amz-* are mandatory-signed; the
  // conditional/range headers are signed too so R2 accepts them.
  const signedValues = new Map();
  signedValues.set("host", host);
  signedValues.set("x-amz-content-sha256", payloadHash);
  signedValues.set("x-amz-date", amzDate);
  for (const name of CONDITIONAL_HEADER_NAMES) {
    const raw = clientHeaders.get(name);
    if (raw !== null) signedValues.set(name, canonicalizeHeaderValue(raw));
  }

  const sortedNames = [...signedValues.keys()].sort();
  const canonicalHeaders = sortedNames.map((name) => `${name}:${signedValues.get(name)}\n`).join("");
  const signedHeaderList = sortedNames.join(";");

  const canonicalUri = `/${bucket}/${encodeS3Path(key)}`;
  const canonicalRequest =
    `${method}\n${canonicalUri}\n\n${canonicalHeaders}\n${signedHeaderList}\n${payloadHash}`;

  const scope = `${dateStamp}/${R2_REGION}/${R2_SERVICE}/aws4_request`;
  const stringToSign =
    `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${await sha256Hex(canonicalRequest)}`;

  const kDate = await hmacSha256(textEncoder.encode("AWS4" + secretKey), dateStamp);
  const kRegion = await hmacSha256(kDate, R2_REGION);
  const kService = await hmacSha256(kRegion, R2_SERVICE);
  const kSigning = await hmacSha256(kService, "aws4_request");
  const signature = toHex(await hmacSha256(kSigning, stringToSign));

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, ` +
    `SignedHeaders=${signedHeaderList}, Signature=${signature}`;

  // Send exactly the signed headers except Host (set by the runtime from the URL)
  // plus Authorization, using the canonicalized values so wire == signed.
  const outHeaders = new Headers();
  outHeaders.set("x-amz-content-sha256", payloadHash);
  outHeaders.set("x-amz-date", amzDate);
  outHeaders.set("authorization", authorization);
  for (const name of CONDITIONAL_HEADER_NAMES) {
    const value = signedValues.get(name);
    if (value !== undefined) outHeaders.set(name, value);
  }

  return { url: `https://${host}${canonicalUri}`, headers: outHeaders };
}

// Translate the R2 S3 response into the exact response shape the old R2-binding
// path produced. R2 has already applied the conditional/range semantics, so its
// status IS the client status for the cases we serve.
function buildClientResponse(upstream, method, key) {
  const status = upstream.status;

  // Missing object OR missing (unmigrated/unknown) bucket — R2 returns 404 for
  // both NoSuchKey and NoSuchBucket. Mirrors the old binding path's null -> 404.
  if (status === 404) return notFound(method);

  // Anything R2 shouldn't return for a well-formed public read (403 bad creds,
  // 5xx, etc.) is an internal problem — surface neither it nor its body.
  if (status !== 200 && status !== 206 && status !== 304 && status !== 412) {
    console.warn(`[media-worker] unexpected R2 status ${status} for key ${key}`);
    return internalError();
  }

  const headers = baseHeaders();
  const upstreamContentType = upstream.headers.get("content-type");
  headers.set("content-type", upstreamContentType || contentTypeForKey(key));
  const upstreamEtag = upstream.headers.get("etag");
  if (upstreamEtag) headers.set("etag", upstreamEtag);
  const upstreamCacheControl = upstream.headers.get("cache-control");
  headers.set("cache-control", upstreamCacheControl || IMMUTABLE_CACHE);
  headers.set("accept-ranges", "bytes");
  headers.set("access-control-expose-headers", EXPOSED_HEADERS);

  // 304 (If-None-Match / If-Modified-Since) and 412 (If-Match / If-Unmodified-
  // Since) carry no body — same as the old binding path's precondition branch,
  // which returned a null body for both. NOTE: R2 now decides 304-vs-412 by HTTP
  // semantics; the old binding path used a coarser "has If-None-Match ? 304 : 412"
  // heuristic, so an If-Modified-Since-only not-modified case is now correctly a
  // 304 (previously a 412). Every other conditional outcome is unchanged.
  if (status === 304 || status === 412) {
    return new Response(null, { status, headers });
  }

  if (status === 206) {
    const contentRange = upstream.headers.get("content-range");
    if (contentRange) headers.set("content-range", contentRange);
    const contentLength = upstream.headers.get("content-length");
    if (contentLength) headers.set("content-length", contentLength);
    return new Response(method === "HEAD" ? null : upstream.body, { status: 206, headers });
  }

  // 200 — full object.
  const contentLength = upstream.headers.get("content-length");
  if (contentLength) headers.set("content-length", contentLength);
  return new Response(method === "HEAD" ? null : upstream.body, { status: 200, headers });
}

export default {
  async fetch(request, env) {
    try {
      const method = request.method;
      if (method !== "GET" && method !== "HEAD") return methodNotAllowed();

      const url = new URL(request.url);
      const host = url.hostname.toLowerCase();

      let path;
      try {
        path = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      } catch {
        return badRequest(method); // malformed percent-encoding
      }

      // Defence in depth: R2 keys are opaque strings, so ".." can't actually
      // escape a "directory" the way it would on a filesystem — but never
      // let a traversal-looking key through regardless.
      if (path.split("/").includes("..")) return notFound(method);

      const sharedHost = (env.SHARED_HOST || "media.doubleyoup.com").toLowerCase();

      // Resolve slug + object key. The key scheme is UNCHANGED; only the bucket
      // source changed (per-site bucket instead of one shared static binding).
      let slug;
      let key;
      if (host === sharedHost) {
        // /<slug>/<rest> — the slug prefix is already in the path, so the key is
        // the path unchanged and the slug is the first segment.
        key = path;
        slug = path.split("/")[0];
      } else {
        // Branded host — map host -> slug via KV, then prepend the slug prefix.
        const mappedSlug = await env.HOSTMAP.get(host);
        if (!mappedSlug) return notFound(method);
        slug = mappedSlug;
        key = path ? `${slug}/${path}` : slug;
      }
      if (!key) return notFound(method);
      if (!SLUG_PATTERN.test(slug)) return notFound(method);

      const bucket = `doubleyoup-media-${slug}`;

      // Read credential is an account-scoped, Object-Read-ONLY R2 token held as a
      // Worker secret (never in a tenant container). Absent config => not live yet.
      if (!env.R2_ACCOUNT_ID || !env.R2_S3_KEY || !env.R2_S3_SECRET) {
        console.error("[media-worker] R2_ACCOUNT_ID / R2_S3_KEY / R2_S3_SECRET not configured");
        return internalError();
      }

      const signed = await buildSignedR2Request({
        method,
        accountId: env.R2_ACCOUNT_ID,
        accessKey: env.R2_S3_KEY,
        secretKey: env.R2_S3_SECRET,
        bucket,
        key,
        clientHeaders: request.headers,
      });

      const upstream = await fetch(signed.url, { method, headers: signed.headers });
      return buildClientResponse(upstream, method, key);
    } catch (err) {
      // Never throw out of fetch() and never leak internals to the client.
      return internalError();
    }
  },
};
