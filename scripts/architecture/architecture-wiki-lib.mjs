import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import {
  FUNCTION_MAP_PATH,
  MAINLINE_WIKI_PATH,
  renderMainlineCallGraphMarkdown,
  renderMainlineChainMarkdown,
} from './mainline-call-map-lib.mjs';

export const WIKI_ROOT = 'docs/architecture/wiki';

export const GENERATED_WIKI_PAGES = [
  {
    kind: 'mainline-index',
    path: MAINLINE_WIKI_PATH,
  },
  {
    kind: 'mainline-chain',
    chainId: 'request.mainline',
    title: 'Request Mainline Call Graph',
    path: `${WIKI_ROOT}/request-mainline-call-graph.md`,
  },
  {
    kind: 'mainline-chain',
    chainId: 'response.mainline',
    title: 'Response Mainline Call Graph',
    path: `${WIKI_ROOT}/response-mainline-call-graph.md`,
  },
  {
    kind: 'mainline-chain',
    chainId: 'error.mainline',
    title: 'Error Mainline Call Graph',
    path: `${WIKI_ROOT}/error-mainline-call-graph.md`,
  },
  {
    kind: 'mainline-chain',
    chainId: 'runtime.lifecycle.mainline',
    title: 'Runtime Lifecycle Call Graph',
    path: `${WIKI_ROOT}/runtime-lifecycle-call-graph.md`,
  },
  {
    kind: 'feature-group',
    title: 'Servertool Ownership Map',
    path: `${WIKI_ROOT}/servertool-ownership-map.md`,
    heading: 'hub.servertool_*',
    purpose:
      '把 servertool 的 owner、验证栈、允许修改路径、禁止修改路径集中成一页，避免在 followup/CLI/stopless/backend-route 多文件里改错层。',
    filters: ['hub.servertool_'],
    relatedDocs: [
      'docs/architecture/function-map.yml',
      'docs/architecture/verification-map.yml',
      'docs/design/pipeline-type-topology-and-module-boundaries.md',
    ],
  },
  {
    kind: 'feature-group',
    title: 'Virtual Router Ownership Map',
    path: `${WIKI_ROOT}/virtual-router-ownership-map.md`,
    heading: 'vr.* / virtual_router.*',
    purpose:
      '把 Virtual Router 相关 owner、选择边界、forwarder/runtime 入口、验证栈集中成一页，避免把 VR 语义误改到 executor/provider/handler。',
    filters: ['vr.', 'virtual_router.'],
    relatedDocs: [
      'docs/architecture/function-map.yml',
      'docs/architecture/verification-map.yml',
      'docs/design/pipeline-type-topology-and-module-boundaries.md',
    ],
  },
];

function readText(root, relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

function loadFunctionMap(root) {
  return YAML.parse(readText(root, FUNCTION_MAP_PATH));
}

function renderList(rows) {
  return Array.isArray(rows) && rows.length > 0
    ? rows.map((row) => `- \`${row}\``).join('\n')
    : '- none';
}

function renderFeatureGroupMarkdown(root, page) {
  const parsed = loadFunctionMap(root);
  const rows = (parsed?.owners ?? []).filter((row) =>
    page.filters.some((prefix) => typeof row?.feature_id === 'string' && row.feature_id.startsWith(prefix))
  );

  const lines = [
    '<!-- AUTO-GENERATED: do not edit by hand. Rebuild with `node scripts/architecture/render-architecture-wiki-pages.mjs`. -->',
    `# ${page.title}`,
    '',
    page.purpose,
    '',
    'Source of truth:',
    `- \`${FUNCTION_MAP_PATH}\` defines owner, builders, paths, and gates`,
    ...(page.relatedDocs ?? []).map((doc) => `- \`${doc}\``),
    '',
    `Feature scope: \`${page.heading}\``,
    '',
    '| feature_id | summary | owner kind | owner module | required gates |',
    '| --- | --- | --- | --- | --- |',
  ];

  for (const row of rows) {
    const gates = Array.isArray(row.required_gates)
      ? row.required_gates.map((item) => `\`${item}\``).join('<br/>')
      : '';
    lines.push(
      `| \`${row.feature_id}\` | ${row.summary ?? ''} | \`${row.owner_kind ?? ''}\` | \`${row.owner_module ?? ''}\` | ${gates} |`
    );
  }

  for (const row of rows) {
    lines.push('');
    lines.push(`## ${row.feature_id}`);
    lines.push('');
    lines.push(`Summary: ${row.summary ?? ''}`);
    lines.push('');
    lines.push(`Owner kind: \`${row.owner_kind ?? ''}\``);
    lines.push(`Owner module: \`${row.owner_module ?? ''}\``);
    lines.push(`Owner scope: ${row.owner_scope ?? ''}`);
    lines.push('');
    lines.push('Canonical types:');
    lines.push(renderList(row.canonical_types));
    lines.push('');
    lines.push('Canonical builders:');
    lines.push(renderList(row.canonical_builders));
    lines.push('');
    lines.push('Allowed paths:');
    lines.push(renderList(row.allowed_paths));
    lines.push('');
    lines.push('Forbidden paths:');
    lines.push(renderList(row.forbidden_paths));
    lines.push('');
    lines.push('Required tests:');
    lines.push(renderList(row.required_tests));
    lines.push('');
    lines.push('Required gates:');
    lines.push(renderList(row.required_gates));
    if (Array.isArray(row.notes) && row.notes.length > 0) {
      lines.push('');
      lines.push('Notes:');
      lines.push(row.notes.map((note) => `- ${note}`).join('\n'));
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

export function renderGeneratedWikiPages(root) {
  const outputs = new Map();
  for (const page of GENERATED_WIKI_PAGES) {
    let content = '';
    if (page.kind === 'mainline-index') {
      content = renderMainlineCallGraphMarkdown(root);
    } else if (page.kind === 'mainline-chain') {
      content = renderMainlineChainMarkdown(root, page.chainId, { title: page.title });
    } else if (page.kind === 'feature-group') {
      content = renderFeatureGroupMarkdown(root, page);
    } else {
      throw new Error(`unknown wiki page kind: ${page.kind}`);
    }
    outputs.set(page.path, content);
  }
  return outputs;
}
