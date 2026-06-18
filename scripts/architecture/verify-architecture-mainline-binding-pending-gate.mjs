// Budget lock for binding-pending / partial mainline debt.
// Existing debt is allowed only if it matches docs/architecture/mainline-binding-budget.yml.
// Any new pending/partial growth, anchored regression, or chain shape drift fails fast.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import {
  validateMainlineCallMap,
  normalizeEdgeStatus,
} from './mainline-call-map-lib.mjs';

const root = process.cwd();
const budgetPath = path.join(root, 'docs/architecture/mainline-binding-budget.yml');
const { failures, parsed } = validateMainlineCallMap(root);
if (failures.length > 0 || !parsed) {
  console.error('[verify:architecture-mainline-binding-pending-gate] failed');
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}

if (!fs.existsSync(budgetPath)) {
  console.error('[verify:architecture-mainline-binding-pending-gate] failed');
  console.error(`- missing budget manifest: ${path.relative(root, budgetPath)}`);
  process.exit(1);
}

let budgetDoc;
try {
  budgetDoc = YAML.parse(fs.readFileSync(budgetPath, 'utf8'));
} catch (err) {
  console.error('[verify:architecture-mainline-binding-pending-gate] failed');
  console.error(`- invalid YAML in ${path.relative(root, budgetPath)}: ${err.message}`);
  process.exit(1);
}

const budgetRows = Array.isArray(budgetDoc?.chains) ? budgetDoc.chains : [];
const budgets = new Map();
for (const row of budgetRows) {
  const chainId = typeof row?.chain_id === 'string' ? row.chain_id : '';
  if (!chainId) continue;
  if (budgets.has(chainId)) {
    console.error('[verify:architecture-mainline-binding-pending-gate] failed');
    console.error(`- duplicate chain budget: ${chainId}`);
    process.exit(1);
  }
  budgets.set(chainId, row);
}

let anchored = 0;
let partial = 0;
let pending = 0;
const perChainRows = [];
const budgetFailures = [];

for (const chain of parsed.chains ?? []) {
  const chainId = typeof chain?.chain_id === 'string' ? chain.chain_id : '';
  if (!chainId) {
    continue;
  }
  let cAnchored = 0;
  let cPartial = 0;
  let cPending = 0;
  for (const edge of chain.edges ?? []) {
    const status = normalizeEdgeStatus(edge);
    if (status === 'anchored') {
      anchored += 1;
      cAnchored += 1;
    } else if (status === 'partial') {
      partial += 1;
      cPartial += 1;
    } else if (status === 'binding pending') {
      pending += 1;
      cPending += 1;
    }
  }
  const totalEdges = cAnchored + cPartial + cPending;
  perChainRows.push({
    chainId,
    pending: cPending,
    partial: cPartial,
    anchored: cAnchored,
    total: totalEdges,
  });

  const budget = budgets.get(chainId);
  if (!budget) {
    budgetFailures.push(`missing budget for chain ${chainId}`);
    continue;
  }
  const expectedTotal = Number(budget.expected_total_edges);
  const minAnchored = Number(budget.min_anchored_edges);
  const maxPartial = Number(budget.max_partial_edges);
  const maxPending = Number(budget.max_binding_pending_edges);
  if (!Number.isFinite(expectedTotal) || expectedTotal < 0) {
    budgetFailures.push(`${chainId}: invalid expected_total_edges`);
  } else if (totalEdges !== expectedTotal) {
    budgetFailures.push(
      `${chainId}: total edges ${totalEdges} exceeds locked shape ${expectedTotal}`
    );
  }
  if (!Number.isFinite(minAnchored) || minAnchored < 0) {
    budgetFailures.push(`${chainId}: invalid min_anchored_edges`);
  } else if (cAnchored < minAnchored) {
    budgetFailures.push(
      `${chainId}: anchored edges ${cAnchored} fell below floor ${minAnchored}`
    );
  }
  if (!Number.isFinite(maxPartial) || maxPartial < 0) {
    budgetFailures.push(`${chainId}: invalid max_partial_edges`);
  } else if (cPartial > maxPartial) {
    budgetFailures.push(
      `${chainId}: partial edges ${cPartial} exceeded budget ${maxPartial}`
    );
  }
  if (!Number.isFinite(maxPending) || maxPending < 0) {
    budgetFailures.push(`${chainId}: invalid max_binding_pending_edges`);
  } else if (cPending > maxPending) {
    budgetFailures.push(
      `${chainId}: binding pending edges ${cPending} exceeded budget ${maxPending}`
    );
  }
}

for (const chainId of budgets.keys()) {
  const exists = perChainRows.some((row) => row.chainId === chainId);
  if (!exists) {
    budgetFailures.push(`budget references missing chain ${chainId}`);
  }
}

const total = anchored + partial + pending;
const pct = (n) => (total > 0 ? `${((n / total) * 100).toFixed(1)}%` : '0.0%');

if (budgetFailures.length > 0) {
  console.error('[verify:architecture-mainline-binding-pending-gate] failed');
  for (const failure of budgetFailures) {
    console.error(`- ${failure}`);
  }
  console.error(`- budget manifest: ${path.relative(root, budgetPath)}`);
  process.exit(1);
}

console.log('[verify:architecture-mainline-binding-pending-gate] ok');
console.log(`- budget manifest: ${path.relative(root, budgetPath)}`);
console.log(`- chains: ${parsed.chains.length}, total edges: ${total}`);
console.log(`- anchored: ${anchored} (${pct(anchored)})`);
console.log(`- partial: ${partial} (${pct(partial)})`);
console.log(`- binding pending: ${pending} (${pct(pending)})`);
for (const row of perChainRows) {
  console.log(
    `- ${row.chainId}: anchored=${row.anchored} partial=${row.partial} pending=${row.pending} total=${row.total}`
  );
}
