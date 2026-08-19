// End-to-end tests of the Worker's request handler with the R2 S3 endpoint stubbed at
// globalThis.fetch, covering the exact primary -> fallback semantics. Node 22 supplies
// fetch/Request/Response/Headers/crypto.subtle, so this needs no Workers runtime and no
// test framework — the only thing it cannot exercise is R2 itself.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";

const SLUG = "rareepicgamer-19f933";
const OBJECT_PATH = "2025/08/photo.jpg";
const PER_SITE_BUCKET = `doubleyoup-media-${SLUG}`;
const SHARED_BUCKET = "doubleyoup-media";

const ENV = {
  SHARED_HOST: "media.doubleyoup.com",
  MEDIA_BUCKET: SHARED_BUCKET,
  R2_ACCOUNT_ID: "acct123",
  R2_S3_KEY: "AKIATEST",
  R2_S3_SECRET: "s3cr3t",
  // Only read for branded hosts; individual tests override it when they need one.
  HOSTMAP: { get: async () => null },
};

const realFetch = globalThis.fetch;
const realWarn = console.warn;
let upstreamCalls;
let warnings;

// Queue one canned R2 response per expected upstream attempt, in order.
function stubUpstream(responses) {
  const queue = [...responses];
  globalThis.fetch = async (url, init) => {
    upstreamCalls.push({ url, method: init.method, headers: init.headers });
    assert.ok(queue.length > 0, `unexpected extra upstream request to ${url}`);
    return queue.shift();
  };
}

function bucketOf(call) {
  return new URL(call.url).pathname.split("/")[1];
}

function objectResponse(status, { body = "IMAGEBYTES", extraHeaders = {} } = {}) {
  const headers = new Headers({ "content-type": "image/jpeg", etag: '"abc123"', ...extraHeaders });
  const hasBody = status !== 304 && status !== 412;
  return new Response(hasBody ? body : null, { status, headers });
}

function s3ErrorResponse(status, code) {
  return new Response(`<Error><Code>${code}</Code></Error>`, {
    status,
    headers: { "content-type": "application/xml" },
  });
}

function sharedHostRequest(headers = {}) {
  return new Request(`https://media.doubleyoup.com/${SLUG}/${OBJECT_PATH}`, { headers });
}

// The Worker's only observability is console.warn, so capture it rather than let it
// print — several tests assert on the lines, and the rest assert silence.
function warningsMatching(pattern) {
  return warnings.filter((line) => pattern.test(line));
}

beforeEach(() => {
  upstreamCalls = [];
  warnings = [];
  console.warn = (line) => warnings.push(String(line));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.warn = realWarn;
});

test("a migrated site is served from its per-site bucket with no second request", async () => {
  stubUpstream([objectResponse(200)]);

  const response = await worker.fetch(sharedHostRequest(), ENV);

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "IMAGEBYTES");
  assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(upstreamCalls.length, 1);
  assert.equal(bucketOf(upstreamCalls[0]), PER_SITE_BUCKET);
  assert.deepEqual(warnings, [], "the happy path must not log per-request noise");
});

test("primary 404 (unmigrated site) falls back to the shared bucket and serves it", async () => {
  stubUpstream([s3ErrorResponse(404, "NoSuchBucket"), objectResponse(200)]);

  const response = await worker.fetch(sharedHostRequest(), ENV);

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "IMAGEBYTES");
  assert.equal(upstreamCalls.length, 2);
  assert.equal(bucketOf(upstreamCalls[0]), PER_SITE_BUCKET);
  assert.equal(bucketOf(upstreamCalls[1]), SHARED_BUCKET);

  // Same object key on both attempts — only the bucket differs.
  const keyOf = (call) => new URL(call.url).pathname.split("/").slice(2).join("/");
  assert.equal(keyOf(upstreamCalls[0]), `${SLUG}/${OBJECT_PATH}`);
  assert.equal(keyOf(upstreamCalls[1]), `${SLUG}/${OBJECT_PATH}`);

  // Every request from an unmigrated site takes this path — logging it would be noise.
  assert.deepEqual(warnings, []);
});

test("primary 403 (bucket-scoped read key) falls back instead of failing the request", async () => {
  stubUpstream([s3ErrorResponse(403, "AccessDenied"), objectResponse(200)]);

  const response = await worker.fetch(sharedHostRequest(), ENV);

  assert.equal(response.status, 200);
  assert.equal(upstreamCalls.length, 2);
  assert.equal(bucketOf(upstreamCalls[1]), SHARED_BUCKET);
});

test("primary 403 warns — the broken-per-site-credential alarm", async () => {
  stubUpstream([s3ErrorResponse(403, "AccessDenied"), objectResponse(200)]);

  await worker.fetch(sharedHostRequest(), ENV);

  const authWarnings = warningsMatching(/fallback-auth-denied/);
  assert.equal(authWarnings.length, 1);
  assert.match(authWarnings[0], /status=403/);
  assert.match(authWarnings[0], new RegExp(`slug=${SLUG}\\b`));
  assert.match(authWarnings[0], new RegExp(`primary_bucket=${PER_SITE_BUCKET}\\b`));
  assert.match(authWarnings[0], new RegExp(`key=${SLUG}/${OBJECT_PATH}`));
  // Distinct from the missing-object signal so the two are greppable apart.
  assert.deepEqual(warningsMatching(/not-found-in-both-buckets/), []);
});

test("primary 401 falls back too, and warns the same way", async () => {
  stubUpstream([s3ErrorResponse(401, "InvalidAccessKeyId"), objectResponse(200)]);

  const response = await worker.fetch(sharedHostRequest(), ENV);

  assert.equal(response.status, 200);
  assert.equal(upstreamCalls.length, 2);

  const authWarnings = warningsMatching(/fallback-auth-denied/);
  assert.equal(authWarnings.length, 1);
  assert.match(authWarnings[0], /status=401/);
});

test("404 in both buckets is a 404 with the 60s negative cache, and warns", async () => {
  stubUpstream([s3ErrorResponse(404, "NoSuchBucket"), s3ErrorResponse(404, "NoSuchKey")]);

  const response = await worker.fetch(sharedHostRequest(), ENV);

  assert.equal(response.status, 404);
  assert.equal(response.headers.get("cache-control"), "public, max-age=60");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(upstreamCalls.length, 2);

  const missWarnings = warningsMatching(/not-found-in-both-buckets/);
  assert.equal(missWarnings.length, 1);
  assert.match(missWarnings[0], new RegExp(`slug=${SLUG}\\b`));
  assert.match(missWarnings[0], new RegExp(`key=${SLUG}/${OBJECT_PATH}`));
  assert.deepEqual(warningsMatching(/fallback-auth-denied/), []);
});

test("a 5xx from the primary propagates and is NOT masked by a fallback lookup", async () => {
  stubUpstream([s3ErrorResponse(503, "SlowDown")]);

  const response = await worker.fetch(sharedHostRequest(), ENV);

  assert.equal(response.status, 500);
  assert.equal(upstreamCalls.length, 1, "a real upstream failure must not trigger a fallback");
  assert.deepEqual(warningsMatching(/fallback-auth-denied|not-found-in-both-buckets/), []);
  assert.equal(warningsMatching(/unexpected R2 status 503/).length, 1);
});

test("a 403 from the FALLBACK surfaces as a 500, not a cached 404", async () => {
  stubUpstream([s3ErrorResponse(404, "NoSuchBucket"), s3ErrorResponse(403, "AccessDenied")]);

  const response = await worker.fetch(sharedHostRequest(), ENV);

  assert.equal(response.status, 500);
  assert.equal(upstreamCalls.length, 2);
  // The 500 + buildClientResponse's own warn is the signal here; the fallback-path
  // lines are for cases that would otherwise be silent.
  assert.equal(warningsMatching(/unexpected R2 status 403/).length, 1);
  assert.deepEqual(warningsMatching(/not-found-in-both-buckets/), []);
});

test("Range is forwarded AND signed identically on both attempts", async () => {
  stubUpstream([
    s3ErrorResponse(404, "NoSuchBucket"),
    objectResponse(206, {
      body: "IMAG",
      extraHeaders: { "content-range": "bytes 0-3/10", "content-length": "4" },
    }),
  ]);

  const response = await worker.fetch(sharedHostRequest({ range: "bytes=0-3" }), ENV);

  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 0-3/10");
  assert.equal(upstreamCalls.length, 2);

  for (const call of upstreamCalls) {
    assert.equal(call.headers.get("range"), "bytes=0-3");
    assert.match(call.headers.get("authorization"), /SignedHeaders=[^,]*\brange\b/);
  }
});

test("conditional headers are forwarded AND signed on both attempts (304 passthrough)", async () => {
  stubUpstream([s3ErrorResponse(404, "NoSuchBucket"), objectResponse(304)]);

  const response = await worker.fetch(sharedHostRequest({ "if-none-match": '"abc123"' }), ENV);

  assert.equal(response.status, 304);
  assert.equal(upstreamCalls.length, 2);

  for (const call of upstreamCalls) {
    assert.equal(call.headers.get("if-none-match"), '"abc123"');
    assert.match(call.headers.get("authorization"), /SignedHeaders=[^,]*if-none-match/);
  }
});

test("branded hosts get the same fallback, with the slug from HOSTMAP", async () => {
  stubUpstream([s3ErrorResponse(404, "NoSuchBucket"), objectResponse(200)]);
  const brandedEnv = { ...ENV, HOSTMAP: { get: async () => SLUG } };

  const request = new Request(`https://media.rareepicgamer.zone/${OBJECT_PATH}`);
  const response = await worker.fetch(request, brandedEnv);

  assert.equal(response.status, 200);
  assert.equal(upstreamCalls.length, 2);
  assert.equal(bucketOf(upstreamCalls[0]), PER_SITE_BUCKET);
  assert.equal(bucketOf(upstreamCalls[1]), SHARED_BUCKET);
  // Branded requests carry no slug in the path, so the Worker prepends it to the key.
  assert.ok(upstreamCalls[1].url.endsWith(`/${SHARED_BUCKET}/${SLUG}/${OBJECT_PATH}`));
});
