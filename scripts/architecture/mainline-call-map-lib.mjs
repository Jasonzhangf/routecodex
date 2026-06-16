import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

export const MAINLINE_CALL_MAP_PATH = 'docs/architecture/mainline-call-map.yml';
export const FUNCTION_MAP_PATH = 'docs/architecture/function-map.yml';
export const MAINLINE_WIKI_PATH = 'docs/architecture/wiki/mainline-call-graph.md';

const EDGE_STATUSES = new Set(['anchored', 'partial', 'binding pending']);

function readText(root, relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

function fileExists(root, relPath) {
  return fs.existsSync(path.join(root, relPath));
}

function loadYaml(root, relPath) {
  return YAML.parse(readText(root, relPath));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function loadFeatureOwners(root) {
  const parsed = loadYaml(root, FUNCTION_MAP_PATH);
  const owners = new Map();
  for (const row of parsed?.owners ?? []) {
    if (!row || typeof row !== 'object') continue;
    const featureId = typeof row.feature_id === 'string' ? row.feature_id : '';
    if (!featureId) continue;
    owners.set(featureId, {
      summary: typeof row.summary === 'string' ? row.summary : '',
      ownerModule: typeof row.owner_module === 'string' ? row.owner_module : '',
    });
  }
  return owners;
}

export function normalizeEdgeStatus(edge) {
  if (edge?.binding_pending === true) return 'binding pending';
  if (typeof edge?.status === 'string') return edge.status.trim();
  return '';
}

function isPendingEdge(edge) {
  return normalizeEdgeStatus(edge) === 'binding pending';
}

function symbolExistsInFile(root, relPath, symbol) {
  const source = readText(root, relPath);
  return new RegExp(`\\b${escapeRegExp(symbol)}\\b`, 'm').test(source);
}

function requireString(failures, where, fieldName, value) {
  if (typeof value !== 'string' || !value.trim()) {
    failures.push(`${where}: missing ${fieldName}`);
    return '';
  }
  return value.trim();
}

function validateSymbolRows(root, failures, where, rows, fieldName) {
  if (!Array.isArray(rows) || rows.length === 0) {
    failures.push(`${where}: missing ${fieldName}`);
    return [];
  }

  const normalized = [];
  for (const [index, row] of rows.entries()) {
    const rowWhere = `${where} ${fieldName}[${index}]`;
    const symbol = requireString(failures, rowWhere, 'symbol', row?.symbol);
    const relPath = requireString(failures, rowWhere, 'file', row?.file);
    if (relPath && !fileExists(root, relPath)) {
      failures.push(`${rowWhere}: missing file ${relPath}`);
    } else if (relPath && symbol && !symbolExistsInFile(root, relPath, symbol)) {
      failures.push(`${rowWhere}: symbol not found in ${relPath}: ${symbol}`);
    }
    normalized.push({ symbol, file: relPath });
  }
  return normalized;
}

export function validateMainlineCallMap(root) {
  const failures = [];
  const parsed = loadYaml(root, MAINLINE_CALL_MAP_PATH);
  const owners = loadFeatureOwners(root);
  const pendingEdgesBySplitBindingId = new Map();

  if (!parsed || typeof parsed !== 'object') {
    failures.push('mainline-call-map parsed to empty/non-object root');
    return { failures, parsed: null, owners };
  }

  if (parsed.version !== 1) failures.push('mainline-call-map: version must be 1');
  if (!Array.isArray(parsed.chains) || parsed.chains.length === 0) {
    failures.push('mainline-call-map: missing chains array');
  }

  for (const chain of parsed.chains ?? []) {
    const chainId = requireString(failures, 'chain', 'chain_id', chain?.chain_id);
    const chainWhere = chainId ? `chain ${chainId}` : 'chain';
    requireString(failures, chainWhere, 'summary', chain?.summary);

    if (!chain?.entry_contract || typeof chain.entry_contract !== 'object') {
      failures.push(`${chainWhere}: missing entry_contract`);
    } else {
      requireString(failures, chainWhere, 'entry_contract.node', chain.entry_contract.node);
      const ownerDoc = requireString(
        failures,
        chainWhere,
        'entry_contract.owner_doc',
        chain.entry_contract.owner_doc
      );
      if (ownerDoc && !fileExists(root, ownerDoc)) {
        failures.push(`${chainWhere}: missing owner_doc file ${ownerDoc}`);
      }
    }

    if (!Array.isArray(chain?.edges) || chain.edges.length === 0) {
      failures.push(`${chainWhere}: missing edges`);
      continue;
    }

    for (const edge of chain.edges) {
      const stepId = requireString(failures, chainWhere, 'step_id', edge?.step_id);
      const edgeWhere = stepId ? `${chainWhere} edge ${stepId}` : `${chainWhere} edge`;
      requireString(failures, edgeWhere, 'from_node', edge?.from_node);
      requireString(failures, edgeWhere, 'to_node', edge?.to_node);

      const status = normalizeEdgeStatus(edge);
      if (!EDGE_STATUSES.has(status)) {
        failures.push(`${edgeWhere}: invalid status ${JSON.stringify(status)}`);
      }

      const pending = isPendingEdge(edge);
      const ownerFeatureId = requireString(
        failures,
        edgeWhere,
        'owner_feature_id',
        edge?.owner_feature_id
      );
      requireString(failures, edgeWhere, 'semantic_input', edge?.semantic_input);
      requireString(failures, edgeWhere, 'semantic_output', edge?.semantic_output);

      if (!pending && ownerFeatureId !== 'binding pending' && !owners.has(ownerFeatureId)) {
        failures.push(`${edgeWhere}: owner_feature_id not found in function-map: ${ownerFeatureId}`);
      }

      if (pending) {
        const splitBindingId =
          typeof edge?.split_binding_id === 'string' ? edge.split_binding_id.trim() : '';
        if (splitBindingId) {
          const refs = pendingEdgesBySplitBindingId.get(splitBindingId) ?? [];
          refs.push({
            chainId,
            stepId,
            fromNode: edge?.from_node ?? '',
            toNode: edge?.to_node ?? '',
          });
          pendingEdgesBySplitBindingId.set(splitBindingId, refs);
        }
        requireString(failures, edgeWhere, 'note', edge?.note);
        continue;
      }

      const callerSymbol = requireString(failures, edgeWhere, 'caller_symbol', edge?.caller_symbol);
      const callerFile = requireString(failures, edgeWhere, 'caller_file', edge?.caller_file);
      const calleeSymbol = requireString(failures, edgeWhere, 'callee_symbol', edge?.callee_symbol);
      const calleeFile = requireString(failures, edgeWhere, 'callee_file', edge?.callee_file);

      for (const [kind, relPath, symbol] of [
        ['caller', callerFile, callerSymbol],
        ['callee', calleeFile, calleeSymbol],
      ]) {
        if (!relPath) continue;
        if (!fileExists(root, relPath)) {
          failures.push(`${edgeWhere}: missing ${kind}_file ${relPath}`);
          continue;
        }
        if (symbol && !symbolExistsInFile(root, relPath, symbol)) {
          failures.push(`${edgeWhere}: ${kind}_symbol not found in ${relPath}: ${symbol}`);
        }
      }
    }
  }

  const splitBindingIds = new Set();
  for (const split of parsed.split_bindings ?? []) {
    const bindingId = requireString(failures, 'split_bindings', 'binding_id', split?.binding_id);
    const where = bindingId ? `split binding ${bindingId}` : 'split binding';
    if (bindingId) {
      if (splitBindingIds.has(bindingId)) {
        failures.push(`${where}: duplicate binding_id`);
      }
      splitBindingIds.add(bindingId);
    }

    const fromNode = requireString(failures, where, 'from_node', split?.from_node);
    const toNode = requireString(failures, where, 'to_node', split?.to_node);
    const ownerFeatureId =
      typeof split?.owner_feature_id === 'string' ? split.owner_feature_id.trim() : '';
    requireString(failures, where, 'note', split?.note);
    if (ownerFeatureId && !owners.has(ownerFeatureId)) {
      failures.push(`${where}: owner_feature_id not found in function-map: ${ownerFeatureId}`);
    }

    validateSymbolRows(root, failures, where, split?.runtime_symbols, 'runtime_symbols');
    validateSymbolRows(root, failures, where, split?.typed_symbols, 'typed_symbols');

    const linkedEdges = bindingId ? (pendingEdgesBySplitBindingId.get(bindingId) ?? []) : [];
    if (bindingId && linkedEdges.length === 0) {
      failures.push(`${where}: no binding pending edge references this split_binding_id`);
      continue;
    }
    for (const edge of linkedEdges) {
      if (edge.fromNode !== fromNode || edge.toNode !== toNode) {
        failures.push(
          `${where}: linked pending edge ${edge.chainId}/${edge.stepId} transition ${edge.fromNode} -> ${edge.toNode} does not match split binding transition ${fromNode} -> ${toNode}`
        );
      }
    }
  }

  for (const [bindingId, edges] of pendingEdgesBySplitBindingId.entries()) {
    if (!splitBindingIds.has(bindingId)) {
      for (const edge of edges) {
        failures.push(
          `chain ${edge.chainId} edge ${edge.stepId}: split_binding_id not found in split_bindings: ${bindingId}`
        );
      }
    }
  }

  for (const shared of parsed.shared_multi_reference_functions ?? []) {
    const functionId = requireString(
      failures,
      'shared_multi_reference_functions',
      'function_id',
      shared?.function_id
    );
    const where = functionId ? `shared function ${functionId}` : 'shared function';
    const symbol = requireString(failures, where, 'symbol', shared?.symbol);
    const relPath = requireString(failures, where, 'file', shared?.file);
    requireString(failures, where, 'owner_feature_id', shared?.owner_feature_id);
    if (relPath && !fileExists(root, relPath)) {
      failures.push(`${where}: missing file ${relPath}`);
    } else if (relPath && symbol && !symbolExistsInFile(root, relPath, symbol)) {
      failures.push(`${where}: symbol not found in ${relPath}: ${symbol}`);
    }
  }

  return { failures, parsed, owners };
}

function toMermaidEdge(stepId, fromNode, toNode, status) {
  const edgeShape = status === 'partial' ? '-.->' : '-->';
  return `${fromNode} ${edgeShape}|${stepId}| ${toNode}`;
}

function statusClass(status) {
  if (status === 'partial') return 'partial';
  if (status === 'binding pending') return 'pending';
  return 'anchored';
}

function renderMermaidChain(chain) {
  const lines = ['```mermaid', 'flowchart LR'];
  const nodeIds = new Set();
  const nodeClass = new Map();

  for (const edge of chain.edges ?? []) {
    nodeIds.add(edge.from_node);
    nodeIds.add(edge.to_node);
    const status = normalizeEdgeStatus(edge);
    lines.push(`  ${toMermaidEdge(edge.step_id, edge.from_node, edge.to_node, status)}`);
    for (const nodeId of [edge.from_node, edge.to_node]) {
      const nextClass = statusClass(status);
      if (!nodeClass.has(nodeId) || nodeClass.get(nodeId) === 'anchored') {
        nodeClass.set(nodeId, nextClass);
      } else if (nodeClass.get(nodeId) === 'partial' && nextClass === 'pending') {
        nodeClass.set(nodeId, nextClass);
      }
    }
  }

  for (const nodeId of nodeIds) {
    lines.splice(2, 0, `  ${nodeId}["${nodeId}"]`);
  }

  lines.push('  classDef anchored fill:#edf7ed,stroke:#2e7d32,stroke-width:1px,color:#1b1f23;');
  lines.push('  classDef partial fill:#fff7e6,stroke:#b26a00,stroke-width:1px,color:#1b1f23;');
  lines.push('  classDef pending fill:#f4f4f5,stroke:#6b7280,stroke-width:1px,stroke-dasharray: 5 5,color:#1b1f23;');

  for (const [nodeId, className] of nodeClass.entries()) {
    lines.push(`  class ${nodeId} ${className};`);
  }

  lines.push('```');
  return lines.join('\n');
}

function renderEdgeTable(chain, owners) {
  const lines = [
    '| step | transition | status | caller -> callee | split binding | owner |',
    '| --- | --- | --- | --- | --- | --- |',
  ];

  for (const edge of chain.edges ?? []) {
    const status = normalizeEdgeStatus(edge);
    const transition = `\`${edge.from_node} -> ${edge.to_node}\``;
    const binding = isPendingEdge(edge)
      ? '`binding pending`'
      : `\`${edge.caller_symbol} -> ${edge.callee_symbol}\``;
    const splitBinding =
      isPendingEdge(edge) && typeof edge.split_binding_id === 'string' && edge.split_binding_id.trim()
        ? `\`${edge.split_binding_id.trim()}\``
        : '';
    const owner = (() => {
      const featureId = edge.owner_feature_id ?? 'binding pending';
      const ownerInfo = owners.get(featureId);
      if (!ownerInfo?.summary) return `\`${featureId}\``;
      return `\`${featureId}\`<br/>${ownerInfo.summary}`;
    })();
    lines.push(`| ${edge.step_id} | ${transition} | ${status} | ${binding} | ${splitBinding} | ${owner} |`);
  }

  return lines.join('\n');
}

export function renderMainlineCallGraphMarkdown(root) {
  const { failures, parsed, owners } = validateMainlineCallMap(root);
  if (failures.length > 0) {
    throw new Error(`cannot render mainline graph with invalid map:\n- ${failures.join('\n- ')}`);
  }

  const lines = [
    '<!-- AUTO-GENERATED: do not edit by hand. Rebuild with `npm run render:architecture-mainline-mermaid`. -->',
    '# Mainline Call Graph',
    '',
    'Source of truth:',
    `- \`${MAINLINE_CALL_MAP_PATH}\` defines request/response/error edges`,
    `- \`${FUNCTION_MAP_PATH}\` enriches owner summary and owner module context`,
    '',
    'Render rules:',
    '- Mermaid page is a render artifact, not a second architecture truth source.',
    '- `anchored` = verified caller/callee binding',
    '- `partial` = edge is bound, but only part of the transition is concretely anchored',
    '- `binding pending` = edge intentionally left unresolved until code audit pins the real bridge',
    '',
  ];

  for (const chain of parsed.chains ?? []) {
    lines.push(`## ${chain.chain_id}`);
    lines.push('');
    lines.push(chain.summary);
    lines.push('');
    lines.push(`Entry contract: \`${chain.entry_contract.node}\` via \`${chain.entry_contract.owner_doc}\``);
    lines.push('');
    lines.push(renderMermaidChain(chain));
    lines.push('');
    lines.push(renderEdgeTable(chain, owners));
    lines.push('');
  }

  if (Array.isArray(parsed.shared_multi_reference_functions) && parsed.shared_multi_reference_functions.length > 0) {
    lines.push('## Shared Multi-Reference Functions');
    lines.push('');
    lines.push('| function_id | symbol | owner | note |');
    lines.push('| --- | --- | --- | --- |');
    for (const row of parsed.shared_multi_reference_functions) {
      const ownerInfo = owners.get(row.owner_feature_id);
      const owner =
        ownerInfo?.summary
          ? `\`${row.owner_feature_id}\`<br/>${ownerInfo.summary}`
          : `\`${row.owner_feature_id}\``;
      lines.push(`| ${row.function_id} | \`${row.symbol}\` | ${owner} | ${row.note ?? ''} |`);
    }
    lines.push('');
  }

  if (Array.isArray(parsed.split_bindings) && parsed.split_bindings.length > 0) {
    lines.push('## Split Bindings');
    lines.push('');
    lines.push('These records explain why some mainline edges intentionally stay `binding pending`.');
    lines.push('Use them when runtime orchestration and typed contract builders are separate layers.');
    lines.push('');
    lines.push('| binding_id | transition | owner | runtime symbols | typed symbols | note |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const row of parsed.split_bindings) {
      const ownerInfo =
        typeof row.owner_feature_id === 'string' ? owners.get(row.owner_feature_id) : undefined;
      const owner =
        typeof row.owner_feature_id === 'string' && row.owner_feature_id.trim()
          ? ownerInfo?.summary
            ? `\`${row.owner_feature_id}\`<br/>${ownerInfo.summary}`
            : `\`${row.owner_feature_id}\``
          : '';
      const runtimeSymbols = Array.isArray(row.runtime_symbols)
        ? row.runtime_symbols
            .map((entry) => `\`${entry.symbol}\``)
            .join('<br/>')
        : '';
      const typedSymbols = Array.isArray(row.typed_symbols)
        ? row.typed_symbols
            .map((entry) => `\`${entry.symbol}\``)
            .join('<br/>')
        : '';
      lines.push(
        `| ${row.binding_id} | \`${row.from_node} -> ${row.to_node}\` | ${owner} | ${runtimeSymbols} | ${typedSymbols} | ${row.note ?? ''} |`
      );
    }
    lines.push('');
  }

  if (Array.isArray(parsed.maintenance_rules) && parsed.maintenance_rules.length > 0) {
    lines.push('## Maintenance Rules');
    lines.push('');
    for (const rule of parsed.maintenance_rules) {
      lines.push(`- ${rule}`);
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}
