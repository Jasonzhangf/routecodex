#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const root = process.env.ROUTECODEX_V3_FIXTURE_ROOT
  ? path.resolve(process.env.ROUTECODEX_V3_FIXTURE_ROOT)
  : process.env.ROUTECODEX_V3_SOURCE_ROOT
    ? path.resolve(process.env.ROUTECODEX_V3_SOURCE_ROOT)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const file = 'docs/architecture/manifests/v3.protocol_normalization_tool_governance_boundary.mainline.yml';
const manifest = YAML.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const failures = [];
for (const id of ['ProviderReqCompat06ProviderCompat', 'ProviderRespCompat02ProviderCompat']) {
  const node = manifest.nodes?.find((row) => row.node_id === id);
  if (!node) {
    failures.push(`${id}: missing Compat boundary declaration`);
    continue;
  }
  if (node.tool_governance === 'allowed' || node.forbidden?.tool_governance !== 'forbidden') {
    failures.push(`${id}: tool governance must remain forbidden`);
  }
  if (node.forbidden?.fallback_or_silent_repair !== 'forbidden') {
    failures.push(`${id}: fallback or silent repair must remain forbidden`);
  }
}
if (failures.length) {
  console.error('[verify:v3-normalization-payload-logic-boundary] failed');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}
console.log('[verify:v3-normalization-payload-logic-boundary] declared Compat boundaries ok');
