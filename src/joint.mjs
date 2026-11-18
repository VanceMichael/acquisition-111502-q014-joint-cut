import { request } from './transport.mjs';
import { digest } from './archive.mjs';

// Every observable source request in one joint round goes through this counter:
// index, catalogs, payloads and catalog revalidation all cost the same.
class Observer {
  constructor(allowedOrigin, requestBudget) {
    this.allowedOrigin = allowedOrigin;
    this.requestBudget = requestBudget;
    this.used = 0;
  }

  get remaining() {
    return this.requestBudget - this.used;
  }

  async observe(entry, headers = {}) {
    if (this.remaining <= 0) throw Object.assign(new Error('request_budget_exhausted'), { status: 409 });
    this.used += 1;
    try {
      return await request(entry, this.allowedOrigin, { headers });
    } catch (error) {
      // A refused address never reached the source, so it does not spend the
      // round's budget.
      if (error.status === 403) this.used -= 1;
      throw error;
    }
  }
}

function failure(reason, detail = {}) {
  return Object.assign(new Error(reason), { status: 400, ...detail });
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function asString(value) {
  return typeof value === 'string' && value ? value : null;
}

function stringArray(value) {
  return Array.isArray(value) && value.every(item => typeof item === 'string' && item);
}

function parseJson(observation, reason) {
  try {
    return JSON.parse(observation.bytes.toString('utf8'));
  } catch {
    throw failure(reason);
  }
}

function resolveHref(base, href) {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

function normalizeIndex(document, entry) {
  const participants = Array.isArray(document?.participants) ? document.participants : null;
  if (!participants || participants.length === 0) throw failure('catalog_malformed');
  const seen = new Set();
  return participants.map(participant => {
    const source = asString(participant?.source);
    // An index without an identifiable participant is not a partial catalog;
    // it is a broken index for the round we would otherwise publish.
    if (!source || seen.has(source)) throw failure('catalog_malformed');
    seen.add(source);
    const href = asString(participant.catalog);
    // A participant listed without a catalog address is a known gap: it is
    // reported as unobserved instead of being silently dropped.
    return { source, address: href ? resolveHref(entry, href) : null, catalog: null };
  });
}

function normalizeCatalog(source, document) {
  if (!document || document.source !== source || !Array.isArray(document.versions)) {
    throw failure('catalog_malformed', { source });
  }
  return {
    // Only an explicit complete:true licenses an exhaustive verdict.
    complete: document.complete === true,
    versions: document.versions.map((version, position) => {
      const requires = asObject(version?.requires) || {};
      const name = asString(version?.version);
      if (!name) throw failure('catalog_malformed', { source });
      for (const allowed of Object.values(requires)) {
        if (!stringArray(allowed)) throw failure('catalog_malformed', { source });
      }
      return {
        source,
        version: name,
        href: asString(version?.href),
        requires,
        location: '/versions/' + position
      };
    })
  };
}

async function observeParticipant(participant, observer) {
  if (!participant.address) {
    return { ...participant, state: 'unavailable', reason: 'catalog_address_missing', evidence: null, catalog: null };
  }
  let observation;
  try {
    // The first read of a catalog is unconditional: a 304 answer would confirm
    // a version we have not looked at in this round.
    observation = await observer.observe(participant.address);
  } catch (error) {
    // A catalog address outside the frozen origin is a gap in what this round
    // can observe, not a failure of the caller-supplied entry.
    return { ...participant, state: 'unavailable', reason: error.message, evidence: null, catalog: null };
  }
  try {
    return { ...participant, state: 'observed', evidence: observation,
      catalog: normalizeCatalog(participant.source, parseJson(observation, 'catalog_malformed')) };
  } catch (error) {
    // A reached but unusable catalog is a gap we observed, not "no combination".
    return { ...participant, state: 'unavailable', reason: error.message, evidence: observation, catalog: null };
  }
}

function acceptCandidate(candidate, selected, knownSources) {
  for (const [other, allowed] of Object.entries(candidate.requires)) {
    if (other === candidate.source) {
      if (!allowed.includes(candidate.version)) return false;
      continue;
    }
    if (!knownSources.has(other)) return false;
    const chosen = selected.get(other);
    if (chosen && !allowed.includes(chosen.version)) return false;
  }
  for (const chosen of selected.values()) {
    const allowed = chosen.requires[candidate.source];
    if (allowed && !allowed.includes(candidate.version)) return false;
  }
  return true;
}

// Depth-first search over declared versions. A cycle is only a set of
// constraints that must hold together; nothing here compares version strings,
// because list order is each source's own preference, not a global order.
function search(order, candidatesBySource, knownSources, excluded, stepLimit) {
  const selected = new Map();
  let steps = 0;
  let truncated = false;

  function visit(position) {
    if (position === order.length) return new Map(selected);
    if (steps >= stepLimit) { truncated = true; return null; }
    steps += 1;
    for (const candidate of candidatesBySource.get(order[position]) || []) {
      if (excluded.has(excludedKey(candidate))) continue;
      if (!acceptCandidate(candidate, selected, knownSources)) continue;
      selected.set(candidate.source, candidate);
      const found = visit(position + 1);
      if (found) return found;
      selected.delete(candidate.source);
    }
    return null;
  }

  return { selection: visit(0), steps, truncated };
}

function excludedKey(candidate) {
  return candidate.source + '\u0000' + candidate.version;
}

function plan(order, catalogsBySource, excluded, stepLimit = 200000) {
  const candidatesBySource = new Map();
  for (const source of order) {
    const versions = catalogsBySource.get(source)?.versions || [];
    // The catalog lists versions from older to newer; reversed is this
    // source's own preference for the freshest usable material.
    candidatesBySource.set(source, versions.slice().reverse());
  }
  return search(order, candidatesBySource, new Set(order), excluded, stepLimit);
}

function describeSelection(selection, order) {
  return order.map(source => {
    const candidate = selection.get(source);
    return { source, version: candidate.version, requires: candidate.requires };
  });
}

function coverageGaps(observed) {
  const unresolved = [];
  for (const participant of observed) {
    if (participant.state === 'unavailable') {
      unresolved.push({
        source: participant.source,
        reason: participant.reason === 'catalog_address_missing' ? 'catalog_missing'
          : participant.reason === 'request_budget_exhausted' ? 'request_budget_exhausted'
            : participant.reason === 'catalog_malformed' ? 'catalog_malformed'
              : 'catalog_unobserved',
        detail: participant.reason,
        location: participant.address
      });
    } else if (!participant.catalog.complete) {
      unresolved.push({ source: participant.source, reason: 'catalog_incomplete', location: participant.address });
    }
  }
  return unresolved;
}

async function archiveEvidence(archive, collectionId, entry, observation, summary) {
  // A source without an ETag has no revision label of its own; use the byte
  // identity so a later round with different bytes is kept, not rejected.
  const revision = observation.revision === 'unversioned' ? 'sha256-' + digest(observation.bytes) : observation.revision;
  return archive.receive({ collectionId, sourceKey: entry, revision,
    mediaType: observation.mediaType, bytes: observation.bytes, summary });
}

function payloadValue(bytes) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return bytes.toString('utf8');
  }
}

// Conditional revalidation right before publishing: if the index or any
// catalog moved, the candidates in hand are no longer a current cut.
async function revalidate(observed, observer, index) {
  const problems = [];
  const check = async (address, evidence, label) => {
    const revision = evidence.revision;
    try {
      if (revision && revision !== 'unversioned') {
        // A fetch that returns the same ETag is the same bytes; a different
        // one means the document moved. A failed recheck leaves this round's
        // validity unconfirmed, which is not "changed".
        const answer = await observer.observe(address, { 'if-none-match': revision });
        if (answer.status === 304 || answer.revision === revision) return;
        problems.push({ ...label, reason: 'catalog_changed', location: address });
      } else {
        const answer = await observer.observe(address);
        if (answer.revision !== revision || !answer.bytes.equals(evidence.bytes)) {
          problems.push({ ...label, reason: 'catalog_changed', location: address });
        }
      }
    } catch (error) {
      problems.push({
        ...label,
        reason: error.message === 'request_budget_exhausted' ? 'request_budget_exhausted' : 'catalog_unconfirmed',
        detail: error.message,
        location: address
      });
    }
  };
  if (index && index.evidence) await check(index.address, index.evidence, { role: 'index' });
  for (const participant of observed) {
    if (participant.state !== 'observed') continue;
    await check(participant.address, participant.evidence, { source: participant.source });
  }
  return problems;
}

function catalogDescriptions(observed) {
  return observed.map(participant => ({
    source: participant.source,
    catalog: participant.address,
    status: participant.state === 'observed' ? 'observed' : 'unavailable',
    complete: participant.catalog ? participant.catalog.complete : null,
    revision: participant.evidence ? participant.evidence.revision : null,
    receiptId: participant.evidence ? participant.evidence.receiptId : null
  }));
}

async function settle(archive, collectionId, observer, state, details) {
  const joint = {
    state,
    ...(details.entry ? { entry: details.entry } : {}),
    ...(details.indexReceiptId ? { indexReceiptId: details.indexReceiptId } : {}),
    selection: details.selection || [],
    catalogs: details.catalogs || [],
    unresolved: details.unresolved || [],
    requests: { used: observer.used, budget: observer.requestBudget }
  };
  if (details.detail) joint.detail = details.detail;
  const issues = joint.unresolved.map(item => ({
    reason: item.reason,
    location: item.location || 'joint-acquisition',
    ...(item.source ? { sources: [item.source] } : {}),
    ...(item.detail ? { detail: item.detail } : {}),
    ...(item.evidence ? { evidence: item.evidence } : {})
  }));
  await archive.publishJoint(collectionId, { records: details.records || [], joint, issues });
  return {
    collectionId,
    state,
    selection: details.selection || [],
    catalogs: details.catalogs || [],
    unresolved: joint.unresolved,
    requests: joint.requests,
    ...(details.detail ? { detail: details.detail } : {})
  };
}

export async function acquireJoint(body, archive, allowedOrigin) {
  if (typeof body.collectionId !== 'string' || !body.collectionId) throw failure('missing_collection');
  if (typeof body.entry !== 'string' || !body.entry) throw failure('missing_entry');
  const budget = body.requestBudget;
  if (!Number.isInteger(budget) || budget < 0) throw failure('invalid_request_budget');
  const collectionId = body.collectionId;
  const entry = body.entry;
  const observer = new Observer(allowedOrigin, budget);

  let indexObservation;
  try {
    indexObservation = await observer.observe(entry);
  } catch (error) {
    if (error.status === 403) throw error;
    return settle(archive, collectionId, observer, 'unconfirmed', {
      entry,
      unresolved: [{
        reason: error.message === 'request_budget_exhausted' ? 'request_budget_exhausted' : 'index_unobserved',
        detail: error.message,
        location: entry
      }]
    });
  }

  const indexReceipt = await archiveEvidence(archive, collectionId, entry, indexObservation, { format: 'joint-index', entry });
  let participants;
  try {
    participants = normalizeIndex(parseJson(indexObservation, 'catalog_malformed'), entry);
  } catch (error) {
    return settle(archive, collectionId, observer, 'unconfirmed', {
      entry,
      indexReceiptId: indexReceipt.receiptId,
      unresolved: [{ reason: 'index_malformed', detail: error.message, location: entry, evidence: [indexReceipt.receiptId] }]
    });
  }

  const observed = [];
  for (const participant of participants) observed.push(await observeParticipant(participant, observer));
  for (const participant of observed) {
    if (!participant.evidence) continue;
    const receipt = await archiveEvidence(archive, collectionId, participant.address, participant.evidence,
      { format: 'source-catalog', source: participant.source });
    participant.evidence.receiptId = receipt.receiptId;
  }

  const catalogs = catalogDescriptions(observed);
  const gaps = coverageGaps(observed);
  const order = observed.map(participant => participant.source);
  const catalogsBySource = new Map(observed.map(participant => [participant.source, participant.catalog]));
  // Index plus every catalog we actually read get one conditional recheck
  // before anything is published; this cost is reserved up front.
  const revalidationChecks = 1 + observed.filter(participant => participant.state === 'observed').length;
  const excluded = new Set();
  const observationFailures = [];

  // Payloads may have left their retention window even though the catalog
  // still lists them. Re-plan around such candidates while budget remains.
  while (true) {
    const attempt = plan(order, catalogsBySource, excluded);
    if (attempt.selection) {
      const selection = describeSelection(attempt.selection, order);
      // A compatible set built only from what a catalog did declare is still
      // tentative: this round cannot see that source's full range of versions,
      // so it is reported as unconfirmed with that tentative selection rather
      // than published as the joint cut.
      if (gaps.length > 0) {
        return settle(archive, collectionId, observer, 'unconfirmed', {
          entry, indexReceiptId: indexReceipt.receiptId, catalogs, selection,
          unresolved: [...gaps, ...observationFailures]
        });
      }
      const needed = order.length + revalidationChecks;
      if (observer.remaining < needed) {
        return settle(archive, collectionId, observer, 'unconfirmed', {
          entry, indexReceiptId: indexReceipt.receiptId, catalogs, selection,
          unresolved: [...observationFailures,
            { reason: 'request_budget_exhausted', detail: 'budget cannot cover the selected payloads and catalog revalidation',
              needed, remaining: observer.remaining }]
        });
      }
      const prepared = await preparePayloads(attempt.selection, observed, archive, collectionId, observer, revalidationChecks);
      if (prepared.records) {
        const problems = await revalidate(observed, observer, { address: entry, evidence: indexObservation });
        if (problems.length > 0) {
          return settle(archive, collectionId, observer, 'unconfirmed', {
            entry, indexReceiptId: indexReceipt.receiptId, catalogs, selection,
            unresolved: [...observationFailures, ...problems]
          });
        }
        const records = prepared.records.map(record => ({
          kind: record.kind, key: record.key, value: record.value, provenance: record.provenance
        }));
        const declared = selection.map(entry => {
          const record = records.find(candidate => candidate.value.source === entry.source);
          return { ...entry, payload: record.value.payload, provenance: record.provenance };
        });
        return settle(archive, collectionId, observer, 'committed', {
          entry, indexReceiptId: indexReceipt.receiptId, catalogs, selection: declared,
          records,
          unresolved: observationFailures
        });
      }
      const { failure: failed } = prepared;
      observationFailures.push(failed);
      if (failed.reason === 'request_budget_exhausted' || failed.reason === 'candidate_address_invalid') {
        return settle(archive, collectionId, observer, 'unconfirmed', {
          entry, indexReceiptId: indexReceipt.receiptId, catalogs, selection,
          unresolved: [...observationFailures]
        });
      }
      excluded.add(failed.source + '\u0000' + failed.version);
      continue;
    }

    if (attempt.truncated) {
      return settle(archive, collectionId, observer, 'unconfirmed', {
        entry, indexReceiptId: indexReceipt.receiptId, catalogs,
        unresolved: [...gaps, ...observationFailures, { reason: 'search_incomplete', detail: 'candidate space exceeded the planning limit' }]
      });
    }
    // Only complete, fully observed catalogs license saying that no
    // combination exists. Anything less is an unfinished observation.
    if (gaps.length > 0 || observationFailures.length > 0) {
      return settle(archive, collectionId, observer, 'unconfirmed', {
        entry, indexReceiptId: indexReceipt.receiptId, catalogs,
        unresolved: [...gaps, ...observationFailures]
      });
    }
    // "Incompatible" is also a claim about this round, so the complete
    // catalogs behind it must still be the ones we read.
    if (observer.remaining < revalidationChecks) {
      return settle(archive, collectionId, observer, 'unconfirmed', {
        entry, indexReceiptId: indexReceipt.receiptId, catalogs,
        unresolved: [{ reason: 'request_budget_exhausted', detail: 'budget cannot cover catalog revalidation before an incompatible verdict',
          needed: revalidationChecks, remaining: observer.remaining }]
      });
    }
    const moved = await revalidate(observed, observer, { address: entry, evidence: indexObservation });
    if (moved.length > 0) {
      return settle(archive, collectionId, observer, 'unconfirmed', {
        entry, indexReceiptId: indexReceipt.receiptId, catalogs,
        unresolved: moved
      });
    }
    return settle(archive, collectionId, observer, 'incompatible', {
      entry, indexReceiptId: indexReceipt.receiptId, catalogs,
      detail: 'every declared version combination of the complete catalogs is excluded by the constraints'
    });
  }
}

async function preparePayloads(selection, observed, archive, collectionId, observer, revalidationChecks) {
  const records = [];
  for (const participant of observed) {
    const candidate = selection.get(participant.source);
    const url = resolveHref(participant.address, candidate.href);
    if (!url) {
      return { failure: { source: participant.source, version: candidate.version,
        reason: 'candidate_address_invalid', location: candidate.location } };
    }
    // Leave room for the remaining payloads and every catalog revalidation.
    const stillNeeded = 1 + revalidationChecks + (observed.length - records.length - 1);
    if (observer.remaining < stillNeeded) {
      return { failure: { source: participant.source, version: candidate.version,
        reason: 'request_budget_exhausted', detail: 'payload not fetched', location: url } };
    }
    try {
      const observation = await observer.observe(url);
      const receipt = await archiveEvidence(archive, collectionId, url, observation,
        { source: participant.source, version: candidate.version });
      records.push({
        kind: 'source-version',
        key: participant.source + ':' + candidate.version,
        value: { source: participant.source, version: candidate.version, payload: payloadValue(observation.bytes), joint: true },
        provenance: [
          { receiptId: participant.evidence.receiptId, location: candidate.location },
          { receiptId: receipt.receiptId, location: '/' }
        ]
      });
    } catch (error) {
      return { failure: {
        source: participant.source,
        version: candidate.version,
        reason: error.message === 'request_budget_exhausted' ? 'request_budget_exhausted'
          : error.status === 403 ? 'payload_not_allowed' : 'payload_unavailable',
        detail: error.message,
        location: url
      } };
    }
  }
  return { records };
}
