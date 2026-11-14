import { retrieve } from './transport.mjs';
export async function acquireSingle(body, archive, allowedOrigin) {
  const catalogUrl = new URL('/sources/' + encodeURIComponent(body.sourceId) + '/catalog', allowedOrigin);
  const catalog = await retrieve(catalogUrl.href, allowedOrigin);
  const declaration = JSON.parse(catalog.bytes);
  const selected = declaration.versions.find(value => value.version === body.version);
  if (!selected) throw Object.assign(new Error('version_not_declared'), { status: 404 });
  const catalogReceipt = await archive.receive({ collectionId: body.collectionId, sourceKey: catalogUrl.href, revision: catalog.revision, mediaType: catalog.mediaType, bytes: catalog.bytes, summary: { source: body.sourceId } });
  const url = new URL(selected.href, allowedOrigin);
  const raw = await retrieve(url.href, allowedOrigin);
  const receipt = await archive.receive({ collectionId: body.collectionId, sourceKey: url.href, revision: raw.revision, mediaType: raw.mediaType, bytes: raw.bytes, summary: { source: body.sourceId, version: body.version } });
  const record = { kind: 'source-version', key: body.sourceId + ':' + body.version, value: { source: body.sourceId, version: body.version, payload: JSON.parse(raw.bytes) }, provenance: [{ receiptId: catalogReceipt.receiptId, location: '/versions' }, { receiptId: receipt.receiptId, location: '/' }] };
  await archive.addRecord(body.collectionId, record);
  return { receiptIds: [catalogReceipt.receiptId, receipt.receiptId], record, scope: 'single-source-only' };
}
