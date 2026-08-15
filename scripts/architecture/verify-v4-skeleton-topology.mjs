#!/usr/bin/env node
/**
 * v4_parity_gate_skeleton_topology
 *
 * Locks the immutable skeleton plan topology (Phase 3/5). Reads the compiled
 * skeleton plan contract (v4/contracts/skeleton-plan.contract.json) and fails
 * red on:
 * 1. non-adjacent edge (positions are not consecutive in the same chain);
 * 2. reverse edge (direction disagrees with node positions);
 * 3. second terminal (more than one terminal node per chain);
 * 4. second runtime kernel (more than one kernel/container root per chain);
 * 5. plugin that calls next_node (plugins must be node-local).
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const failures = [];

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  } catch (error) {
    failures.push(`${file}: cannot read/parse: ${error.message}`);
    return null;
  }
};

const plan = readJson('v4/contracts/skeleton-plan.contract.json');
if (!plan) {
  console.error('[v4_parity_gate_skeleton_topology] FAIL');
  console.error(failures.join('\n'));
  process.exit(1);
}

// The compiled contract stores chains as an ordered array (canonical Rust
// shape). Older authoring drafts used a keyed object; only the array shape is
// publishable, so the gate accepts arrays and rejects unexpected shapes.
const rawChains = plan.chains ?? [];
if (!Array.isArray(rawChains)) {
  console.error('[v4_parity_gate_skeleton_topology] FAIL');
  console.error('chains must be an ordered array in the compiled skeleton plan');
  process.exit(1);
}
for (const chain of rawChains) {
  const chainId = chain.chain_id;
  if (!chainId) {
    failures.push('chain entry without chain_id');
    continue;
  }
  const nodes = chain.nodes ?? [];
  const terminals = nodes.filter((node) => node.terminal === true);
  if (terminals.length > 1) {
    failures.push(`skeleton ${chainId}: second terminal (${terminals.map((n) => n.node_id).join(', ')})`);
  }
  const kernels = nodes.filter((node) => node.kernel === true);
  if (kernels.length > 1) {
    failures.push(`skeleton ${chainId}: second runtime kernel (${kernels.map((n) => n.node_id).join(', ')})`);
  }
  const byNode = new Map(nodes.map((node) => [node.node_id, node]));
  for (const edge of chain.edges ?? []) {
    const from = byNode.get(edge.from);
    const to = byNode.get(edge.to);
    if (!from || !to) {
      failures.push(`skeleton ${chainId}: edge references unknown node (${edge.from}->${edge.to})`);
      continue;
    }
    if (from.chain !== chainId || to.chain !== chainId) {
      failures.push(`skeleton ${chainId}: cross-chain edge ${edge.from}->${edge.to}`);
      continue;
    }
    if (edge.direction === 'forward' && to.position !== from.position + 1) {
      failures.push(`skeleton ${chainId}: non-adjacent forward edge ${edge.from}->${edge.to}`);
    }
    if (edge.direction === 'reverse') {
      failures.push(`skeleton ${chainId}: reverse edge ${edge.from}->${edge.to}`);
    }
  }
  for (const node of nodes) {
    for (const plugin of node.plugins ?? []) {
      if (plugin.effects?.includes('next_node')) {
        failures.push(`skeleton ${chainId}: plugin ${plugin.plugin_id} calls next_node`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error('[v4_parity_gate_skeleton_topology] FAIL');
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('[v4_parity_gate_skeleton_topology] OK single-terminal adjacent-only skeleton');
