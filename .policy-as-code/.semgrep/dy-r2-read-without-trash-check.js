// Fixture for dy-r2-read-without-trash-check.

async function readKeyFromSiteBuckets({ method, env, slug, key, clientHeaders }) {
  // ok: dy-r2-read-without-trash-check
  return await fetchObjectFromBucket({ method, env, bucket: `doubleyoup-media-${slug}`, key, clientHeaders });
}

async function handleVulnerable(request, env, method, slug, key, keyPrefix, sitePath) {
  if (isTrashRequest(key, sitePath)) return notFound(method);
  const liveKey = liveKeyForStagingKey(slug, keyPrefix, key);
  const isStagingRequest = liveKey !== null;

  // ok: dy-r2-read-without-trash-check
  let upstream = await readKeyFromSiteBuckets({ method, env, slug, key, clientHeaders: request.headers });

  // The media-worker#14 shape: the live key of /sg-trash/... is trash/..., and nothing checks it.
  if (isStagingRequest && upstream.status === 404) {
    // ruleid: dy-r2-read-without-trash-check
    upstream = await readKeyFromSiteBuckets({ method, env, slug, key: liveKey, clientHeaders: request.headers });
  }
  return upstream;
}

async function handleFixed(request, env, method, slug, key, keyPrefix, sitePath) {
  if (isTrashRequest(key, sitePath)) return notFound(method);
  const liveKey = liveKeyForStagingKey(slug, keyPrefix, key);
  const isStagingRequest = liveKey !== null;
  if (isStagingRequest && isTrashRequest(liveKey, sitePath)) return notFound(method);

  // ok: dy-r2-read-without-trash-check
  let upstream = await readKeyFromSiteBuckets({ method, env, slug, key, clientHeaders: request.headers });
  if (isStagingRequest && upstream.status === 404) {
    // ok: dy-r2-read-without-trash-check
    upstream = await readKeyFromSiteBuckets({ method, env, slug, key: liveKey, clientHeaders: request.headers });
  }
  return upstream;
}

async function handleNoCheckAtAll(request, env, method, slug, key) {
  // ruleid: dy-r2-read-without-trash-check
  return await readKeyFromSiteBuckets({ method, env, slug, key, clientHeaders: request.headers });
}
