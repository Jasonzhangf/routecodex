import { finalizeReport, stringValue } from './report-model.mjs';

export { REPORT_SCHEMA_VERSION, buildMatrixCoverage, finalizeReport } from './report-model.mjs';

export function renderMarkdown(report) {
  const value = finalizeReport(report);
  const lines = [];
  lines.push('# Magpie Live Mock-Provider Baseline');
  lines.push('');
  lines.push(`- status: \`${value.status}\``);
  lines.push(`- source status: \`${value.source_status}\``);
  lines.push(`- unique cases: \`${value.summary.total}\``);
  lines.push(`- entries: \`${value.summary.entries}\``);
  lines.push(`- passed: \`${value.summary.passed}\``);
  lines.push(`- failed: \`${value.summary.failed}\``);
  lines.push(`- not_run: \`${value.summary.not_run}\``);
  lines.push(`- infra_failure: \`${value.summary.infra_failure}\``);
  lines.push(`- duplicate case ids: ${value.summary.duplicate_case_ids.length ? value.summary.duplicate_case_ids.map(code).join(', ') : 'none'}`);
  lines.push('');
  lines.push('## Execution Details');
  lines.push('');
  lines.push('### Runtime');
  lines.push('');
  lines.push(`- kind: ${code(value.runtime_identity?.kind ?? 'unspecified')}`);
  lines.push(`- path: ${code(value.runtime_identity?.path ?? 'unknown')}`);
  lines.push(`- version: ${code(value.runtime_identity?.version ?? 'unknown')}`);
  lines.push('');
  lines.push('### Fixture Reference');
  lines.push('');
  lines.push(`- repo: ${code(value.source_identity?.repo ?? 'unknown')}`);
  lines.push(`- config check exit: ${code(value.config_identity?.check ?? 'not_run')}`);
  lines.push('- config check and source declarations are setup evidence only; they are not live matrix success.');
  lines.push('');
  lines.push('## Case Results');
  lines.push('');
  lines.push('| case_id | entry | provider | transport | mode | status | diagnostic | evidence |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const entry of value.cases) {
    lines.push(
      `| ${cell(entry.case_id)} | ${cell(entry.entry_protocol)} | ${cell(entry.provider_protocol)} | ${cell(entry.transport)} | ${cell(entry.mode)} | ${cell(entry.status)} | ${cell(entry.diagnostic)} | ${cell(entry.evidence_refs.join(', '))} |`,
    );
  }
  if (value.cases.length === 0) lines.push('| none |  |  |  |  | not_run | no cases were sent |  |');
  lines.push('');
  lines.push('## Base Matrix');
  lines.push('');
  lines.push('| entry | provider | status | variants | case_ids |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const matrixCell of value.matrix_cells) {
    const variants = matrixCell.variants.map((variant) => `${variant.transport}/${variant.mode}${variant.supplemental ? ' (supplemental)' : ''}: ${variant.status} (${variant.case_count})`).join('; ');
    const caseIds = matrixCell.variants.flatMap((variant) => variant.case_ids).join(', ');
    lines.push(`| ${cell(matrixCell.entry_protocol)} | ${cell(matrixCell.provider_protocol)} | ${cell(matrixCell.status)} | ${cell(variants)} | ${cell(caseIds)} |`);
  }
  lines.push('');
  lines.push('## Boundary Scope');
  lines.push('');
  if (value.boundary_cases.length === 0) {
    lines.push('- none');
  } else {
    lines.push('| case_id | entry | provider | transport | mode | status | first divergence | diagnostic | evidence |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const entry of value.boundary_cases) {
      lines.push(`| ${cell(entry.case_id)} | ${cell(entry.entry_protocol)} | ${cell(entry.provider_protocol)} | ${cell(entry.transport)} | ${cell(entry.mode)} | ${cell(entry.status)} | ${cell(entry.first_divergence ?? 'unknown')} | ${cell(entry.diagnostic)} | ${cell(entry.evidence_refs.join(', '))} |`);
    }
  }
  lines.push('');
  lines.push('## P2 Handoff');
  lines.push('');
  if (value.p2_handoff.length === 0) {
    lines.push('- none');
  } else {
    for (const group of value.p2_handoff) {
      lines.push(`### ${group.first_divergence}`);
      lines.push('');
      for (const entry of group.cases) lines.push(`- ${code(entry.case_id)}: ${entry.diagnostic}`);
      lines.push('');
    }
  }
  lines.push('## Infrastructure Failures');
  lines.push('');
  if (value.infra_failures.length === 0) {
    lines.push('- none');
  } else {
    for (const entry of value.infra_failures) lines.push(`- ${code(entry.case_id)}: ${entry.diagnostic}`);
  }
  lines.push('');
  lines.push('## Cleanup');
  lines.push('');
  lines.push(`- complete: ${code(value.cleanup.complete)}`);
  for (const [key, entry] of Object.entries(value.cleanup)) {
    if (key !== 'complete') lines.push(`- ${key}: ${code(entry)}`);
  }
  lines.push('');
  lines.push('## Evidence References');
  lines.push('');
  lines.push(`- root: ${code(value.evidence.root ?? 'unknown')}`);
  lines.push(`- root persistent: ${code(Boolean(value.evidence.persistent))}`);
  for (const reference of value.evidence.references) lines.push(`- ${code(reference.reference)} (persistent: ${code(Boolean(reference.persistent))})`);
  if (value.evidence.references.length === 0) lines.push('- none');
  lines.push('');
  return lines.join('\n');
}

function cell(value) {
  return stringValue(value).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function code(value) {
  return `\`${stringValue(value).replace(/`/g, '\\`')}\``;
}
