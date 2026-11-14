import assert from 'node:assert/strict';
import { harness } from './harness.mjs';

for (const [stage, expected] of [['partial', 'unconfirmed'], ['incompatible', 'incompatible']]) {
  const context = await harness(stage);
  try {
    const result = await context.call('/joint-acquisitions', { collectionId: 'check', entry: context.source + '/catalog', requestBudget: 20 });
    assert.ok([200, 201].includes(result.status), '未说明来源缺件: 联合领取入口');
    assert.equal(result.value.state, expected, '把来源观察缺失与已确认无兼容组合混为一谈');
  } finally { await context.close(); }
}
const racing = await harness('racing');
try {
  const result = await racing.call('/joint-acquisitions', { collectionId: 'racing', entry: racing.source + '/catalog', requestBudget: 20 });
  assert.ok([200, 201].includes(result.status));
  assert.notEqual(result.value.state, 'committed', '目录资格变化后仍发表失效的候选切面');
} finally { await racing.close(); }
