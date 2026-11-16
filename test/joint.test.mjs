import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.mjs';
import alpha from '../fixtures/alpha.json' with { type: 'json' };
import beta from '../fixtures/beta.json' with { type: 'json' };
import gamma from '../fixtures/gamma.json' with { type: 'json' };

function constraintsHold(catalogs, selection) {
  for (const catalog of catalogs) {
    const version = catalog.versions.find(candidate => candidate.version === selection[catalog.source]);
    if (!version) return false;
    for (const [source, allowed] of Object.entries(version.requires || {})) {
      if (!allowed.includes(selection[source])) return false;
    }
  }
  return true;
}

async function joint(context, collectionId, requestBudget = 20) {
  return context.call('/joint-acquisitions', { collectionId, entry: context.source + '/catalog', requestBudget });
}

test('完整目录给出可共同交付的兼容切面并保留各方原文与目录依据', async () => {
  const context = await harness();
  try {
    const result = await joint(context, 'joint');
    assert.equal(result.status, 201);
    assert.equal(result.value.state, 'committed');
    assert.equal(result.value.basis.validity, 'confirmed');
    assert.equal(result.value.selection.alpha !== undefined, true);

    const collection = (await context.call('/collections/joint')).value;
    assert.equal(collection.joint.state, 'committed');
    const records = collection.records.filter(record => record.kind === 'source-version');
    assert.equal(records.length, 3);
    const selection = Object.fromEntries(records.map(record => [record.value.source, record.value.version]));
    assert.deepEqual(selection, result.value.selection);
    assert.ok(constraintsHold([alpha, beta, gamma], selection));

    for (const record of records) {
      assert.ok(record.provenance.length >= 2);
      for (const origin of record.provenance) {
        const receipt = await context.call('/receipts/' + origin.receiptId);
        assert.equal(receipt.status, 200);
        assert.equal(receipt.value.collectionId, 'joint');
      }
      const payloadReceipt = await fetch(context.base + '/receipts/' + record.provenance[1].receiptId + '/body').then(response => response.json());
      assert.deepEqual(payloadReceipt, record.value.payload);
    }
    for (const catalog of result.value.basis.catalogs) {
      assert.ok(catalog.receiptId);
      assert.equal((await context.call('/receipts/' + catalog.receiptId)).status, 200);
    }
    assert.ok(context.provider.requests.length <= 20);
  } finally { await context.close(); }
});

test('环状兼容关系仍然可以共同交付', async () => {
  const context = await harness('cycle');
  try {
    const result = await joint(context, 'cycle');
    assert.equal(result.value.state, 'committed');
    assert.deepEqual(result.value.selection, { alpha: '1', beta: '1', gamma: '1' });
  } finally { await context.close(); }
});

test('按来源声明的偏好选择较新版本而不做跨来源排序', async () => {
  const context = await harness('prefer');
  try {
    const result = await joint(context, 'prefer');
    assert.equal(result.value.state, 'committed');
    assert.deepEqual(result.value.selection, { alpha: '2', beta: '2', gamma: '2' });
  } finally { await context.close(); }
});

test('正文临时不可领取时退到较旧的兼容版本并说明跳过项', async () => {
  const context = await harness('payload-missing');
  try {
    const result = await joint(context, 'fallback');
    assert.equal(result.value.state, 'committed');
    assert.deepEqual(result.value.selection, { alpha: '1', beta: '1', gamma: '2' });
    assert.equal(result.value.skippedVersions.length, 1);
    assert.equal(result.value.skippedVersions[0].url.endsWith('/sources/alpha/versions/2'), true);
  } finally { await context.close(); }
});

test('完整有效目录排除所有组合时报告 incompatible', async () => {
  const context = await harness('incompatible');
  try {
    const result = await joint(context, 'incompatible');
    assert.equal(result.value.state, 'incompatible');
    assert.equal(result.value.basis.validity, 'confirmed');
    assert.deepEqual(result.value.pending, []);
    const collection = (await context.call('/collections/incompatible')).value;
    assert.equal(collection.joint.state, 'incompatible');
    assert.equal(collection.records.length, 0);
  } finally { await context.close(); }
});

test('目录不全时只说明未确认部分而不宣称无解', async () => {
  const context = await harness('partial');
  try {
    const result = await joint(context, 'partial');
    assert.equal(result.value.state, 'unconfirmed');
    assert.deepEqual(result.value.unconfirmedSources, ['gamma']);
    assert.ok(result.value.pending.some(item => item.reason === 'catalog_unavailable'));
    assert.notEqual(result.value.state, 'incompatible');
  } finally { await context.close(); }
});

test('目录只列出部分候选时不能把未找到组合说成组合不存在', async () => {
  const context = await harness('incomplete');
  try {
    const result = await joint(context, 'incomplete');
    assert.equal(result.value.state, 'unconfirmed');
    assert.ok(result.value.pending.some(item => item.reason === 'catalog_incomplete'));
  } finally { await context.close(); }
});

test('目录资格在发表前变化时不发表旧候选切面', async () => {
  const context = await harness('racing');
  try {
    const result = await joint(context, 'racing');
    assert.notEqual(result.value.state, 'committed');
    assert.notDeepEqual(result.value.selection, { alpha: '1', beta: '1', gamma: '1' });
    if (result.value.state === 'incompatible') {
      // 可以基于变更后的完整目录重新规划；此时必须已确认本轮有效性。
      assert.equal(result.value.basis.validity, 'confirmed');
    } else {
      assert.equal(result.value.state, 'unconfirmed');
      assert.ok(result.value.pending.some(item => item.reason === 'catalog_changed' || item.reason === 'catalog_validity_unconfirmed'));
    }
    assert.equal((await context.call('/collections/racing')).value.records.length, 0);
  } finally { await context.close(); }
});

test('请求预算耗尽时说明仍缺的观察与未确认来源', async () => {
  const context = await harness();
  try {
    const result = await joint(context, 'budget', 3);
    assert.equal(result.value.state, 'unconfirmed');
    assert.ok(result.value.pending.some(item => item.reason === 'budget_exhausted'));
    assert.ok(result.value.unconfirmedSources.length > 0);
    assert.ok(context.provider.requests.length <= 3);
  } finally { await context.close(); }
});

test('联合目录入口与版本地址都受授权来源限制', async () => {
  const context = await harness();
  try {
    assert.equal((await context.call('/joint-acquisitions', { collectionId: 'outside', entry: 'http://outside.invalid/catalog', requestBudget: 5 })).status, 403);
    assert.equal(context.provider.requests.length, 0);
  } finally { await context.close(); }
});

test('先前单方原文不会让联合入口少领取，发表后索引与联合状态一致', async () => {
  const context = await harness();
  try {
    const single = await context.call('/single-source', { collectionId: 'mixed', sourceId: 'alpha', version: '2' });
    assert.equal(single.status, 201);
    const result = await joint(context, 'mixed');
    assert.equal(result.value.state, 'committed');
    assert.equal(result.value.selection.alpha, '1');
    const collection = (await context.call('/collections/mixed')).value;
    const records = collection.records.filter(record => record.kind === 'source-version');
    assert.deepEqual(
      Object.fromEntries(records.map(record => [record.value.source, record.value.version])),
      result.value.selection
    );
    assert.equal(collection.joint.state, 'committed');
    assert.deepEqual(collection.joint.selection, result.value.selection);
    // 单方原文仍可按收件回查。
    assert.equal((await context.call('/receipts/' + single.value.receiptIds[1])).status, 200);
  } finally { await context.close(); }
});

test('联合发表后可重启回查，且未确认尝试不覆盖已发表切面', async () => {
  const context = await harness();
  try {
    const first = await joint(context, 'persist');
    assert.equal(first.value.state, 'committed');
    const selection = first.value.selection;
    assert.equal((await context.call('/collections/persist/records', {
      kind: 'manual-note', key: 'n1', value: { text: '人工确认' },
      provenance: [{ receiptId: first.value.receiptIds[0], location: 'byte:0' }]
    })).status, 201);
    await context.restart();
    const collection = (await context.call('/collections/persist')).value;
    assert.deepEqual(collection.joint.selection, selection);
    assert.equal(collection.joint.state, 'committed');
    assert.equal(collection.records.filter(record => record.kind === 'manual-note').length, 1);

    const second = await joint(context, 'persist', 2);
    assert.equal(second.value.state, 'unconfirmed');
    const after = (await context.call('/collections/persist')).value;
    assert.equal(after.joint.state, 'committed');
    assert.deepEqual(after.joint.selection, selection);
    assert.equal(after.jointAttempt.state, 'unconfirmed');
  } finally { await context.close(); }
});
