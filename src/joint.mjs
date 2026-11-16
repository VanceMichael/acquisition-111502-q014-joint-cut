import { requestSource, sourceUrl } from './transport.mjs';
import { digest, identifier } from './archive.mjs';

const MAX_ATTEMPTS = 3;
const NODE_LIMIT = 500_000;

class BudgetExhausted extends Error {
  constructor() {
    super('request_budget_exhausted');
    this.name = 'BudgetExhausted';
  }
}

class Budget {
  constructor(limit) {
    this.limit = limit;
    this.used = 0;
  }

  async fetch(entry, options = {}) {
    if (this.used >= this.limit) throw new BudgetExhausted();
    this.used++;
    return requestSource(entry, options.allowedOrigin, { headers: options.headers || {} });
  }
}

function invalid(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function pending(reason, location, detail, source) {
  const item = { reason, location };
  if (detail !== undefined) item.detail = detail;
  if (source !== undefined) item.source = source;
  return item;
}

function revisionLabel(revision) {
  return revision || 'unversioned';
}

function parseDeclaration(document, entryUrl, allowedOrigin) {
  let value;
  try {
    value = JSON.parse(document.bytes);
  } catch {
    return { ok: false, pending: [pending('joint_catalog_malformed', '/', '入口不是可解析的 JSON 目录')] };
  }
  if (!value || typeof value !== 'object' || !Array.isArray(value.participants)) {
    return { ok: false, pending: [pending('joint_catalog_malformed', '/participants', '目录缺少 participants 数组')] };
  }
  const participants = [];
  const seen = new Set();
  for (const [index, entry] of value.participants.entries()) {
    const location = `/participants/${index}`;
    if (!entry || typeof entry.source !== 'string' || !entry.source || typeof entry.catalog !== 'string' || !entry.catalog) {
      return { ok: false, pending: [pending('joint_catalog_malformed', location, '参与者需要 source 与非空 catalog')] };
    }
    if (seen.has(entry.source)) {
      return { ok: false, pending: [pending('joint_catalog_malformed', location, '来源重复: ' + entry.source)] };
    }
    seen.add(entry.source);
    let catalogUrl;
    try {
      catalogUrl = new URL(entry.catalog, entryUrl).href;
      sourceUrl(catalogUrl, allowedOrigin);
    } catch {
      return { ok: false, pending: [pending('catalog_pointer_not_allowed', location, '目录地址不在授权来源内')] };
    }
    participants.push({ source: entry.source, catalogUrl });
  }
  if (participants.length === 0) {
    return { ok: false, pending: [pending('no_participants', '/participants', '联合目录没有可选择的参与来源')] };
  }
  return { ok: true, participants };
}

function parseCatalog(document, source, catalogUrl, allowedOrigin, knownSources) {
  let value;
  try {
    value = JSON.parse(document.bytes);
  } catch {
    return { ok: false, pending: [pending('catalog_malformed', catalogUrl, source + ' 目录不是可解析的 JSON', source)] };
  }
  if (!value || typeof value !== 'object' || value.source !== source || !Array.isArray(value.versions)) {
    return { ok: false, pending: [pending('catalog_malformed', catalogUrl, source + ' 目录身份或 versions 不符', source)] };
  }
  const versions = [];
  const seen = new Set();
  for (const [index, entry] of value.versions.entries()) {
    const location = catalogUrl + '#/versions/' + index;
    if (!entry || typeof entry.version !== 'string' || !entry.version || typeof entry.href !== 'string' || !entry.href) {
      return { ok: false, pending: [pending('catalog_malformed', location, '版本需要非空 version 与 href', source)] };
    }
    if (seen.has(entry.version)) {
      return { ok: false, pending: [pending('catalog_malformed', location, '来源内版本重复: ' + entry.version, source)] };
    }
    seen.add(entry.version);
    let href;
    try {
      href = new URL(entry.href, catalogUrl).href;
      sourceUrl(href, allowedOrigin);
    } catch {
      return { ok: false, pending: [pending('catalog_pointer_not_allowed', location, '版本地址不在授权来源内', source)] };
    }
    if (entry.requires !== undefined && (!entry.requires || typeof entry.requires !== 'object' || Array.isArray(entry.requires))) {
      return { ok: false, pending: [pending('catalog_malformed', location + '/requires', 'requires 必须是对象', source)] };
    }
    const requires = new Map();
    for (const [target, allowed] of Object.entries(entry.requires || {})) {
      if (target === source || !knownSources.has(target)) {
        return { ok: false, pending: [pending('catalog_malformed', location + '/requires/' + target, 'requires 指向的来源不在本次联合目录内', source)] };
      }
      if (!Array.isArray(allowed) || allowed.some(version => typeof version !== 'string' || !version)) {
        return { ok: false, pending: [pending('catalog_malformed', location + '/requires/' + target, '允许版本必须是非空字符串数组', source)] };
      }
      requires.set(target, new Set(allowed));
    }
    versions.push({ version: entry.version, href, requires, index });
  }
  return { ok: true, catalog: { source, complete: value.complete === true, versions } };
}

function selectionObject(assignment) {
  return Object.fromEntries([...assignment].map(([source, option]) => [source, option.version]));
}

// 目录只按本来源 versions 的顺序表达偏好（旧到新）。参与者顺序仅作为确定性的
// 词典序搜索次序，不用版本号或发布时间做跨来源排序。返回的第一个完整可行分配
// 因此是按该次序最偏好（最新）的可行切面。
function searchSelection(participants, catalogs, exclusions) {
  const order = participants.map(entry => entry.source);
  const options = new Map(order.map(source => {
    const excluded = exclusions?.get(source);
    return [source, catalogs.get(source).versions
      .filter(option => !excluded || !excluded.has(option.version))
      .slice()
      .reverse()];
  }));
  if (order.some(source => options.get(source).length === 0)) {
    return { found: null, aborted: false, nodes: 0 };
  }
  const assignment = new Map();
  let nodes = 0;
  let aborted = false;

  function consistent() {
    for (const [source, option] of assignment) {
      for (const [target, allowed] of option.requires) {
        if (assignment.has(target)) {
          if (!allowed.has(assignment.get(target).version)) return false;
        } else if (!options.get(target).some(candidate => allowed.has(candidate.version))) {
          return false;
        }
      }
    }
    return true;
  }

  function walk(position) {
    if (position === order.length) return new Map(assignment);
    const source = order[position];
    for (const option of options.get(source)) {
      if (aborted) return null;
      nodes++;
      if (nodes > NODE_LIMIT) {
        aborted = true;
        return null;
      }
      assignment.set(source, option);
      if (consistent()) {
        const result = walk(position + 1);
        if (result) return result;
      }
      assignment.delete(source);
    }
    return null;
  }

  return { found: walk(0), aborted, nodes };
}

async function observeRound(entryUrl, budget, allowedOrigin, progress) {
  progress.phase = 'entry';
  progress.activeSource = undefined;
  progress.location = entryUrl.href;
  progress.participants = null;
  progress.catalogFailures = [];
  progress.entryEvidence = null;
  progress.payloadCache = new Map();
  let document;
  try {
    document = await budget.fetch(entryUrl.href, { allowedOrigin });
  } catch (error) {
    if (error instanceof BudgetExhausted) throw error;
    return { ok: false, pending: [pending('joint_catalog_unavailable', entryUrl.href, error.message)] };
  }
  if (!document.ok) {
    return { ok: false, pending: [pending('joint_catalog_unavailable', entryUrl.href, 'HTTP ' + document.status)] };
  }
  progress.evidence.push({ url: entryUrl.href, document, summary: { role: 'joint-catalog' } });
  progress.entryEvidence = { url: entryUrl.href, revision: document.revision };
  const entry = { ...document, url: entryUrl.href };
  const declaration = parseDeclaration(entry, entryUrl.href, allowedOrigin);
  if (!declaration.ok) return { ok: false, pending: declaration.pending };
  progress.participants = declaration.participants;
  const knownSources = new Set(declaration.participants.map(entry => entry.source));

  const catalogs = new Map();
  const observedCatalogs = new Map();
  const failures = [];
  for (const participant of declaration.participants) {
    progress.phase = 'catalog';
    progress.activeSource = participant.source;
    progress.location = participant.catalogUrl;
    let response;
    try {
      response = await budget.fetch(participant.catalogUrl, { allowedOrigin });
    } catch (error) {
      if (error instanceof BudgetExhausted) throw error;
      failures.push(pending('catalog_unavailable', participant.catalogUrl, error.message, participant.source));
      continue;
    }
    if (!response.ok) {
      failures.push(pending('catalog_unavailable', participant.catalogUrl, 'HTTP ' + response.status, participant.source));
      continue;
    }
    progress.evidence.push({ url: participant.catalogUrl, document: response, summary: { role: 'source-catalog', source: participant.source } });
    const parsed = parseCatalog(response, participant.source, participant.catalogUrl, allowedOrigin, knownSources);
    if (!parsed.ok) {
      failures.push(...parsed.pending);
      continue;
    }
    const catalog = {
      ...parsed.catalog,
      url: participant.catalogUrl,
      bytes: response.bytes,
      revision: response.revision,
      mediaType: response.mediaType
    };
    catalogs.set(participant.source, catalog);
    observedCatalogs.set(participant.source, {
      source: participant.source,
      url: catalog.url,
      revision: catalog.revision,
      complete: catalog.complete
    });
  }
  progress.activeSource = undefined;
  progress.observedCatalogs = observedCatalogs;
  progress.catalogFailures = failures.map(item => ({ source: item.source ?? null, failure: item.reason, location: item.location, detail: item.detail }));
  if (failures.length > 0) {
    return { ok: false, pending: failures, participants: declaration.participants, catalogs, entry };
  }
  return { ok: true, participants: declaration.participants, catalogs, entry };
}

function conditionalHeaders(document) {
  const revision = document.revision;
  return revision && revision !== 'unversioned' ? { 'if-none-match': revision } : {};
}

async function revalidateRound(round, budget, allowedOrigin, progress) {
  const documents = [round.entry];
  for (const participant of round.participants) documents.push(round.catalogs.get(participant.source));
  const failures = [];
  for (const document of documents) {
    progress.phase = 'revalidate';
    progress.activeSource = undefined;
    progress.location = document.url;
    let response;
    try {
      response = await budget.fetch(document.url, { allowedOrigin, headers: conditionalHeaders(document) });
    } catch (error) {
      if (error instanceof BudgetExhausted) throw error;
      failures.push(pending('catalog_validity_unconfirmed', document.url, error.message));
      continue;
    }
    if (response.status === 304) continue;
    if (!response.ok) {
      failures.push(pending('catalog_changed', document.url, '复验请求返回 HTTP ' + response.status));
      continue;
    }
    const identical = response.revision === document.revision && response.bytes.equals(document.bytes);
    if (!identical) {
      if (response.revision !== document.revision) {
        progress.evidence.push({ url: document.url, document: response, summary: { role: 'catalog-revalidation' } });
      }
      failures.push(pending('catalog_changed', document.url,
        '规划时 ' + revisionLabel(document.revision) + '，复验时 ' + revisionLabel(response.revision)));
    }
  }
  return { ok: failures.length === 0, pending: failures };
}

async function fetchPayloads(assignment, budget, allowedOrigin, progress) {
  const payloads = new Map();
  const failures = [];
  progress.phase = 'payload';
  progress.payloadConfirmed.clear();
  for (const [source, option] of assignment) {
    progress.activeSource = source;
    progress.location = option.href;
    const cached = progress.payloadCache.get(option.href);
    if (cached) {
      payloads.set(source, cached);
      progress.payloadConfirmed.set(source, option.version);
      continue;
    }
    let response;
    try {
      response = await budget.fetch(option.href, { allowedOrigin });
    } catch (error) {
      if (error instanceof BudgetExhausted) throw error;
      failures.push({ source, version: option.version, url: option.href, retryable: false, reason: error.message });
      continue;
    }
    if (!response.ok) {
      failures.push({
        source, version: option.version, url: option.href,
        retryable: response.status === 404 || response.status === 410,
        reason: 'HTTP ' + response.status
      });
      continue;
    }
    payloads.set(source, response);
    progress.payloadCache.set(option.href, response);
    progress.payloadConfirmed.set(source, option.version);
    progress.evidence.push({ url: option.href, document: response, summary: { role: 'source-version', source, version: option.version } });
  }
  progress.activeSource = undefined;
  return { ok: failures.length === 0, payloads, failures };
}

async function archiveEvidence(collectionId, evidence, archive) {
  const byKey = new Map();
  const receiptIds = [];
  for (const item of evidence) {
    const key = item.url + '\n' + item.document.revision;
    if (byKey.has(key)) continue;
    const receipt = await archive.receive({
      collectionId,
      sourceKey: item.url,
      revision: item.document.revision,
      mediaType: item.document.mediaType,
      bytes: item.document.bytes,
      summary: { ...item.summary, byteLength: item.document.bytes.length }
    });
    byKey.set(key, receipt.receiptId);
    receiptIds.push(receipt.receiptId);
  }
  return { byKey, receiptIds };
}

function payloadValue(response, source, version) {
  try {
    return JSON.parse(response.bytes);
  } catch {
    return {
      encoding: 'base64', mediaType: response.mediaType, source, version,
      sha256: digest(response.bytes), data: response.bytes.toString('base64')
    };
  }
}

function catalogBasis(round) {
  return round.participants.map(participant => {
    const catalog = round.catalogs.get(participant.source);
    return { source: participant.source, url: catalog.url, revision: catalog.revision, complete: catalog.complete };
  });
}

function unconfirmedBody(collectionId, progress, extra = {}) {
  const pendingItems = [...progress.pending, ...(extra.pending || [])];
  const pendingSources = new Set();
  for (const item of pendingItems) if (item.source) pendingSources.add(item.source);
  const payloadStageReached = extra.selection !== undefined || progress.selection !== null;
  for (const participant of progress.participants || []) {
    if (!progress.observedCatalogs.has(participant.source)) pendingSources.add(participant.source);
    else if (payloadStageReached && !progress.payloadConfirmed.has(participant.source)) pendingSources.add(participant.source);
  }
  return {
    collectionId,
    state: 'unconfirmed',
    selection: extra.selection ?? progress.selection ?? null,
    basis: {
      entry: progress.entryEvidence,
      catalogs: [...progress.observedCatalogs.values()],
      catalogFailures: [...progress.catalogFailures],
      payloads: [...progress.payloadConfirmed].map(([source, version]) => ({ source, version, confirmed: true })),
      validity: 'unconfirmed'
    },
    pending: pendingItems,
    unconfirmedSources: [...pendingSources],
    requestsUsed: progress.budget.used,
    requestBudget: progress.budget.limit,
    ...(extra.detail ? { detail: extra.detail } : {})
  };
}

async function unconfirmedResult(body, progress, archive, extra = {}) {
  const archived = await archiveEvidence(body.collectionId, progress.evidence, archive);
  const response = unconfirmedBody(body.collectionId, progress, extra);
  response.receiptIds = archived.receiptIds;
  await archive.saveJointAttempt(body.collectionId, {
    state: 'unconfirmed',
    selection: response.selection,
    basis: response.basis,
    pending: response.pending,
    unconfirmedSources: response.unconfirmedSources,
    requestsUsed: response.requestsUsed,
    requestBudget: response.requestBudget,
    receiptIds: response.receiptIds,
    attemptedAt: new Date().toISOString()
  }, response.pending);
  return { status: 200, body: response };
}

async function incompatibleResult(body, progress, round, entryUrl, archive) {
  const archived = await archiveEvidence(body.collectionId, progress.evidence, archive);
  const response = {
    collectionId: body.collectionId,
    state: 'incompatible',
    selection: null,
    detail: '本轮完整且有效的来源目录按各自声明的兼容关系排除了所有组合',
    basis: {
      entry: { url: entryUrl.href, revision: round.entry.revision, receiptId: archived.byKey.get(entryUrl.href + '\n' + round.entry.revision) },
      catalogs: catalogBasis(round).map(catalog => ({
        ...catalog,
        receiptId: archived.byKey.get(catalog.url + '\n' + catalog.revision)
      })),
      validity: 'confirmed'
    },
    pending: [],
    requestsUsed: progress.budget.used,
    requestBudget: progress.budget.limit,
    receiptIds: archived.receiptIds
  };
  await archive.saveJointAttempt(body.collectionId, {
    state: 'incompatible',
    selection: null,
    basis: response.basis,
    pending: [],
    requestsUsed: response.requestsUsed,
    requestBudget: response.requestBudget,
    receiptIds: response.receiptIds,
    attemptedAt: new Date().toISOString()
  }, []);
  return { status: 200, body: response };
}

async function commitResult(body, progress, round, entryUrl, chosen, payloads, archive, skipped) {
  const archived = await archiveEvidence(body.collectionId, progress.evidence, archive);
  const records = [];
  for (const participant of round.participants) {
    const source = participant.source;
    const option = chosen.get(source);
    const catalog = round.catalogs.get(source);
    const payload = payloads.get(source);
    const catalogReceipt = archived.byKey.get(catalog.url + '\n' + catalog.revision);
    const payloadReceipt = archived.byKey.get(option.href + '\n' + payload.revision);
    records.push({
      kind: 'source-version',
      key: source + ':' + option.version,
      value: { source, version: option.version, payload: payloadValue(payload, source, option.version) },
      provenance: [
        { receiptId: catalogReceipt, location: '/versions/' + option.index },
        { receiptId: payloadReceipt, location: '/' }
      ]
    });
  }
  const publication = {
    state: 'committed',
    selection: selectionObject(chosen),
    basis: {
      entry: { url: entryUrl.href, revision: round.entry.revision, receiptId: archived.byKey.get(entryUrl.href + '\n' + round.entry.revision) },
      catalogs: catalogBasis(round).map(catalog => ({
        ...catalog,
        receiptId: archived.byKey.get(catalog.url + '\n' + catalog.revision)
      })),
      validity: 'confirmed'
    },
    skippedVersions: skipped,
    recordKeys: records.map(record => record.key),
    requestsUsed: progress.budget.used,
    requestBudget: progress.budget.limit,
    publishedAt: new Date().toISOString()
  };
  await archive.publishJoint(body.collectionId, records, publication);
  return {
    status: 201,
    body: {
      collectionId: body.collectionId,
      state: 'committed',
      selection: publication.selection,
      basis: publication.basis,
      skippedVersions: publication.skippedVersions,
      recordKeys: publication.recordKeys,
      receiptIds: archived.receiptIds,
      requestsUsed: publication.requestsUsed,
      requestBudget: publication.requestBudget,
      pending: []
    }
  };
}

export async function acquireJoint(body, archive, allowedOrigin) {
  if (!body || typeof body !== 'object') throw invalid('invalid_joint_request');
  identifier(body.collectionId);
  if (typeof body.entry !== 'string' || !body.entry) throw invalid('missing_entry');
  if (!Number.isInteger(body.requestBudget) || body.requestBudget < 0) throw invalid('invalid_request_budget');
  let entryUrl;
  try {
    entryUrl = sourceUrl(body.entry, allowedOrigin);
  } catch (error) {
    if (error.status) throw error;
    throw invalid('invalid_entry');
  }
  const budget = new Budget(body.requestBudget);
  const progress = {
    budget,
    phase: 'start',
    activeSource: undefined,
    location: entryUrl.href,
    participants: null,
    observedCatalogs: new Map(),
    catalogFailures: [],
    evidence: [],
    pending: [],
    entryEvidence: null,
    selection: null,
    payloadConfirmed: new Map(),
    payloadCache: new Map()
  };
  const exclusions = new Map();

  try {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const round = await observeRound(entryUrl, budget, allowedOrigin, progress);
      if (!round.ok) {
        progress.pending.push(...round.pending);
        return await unconfirmedResult(body, progress, archive);
      }

      let chosen = null;
      let payloads = null;
      let payloadPending = [];
      while (true) {
        const search = searchSelection(round.participants, round.catalogs, exclusions);
        if (!search.found) {
          if (search.aborted) {
            progress.pending.push(pending('search_limit_reached', '/', '候选组合过多，未能证明不存在兼容切面'));
            return await unconfirmedResult(body, progress, archive);
          }
          const withoutExclusions = exclusions.size > 0
            ? searchSelection(round.participants, round.catalogs, null)
            : search;
          if (withoutExclusions.found) {
            progress.pending.push(...payloadPending);
            progress.pending.push(pending('declared_selection_unavailable', '/',
              '目录仍声明有兼容组合，但本轮可领取的正文已不可用；不能据此断定组合不存在'));
            return await unconfirmedResult(body, progress, archive, {
              selection: selectionObject(withoutExclusions.found)
            });
          }
          const incomplete = round.participants.filter(participant => round.catalogs.get(participant.source).complete !== true);
          if (incomplete.length > 0) {
            progress.pending.push(...payloadPending);
            progress.pending.push(...incomplete.map(participant => pending('catalog_incomplete', round.catalogs.get(participant.source).url,
              participant.source + ' 未声明完整候选列表，不能断言不存在兼容组合', participant.source)));
            return await unconfirmedResult(body, progress, archive);
          }
          const validity = await revalidateRound(round, budget, allowedOrigin, progress);
          if (!validity.ok) {
            progress.pending.push(...validity.pending);
            continue;
          }
          return await incompatibleResult(body, progress, round, entryUrl, archive);
        }

        progress.selection = selectionObject(search.found);
        const fetched = await fetchPayloads(search.found, budget, allowedOrigin, progress);
        if (fetched.ok) {
          chosen = search.found;
          payloads = fetched.payloads;
          break;
        }
        const fatal = fetched.failures.filter(failure => !failure.retryable);
        if (fatal.length > 0) {
          progress.pending.push(...fatal.map(failure => pending('source_unreachable', failure.url, failure.reason, failure.source)));
          progress.pending.push(pending('payload_unconfirmed', '/', '正文未全部取得，不能发表联合切面'));
          return await unconfirmedResult(body, progress, archive);
        }
        payloadPending = fetched.failures.map(failure => pending('version_unavailable', failure.url,
          failure.source + ':' + failure.version + ' 本轮不可领取（' + failure.reason + '），已尝试其他可兼容版本', failure.source));
        for (const failure of fetched.failures) {
          if (!exclusions.has(failure.source)) exclusions.set(failure.source, new Set());
          exclusions.get(failure.source).add(failure.version);
        }
      }

      const validity = await revalidateRound(round, budget, allowedOrigin, progress);
      if (!validity.ok) {
        progress.pending.push(...validity.pending);
        continue;
      }
      return await commitResult(body, progress, round, entryUrl, chosen, payloads, archive, payloadPending.map(item => ({
        source: item.source, url: item.location, reason: item.reason, detail: item.detail
      })));
    }
    progress.pending.push(pending('catalog_validity_unconfirmed', '/',
      '在 ' + MAX_ATTEMPTS + ' 次规划内目录持续变化，未能以本轮有效目录确认切面'));
  } catch (error) {
    if (!(error instanceof BudgetExhausted)) throw error;
    progress.pending.push(pending('budget_exhausted', progress.location,
      '请求预算 ' + budget.limit + ' 已用尽；当前阶段 ' + progress.phase,
      progress.activeSource ?? progress.participants?.find(participant => !progress.observedCatalogs.has(participant.source))?.source));
  }
  return await unconfirmedResult(body, progress, archive);
}
