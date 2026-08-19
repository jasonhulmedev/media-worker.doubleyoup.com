// Unit tests for the two pure bucket-selection decisions exported by the Worker.
// Run with `npm test` (node's built-in runner — no test framework dependency, and no
// Workers runtime needed since these functions touch neither fetch nor env bindings).

import { test } from "node:test";
import assert from "node:assert/strict";

import { bucketAttemptOrder, shouldFallbackToSharedBucket } from "../src/index.js";

const SLUG = "rareepicgamer-19f933";

test("per-site bucket is always tried first, shared bucket second", () => {
  const order = bucketAttemptOrder(SLUG, { MEDIA_BUCKET: "doubleyoup-media" });
  assert.deepEqual(order, ["doubleyoup-media-rareepicgamer-19f933", "doubleyoup-media"]);
});

test("MEDIA_BUCKET unset falls back to the default shared bucket name", () => {
  const order = bucketAttemptOrder(SLUG, {});
  assert.deepEqual(order, ["doubleyoup-media-rareepicgamer-19f933", "doubleyoup-media"]);
});

test("MEDIA_BUCKET empty string is treated as unset", () => {
  const order = bucketAttemptOrder(SLUG, { MEDIA_BUCKET: "" });
  assert.deepEqual(order, ["doubleyoup-media-rareepicgamer-19f933", "doubleyoup-media"]);
});

test("MEDIA_BUCKET overrides only the fallback, never the primary", () => {
  const order = bucketAttemptOrder(SLUG, { MEDIA_BUCKET: "doubleyoup-media-staging" });
  assert.deepEqual(order, ["doubleyoup-media-rareepicgamer-19f933", "doubleyoup-media-staging"]);
});

test("a MEDIA_BUCKET equal to the per-site bucket collapses to a single attempt", () => {
  const order = bucketAttemptOrder(SLUG, { MEDIA_BUCKET: `doubleyoup-media-${SLUG}` });
  assert.deepEqual(order, ["doubleyoup-media-rareepicgamer-19f933"]);
});

test("only 401/403/404 from the primary trigger the shared-bucket fallback", () => {
  for (const status of [401, 403, 404]) {
    assert.equal(shouldFallbackToSharedBucket(status), true, `expected fallback on ${status}`);
  }

  // Successes are served as-is; server errors must surface rather than be masked by a
  // second lookup that could turn a real outage into a cached 404.
  for (const status of [200, 206, 304, 412, 429, 500, 502, 503, 504]) {
    assert.equal(shouldFallbackToSharedBucket(status), false, `expected no fallback on ${status}`);
  }
});
