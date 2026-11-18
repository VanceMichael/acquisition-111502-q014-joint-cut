import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.mjs';
import alpha from '../fixtures/alpha.json' with { type: 'json' };
import beta from '../fixtures/beta.json' with { type: 'json' };
import gamma from '../fixtures/gamma.json' with { type: 'json' };

function assertConstraints(records, catalogs) {
  const selection = Object.fromEntries(records.map(record => [record.value.source, record.value.version]));
  for (const catalog of catalogs) {
    const declared = catalog.versions.find(candidate => candidate.version === selection[catalog.source]);
    assert.ok(declared, '选择了目录未声明的版本');
    for (const [source, allowed] of Object.entries(declared.requires || {})) {
      assert.ok(allowed.includes(selection[source]), '联合版本互不兼容');
    }
  }
  return selection;
}

test('完整目录给出可共同交付的切面并保留目录与原文依据', async () => {
  const context = await harness();
  try {
    const result = await context.call('/joint-acquisitions', { collectionId: 'joint', entry: context.source + '/catalog', requestBudget: 20 });
    assert.equal(result.status, 201);
    assert.equal(result.value.state, 'committed');
    const collection = (await context.call('/collections/joint')).value;
    assert.equal(collection.joint.state, 'committed');
    const records = collection.records.filter(record => record.kind === 'source-version');
    assert.equal(records.length, 3);
    const selection = assertConstraints(records, [alpha, beta, gamma]);
    // Only the oldest set satisfies every declared requirement, even though
    // newer versions exist in every catalog.
    assert.deepEqual(selection, { alpha: '1', beta: '1', gamma: '1' });
    for (const record of records) {
      assert.equal(record.provenance.length, 2);
      const locations = record.provenance.map(origin => origin.location);
      assert.ok(locations.some(location => location.startsWith('/versions/')));
      for (const origin of record.provenance) {
        const receipt = await context.call('/receipts/' + origin.receiptId);
        assert.equal(receipt.status, 200);
        assert.equal(receipt.value.collectionId, 'joint');
      }
    }
    assert.ok(context.provider.requests.length <= 20);
    // The published cut is backed by conditional revalidation of every catalog.
    assert.ok(context.provider.requests.some(request => request.headers['if-none-match']));
    assert.equal((await context.call('/collections/joint')).value.issues.length, 0);
  } finally { await context.close(); }
});

test('有一方目录不可观察时只声明未确认而不称组合不存在', async () => {
  const context = await harness('partial');
  try {
    const result = await context.call('/joint-acquisitions', { collectionId: 'partial', entry: context.source + '/catalog', requestBudget: 20 });
    assert.equal(result.status, 201);
    assert.equal(result.value.state, 'unconfirmed');
    assert.ok(result.value.unresolved.some(item => item.source === 'gamma'));
    const collection = (await context.call('/collections/partial')).value;
    assert.equal(collection.records.filter(record => record.kind === 'source-version').length, 0);
    assert.ok(collection.issues.length > 0);
  } finally { await context.close(); }
});

test('完整目录排除全部组合时才判为已证无解', async () => {
  const context = await harness('incompatible');
  try {
    const result = await context.call('/joint-acquisitions', { collectionId: 'none', entry: context.source + '/catalog', requestBudget: 20 });
    assert.equal(result.value.state, 'incompatible');
    assert.equal((await context.call('/collections/none')).value.records.length, 0);
  } finally { await context.close(); }
});

test('目录资格在发表前变化时不发表旧候选', async () => {
  const context = await harness('racing');
  try {
    const result = await context.call('/joint-acquisitions', { collectionId: 'racing', entry: context.source + '/catalog', requestBudget: 20 });
    assert.notEqual(result.value.state, 'committed');
    assert.ok(['unconfirmed', 'incompatible'].includes(result.value.state));
    const collection = (await context.call('/collections/racing')).value;
    assert.notEqual(collection.joint.state, 'committed');
    assert.equal(collection.records.filter(record => record.kind === 'source-version').length, 0);
  } finally { await context.close(); }
});

test('预算耗尽只报告仍未确认的部分且不超出预算', async () => {
  const context = await harness();
  try {
    const result = await context.call('/joint-acquisitions', { collectionId: 'budget', entry: context.source + '/catalog', requestBudget: 2 });
    assert.equal(result.value.state, 'unconfirmed');
    assert.ok(result.value.unresolved.some(item => item.reason === 'request_budget_exhausted'));
    assert.equal(context.provider.requests.length, 2);
  } finally { await context.close(); }
});

test('先前单方原文不等于联合声明，联合状态与索引一致且跨重启保留', async () => {
  const context = await harness();
  try {
    for (const sourceId of ['alpha', 'beta', 'gamma']) {
      await context.call('/single-source', { collectionId: 'mixed', sourceId, version: '2' });
    }
    const before = (await context.call('/collections/mixed')).value;
    assert.equal(before.joint, null);
    const result = await context.call('/joint-acquisitions', { collectionId: 'mixed', entry: context.source + '/catalog', requestBudget: 20 });
    assert.equal(result.value.state, 'committed');
    await context.restart();
    const after = (await context.call('/collections/mixed')).value;
    assert.equal(after.joint.state, 'committed');
    const jointRecords = after.records.filter(record => record.value.joint === true);
    assert.equal(jointRecords.length, 3);
    assertConstraints(jointRecords, [alpha, beta, gamma]);
    // The single-source receipts from the earlier round remain retrievable.
    for (const receiptId of before.receiptIds) {
      assert.equal((await context.call('/receipts/' + receiptId)).status, 200);
    }
  } finally { await context.close(); }
});

test('重新规划失败时先前的联合切面不再显示为当前可交付', async () => {
  const context = await harness();
  try {
    assert.equal((await context.call('/joint-acquisitions', { collectionId: 'again', entry: context.source + '/catalog', requestBudget: 20 })).value.state, 'committed');
    const retry = await context.call('/joint-acquisitions', { collectionId: 'again', entry: context.source + '/catalog', requestBudget: 1 });
    assert.equal(retry.value.state, 'unconfirmed');
    const collection = (await context.call('/collections/again')).value;
    assert.equal(collection.joint.state, 'unconfirmed');
    assert.equal(collection.records.filter(record => record.value.joint === true).length, 0);
  } finally { await context.close(); }
});

test('环状约束按同时成立处理而不是当作坏目录', async () => {
  const context = await harness();
  try {
    // alpha -> beta -> gamma -> alpha is a cycle; a joint set exists.
    const result = await context.call('/joint-acquisitions', { collectionId: 'cycle', entry: context.source + '/catalog', requestBudget: 20 });
    assert.equal(result.value.state, 'committed');
    assertConstraints((await context.call('/collections/cycle')).value.records, [alpha, beta, gamma]);
  } finally { await context.close(); }
});

test('联合领取拒绝非法预算与授权来源之外的入口', async () => {
  const context = await harness();
  try {
    assert.equal((await context.call('/joint-acquisitions', { collectionId: 'bad', entry: context.source + '/catalog', requestBudget: -1 })).status, 400);
    assert.equal((await context.call('/joint-acquisitions', { collectionId: 'bad', entry: 'http://outside.invalid/catalog', requestBudget: 20 })).status, 403);
    assert.equal(context.provider.requests.length, 0);
  } finally { await context.close(); }
});

test('选中正文退出保留期时在预算内改选且不声称可交付', async () => {
  const context = await harness('retired');
  try {
    const result = await context.call('/joint-acquisitions', { collectionId: 'retired', entry: context.source + '/catalog', requestBudget: 20 });
    assert.equal(result.value.state, 'unconfirmed');
    assert.ok(result.value.unresolved.some(item => item.reason === 'payload_unavailable'));
    assert.ok(context.provider.requests.length <= 20);
    const collection = (await context.call('/collections/retired')).value;
    assert.equal(collection.records.filter(record => record.kind === 'source-version').length, 0);
  } finally { await context.close(); }
});

test('按来源列出的新旧顺序取较新可兼容版本而不比较版本号字符串', async () => {
  const context = await harness('preference');
  try {
    const result = await context.call('/joint-acquisitions', { collectionId: 'pref', entry: context.source + '/catalog', requestBudget: 20 });
    assert.equal(result.value.state, 'committed');
    // Both sets satisfy every constraint; the newer one is the joint cut even
    // though "9" sorts after "10" as a string.
    assert.deepEqual(result.value.selection.map(item => [item.source, item.version]), [['alpha', '10'], ['beta', '10']]);
  } finally { await context.close(); }
});
