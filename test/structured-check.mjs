import assert from 'node:assert/strict';
import { harness } from './harness.mjs';
import alpha from '../fixtures/alpha.json' with { type: 'json' };
import beta from '../fixtures/beta.json' with { type: 'json' };
import gamma from '../fixtures/gamma.json' with { type: 'json' };

const context = await harness();
try {
  const result = await context.call('/joint-acquisitions', { collectionId: 'joint', entry: context.source + '/catalog', requestBudget: 20 });
  assert.ok([200, 201].includes(result.status), '未找到所需资料观察: 联合领取入口');
  assert.equal(result.value.state, 'committed');
  const collection = (await context.call('/collections/joint')).value;
  const records = collection.records.filter(record => record.kind === 'source-version');
  assert.equal(records.length, 3);
  const selection = Object.fromEntries(records.map(record => [record.value.source, record.value.version]));
  for (const catalog of [alpha, beta, gamma]) {
    const version = catalog.versions.find(candidate => candidate.version === selection[catalog.source]);
    assert.ok(version, '选择了目录未声明的版本');
    for (const [source, allowed] of Object.entries(version.requires || {})) assert.ok(allowed.includes(selection[source]), '联合版本互不兼容');
  }
  assert.ok(context.provider.requests.length <= 20, '超出领取预算');
  for (const record of records) for (const origin of record.provenance) assert.equal((await context.call('/receipts/' + origin.receiptId)).status, 200);
  console.log(JSON.stringify({ state: result.value.state, selection, sourceRequests: context.provider.requests.length }));
} finally { await context.close(); }
