const DEFAULT_MAXIMUM_BYTES = 16 * 1024 * 1024;

function sourceUrl(entry, allowedOrigin) {
  const url = new URL(entry);
  if (url.origin !== allowedOrigin || url.username || url.password) {
    throw Object.assign(new Error('source_not_allowed'), { status: 403 });
  }
  return url;
}

async function discard(response) {
  if (!response.body) return;
  try { await response.body.cancel(); } catch { /* the response is already closed */ }
}

// One observable source request. Conditional responses (304/412) are returned
// without bytes so callers can tell "still the same version" from "changed".
export async function request(entry, allowedOrigin, { maximumBytes = DEFAULT_MAXIMUM_BYTES, headers = {} } = {}) {
  const url = sourceUrl(entry, allowedOrigin);
  let response;
  try {
    response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000), headers });
  } catch (error) {
    if (error?.status) throw error;
    throw Object.assign(new Error('source_unavailable'), { status: 502 });
  }
  const envelope = {
    status: response.status,
    mediaType: response.headers.get('content-type') || 'application/octet-stream',
    revision: response.headers.get('etag') || 'unversioned',
    headers: Object.fromEntries(response.headers),
    bytes: Buffer.alloc(0)
  };
  if (response.status === 304 || response.status === 412) {
    await discard(response);
    return envelope;
  }
  if (!response.ok) {
    await discard(response);
    throw Object.assign(new Error('source_response_' + response.status), { status: 502 });
  }
  let length = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > maximumBytes) throw Object.assign(new Error('source_too_large'), { status: 413 });
    chunks.push(chunk);
  }
  return { ...envelope, bytes: Buffer.concat(chunks) };
}

export async function retrieve(entry, allowedOrigin, maximumBytes = DEFAULT_MAXIMUM_BYTES) {
  return request(entry, allowedOrigin, { maximumBytes });
}
