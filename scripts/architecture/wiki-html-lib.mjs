import fs from 'node:fs';
import path from 'node:path';
import { GENERATED_WIKI_PAGES, MANUAL_WIKI_PAGES, WIKI_ROOT } from './architecture-wiki-lib.mjs';
import {
  loadV3ArchitectureAuditLocks,
  loadV3MainlineCallMap,
  renderV3MainlineCallerFlowHtml,
  V3_CALLER_FLOW_PATH,
  V3_MAINLINE_SKELETON_SOP_PATH,
} from './v3-mainline-caller-flow-lib.mjs';
import {
  renderV3Req04ToolGovernanceReviewHtml,
  V3_REQ04_TOOL_GOVERNANCE_REVIEW_PATH,
} from './v3-req04-tool-governance-review-lib.mjs';

export const WIKI_HTML_ROOT = `${WIKI_ROOT}/html`;

export const MERMAID_SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js';


const V3_ENTRY_PROTOCOL_ENDPOINT_BINDING_PATH = 'docs/architecture/wiki/v3-entry-protocol-endpoint-binding.md';
const V3_CONFIG_COMPACT_HUB_V1_DEFAULTS_SOP_PATH = 'docs/architecture/wiki/v3-config-compact-hub-v1-defaults-sop.md';
const V3_OPENAI_CHAT_RELAY_CONTROLLED_RUNTIME_PATH = 'docs/architecture/wiki/v3-openai-chat-relay-controlled-runtime.md';
const V3_GEMINI_RELAY_CONTROLLED_RUNTIME_PATH = 'docs/architecture/wiki/v3-gemini-relay-controlled-runtime.md';
const V3_PROTOCOL_NORMALIZATION_TOOL_GOVERNANCE_BOUNDARY_PATH = 'docs/architecture/wiki/v3-protocol-normalization-tool-governance-boundary.md';

const V3_DEDICATED_REVIEW_SURFACES = new Map([
  [V3_CONFIG_COMPACT_HUB_V1_DEFAULTS_SOP_PATH, {
    id: 'v3-config-compact-hub-v1-defaults-sop',
    eyebrow: 'config compiler review · audited lock',
    title: 'V3 Compact Hub V1 Defaults SOP Review',
    summary: 'Locks compact user authoring to one Rust config compiler path. Fixed Hub endpoint, hook, resource, and execution declarations are derived before Manifest publication and cannot be rebuilt by Runtime, Server, Provider, Virtual Router, Target, or Compat.',
    requestTitle: 'Compact authoring compile flow',
    responseTitle: 'Published Manifest consumption boundary',
    requestEdges: [
      ['V3Config02AuthoringParsed', 'V3HubV1CompactAuthoringAccepted', 'v3-cfg-compact-01 parse compact declaration'],
      ['V3HubV1CompactAuthoringAccepted', 'V3Config03SchemaValidated', 'v3-cfg-compact-02 derive Hub V1 defaults'],
      ['V3HubV1CompactAuthoringAccepted', 'V3Config03SchemaValidated', 'v3-cfg-compact-03 derive server execution defaults'],
      ['V3Config03SchemaValidated', 'V3Config05ManifestPublished', 'v3-cfg-compact-04 publish deterministic Manifest'],
    ],
    responseEdges: [
      ['V3Config05ManifestPublished', 'V3 Runtime / Server consumers', 'consume compiled declarations only'],
      ['Source config files', 'routecodex-v3-config only', 'single file IO and default owner'],
      ['Runtime / Server / Provider / Compat', 'Forbidden default writer', 'must not rebuild fixed Hub V1 defaults'],
    ],
    logicCards: [
      ['Compact authoring is intentional', 'Users declare pipeline identity and business routing/provider choices without listing fixed Hub hook/resource lifecycle internals.'],
      ['Config compiler is the sole default owner', 'default_hub_v1_authoring and default_server_execution live only in routecodex-v3-config and materialize before Manifest publication.'],
      ['Manifest is the runtime truth', 'Runtime and Server consume V3Config05ManifestPublished; source config reads or local default reconstruction are architecture violations.'],
    ],
    resources: [
      ['v3.config.authoring_parsed', 'routecodex-v3-config', 'Compact source declaration after parse.'],
      ['v3.config.hub_pipeline_declarations', 'routecodex-v3-config', 'Closed fixed Hub V1 endpoints, hooks, resources, and execution declarations.'],
      ['v3.config.published_manifest', 'routecodex-v3-config', 'Only runtime/server configuration truth.'],
    ],
    checklist: ['Compact TOML compiles to the closed deterministic Manifest', 'V2 compat uses the same default owner', 'No default writer exists outside routecodex-v3-config', 'Locked fingerprint changes require Jason manual authorization'],
  }],
  [V3_ENTRY_PROTOCOL_ENDPOINT_BINDING_PATH, {
    id: 'v3-entry-protocol-endpoint-binding',
    eyebrow: 'entry protocol review · dedicated surface',
    title: 'V3 Entry Protocol Endpoint Binding Review',
    summary: 'Locks HTTP endpoint → entry protocol → execution mode → owner before Server dispatch. This page is a review surface for dispatch ownership only; runtime/provider behavior remains in the selected owner.',
    requestTitle: 'Endpoint binding request flow',
    responseTitle: 'Dispatch / response ownership boundary',
    requestEdges: [
      ['Client HTTP request', 'V3Server03HttpRequestRaw', 'server captures method/path/body facts'],
      ['V3Server03HttpRequestRaw', 'V3EntryProtocolBindingRegistry', 'lookup endpoint pattern'],
      ['V3EntryProtocolBindingRegistry', 'V3EntryBind04ExecutionBindingProjected', 'resolve protocol/mode/owner'],
      ['V3EntryBind04ExecutionBindingProjected', 'Runtime owner entry', 'dispatch only after binding is known'],
    ],
    responseEdges: [
      ['Runtime owner output', 'V3ServerRespOutbound06ClientFrame', 'server transports typed output'],
      ['Error owner output', 'V3Error06ClientProjected', 'invalid method/path/content-type uses Error01-06'],
    ],
    logicCards: [
      ['Binding registry is the entry truth', 'Endpoint pattern, protocol, execution mode, implementation status, and owner must be known before dispatch.'],
      ['Server is not protocol runtime', 'Server consumes binding and transports output; it must not infer provider/request/response semantics from raw paths.'],
      ['Live cutover is separate', 'This page does not claim credentials, provider availability, install, restart, or production cutover.'],
    ],
    resources: [
      ['v3.entry_protocol.binding_registry', 'v3-config manifest / server reader', 'Entry protocol ownership; no provider/client normal payload.'],
      ['v3.server.endpoint_binding_projection', 'routecodex-v3-server', 'Dispatch projection only; no response governance.'],
      ['v3.error.chain', 'routecodex-v3-error', 'Invalid entry failures enter Error01-06.'],
    ],
    checklist: ['Endpoint has one protocol owner', 'Execution mode is known before dispatch', 'Server does not bypass runtime owner', 'Live/global/prod remains unclaimed'],
  }],
  [V3_OPENAI_CHAT_RELAY_CONTROLLED_RUNTIME_PATH, {
    id: 'v3-openai-chat-relay-controlled-runtime',
    eyebrow: 'controlled runtime review · dedicated surface',
    title: 'V3 OpenAI Chat Relay Controlled Runtime Review',
    summary: 'Controlled loopback review for OpenAI Chat Relay. It proves source/runtime wiring, JSON/SSE/error/isolation behavior, and explicit non-claim of live provider cutover.',
    requestTitle: 'OpenAI Chat request lifecycle',
    responseTitle: 'OpenAI Chat response lifecycle',
    requestEdges: [
      ['V3OpenAiChatRelayRuntimeInput', 'V3HubReqInbound01ClientRaw', 'entry owner receives typed input'],
      ['V3HubReqInbound01ClientRaw', 'V3HubReqChatProcess04Governed', 'normalize, classify, restore/govern'],
      ['V3HubReqChatProcess04Governed', 'V3HubReqTarget06Resolved', 'plan and resolve target'],
      ['V3HubReqTarget06Resolved', 'V3ProviderReqOutbound09TransportRequest', 'provider semantic → wire → transport'],
    ],
    responseEdges: [
      ['V3ProviderRespInbound01Raw', 'ProviderRespCompat02ProviderCompat', 'provider compat before Hub parse'],
      ['ProviderRespCompat02ProviderCompat', 'V3HubRespChatProcess03Governed', 'normalize then govern response'],
      ['V3HubRespChatProcess03Governed', 'V3HubRespOutbound05ClientSemantic', 'save continuation then project client semantic'],
      ['V3HubRespOutbound05ClientSemantic', 'V3ServerRespOutbound06ClientFrame', 'Body::from_stream / JSON body transport only'],
    ],
    logicCards: [
      ['Runtime owns protocol lifecycle', 'OpenAI Chat request/response protocol handling stays in Rust runtime/codec owners, not Server or SSE.'],
      ['SSE stays streaming transport', 'Controlled SSE evidence proves first frame does not wait for terminal and no full-stream materialization.'],
      ['Error and isolation are explicit', 'Provider failure enters Error01-06; metadata_center never enters provider/client normal payload.'],
    ],
    resources: [
      ['v3.openai_chat.client_sse_stream', 'V3HubRespOutbound05ClientSemantic', 'Client SSE stream projection before server frame.'],
      ['v3.response.provider_raw', 'provider response runtime', 'Raw provider truth before compat/inbound.'],
      ['v3.error.chain', 'routecodex-v3-error', 'Controlled 429/error path.'],
    ],
    checklist: ['Req01-Req09 and Resp01-Resp06 only', 'No raw SSE body collection', 'No server-side Chat semantic parsing', 'Live provider replay remains pending'],
  }],
  [V3_GEMINI_RELAY_CONTROLLED_RUNTIME_PATH, {
    id: 'v3-gemini-relay-controlled-runtime',
    eyebrow: 'controlled runtime review · dedicated surface',
    title: 'V3 Gemini Relay Controlled Runtime Review',
    summary: 'Controlled loopback review for Gemini Relay. It proves endpoint binding, Gemini protocol runtime ownership, JSON/SSE/error/isolation behavior, and explicit non-claim of live production cutover.',
    requestTitle: 'Gemini request lifecycle',
    responseTitle: 'Gemini response lifecycle',
    requestEdges: [
      ['Client Gemini endpoint', 'V3EntryProtocolBindingRegistry', 'dynamic endpoint classified as gemini'],
      ['V3GeminiRelayRuntimeInput', 'V3HubReqChatProcess04Governed', 'entry normalization, continuation, tool governance'],
      ['V3HubReqChatProcess04Governed', 'V3HubReqOutbound07ProviderSemantic', 'Hub semantic to Gemini provider semantic'],
      ['V3HubReqOutbound07ProviderSemantic', 'V3ProviderReqOutbound09TransportRequest', 'Gemini wire URL/body transport'],
    ],
    responseEdges: [
      ['V3ProviderRespInbound01Raw', 'ProviderRespCompat02ProviderCompat', 'provider compat before Hub parse'],
      ['ProviderRespCompat02ProviderCompat', 'V3HubRespChatProcess03Governed', 'candidate/functionCall/finishReason governance owner'],
      ['V3HubRespChatProcess03Governed', 'V3HubRespOutbound05ClientSemantic', 'save then project client semantic'],
      ['V3HubRespOutbound05ClientSemantic', 'V3ServerRespOutbound06ClientFrame', 'server transports JSON/SSE only'],
    ],
    logicCards: [
      ['Gemini codec owns Gemini semantics', 'URL/model, candidates, functionCall, finishReason, and stream terminal rules stay in Gemini codec/runtime.'],
      ['Server consumes binding only', 'Server dispatches to the Gemini runtime owner and transports typed output; it does not parse Gemini response semantics.'],
      ['Malformed streams fail explicitly', 'Malformed JSON, EOF without terminal, and post-terminal frames are provider/runtime errors, not hidden successes.'],
    ],
    resources: [
      ['v3.gemini.client_sse_stream', 'V3HubRespOutbound05ClientSemantic', 'Gemini client SSE stream projection.'],
      ['v3.entry_protocol.binding_registry', 'V3 config/server', 'Gemini endpoint binding.'],
      ['v3.error.chain', 'routecodex-v3-error', 'Controlled provider errors and malformed bodies.'],
    ],
    checklist: ['Gemini relay implemented in config registry', 'No synthetic [DONE]', 'No server-side candidate/functionCall parsing', 'Real Gemini provider remains out of scope'],
  }],
  [V3_PROTOCOL_NORMALIZATION_TOOL_GOVERNANCE_BOUNDARY_PATH, {
    id: 'v3-protocol-normalization-tool-governance-boundary',
    eyebrow: 'normalization boundary review · dedicated surface',
    title: 'V3 Protocol Normalization / Tool Governance Boundary Review',
    summary: 'Locks the boundary that protocol normalization validates and maps adjacent protocols only, while tool identity pairing, uniqueness, servertool, stopless, and continuation semantics stay in Chat Process govern nodes.',
    requestTitle: 'Request normalization vs Req04 governance',
    responseTitle: 'Response normalization vs Resp03 governance',
    requestEdges: [
      ['ServerReqInbound01ClientRaw', 'HubReqInbound02Standardized', 'entry shape normalization only'],
      ['HubReqInbound02Standardized', 'HubReqChatProcess03Governed', 'tool identity pairing and orphan checks'],
      ['HubReqChatProcess03Governed', 'HubReqOutbound05ProviderSemantic', 'governed request to provider semantic'],
      ['HubReqOutbound05ProviderSemantic', 'ProviderReqCompat06ProviderCompat', 'compat only, no tool governance'],
    ],
    responseEdges: [
      ['ProviderRespInbound01Raw', 'ProviderRespCompat02ProviderCompat', 'provider compat only'],
      ['ProviderRespCompat02ProviderCompat', 'HubRespInbound03Parsed', 'response shape normalization only'],
      ['HubRespInbound03Parsed', 'HubRespChatProcess04Governed', 'tool/servertool/stopless governance'],
      ['HubRespChatProcess04Governed', 'HubRespOutbound06ClientSemantic', 'save then project after governance'],
    ],
    logicCards: [
      ['Normalization is not governance', 'Codecs map protocols and preserve invalid tool identity shapes for Chat Process rejection or governance.'],
      ['Compat is not fallback', 'Provider compat nodes perform provider micro-adjustments only; no route, model, tool, or fallback policy.'],
      ['Chat Process owns tool semantics', 'Tool pairing, duplicate identity, orphan output, servertool, stopless, and continuation belong to Req04/Resp03.'],
    ],
    resources: [
      ['v3.hub.tool_governance_truth', 'Req04 / Resp03 Chat Process', 'Tool identity and governance result.'],
      ['v3.protocol_conversion.field_parity_contract', 'verification manifest', 'Field parity matrix and red fixtures.'],
      ['v3.hub.provider_wire_payload', 'ReqOutbound/provider codec', 'Provider-bound field legality after governance.'],
    ],
    checklist: ['OpenAI Chat tool identity preserved through normalization', 'Gemini functionResponse pairing governed at Req04', 'Provider compat nodes do not own fallback or tool governance', 'Resp Chat Process rejects duplicate canonical tool identity'],
  }],
]);

function readText(root, relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function wikiMarkdownPaths() {
  return [
    ...GENERATED_WIKI_PAGES.map((page) => page.path),
    ...MANUAL_WIKI_PAGES.map((page) => page.path),
  ];
}

function htmlPathForMarkdown(relPath) {
  const relativeFromWikiRoot = path.relative(WIKI_ROOT, relPath);
  return path.join(WIKI_HTML_ROOT, relativeFromWikiRoot).replace(/\.md$/u, '.html');
}

function markdownTitle(markdown, fallback) {
  const match = markdown.match(/^#\s+(.+)$/mu);
  return match ? match[1].trim() : fallback;
}

function splitCodeFenceBody(block) {
  const lines = block.split('\n');
  const first = lines.shift() ?? '';
  const info = first.replace(/^```/u, '').trim();
  if (lines.at(-1)?.trim() === '```') {
    lines.pop();
  }
  return {
    info,
    body: lines.join('\n'),
  };
}

function renderInline(text) {
  const escaped = escapeHtml(text);
  return escaped.replace(/`([^`]+)`/gu, '<code>$1</code>');
}

function renderMarkdown(markdown) {
  const lines = markdown.replace(/\r\n/gu, '\n').split('\n');
  const parts = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    if (trimmed.startsWith('<!--')) {
      index += 1;
      continue;
    }

    if (trimmed.startsWith('```')) {
      const fence = [line];
      index += 1;
      while (index < lines.length) {
        fence.push(lines[index]);
        if (lines[index].trim() === '```') {
          index += 1;
          break;
        }
        index += 1;
      }
      const { info, body } = splitCodeFenceBody(fence.join('\n'));
      if (info === 'mermaid') {
        parts.push(`<pre class="mermaid">${escapeHtml(body.trim())}</pre>`);
      } else {
        parts.push(`<pre><code class="language-${escapeHtml(info || 'text')}">${escapeHtml(body)}</code></pre>`);
      }
      continue;
    }

    if (/^#{1,6}\s+/u.test(trimmed)) {
      const level = trimmed.match(/^#+/u)[0].length;
      const text = trimmed.replace(/^#{1,6}\s+/u, '');
      parts.push(`<h${level}>${renderInline(text)}</h${level}>`);
      index += 1;
      continue;
    }

    if (trimmed.startsWith('- ')) {
      const items = [];
      while (index < lines.length && lines[index].trim().startsWith('- ')) {
        items.push(lines[index].trim().slice(2));
        index += 1;
      }
      parts.push(`<ul>\n${items.map((item) => `  <li>${renderInline(item)}</li>`).join('\n')}\n</ul>`);
      continue;
    }

    if (trimmed.startsWith('|')) {
      const tableLines = [];
      while (index < lines.length && lines[index].trim().startsWith('|')) {
        tableLines.push(lines[index].trim());
        index += 1;
      }
      const rows = tableLines
        .filter((row, rowIndex) => !(rowIndex === 1 && /^(\|\s*---)+\|?$/u.test(row.replace(/-+/gu, '---'))))
        .map((row) => row.split('|').slice(1, -1).map((cell) => cell.trim()));
      if (rows.length > 0) {
        const [header, ...body] = rows;
        parts.push('<table>');
        parts.push(`<thead><tr>${header.map((cell) => `<th>${renderInline(cell)}</th>`).join('')}</tr></thead>`);
        parts.push('<tbody>');
        for (const row of body) {
          parts.push(`<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join('')}</tr>`);
        }
        parts.push('</tbody>');
        parts.push('</table>');
      }
      continue;
    }

    const paragraph = [trimmed];
    index += 1;
    while (index < lines.length) {
      const next = lines[index].trim();
      if (!next || next.startsWith('#') || next.startsWith('- ') || next.startsWith('|') || next.startsWith('```') || next.startsWith('<!--')) {
        break;
      }
      paragraph.push(next);
      index += 1;
    }
    parts.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
  }

  return parts.join('\n');
}


const V3_SOP_REVIEW_MARKERS = [
  'data-review-surface="v3-mainline-skeleton-sop"',
  'V3 Mainline Skeleton SOP Review',
  'Separated locked skeleton diagrams',
  'Request skeleton',
  'Response skeleton',
  'Error resources',
  'SSE Edge SOP',
  'Locked chain fingerprints',
  'Change authorization contract',
  'Canonical sources',
  'Request node logic',
  'Response node logic',
  'V3HubReqInbound01ClientRaw',
  'ProviderRespCompat02ProviderCompat',
  'V3ServerRespOutbound06ClientFrame',
];

function v3SopNodeCard(node, title, rule) {
  return `<article class="logic-card">
    <div class="node-card-top"><span>${escapeHtml(node)}</span></div>
    <h3>${escapeHtml(title)}</h3>
    <p>${escapeHtml(rule)}</p>
  </article>`;
}

function v3SopMermaid(kind) {
  if (kind === 'request') {
    return [
      '%%{init: {"flowchart": {"htmlLabels": true, "curve": "basis", "rankSpacing": 105, "nodeSpacing": 65}, "themeVariables": {"fontSize": "20px"}} }%%',
      'flowchart TD',
      '  R0["<b>V3HubReqInbound01ClientRaw</b><br/><small>client raw request / server entry facts only</small>"]',
      '  R1["<b>V3HubReqInbound02Normalized</b><br/><small>non-destructive entry protocol normalization</small>"]',
      '  R2["<b>V3HubReqContinuation03Classified</b><br/><small>entry + owner + scope classification, no payload restore</small>"]',
      '  R3["<b>V3HubReqChatProcess04Governed</b><br/><small>request-side continuation restore and tool governance owner</small>"]',
      '  R4["<b>V3HubReqExecution05Planned</b><br/><small>execution plan only</small>"]',
      '  R5["<b>V3HubReqTarget06Resolved</b><br/><small>target selected, no payload patch</small>"]',
      '  R6["<b>V3HubReqOutbound07ProviderSemantic</b><br/><small>provider semantic envelope</small>"]',
      '  R7["<b>ProviderReqCompat06ProviderCompat</b><br/><small>provider compat boundary</small>"]',
      '  R8["<b>V3ProviderReqOutbound08WirePayload</b><br/><small>provider wire JSON/body</small>"]',
      '  R9["<b>V3ProviderReqOutbound09TransportRequest</b><br/><small>HTTP transport request</small>"]',
      '  R0 -->|server accept| R1 -->|classify continuation owner/scope| R2 -->|restore/govern at Req04| R3 -->|plan| R4 -->|resolve target| R5 -->|build semantic| R6 -->|compat only| R7 -->|wire codec| R8 -->|transport| R9',
      '  classDef node fill:#f8fafc,stroke:#334155,stroke-width:1.6px,color:#0f172a;',
      '  classDef owner fill:#ecfdf5,stroke:#047857,stroke-width:2px,color:#064e3b;',
      '  class R0,R1,R2,R4,R5,R6,R7,R8,R9 node;',
      '  class R3 owner;',
    ].join('\n');
  }
  return [
    '%%{init: {"flowchart": {"htmlLabels": true, "curve": "basis", "rankSpacing": 105, "nodeSpacing": 65}, "themeVariables": {"fontSize": "20px"}} }%%',
    'flowchart TD',
    '  S0["<b>V3ProviderRespInbound01Raw</b><br/><small>provider raw response/event bytes already received</small>"]',
    '  S1["<b>ProviderRespCompat02ProviderCompat</b><br/><small>provider-specific compat before Hub parse</small>"]',
    '  S2["<b>V3HubRespInbound02Normalized</b><br/><small>Hub response semantic input</small>"]',
    '  S3["<b>V3HubRespChatProcess03Governed</b><br/><small>response tool/servertool/stopless governance owner</small>"]',
    '  S4["<b>V3HubRespContinuation04Committed</b><br/><small>continuation save endpoint only</small>"]',
    '  S5["<b>V3HubRespOutbound05ClientSemantic</b><br/><small>client protocol projection only</small>"]',
    '  S6["<b>V3ServerRespOutbound06ClientFrame</b><br/><small>HTTP/SSE frame handoff only</small>"]',
    '  S0 -->|compat first| S1 -->|normalize| S2 -->|govern at Resp03| S3 -->|save only| S4 -->|project| S5 -->|frame/stream| S6',
    '  classDef node fill:#f8fafc,stroke:#334155,stroke-width:1.6px,color:#0f172a;',
    '  classDef owner fill:#ecfdf5,stroke:#047857,stroke-width:2px,color:#064e3b;',
    '  class S0,S1,S2,S4,S5,S6 node;',
    '  class S3 owner;',
  ].join('\n');
}

function v3SopHtmlTable(headers, rows) {
  return `<table><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}


function v3ReviewMermaid(title, edges) {
  const nodes = [];
  const nodeIds = new Map();
  const idFor = (node) => {
    if (!nodeIds.has(node)) {
      const id = `N${nodeIds.size}`;
      nodeIds.set(node, id);
      nodes.push(node);
    }
    return nodeIds.get(node);
  };
  const lines = [
    '%%{init: {"flowchart": {"htmlLabels": true, "curve": "basis", "rankSpacing": 105, "nodeSpacing": 65}, "themeVariables": {"fontSize": "20px"}} }%%',
    'flowchart TD',
    `  title_note["<b>${title}</b><br/><small>generated dedicated review surface</small>"]`,
  ];
  for (const [from, to] of edges) {
    idFor(from);
    idFor(to);
  }
  for (const node of nodes) {
    lines.push(`  ${idFor(node)}["<b>${escapeHtml(node)}</b>"]`);
  }
  if (nodes.length) lines.push(`  title_note --> ${idFor(nodes[0])}`);
  for (const [from, to, label] of edges) {
    lines.push(`  ${idFor(from)} -->|${escapeHtml(label)}| ${idFor(to)}`);
  }
  lines.push('  classDef node fill:#f8fafc,stroke:#334155,stroke-width:1.6px,color:#0f172a;');
  if (nodes.length) lines.push(`  class ${nodes.map((node) => idFor(node)).join(',')} node;`);
  return lines.join('\n');
}

function v3ReviewCard(title, text) {
  return `<article class="logic-card">
    <h3>${escapeHtml(title)}</h3>
    <p>${escapeHtml(text)}</p>
  </article>`;
}

function renderV3DedicatedReviewHtml(root, markdownPath) {
  const cfg = V3_DEDICATED_REVIEW_SURFACES.get(markdownPath);
  if (!cfg) throw new Error(`missing V3 dedicated review config for ${markdownPath}`);
  const canonical = [
    markdownPath,
    'docs/architecture/wiki/html/v3-mainline-caller-flow.html',
    'docs/architecture/v3-mainline-call-map.yml',
    'docs/architecture/v3-resource-operation-map.yml',
    'docs/architecture/v3-function-map.yml',
    'docs/architecture/v3-verification-map.yml',
  ];
  const markdownExists = fs.existsSync(path.join(root, markdownPath));
  const markdown = markdownExists ? readText(root, markdownPath) : '';
  const sourceSections = ['## Status', '## Main Rule', '## Contract', '## Ownership checklist', '## Required gates']
    .filter((token) => markdown.includes(token));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(cfg.title)}</title>
  <script src="${MERMAID_SCRIPT_URL}"></script>
  <script>mermaid.initialize({ startOnLoad: true, theme: 'default', securityLevel: 'loose' });</script>
  <style>
    :root { color-scheme: light; --bg:#f5f1e9; --panel:#fffdfa; --ink:#172033; --muted:#647083; --line:#d8d0c2; --accent:#0f766e; --accent-dark:#134e4a; --accent-soft:#dff4ef; --danger:#be123c; --code:#f6f0e7; }
    * { box-sizing: border-box; }
    body { margin:0; font-family:"Iowan Old Style","Palatino Linotype","Book Antiqua",Georgia,serif; background:radial-gradient(circle at 10% 0%, rgba(15,118,110,.12), transparent 30%), radial-gradient(circle at 90% 10%, rgba(217,119,6,.12), transparent 30%), linear-gradient(180deg,#fbf7ef 0%,var(--bg) 100%); color:var(--ink); }
    main { max-width:1680px; margin:0 auto; padding:34px 22px 72px; }
    header.hero, section.panel { background:rgba(255,253,250,.96); border:1px solid var(--line); border-radius:24px; box-shadow:0 18px 48px rgba(23,32,51,.08); padding:28px; margin:18px 0; }
    header.hero { background:linear-gradient(135deg, rgba(15,118,110,.14), rgba(255,253,250,.96)); }
    .eyebrow { display:inline-flex; gap:8px; align-items:center; padding:6px 10px; border-radius:999px; background:var(--accent-soft); color:var(--accent-dark); font-weight:800; font-size:.9rem; }
    h1 { margin:14px 0 10px; font-size:clamp(2.2rem,4.8vw,4.8rem); line-height:.96; letter-spacing:-.055em; }
    h2 { margin:0 0 14px; font-size:clamp(1.45rem,2.6vw,2.35rem); letter-spacing:-.025em; }
    h3 { margin:0 0 8px; font-size:1.12rem; letter-spacing:-.012em; }
    p { margin:0; color:var(--muted); line-height:1.55; }
    code { font-family:"SFMono-Regular","Menlo","Consolas",monospace; font-size:.88em; background:var(--code); border:1px solid rgba(216,208,194,.9); border-radius:7px; padding:.08rem .35rem; }
    .meta-row { display:flex; flex-wrap:wrap; gap:10px; margin-top:18px; }
    .meta-pill { border:1px solid var(--line); background:rgba(255,255,255,.74); border-radius:999px; padding:8px 12px; color:var(--muted); font-size:.92rem; }
    .flow-stack { display:grid; gap:22px; }
    .flow-box { overflow-x:auto; background:linear-gradient(180deg,rgba(15,118,110,.045),rgba(255,255,255,.92)); border:1px solid var(--line); border-radius:18px; padding:22px; }
    pre.mermaid { min-width:1120px; margin:0; font-size:20px; line-height:1.45; }
    .logic-grid, .note-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(290px,1fr)); gap:14px; }
    .logic-card, .note-card { border:1px solid var(--line); border-radius:18px; background:white; padding:16px; min-height:150px; border-top:5px solid var(--accent); }
    table { width:100%; border-collapse:collapse; background:white; border:1px solid var(--line); border-radius:14px; overflow:hidden; font-size:.96rem; }
    th,td { border:1px solid var(--line); padding:11px 12px; vertical-align:top; text-align:left; line-height:1.45; }
    th { background:var(--accent-soft); color:var(--accent-dark); font-weight:800; }
    .callout { border-left:5px solid var(--danger); background:#fff1f2; border-radius:16px; padding:16px 18px; line-height:1.58; color:#7f1d1d; }
    ul { margin:0; color:var(--muted); line-height:1.55; }
  </style>
</head>
<body data-review-surface="${escapeHtml(cfg.id)}">
  <main>
    <header class="hero">
      <span class="eyebrow">${escapeHtml(cfg.eyebrow)}</span>
      <h1>${escapeHtml(cfg.title)}</h1>
      <p>${escapeHtml(cfg.summary)}</p>
      <div class="meta-row">
        <span class="meta-pill">Canonical Markdown source: <code>${escapeHtml(markdownPath)}</code></span>
        <span class="meta-pill">Review surface class: <code>V3 dedicated annotated HTML</code></span>
        <span class="meta-pill">Generic Markdown renderer: <code>forbidden</code></span>
      </div>
    </header>

    <section class="panel">
      <h2>Separated request / response diagrams</h2>
      <div class="flow-stack">
        <section><h3>${escapeHtml(cfg.requestTitle)}</h3><div class="flow-box"><pre class="mermaid">${escapeHtml(v3ReviewMermaid(cfg.requestTitle, cfg.requestEdges))}</pre></div></section>
        <section><h3>${escapeHtml(cfg.responseTitle)}</h3><div class="flow-box"><pre class="mermaid">${escapeHtml(v3ReviewMermaid(cfg.responseTitle, cfg.responseEdges))}</pre></div></section>
      </div>
    </section>

    <section class="panel">
      <h2>Node logic cards</h2>
      <div class="logic-grid">${cfg.logicCards.map(([title, text]) => v3ReviewCard(title, text)).join('\n')}</div>
    </section>

    <section class="panel">
      <h2>Resource / error / side-channel section</h2>
      ${v3SopHtmlTable(['Resource', 'Owner', 'Rule'], cfg.resources.map(([resource, owner, rule]) => [`<code>${escapeHtml(resource)}</code>`, escapeHtml(owner), escapeHtml(rule)]))}
    </section>

    <section class="panel">
      <h2>Review checklist</h2>
      <ul>${cfg.checklist.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
    </section>

    <section class="panel">
      <h2>Source-section evidence</h2>
      <p>Detected source sections: ${sourceSections.length ? sourceSections.map((item) => `<code>${escapeHtml(item)}</code>`).join(' ') : '<code>source sections pending</code>'}</p>
    </section>

    <section class="panel">
      <h2>Canonical sources</h2>
      <ul>${canonical.map((source) => `<li><code>${escapeHtml(source)}</code></li>`).join('')}</ul>
    </section>
  </main>
</body>
</html>`;
}

export function auditV3DedicatedReviewSurfacesHtml(expectedOutputs) {
  const failures = [];
  for (const [markdownPath, cfg] of V3_DEDICATED_REVIEW_SURFACES.entries()) {
    const htmlPath = htmlPathForMarkdown(markdownPath);
    const html = expectedOutputs.get(htmlPath);
    if (!html) {
      failures.push(`${htmlPath}: missing V3 dedicated review HTML expectation`);
      continue;
    }
    const required = [
      `data-review-surface="${cfg.id}"`,
      cfg.title,
      'Separated request / response diagrams',
      'Node logic cards',
      'Resource / error / side-channel section',
      'Review checklist',
      'Canonical sources',
      'Canonical Markdown source:',
      'Generic Markdown renderer: <code>forbidden</code>',
    ];
    for (const token of required) {
      if (!html.includes(token)) failures.push(`${htmlPath}: missing dedicated review token ${token}`);
    }
    if (html.includes('<section class="frame">') || html.includes('<article>\n        <h1>')) {
      failures.push(`${htmlPath}: V3 dedicated review surface must not use generic Markdown renderer`);
    }
    if ((html.match(/<pre class="mermaid">/g) ?? []).length < 2) {
      failures.push(`${htmlPath}: V3 dedicated review surface must include separate request/response Mermaid diagrams`);
    }
    if ((html.match(/logic-card/g) ?? []).length < 3) {
      failures.push(`${htmlPath}: V3 dedicated review surface must include node logic cards`);
    }
    if (!html.includes('<table>')) {
      failures.push(`${htmlPath}: V3 dedicated review surface must include resource/error/side-channel table`);
    }
  }
  return failures;
}

function renderV3MainlineSkeletonSopHtml(root) {
  const map = loadV3MainlineCallMap(root);
  const locks = loadV3ArchitectureAuditLocks(root);
  const chains = map?.chains ?? [];
  const locksByChain = new Map((locks?.locked_items ?? []).map((item) => [item.chain_id, item]));
  const required = locks?.policy?.required_locked_chains ?? [];
  const lockRows = required.map((chainId) => {
    const chain = chains.find((item) => item.chain_id === chainId);
    const lock = locksByChain.get(chainId);
    return [
      `<code>${escapeHtml(chainId)}</code>`,
      `<span class="status">${escapeHtml(lock?.status ?? 'missing')}</span>`,
      String(chain?.edges?.length ?? 0),
      `<code>${escapeHtml(chain?.owner_feature_id ?? '<missing>')}</code>`,
      `<code>${escapeHtml((lock?.fingerprint ?? '<missing>').slice(0, 28))}…</code>`,
    ];
  });
  const canonical = [
    V3_MAINLINE_SKELETON_SOP_PATH,
    'docs/architecture/wiki/html/v3-mainline-caller-flow.html',
    'docs/architecture/v3-mainline-call-map.yml',
    'docs/architecture/v3-resource-operation-map.yml',
    'docs/architecture/v3-architecture-audit-locks.yml',
    'docs/architecture/v3-function-map.yml',
    'docs/architecture/v3-verification-map.yml',
  ];
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>V3 Mainline Skeleton SOP Review</title>
  <script src="${MERMAID_SCRIPT_URL}"></script>
  <script>mermaid.initialize({ startOnLoad: true, theme: 'default', securityLevel: 'loose' });</script>
  <style>
    :root { color-scheme: light; --bg:#f5f1e9; --panel:#fffdfa; --ink:#172033; --muted:#647083; --line:#d8d0c2; --accent:#0f766e; --accent-dark:#134e4a; --accent-soft:#dff4ef; --danger:#be123c; --code:#f6f0e7; }
    * { box-sizing: border-box; }
    body { margin:0; font-family:"Iowan Old Style","Palatino Linotype","Book Antiqua",Georgia,serif; background:radial-gradient(circle at 10% 0%, rgba(15,118,110,.12), transparent 30%), radial-gradient(circle at 90% 10%, rgba(37,99,235,.10), transparent 32%), linear-gradient(180deg,#fbf7ef 0%,var(--bg) 100%); color:var(--ink); }
    main { max-width:1680px; margin:0 auto; padding:34px 22px 72px; }
    header.hero, section.panel { background:rgba(255,253,250,.96); border:1px solid var(--line); border-radius:24px; box-shadow:0 18px 48px rgba(23,32,51,.08); padding:28px; margin:18px 0; }
    header.hero { background:linear-gradient(135deg, rgba(15,118,110,.14), rgba(255,253,250,.96)); }
    .eyebrow { display:inline-flex; gap:8px; align-items:center; padding:6px 10px; border-radius:999px; background:var(--accent-soft); color:var(--accent-dark); font-weight:800; font-size:.9rem; }
    h1 { margin:14px 0 10px; font-size:clamp(2.2rem,4.8vw,4.8rem); line-height:.96; letter-spacing:-.055em; }
    h2 { margin:0 0 14px; font-size:clamp(1.45rem,2.6vw,2.35rem); letter-spacing:-.025em; }
    h3 { margin:0 0 8px; font-size:1.12rem; letter-spacing:-.012em; }
    p { margin:0; color:var(--muted); line-height:1.55; }
    code { font-family:"SFMono-Regular","Menlo","Consolas",monospace; font-size:.88em; background:var(--code); border:1px solid rgba(216,208,194,.9); border-radius:7px; padding:.08rem .35rem; }
    .meta-row { display:flex; flex-wrap:wrap; gap:10px; margin-top:18px; }
    .meta-pill { border:1px solid var(--line); background:rgba(255,255,255,.74); border-radius:999px; padding:8px 12px; color:var(--muted); font-size:.92rem; }
    .flow-stack { display:grid; gap:22px; }
    .flow-box { overflow-x:auto; background:linear-gradient(180deg,rgba(15,118,110,.045),rgba(255,255,255,.92)); border:1px solid var(--line); border-radius:18px; padding:22px; }
    pre.mermaid { min-width:1180px; margin:0; font-size:20px; line-height:1.45; }
    .logic-grid, .note-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(290px,1fr)); gap:14px; }
    .logic-card, .note-card { border:1px solid var(--line); border-radius:18px; background:white; padding:16px; min-height:150px; border-top:5px solid var(--accent); }
    .node-card-top { display:flex; justify-content:space-between; gap:12px; margin-bottom:12px; color:var(--muted); font-family:"SFMono-Regular","Menlo","Consolas",monospace; font-size:.78rem; }
    table { width:100%; border-collapse:collapse; background:white; border:1px solid var(--line); border-radius:14px; overflow:hidden; font-size:.96rem; }
    th,td { border:1px solid var(--line); padding:11px 12px; vertical-align:top; text-align:left; line-height:1.45; }
    th { background:var(--accent-soft); color:var(--accent-dark); font-weight:800; }
    .callout { border-left:5px solid var(--danger); background:#fff1f2; border-radius:16px; padding:16px 18px; line-height:1.58; color:#7f1d1d; }
    .status { border-radius:999px; background:var(--accent-soft); color:var(--accent-dark); padding:3px 8px; font-weight:800; }
    ul { margin:0; color:var(--muted); line-height:1.55; }
  </style>
</head>
<body data-review-surface="v3-mainline-skeleton-sop">
  <main>
    <header class="hero">
      <span class="eyebrow">locked SOP review · generated dedicated surface</span>
      <h1>V3 Mainline Skeleton SOP Review</h1>
      <p>这个页面是主骨架 SOP 的专用 review surface，不允许退回通用 Markdown HTML。它用同一套可视标准展示 request / response / error / SSE edge 边界、锁定链 fingerprint 和变更授权规则。</p>
      <div class="meta-row">
        <span class="meta-pill">Canonical Markdown source: <code>${escapeHtml(V3_MAINLINE_SKELETON_SOP_PATH)}</code></span>
        <span class="meta-pill">Review source: <code>docs/architecture/v3-mainline-call-map.yml</code></span>
        <span class="meta-pill">Lock source: <code>docs/architecture/v3-architecture-audit-locks.yml</code></span>
      </div>
    </header>

    <section class="panel">
      <h2>Separated locked skeleton diagrams</h2>
      <div class="flow-stack">
        <section><h3>Request skeleton</h3><div class="flow-box"><pre class="mermaid">${escapeHtml(v3SopMermaid('request'))}</pre></div></section>
        <section><h3>Response skeleton</h3><div class="flow-box"><pre class="mermaid">${escapeHtml(v3SopMermaid('response'))}</pre></div></section>
      </div>
    </section>

    <section class="panel">
      <h2>Request node logic</h2>
      <div class="logic-grid">
        ${v3SopNodeCard('ReqInbound', 'Non-destructive entry normalization', 'Server and ReqInbound capture entry facts and normalize protocol shape only; they do not restore continuation or repair history.')}
        ${v3SopNodeCard('Req04', 'Request Chat Process owner', 'Continuation restore, current-turn tool governance, stopless request control, and tool declaration merge live here.')}
        ${v3SopNodeCard('ReqOutbound / Compat / Wire', 'Provider-bound request owner', 'Provider field legality is fixed in outbound/provider codec; not by deleting transcript truth earlier.')}
      </div>
    </section>

    <section class="panel">
      <h2>Response node logic</h2>
      <div class="logic-grid">
        ${v3SopNodeCard('ProviderRespCompat02ProviderCompat', 'Compat before RespInbound', 'Provider-specific response shape differences are normalized before Hub response parsing.')}
        ${v3SopNodeCard('Resp03', 'Response Chat Process owner', 'Text harvest, tool frame repair, finish_reason branch, servertool, stopless, and ordinary tool governance live here.')}
        ${v3SopNodeCard('Resp04 / RespOutbound / Server frame', 'Save then project then frame', 'Resp04 only saves governed continuation truth; RespOutbound projects client semantic; server/SSE only frames/transports.')}
      </div>
    </section>

    <section class="panel">
      <h2>Error resources</h2>
      <div class="note-grid">
        <article class="note-card"><h3>Error01-06 is a resource graph</h3><p>Error handling is not a side-channel label. Provider/runtime errors must enter the typed error chain and provider health resources without entering normal payload.</p></article>
        <article class="note-card"><h3>Side-channel is carrier only</h3><p>Metadata, debug, error, snapshot, health, and stopless control facts are resources with owners. Side-channel only moves those facts; it is not business payload.</p></article>
      </div>
    </section>

    <section class="panel">
      <h2>SSE Edge SOP</h2>
      <div class="callout"><strong>SSE is transport only.</strong> It owns bytes, UTF-8/frame parsing, frame limits, backpressure/EOF/drop/error closeout, and opaque frame re-encoding only. It must not parse event/data JSON, required_action, terminal status, tool calls, continuation, stopless/servertool, routing, retry, or error-policy semantics.</div>
    </section>

    <section class="panel">
      <h2>Locked chain fingerprints</h2>
      ${v3SopHtmlTable(['Chain', 'Lock status', 'Edges', 'Owner', 'Fingerprint'], lockRows)}
    </section>

    <section class="panel">
      <h2>Change authorization contract</h2>
      <div class="callout"><strong>Locked chain edge/resource/caller/callee/fingerprint changes require Jason manual authorization.</strong> The authorization record must include authorization id, item id, approved_by Jason, before/after fingerprints, and reason/scope.</div>
    </section>

    <section class="panel">
      <h2>Canonical sources</h2>
      <ul>${canonical.map((source) => `<li><code>${escapeHtml(source)}</code></li>`).join('')}</ul>
    </section>
  </main>
</body>
</html>`;
}

export function auditV3MainlineSkeletonSopHtmlText(htmlText, relPath = V3_MAINLINE_SKELETON_SOP_PATH) {
  const failures = [];
  for (const token of V3_SOP_REVIEW_MARKERS) {
    if (!htmlText.includes(token)) failures.push(`${relPath}: generated SOP HTML missing review-surface token ${token}`);
  }
  if (htmlText.includes('<section class="frame">') || htmlText.includes('<article>\n        <h1>')) {
    failures.push(`${relPath}: V3 locked SOP must use dedicated review renderer, not generic markdown renderer`);
  }
  const mermaidCount = (htmlText.match(/<pre class="mermaid">/g) ?? []).length;
  if (mermaidCount < 2) failures.push(`${relPath}: V3 locked SOP HTML must contain separate request and response Mermaid diagrams`);
  return failures;
}

function renderHtmlDocument({ title, markdownPath, bodyHtml }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <script src="${MERMAID_SCRIPT_URL}"></script>
  <script>mermaid.initialize({ startOnLoad: true, theme: 'default', securityLevel: 'loose' });</script>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4f0e8;
      --panel: #fffdfa;
      --ink: #1f241f;
      --muted: #5f665f;
      --line: #d9cfbf;
      --accent: #0f766e;
      --accent-soft: #dff4ef;
      --code: #f3efe6;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif;
      background:
        radial-gradient(circle at top left, rgba(15, 118, 110, 0.08), transparent 32%),
        linear-gradient(180deg, #f7f3eb 0%, var(--bg) 100%);
      color: var(--ink);
    }
    main {
      max-width: 1100px;
      margin: 0 auto;
      padding: 40px 20px 72px;
    }
    .frame {
      background: color-mix(in srgb, var(--panel) 94%, white);
      border: 1px solid var(--line);
      border-radius: 20px;
      box-shadow: 0 18px 48px rgba(31, 36, 31, 0.08);
      overflow: hidden;
    }
    header {
      padding: 24px 28px 18px;
      border-bottom: 1px solid var(--line);
      background: linear-gradient(135deg, rgba(15, 118, 110, 0.1), rgba(255, 253, 250, 0.9));
    }
    header h1 {
      margin: 0 0 8px;
      font-size: clamp(2rem, 4vw, 3rem);
      line-height: 1.05;
      letter-spacing: -0.03em;
    }
    header p {
      margin: 0;
      color: var(--muted);
      font-size: 0.98rem;
    }
    article {
      padding: 28px;
      line-height: 1.65;
      font-size: 17px;
    }
    h1, h2, h3, h4, h5, h6 { line-height: 1.15; margin: 1.4em 0 0.55em; }
    h1:first-child, h2:first-child, h3:first-child { margin-top: 0; }
    h2 { font-size: 1.7rem; border-top: 1px solid var(--line); padding-top: 1.1rem; }
    h3 { font-size: 1.25rem; color: var(--accent); }
    p, ul, table, pre { margin: 0 0 1rem; }
    ul { padding-left: 1.35rem; }
    li + li { margin-top: 0.35rem; }
    code {
      font-family: "SFMono-Regular", "Menlo", "Consolas", monospace;
      font-size: 0.92em;
      background: var(--code);
      border: 1px solid color-mix(in srgb, var(--line) 80%, white);
      border-radius: 6px;
      padding: 0.08rem 0.35rem;
    }
    pre {
      background: #f8f4ec;
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 14px;
      overflow-x: auto;
    }
    pre code {
      background: transparent;
      border: 0;
      padding: 0;
    }
    .mermaid {
      background: linear-gradient(180deg, rgba(15, 118, 110, 0.04), rgba(255,255,255,0.92));
      padding: 20px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      background: white;
      border: 1px solid var(--line);
    }
    th, td {
      border: 1px solid var(--line);
      padding: 10px 12px;
      vertical-align: top;
      text-align: left;
    }
    th {
      background: var(--accent-soft);
      font-weight: 700;
    }
    @media (max-width: 720px) {
      main { padding: 18px 12px 40px; }
      article, header { padding-left: 16px; padding-right: 16px; }
      article { font-size: 15px; }
    }
  </style>
</head>
<body>
  <main>
    <section class="frame">
      <header>
        <h1>${escapeHtml(title)}</h1>
        <p>Canonical Markdown source: <code>${escapeHtml(markdownPath)}</code></p>
      </header>
      <article>
${bodyHtml}
      </article>
    </section>
  </main>
</body>
</html>
`;
}

export function renderArchitectureWikiHtmlPages(root) {
  const outputs = new Map();
  for (const markdownPath of wikiMarkdownPaths()) {
    if (V3_DEDICATED_REVIEW_SURFACES.has(markdownPath)) {
      outputs.set(htmlPathForMarkdown(markdownPath), renderV3DedicatedReviewHtml(root, markdownPath));
      continue;
    }
    if (markdownPath === V3_CALLER_FLOW_PATH) {
      outputs.set(htmlPathForMarkdown(markdownPath), renderV3MainlineCallerFlowHtml(root));
      continue;
    }
    if (markdownPath === V3_REQ04_TOOL_GOVERNANCE_REVIEW_PATH) {
      outputs.set(htmlPathForMarkdown(markdownPath), renderV3Req04ToolGovernanceReviewHtml(root));
      continue;
    }
    if (markdownPath === V3_MAINLINE_SKELETON_SOP_PATH) {
      outputs.set(htmlPathForMarkdown(markdownPath), renderV3MainlineSkeletonSopHtml(root));
      continue;
    }
    const markdown = readText(root, markdownPath);
    const title = markdownTitle(markdown, path.basename(markdownPath, '.md'));
    const bodyHtml = renderMarkdown(markdown)
      .split('\n')
      .map((line) => (line ? `        ${line}` : ''))
      .join('\n');
    outputs.set(
      htmlPathForMarkdown(markdownPath),
      renderHtmlDocument({
        title,
        markdownPath,
        bodyHtml,
      }),
    );
  }
  return outputs;
}
