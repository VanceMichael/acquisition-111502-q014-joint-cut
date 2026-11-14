import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.mjs';

test('已有单方领取可保存各自声明的版本但不声称联合兼容', async () => {
  const context = await harness();
  try {
    for (const sourceId of ['alpha', 'beta', 'gamma']) {
      const result = await context.call('/single-source', { collectionId: 'separate', sourceId, version: '2' });
      assert.equal(result.status, 201);
      assert.equal(result.value.scope, 'single-source-only');
    }
    assert.equal((await context.call('/collections/separate')).value.records.length, 3);
  } finally { await context.close(); }
});

test('来源目录可以缺失、明确无解或失去先前有效性', async () => {
  const partial = await harness('partial');
  try { assert.equal((await fetch(partial.source + '/sources/gamma/catalog')).status, 503); }
  finally { await partial.close(); }
  const racing = await harness('racing');
  try {
    const first = await fetch(racing.source + '/sources/alpha/catalog');
    const tag = first.headers.get('etag');
    await first.arrayBuffer();
    const next = await fetch(racing.source + '/sources/alpha/catalog', { headers: { 'if-match': tag } });
    assert.equal(next.status, 412);
  } finally { await racing.close(); }
});
