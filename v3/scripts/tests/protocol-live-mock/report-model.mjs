import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';

export const REPORT_SCHEMA_VERSION = 2;

const ENTRY_PROTOCOLS = ['openai_chat', 'responses', 'anthropic', 'gemini'];
const PROVIDER_PROTOCOLS = ['openai_chat', 'responses', 'anthropic', 'gemini'];
const CASE_STATUSES = ['passed', 'failed', 'not_run', 'infra_failure'];
const STATUS_PRIORITY = new Map([
  ['passed', 0],
  ['not_run', 1],
  ['failed', 2],
  ['infra_failure', 3],
]);

export function buildMatrixCoverage(cases) {
  const normalizedCases = (Array.isArray(cases) ? cases : []).map((entry, index) => normalizeCase(entry, index, {}));
  const uniqueCases = uniqueCasesById(normalizedCases);
  return ENTRY_PROTOCOLS.flatMap((entryProtocol) =>
    PROVIDER_PROTOCOLS.map((providerProtocol) => {
      const requiredVariants = entryProtocol === providerProtocol
        ? [
            { transport: 'json', mode: 'direct', supplemental: false },
            { transport: 'sse', mode: 'direct', supplemental: false },
          ]
        : [
            { transport: 'json', mode: 'relay', supplemental: false },
            { transport: 'sse', mode: 'relay', supplemental: false },
          ];
      const supplementalVariants = entryProtocol === providerProtocol
        ? [{ transport: 'json', mode: 'relay', supplemental: true }]
        : [];
      const variants = [...requiredVariants, ...supplementalVariants].map((variant) =>
        buildVariantCoverage(uniqueCases, entryProtocol, providerProtocol, variant),
      );
      const required = variants.filter((variant) => !variant.supplemental);
      const allRequiredHaveCases = required.every((variant) => variant.case_count > 0);
      let status = 'not_covered';
      if (required.some((variant) => variant.status === 'infra_failure')) status = 'infra_failure';
      else if (required.some((variant) => variant.status === 'failed')) status = 'covered_with_failures';
      else if (allRequiredHaveCases && required.every((variant) => variant.status === 'passed')) status = 'covered';
      else if (allRequiredHaveCases) status = 'not_run';

      return {
        entry_protocol: entryProtocol,
        provider_protocol: providerProtocol,
        scope: 'base',
        status,
        required_variant_count: required.length,
        covered_required_variant_count: required.filter((variant) => variant.case_count > 0).length,
        variants,
      };
    }),
  );
}

export function finalizeReport(report) {
  const source = isPlainObject(report) ? structuredClone(report) : {};
  const rawCases = Array.isArray(source.entries) ? source.entries : Array.isArray(source.cases) ? source.cases : [];
  const normalizedCases = rawCases.map((entry, index) => normalizeCase(entry, index, source));
  const uniqueCases = uniqueCasesById(normalizedCases);
  const duplicateCaseIds = [...groupBy(uniqueCases, (entry) => entry.case_id)]
    .filter(([, entries]) => entries.some((entry) => entry.duplicate_count > 1))
    .map(([caseId]) => caseId);

  const summary = summarizeCases(uniqueCases, normalizedCases, source);
  const matrixCells = buildMatrixCoverage(uniqueCases);
  const supplementalCells = matrixCells.filter((cell) => cell.variants.some((variant) => variant.supplemental));
  const boundaryCases = uniqueCases.filter((entry) => entry.scope === 'boundary');
  const runtimeIdentity = normalizeRuntimeIdentity(source.binary ?? source.runtime_identity ?? source.runtime);
  const sourceIdentity = normalizeSourceIdentity(source, rawCases);
  const cleanup = normalizeCleanup(source.cleanup);
  const evidence = normalizeEvidence(source, uniqueCases);

  const finalized = {
    ...source,
    schema_version: source.schema_version ?? REPORT_SCHEMA_VERSION,
    report_schema_version: REPORT_SCHEMA_VERSION,
    source_status: source.status ?? 'unknown',
    status: deriveReportStatus(summary),
    cases: uniqueCases,
    entries: normalizedCases,
    summary,
    matrix_cells: matrixCells,
    supplemental_relay_cells: supplementalCells,
    boundary_cases: boundaryCases,
    p2_handoff: buildP2Handoff(uniqueCases),
    infra_failures: uniqueCases.filter((entry) => entry.status === 'infra_failure'),
    runtime_identity: runtimeIdentity,
    binary: runtimeIdentity,
    source_identity: sourceIdentity,
    cleanup,
    evidence,
  };

  return finalized;
}

function buildVariantCoverage(cases, entryProtocol, providerProtocol, variant) {
  const matching = cases.filter((entry) =>
    entry.scope === 'base' &&
    entry.entry_protocol === entryProtocol &&
    entry.provider_protocol === providerProtocol &&
    entry.transport === variant.transport &&
    entry.mode === variant.mode,
  );
  const statusCounts = countStatuses(matching);
  let status = 'not_run';
  if (matching.some((entry) => entry.status === 'infra_failure')) status = 'infra_failure';
  else if (matching.some((entry) => entry.status === 'failed')) status = 'failed';
  else if (matching.length === 0) status = 'not_run';
  else if (matching.some((entry) => entry.status === 'not_run')) status = 'not_run';
  else status = 'passed';

  return {
    transport: variant.transport,
    mode: variant.mode,
    supplemental: Boolean(variant.supplemental),
    case_ids: matching.map((entry) => entry.case_id),
    case_count: matching.length,
    status,
    status_counts: statusCounts,
  };
}

function normalizeCase(entry, index, report) {
  const value = isPlainObject(entry) ? structuredClone(entry) : {};
  const cellValue = isPlainObject(value.cell) ? value.cell : {};
  const caseId = stringValue(value.case_id) || value.case_id || `unknown-case-${index + 1}`;
  const entryProtocol = stringValue(cellValue.entry_protocol ?? value.entry_protocol);
  const providerProtocol = stringValue(cellValue.provider_protocol ?? value.provider_protocol);
  const transport = stringValue(cellValue.transport ?? value.transport);
  const mode = stringValue(cellValue.mode ?? value.mode);
  const explicitScope = value.scope ?? cellValue.scope;
  const scope = explicitScope === 'boundary' ? 'boundary' : explicitScope === 'base' ? 'base' : !isBaseCaseId(caseId) ? 'boundary' : 'base';
  const status = classifyCaseStatus(value, report.status);
  const diagnostic = stringValue(value.diagnostic ?? value.error ?? value.reason) || (status === 'passed' ? 'baseline assertions passed' : 'no diagnostic');
  const evidenceRefs = collectEvidenceRefs(value, report);

  return {
    ...value,
    case_id: caseId,
    entry_protocol: entryProtocol,
    provider_protocol: providerProtocol,
    transport,
    mode,
    scope,
    status,
    raw_status: value.status ?? 'missing',
    diagnostic,
    product_failures: numberValue(value.product_failures),
    runner_failures: numberValue(value.runner_failures),
    first_divergence: stringValue(value.first_divergence ?? value.observed_first_external_divergence ?? value.first_external_divergence) || null,
    evidence_refs: evidenceRefs,
    duplicate_count: 1,
  };
}

function uniqueCasesById(cases) {
  const order = [];
  const byId = new Map();
  for (const entry of cases) {
    const caseId = stringValue(entry.case_id) || `unknown-case-${order.length + 1}`;
    const normalized = { ...entry, case_id: caseId };
    const existing = byId.get(caseId);
    if (!existing) {
      byId.set(caseId, normalized);
      order.push(caseId);
      continue;
    }
    byId.set(caseId, mergeDuplicateCase(existing, normalized));
  }
  return order.map((caseId) => byId.get(caseId));
}

function mergeDuplicateCase(left, right) {
  const status = worseStatus(left.status, right.status);
  const diagnostics = [left.diagnostic, right.diagnostic].filter((entry) => entry && entry !== 'baseline assertions passed');
  return {
    ...left,
    ...right,
    status,
    diagnostic: [...new Set(diagnostics)].join('; ') || left.diagnostic,
    product_failures: Math.max(left.product_failures ?? 0, right.product_failures ?? 0),
    runner_failures: Math.max(left.runner_failures ?? 0, right.runner_failures ?? 0),
    evidence_refs: [...new Set([...(left.evidence_refs ?? []), ...(right.evidence_refs ?? [])])],
    duplicate_count: (left.duplicate_count ?? 1) + (right.duplicate_count ?? 1),
  };
}

function summarizeCases(uniqueCases, allCases, report) {
  const counts = countStatuses(uniqueCases);
  const duplicateCaseIds = uniqueCases
    .filter((entry) => entry.duplicate_count > 1)
    .map((entry) => entry.case_id)
    .sort();
  const hasReportInfrastructureFailure = isInfrastructureReportStatus(report.status);
  return {
    total: uniqueCases.length,
    entries: allCases.length,
    duplicate_case_ids: duplicateCaseIds,
    duplicate_entries: allCases.length - uniqueCases.length,
    passed: counts.passed,
    failed: counts.failed,
    not_run: counts.not_run,
    skipped: counts.not_run,
    infra_failure: counts.infra_failure + (uniqueCases.length === 0 && hasReportInfrastructureFailure ? 1 : 0),
    product_failures: sum(uniqueCases, 'product_failures'),
    runner_failures: sum(uniqueCases, 'runner_failures'),
  };
}

function deriveReportStatus(summary) {
  if (summary.infra_failure > 0) return 'infra_failed';
  if (summary.failed > 0) return 'baseline_completed_with_failures';
  if (summary.total > 0 && summary.passed === summary.total && summary.not_run === 0) return 'passed';
  return 'not_run';
}

function classifyCaseStatus(entry, reportStatus) {
  if (isInfrastructureReportStatus(reportStatus)) return 'infra_failure';
  if (entry.infra_failure === true || entry.classification === 'infrastructure' || entry.classification === 'infra_failure') return 'infra_failure';
  if (numberValue(entry.runner_failures) > 0) return 'infra_failure';
  const status = stringValue(entry.status).toLowerCase();
  if (['infra_failure', 'infrastructure_failure', 'runner_failed', 'runner_error', 'setup_failed', 'startup_failed'].includes(status)) return 'infra_failure';
  if (['not_run', 'skipped', 'pending'].includes(status)) return 'not_run';
  if (['failed', 'failure', 'product_failed', 'baseline_failed'].includes(status)) return 'failed';
  if (['passed', 'pass', 'ok', 'success'].includes(status)) {
    if (numberValue(entry.product_failures) > 0) return 'failed';
    return 'passed';
  }
  return 'not_run';
}

function buildP2Handoff(cases) {
  const failedCases = cases.filter((entry) => entry.status === 'failed');
  const groups = new Map();
  for (const entry of failedCases) {
    const key = entry.first_divergence || 'unknown';
    const bucket = groups.get(key) ?? [];
    bucket.push(entry);
    groups.set(key, bucket);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => {
      if (left === 'unknown') return 1;
      if (right === 'unknown') return -1;
      return left.localeCompare(right);
    })
    .map(([firstDivergence, entries]) => ({
      first_divergence: firstDivergence,
      count: entries.length,
      cases: entries.map((entry) => ({
        case_id: entry.case_id,
        status: entry.status,
        diagnostic: entry.diagnostic,
        first_divergence: entry.first_divergence,
        evidence_refs: entry.evidence_refs,
      })),
    }));
}

function normalizeRuntimeIdentity(value) {
  const runtime = isPlainObject(value) ? structuredClone(value) : {};
  return {
    ...runtime,
    kind: stringValue(runtime.kind ?? runtime.identity_kind ?? runtime.runtime_kind) || 'unspecified',
    path: stringValue(runtime.path) || null,
    version: stringValue(runtime.version) || null,
    sha256: stringValue(runtime.sha256 ?? runtime.hash) || null,
  };
}

function normalizeSourceIdentity(report, cases) {
  const source = isPlainObject(report.source_identity) ? report.source_identity : isPlainObject(report.source) ? report.source : {};
  const firstSource = cases.find((entry) => isPlainObject(entry.source))?.source ?? {};
  return {
    repo: stringValue(source.repo ?? firstSource.repo) || null,
    sha: stringValue(source.sha ?? report.source_sha ?? report.sourceSha ?? firstSource.sha) || null,
    fixture_sha: stringValue(report.fixture_source_sha ?? report.fixtureSourceSha ?? source.fixture_sha ?? firstSource.sha) || null,
  };
}

function normalizeCleanup(value) {
  const cleanup = isPlainObject(value) ? structuredClone(value) : { complete: false, reason: 'cleanup receipt missing' };
  const complete = cleanup.complete === true && cleanup.status !== 'incomplete' && cleanup.force_killed !== true;
  return { ...cleanup, complete };
}

function normalizeEvidence(report, cases) {
  const root = stringValue(report.evidence_root ?? report.evidence?.root) || null;
  const rootIsTemporary = Boolean(root) && isTemporaryPath(root);
  const references = [];
  for (const entry of cases) {
    for (const reference of entry.evidence_refs ?? []) {
      const stableReference = stableEvidenceReference(reference, root, report.fixture_root);
      references.push({
        reference: stableReference,
        original: reference,
        persistent: !rootIsTemporary && !isTemporaryPath(reference),
      });
    }
  }
  return {
    root,
    persistent: Boolean(root) && !rootIsTemporary,
    references: dedupeBy(references, (entry) => entry.reference),
  };
}

function collectEvidenceRefs(entry, report) {
  const candidates = [];
  for (const key of ['captures', 'client_evidence', 'client_result', 'diagnostic_evidence', 'evidence', 'raw_result']) {
    const value = entry[key];
    if (Array.isArray(value)) candidates.push(...value);
    else if (typeof value === 'string') candidates.push(value);
    else if (isPlainObject(value)) {
      for (const nestedKey of ['path', 'json_path', 'markdown_path', 'result_path', 'capture_path', 'source']) {
        if (typeof value[nestedKey] === 'string') candidates.push(value[nestedKey]);
      }
    }
  }
  if (typeof report.evidence_root === 'string' && Array.isArray(entry.captures)) {
    candidates.push(...entry.captures.map((capture) => (pathLike(capture) ? String(capture) : '')));
  }
  return [...new Set(candidates.filter(pathLike))].map(String);
}

function stableEvidenceReference(reference, evidenceRoot, fixtureRoot) {
  if (!isAbsolute(reference)) return reference;
  for (const root of [evidenceRoot, fixtureRoot].filter(Boolean)) {
    const relativeReference = relative(resolve(root), resolve(reference));
    if (relativeReference && !relativeReference.startsWith('..') && !isAbsolute(relativeReference)) return relativeReference;
  }
  return reference;
}

function isBaseCaseId(caseId) {
  return /^(chat|openai_chat|responses|anthropic|gemini)-to-(chat|openai_chat|responses|anthropic|gemini)-(json|sse)$/.test(caseId) ||
    caseId === 'same-protocol-relay-chat-to-chat-json';
}

function isInfrastructureReportStatus(status) {
  return ['runner_startup_failed', 'config_invalid', 'setup_failed', 'runner_failed', 'infrastructure_failure'].includes(status);
}

function isTemporaryPath(value) {
  if (!value) return false;
  const resolved = resolve(String(value));
  const temporaryRoots = [...new Set([resolve(tmpdir()), resolve('/tmp'), resolve('/private/tmp')])];
  return temporaryRoots.some((root) => resolved === root || resolved.startsWith(`${root}/`));
}

function countStatuses(cases) {
  const counts = Object.fromEntries(CASE_STATUSES.map((status) => [status, 0]));
  for (const entry of cases) counts[entry.status] = (counts[entry.status] ?? 0) + 1;
  return counts;
}

function sum(cases, key) {
  return cases.reduce((total, entry) => total + numberValue(entry[key]), 0);
}

function worseStatus(left, right) {
  return (STATUS_PRIORITY.get(right) ?? 0) >= (STATUS_PRIORITY.get(left) ?? 0) ? right : left;
}

function groupBy(values, selector) {
  const groups = new Map();
  for (const value of values) {
    const key = selector(value);
    const bucket = groups.get(key) ?? [];
    bucket.push(value);
    groups.set(key, bucket);
  }
  return groups;
}

function dedupeBy(values, selector) {
  const seen = new Set();
  return values.filter((value) => {
    const key = selector(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function numberValue(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

export function stringValue(value) {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function pathLike(value) {
  return typeof value === 'string' && value.length > 0;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
