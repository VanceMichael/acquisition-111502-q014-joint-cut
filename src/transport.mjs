const DEFAULT_MAXIMUM_BYTES = 16 * 1024 * 1024;

export function sourceUrl(entry, allowedOrigin) {
  const url = new URL(entry);
  if (url.origin !== allowedOrigin || url.username || url.password) {
    throw Object.assign(new Error('source_not_allowed'), { status: 403 });
  }
  return url;
}

export async function requestSource(entry, allowedOrigin, { headers = {}, maximumBytes = DEFAULT_MAXIMUM_BYTES } = {}) {
  const url = sourceUrl(entry, allowedOrigin);
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000), headers });
  let length = 0;
  const chunks = [];
  if (response.body) {
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > maximumBytes) throw Object.assign(new Error('source_too_large'), { status: 413 });
      chunks.push(chunk);
    }
  }
  return {
    status: response.status,
    ok: response.ok,
    bytes: Buffer.concat(chunks),
    mediaType: response.headers.get('content-type') || 'application/octet-stream',
    revision: response.headers.get('etag') || 'unversioned',
    headers: Object.fromEntries(response.headers)
  };
}

export async function retrieve(entry, allowedOrigin, maximumBytes = DEFAULT_MAXIMUM_BYTES) {
  const result = await requestSource(entry, allowedOrigin, { maximumBytes });
  if (!result.ok) throw Object.assign(new Error('source_response_' + result.status), { status: 502 });
  return { bytes: result.bytes, mediaType: result.mediaType, revision: result.revision, headers: result.headers };
}
