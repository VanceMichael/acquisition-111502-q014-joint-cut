import { harness } from '../test/harness.mjs';
import descriptor from '../fixtures/descriptor.json' with { type: 'json' };

const context = await harness(process.env.SOURCE_STAGE || 'complete');
try {
  const result = await context.call('/acquisitions', { collectionId: 'demo', entry: context.source + descriptor.entry, options: descriptor.options || {} });
  console.log(JSON.stringify({ acquisition: result }, null, 2));
  const collection = await context.call('/collections/demo');
  console.log(JSON.stringify(collection.value, null, 2));
  for (const receiptId of collection.value.receiptIds) {
    console.log(JSON.stringify((await context.call('/receipts/' + receiptId)).value, null, 2));
  }
  const joint = await context.call('/joint-acquisitions', { collectionId: 'demo-joint', entry: context.source + '/catalog', requestBudget: 20 });
  console.log(JSON.stringify({ joint: joint.value }, null, 2));
  const jointCollection = await context.call('/collections/demo-joint');
  console.log(JSON.stringify(jointCollection.value, null, 2));
  console.log(JSON.stringify({ sourceRequests: context.provider.requests.map(({ method, path, query }) => ({ method, path, query })) }, null, 2));
  if (result.status >= 400 || !['committed', 'unconfirmed', 'incompatible'].includes(joint.value.state)) process.exitCode = 1;
} finally { await context.close(); }
