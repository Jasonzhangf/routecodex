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

export const MANUAL_WIKI_PAGES = [
  {
    path: `${WIKI_ROOT}/stopless-session-mainline-source.md`,
    title: '# Stopless Session Mainline Source',
    minMermaidBlocks: 1,
    requiredTokens: [
      '## Purpose',
      '## Stopless Session Mainline',
      '## Edge Owners and Current Status',
      '## Active Gaps',
      'stopless-gap-03',
      'stopless-gap-04',
      'stopless-gap-05',
    ],
  },
  {
    path: `${WIKI_ROOT}/internal-error-numbering-mainline-source.md`,
    title: '# Internal Error Numbering Mainline Source',
    minMermaidBlocks: 1,
    requiredTokens: [
      '## Purpose',
      '## Main Rule',
      '## Numbering Contract',
      '## Internal Error Numbering Mainline',
      '## Node Contract',
      '## Extension Checklist',
      '## Review Checklist',
      'IntErrNum01SourceObserved',
      'IntErrNum07ClientBoundaryPreserved',
      'ExternalErrorLink',
    ],
  },
  {
    path: `${WIKI_ROOT}/metadata-boundary-map.md`,
    title: '# Metadata Boundary Map',
    minMermaidBlocks: 2,
    requiredTokens: [
      'Canonical sources:',
      '## Main Rule',
      '## Scope Keys',
      '## Request / Response Flow',
      '## Metadata Consumers',
      '## Mapping Gaps / Review Findings',
      'meta-gap-01',
    ],
  },
  {
    path: `${WIKI_ROOT}/metadata-center-mainline-source.md`,
    title: '# Metadata Center Mainline Source',
    minMermaidBlocks: 1,
    requiredTokens: [
      '## Purpose',
      '## Metadata Center Mainline',
      '## Stage Owners and Target Families',
      '## Family Definitions',
      '## Provenance Contract',
      '## Current Structural Problems This Page Is Meant To Eliminate',
      '## Migration Order',
      '## Review Checklist',
    ],
  },
  {
    path: `${WIKI_ROOT}/chat-process-protocol-mapping.md`,
    title: '# Chat Process Protocol Mapping',
    minMermaidBlocks: 3,
    requiredTokens: [
      'Canonical sources:',
      '## Main Rule',
      '## Request-Side Semantic Mapping',
      '## Response-Side Semantic Mapping',
      '## Field-Level Mapping Matrix',
      '## Mapping Gaps / Review Findings',
      'map-gap-01',
    ],
  },
  {
    path: `${WIKI_ROOT}/server-responses-sse-bridge-map.md`,
    title: '# Server Responses SSE Bridge Map',
    minMermaidBlocks: 1,
    requiredTokens: [
      'Canonical sources:',
      '## Main Rule',
      '## Surface Flow',
      '## Owner Matrix',
      '## JSON / SSE Equality Matrix',
      '## Gaps / Review Findings',
      'sse-gap-01',
    ],
  },
  {
    path: `${WIKI_ROOT}/responses-direct-relay-map.md`,
    title: '# Responses Direct Relay Map',
    minMermaidBlocks: 3,
    requiredTokens: [
      'Canonical sources:',
      '## Main Rule',
      '## Ownership Flow',
      '## Entry Matrix',
      '## Direct vs Relay Ownership',
      '## Three-key Isolation',
      '## Legal and Illegal Paths',
      '## Review Findings',
      'direct-relay-gap-01',
      '__shadowCompareForcedProviderKey',
    ],
  },
  {
    path: `${WIKI_ROOT}/direct-semantic-classification-mainline.md`,
    title: '# Direct Semantic Classification Mainline',
    minMermaidBlocks: 1,
    requiredTokens: [
      'Canonical sources:',
      '## Flow',
      '## Classification Matrix',
      '## Layer Matrix',
      '## Forbidden Shortcuts',
      '## Current State',
      '## Review Checklist',
      'ConfigDirect01AuthoringPolicy',
      'VrDirect03ResolvedSemantics',
      'DirectReq04ProjectionPlan',
      'DirectResp05ProjectionPlan',
      'anchored to real Rust caller/callee symbols',
    ],
  },
  {
    path: `${WIKI_ROOT}/servertool-followup-call-graph.md`,
    title: '# Servertool Followup Call Graph',
    minMermaidBlocks: 3,
    requiredTokens: [
      'Canonical sources:',
      '## Main Rule',
      '## Mainline',
      '## Node Boundary',
      '## Branch Split',
      '## Owner Matrix',
      '## Followup vs CLI',
      '## Stopless Branch',
      '## Review Findings',
      'followup-gap-01',
      'HubRespChatProcess03Governed',
      'ServertoolReq04FollowupBuilt',
    ],
  },
  {
    path: `${WIKI_ROOT}/topology-residual-node-review.md`,
    title: '# Topology Residual Node Review',
    minMermaidBlocks: 1,
    requiredTokens: [
      '## Purpose',
      '## Main Rule',
      '## Residual Topology Surface',
      '## Node Matrix',
      '## Owner Matrix',
      '## Review Findings',
      'topology-residual-gap-01',
      'ServerReqInbound02PipelineInput',
      'ProviderReqOutbound08TransportSigned',
      'MetaResp04SameRequestCarrier',
    ],
  },
  {
    path: `${WIKI_ROOT}/hub-pipeline-rust-reference-closeout.md`,
    title: '# Hub Pipeline Rust Reference Closeout',
    minMermaidBlocks: 1,
    requiredTokens: [
      '## Purpose',
      '## Main Rule',
      '## Reference Flow',
      '## Classification Matrix',
      '## Owner Matrix',
      '## Active Claim Boundary',
      '## Review Findings',
      'hub-rust-ref-gap-01',
      'verify:hub-pipeline-native-reference-gate',
    ],
  },
  {
    path: `${WIKI_ROOT}/v3-openai-chat-relay-controlled-runtime.md`,
    title: '# V3 OpenAI Chat Relay Controlled Runtime',
    minMermaidBlocks: 1,
    requiredTokens: [
      '## Status',
      '## Single lifecycle',
      '## JSON, SSE, error, isolation',
      '## Ownership checklist',
      '## Required gates',
      'v3.openai_chat_relay_runtime_integration',
      'Body::from_stream',
      'Live provider compatibility',
    ],
  },
  {
    path: `${WIKI_ROOT}/v3-gemini-relay-controlled-runtime.md`,
    title: '# V3 Gemini Relay Controlled Runtime',
    minMermaidBlocks: 1,
    requiredTokens: [
      '## Status',
      '## Single lifecycle',
      '## JSON, SSE, error, isolation',
      '## Ownership checklist',
      '## Required gates',
      'v3.gemini_relay_runtime_integration',
      'Body::from_stream',
      'Live Gemini provider compatibility',
    ],
  },
  {
    path: `${WIKI_ROOT}/v3-entry-protocol-endpoint-binding.md`,
    title: '# V3 Entry Protocol Endpoint Binding',
    minMermaidBlocks: 1,
    requiredTokens: [
      '## Purpose',
      '## Main Rule',
      '## Binding Matrix',
      '## Mainline',
      '## Review Checklist',
      '## Current Integration Boundary',
      'v3.entry_protocol_endpoint_binding',
      'v3-entry-bind-01',
      'Gemini relay implemented',
      'live/global/prod not claimed',
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

export function verifyManualWikiPages(root) {
  const failures = [];
  for (const page of MANUAL_WIKI_PAGES) {
    const absPath = path.join(root, page.path);
    if (!fs.existsSync(absPath)) {
      failures.push(`missing manual wiki page: ${page.path}`);
      continue;
    }
    const current = fs.readFileSync(absPath, 'utf8');
    if (!current.includes(page.title)) {
      failures.push(`${page.path}: missing title ${page.title}`);
    }
    const mermaidCount = (current.match(/```mermaid/g) ?? []).length;
    if (mermaidCount < (page.minMermaidBlocks ?? 1)) {
      failures.push(
        `${page.path}: expected at least ${page.minMermaidBlocks ?? 1} mermaid blocks, found ${mermaidCount}`
      );
    }
    for (const token of page.requiredTokens ?? []) {
      if (!current.includes(token)) {
        failures.push(`${page.path}: missing required token ${token}`);
      }
    }
  }
  return failures;
}
