#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  auditV3CallerFlow,
  auditV3ArchitectureLocks,
  auditV3CallerFlowSource,
  auditV3ReviewSurfaceHtmlText,
  loadV3ArchitectureAuditLocks,
  loadV3MainlineCallMap,
  renderV3MainlineCallerFlowHtml,
  renderV3MainlineCallerFlowMarkdown,
  V3_ARCHITECTURE_AUDIT_LOCKS_PATH,
  V3_CALLER_FLOW_HTML_PATH,
  V3_CALLER_FLOW_PATH,
} from './v3-mainline-caller-flow-lib.mjs';
import YAML from 'yaml';

const root = process.cwd();
const expected = renderV3MainlineCallerFlowMarkdown(root);
const outputPath = path.join(root, V3_CALLER_FLOW_PATH);
const expectedHtml = renderV3MainlineCallerFlowHtml(root);
const htmlOutputPath = path.join(root, V3_CALLER_FLOW_HTML_PATH);
const failures = [];

if (!fs.existsSync(outputPath)) {
  failures.push(`missing generated caller flow: ${V3_CALLER_FLOW_PATH}`);
} else {
  const current = fs.readFileSync(outputPath, 'utf8');
  if (current !== expected) failures.push(`${V3_CALLER_FLOW_PATH} is out of sync; run npm run render:v3-mainline-caller-flow`);
}
if (!fs.existsSync(htmlOutputPath)) {
  failures.push(`missing generated caller flow HTML: ${V3_CALLER_FLOW_HTML_PATH}`);
} else {
  const currentHtml = fs.readFileSync(htmlOutputPath, 'utf8');
  if (currentHtml !== expectedHtml) failures.push(`${V3_CALLER_FLOW_HTML_PATH} is out of sync; run npm run render:v3-mainline-caller-flow`);
  for (const failure of auditV3ReviewSurfaceHtmlText(currentHtml).failures) failures.push(failure);
}
for (const failure of auditV3ReviewSurfaceHtmlText(expectedHtml, 'rendered HTML').failures) failures.push(failure);

const parsed = loadV3MainlineCallMap(root);
const audit = auditV3CallerFlow(parsed);
const sourceAudit = auditV3CallerFlowSource(root);
const locks = loadV3ArchitectureAuditLocks(root);
let previousLocks = null;
try {
  const previous = execFileSync('git', ['show', `HEAD:${V3_ARCHITECTURE_AUDIT_LOCKS_PATH}`], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  previousLocks = YAML.parse(previous) ?? {};
} catch {
  previousLocks = null;
}
const lockAudit = auditV3ArchitectureLocks(parsed, locks, previousLocks);
for (const edge of audit.forbiddenDirectProjection) {
  failures.push(`forbidden direct response projection edge: ${edge.chain_id}/${edge.step_id} ${edge.from_node} -> ${edge.to_node}`);
}
for (const edge of sourceAudit.forbiddenRegisteredHooks) {
  failures.push(`forbidden source registered direct response edge: ${edge.source_path} ${edge.input_node} -> ${edge.output_node}`);
}
for (const edge of audit.missing) {
  failures.push(`missing caller map field: ${edge.chain_id}/${edge.step_id} ${edge.reason}`);
}
for (const failure of lockAudit.failures) {
  failures.push(`architecture audit lock failure: ${failure}`);
}

if (failures.length) {
  console.error('[verify:v3-mainline-caller-flow] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[verify:v3-mainline-caller-flow] ok');
console.log(`- ${V3_CALLER_FLOW_PATH} is synced`);
console.log(`- ${V3_CALLER_FLOW_HTML_PATH} is synced`);
console.log(`- binding_pending edges listed for review: ${audit.bindingPending.length}`);
console.log(`- manual audit locked chains: ${(locks?.locked_items ?? []).length}`);
console.log(`- manual audit pending chains: ${lockAudit.warnings.length}`);
