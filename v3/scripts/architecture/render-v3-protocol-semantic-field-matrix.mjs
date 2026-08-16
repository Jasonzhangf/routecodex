#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

export const V3_PROTOCOL_SEMANTIC_FIELD_MATRIX_PATH = 'docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml';
export const V3_PROTOCOL_SEMANTIC_FIELD_MATRIX_HTML_PATH = 'docs/architecture/wiki/html/v3-protocol-semantic-field-matrix.html';

const PROTOCOLS = [
  ['responses', 'Responses'],
  ['openai_chat', 'OpenAI Chat'],
  ['anthropic', 'Anthropic Messages'],
  ['gemini', 'Gemini'],
];
const CLASSIFICATION_BUCKETS = [
  ['canonical_chat_fields', 'Canonical Chat fields'],
  ['protocol_specific_chat_extension_fields', 'Protocol-specific Chat extensions'],
  ['edge_only_fields', 'Edge-only / transport fields'],
  ['unsupported_or_lossy_fields', 'Unsupported / lossy fields'],
];

export function loadV3ProtocolSemanticFieldMatrix(root = process.cwd()) {
  const source = fs.readFileSync(path.join(root, V3_PROTOCOL_SEMANTIC_FIELD_MATRIX_PATH), 'utf8');
  return YAML.parse(source);
}

export function renderV3ProtocolSemanticFieldMatrixHtml(matrix) {
  const sourceCount = Object.keys(matrix?.source_inventory?.sources ?? {}).length;
  const semanticCount = Object.keys(matrix?.semantic_correspondence ?? {}).length;
  const manualGroupCount = Array.isArray(matrix?.chat_semantic_translation_groups)
    ? matrix.chat_semantic_translation_groups.length
    : 0;
  const gapCount = Array.isArray(matrix?.implementation_gaps) ? matrix.implementation_gaps.length : 0;
  const inventoryFieldCount = PROTOCOLS.reduce((sum, [protocol]) => sum + sourceInventoryFields(matrix, protocol).length, 0);
  const classifiedFieldCount = PROTOCOLS.reduce((sum, [protocol]) => sum + classifiedFields(matrix, protocol).length, 0);

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>V3 Protocol Semantic Field Matrix</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7fb;
      --panel: #ffffff;
      --ink: #172033;
      --muted: #667085;
      --border: #d9e1ee;
      --header: #0f1b33;
      --accent: #2563eb;
      --accent-soft: #eaf1ff;
      --warn: #92400e;
      --warn-soft: #fff7ed;
      --bad: #991b1b;
      --bad-soft: #fef2f2;
      --good: #166534;
      --good-soft: #ecfdf3;
      --code-bg: #f2f4f7;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--ink); line-height: 1.55; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    code { background: var(--code-bg); border: 1px solid #e4e7ec; border-radius: 5px; padding: 0.05rem 0.32rem; font-family: "SFMono-Regular", Consolas, monospace; font-size: 0.9em; }
    .page { max-width: 1680px; margin: 0 auto; padding: 32px 28px 64px; }
    .hero { background: linear-gradient(135deg, #111827 0%, #1d4ed8 55%, #0891b2 100%); color: white; border-radius: 24px; padding: 32px; box-shadow: 0 24px 60px rgba(15, 23, 42, 0.22); }
    .eyebrow { display: inline-flex; align-items: center; gap: 8px; margin-bottom: 10px; padding: 4px 10px; border-radius: 999px; background: rgba(255,255,255,0.14); color: #e0f2fe; font-size: 0.86rem; letter-spacing: 0.04em; text-transform: uppercase; }
    h1 { margin: 0 0 12px; font-size: clamp(2rem, 3.3vw, 4rem); line-height: 1.02; }
    .hero p { max-width: 980px; margin: 0 0 18px; color: #dbeafe; font-size: 1.04rem; }
    .meta-row, .stat-row { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 16px; }
    .meta-pill, .stat-card { display: inline-flex; align-items: center; gap: 8px; border-radius: 999px; padding: 8px 12px; background: rgba(255,255,255,0.12); border: 1px solid rgba(255,255,255,0.18); color: #f8fafc; }
    .stat-card { border-radius: 16px; min-width: 160px; flex-direction: column; align-items: flex-start; }
    .stat-card strong { font-size: 1.35rem; line-height: 1; }
    .nav { position: sticky; top: 0; z-index: 6; margin: 18px 0; padding: 10px; display: flex; flex-wrap: wrap; gap: 8px; background: rgba(246, 247, 251, 0.9); backdrop-filter: blur(10px); border: 1px solid var(--border); border-radius: 18px; }
    .nav a { padding: 7px 10px; border-radius: 999px; background: var(--panel); border: 1px solid var(--border); font-size: 0.92rem; }
    .section { margin-top: 24px; padding: 24px; background: var(--panel); border: 1px solid var(--border); border-radius: 22px; box-shadow: 0 10px 30px rgba(15, 23, 42, 0.05); }
    .section h2 { margin: 0 0 6px; font-size: 1.55rem; }
    .section > p { margin: 0 0 16px; color: var(--muted); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(310px, 1fr)); gap: 14px; }
    .card { border: 1px solid var(--border); border-radius: 18px; padding: 16px; background: #fbfdff; }
    .card h3 { margin: 0 0 10px; font-size: 1.05rem; }
    .source-meta { display: grid; gap: 6px; font-size: 0.92rem; color: var(--muted); }
    .source-meta code { overflow-wrap: anywhere; }
    .table-wrap { overflow: auto; border: 1px solid var(--border); border-radius: 16px; background: white; }
    table { border-collapse: separate; border-spacing: 0; width: 100%; min-width: 980px; }
    th, td { text-align: left; vertical-align: top; border-bottom: 1px solid var(--border); border-right: 1px solid var(--border); padding: 10px 12px; }
    th:last-child, td:last-child { border-right: 0; }
    tr:last-child td { border-bottom: 0; }
    th { position: sticky; top: 0; z-index: 2; background: var(--header); color: white; font-size: 0.86rem; letter-spacing: 0.02em; }
    tbody tr:nth-child(2n) td { background: #fcfcfd; }
    .field-list { margin: 0; padding: 0; list-style: none; display: grid; gap: 4px; }
    .field-list li { overflow-wrap: anywhere; }
    .standard-cell { background: #eff6ff !important; border-left: 4px solid var(--accent); }
    .equiv-cell h4 { margin: 0.35rem 0 0.2rem; font-size: 0.78rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
    .equiv-cell h4:first-child { margin-top: 0; }
    .muted { color: var(--muted); }
    .badge { display: inline-flex; align-items: center; justify-content: center; border-radius: 999px; padding: 2px 8px; font-size: 0.78rem; font-weight: 700; white-space: nowrap; border: 1px solid transparent; }
    .badge.covered { color: var(--good); background: var(--good-soft); border-color: #bbf7d0; }
    .badge.partial, .badge.fixed_doc_gate { color: var(--warn); background: var(--warn-soft); border-color: #fed7aa; }
    .badge.unsupported, .badge.unsupported_or_lossy, .badge.lossy { color: var(--bad); background: var(--bad-soft); border-color: #fecaca; }
    .badge.edge_only { color: #075985; background: #ecfeff; border-color: #bae6fd; }
    .badge.protocol_specific_chat_extension { color: #6d28d9; background: #f5f3ff; border-color: #ddd6fe; }
    .badge.canonical_chat { color: #1d4ed8; background: var(--accent-soft); border-color: #bfdbfe; }
    details { border: 1px solid var(--border); border-radius: 14px; padding: 10px 12px; background: #fbfdff; }
    details + details { margin-top: 10px; }
    summary { cursor: pointer; font-weight: 700; }
    .bucket-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; }
    .protocol-title { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 20px 0 10px; }
    .protocol-title h3 { margin: 0; }
    .footer { margin-top: 20px; color: var(--muted); font-size: 0.92rem; }
    .marker { display: none; }
  </style>
</head>
<body data-review-surface="v3-protocol-semantic-field-matrix" data-matrix-version="${escapeAttr(matrix?.matrix_version ?? 'unknown')}" data-owner-feature-id="${escapeAttr(matrix?.owner_feature_id ?? 'unknown')}">
  <main class="page">
    <header class="hero">
      <span class="eyebrow">V3 protocol conversion · field correspondence audit</span>
      <h1>V3 Protocol Semantic Field Matrix</h1>
      <p>字段级审计面：Chat Process 协议就是 OpenAI Chat 原生 request/response 字段加扩展字段。OpenAI Chat 原生字段必须原名保留（包括 <code>[]</code> item notation）；只有 OpenAI Chat 没有的语义才新增协议无关的顶级 <code>request.</code> / <code>response.</code> / <code>edge.</code> 扩展字段。Responses、Anthropic Messages、Gemini 只作为等价协议投影列；SSE/transport 只作为 edge，不承担语义。</p>
      <div class="meta-row">
        <span class="meta-pill">matrix_version <code>${escapeHtml(matrix?.matrix_version ?? 'unknown')}</code></span>
        <span class="meta-pill">owner <code>${escapeHtml(matrix?.owner_feature_id ?? 'unknown')}</code></span>
        <span class="meta-pill">source <code>${escapeHtml(V3_PROTOCOL_SEMANTIC_FIELD_MATRIX_PATH)}</code></span>
        <span class="meta-pill">rebuild <code>npm run render:v3-protocol-semantic-field-matrix</code></span>
      </div>
      <div class="stat-row">
        ${statCard(sourceCount, 'source documents')}
        ${statCard(inventoryFieldCount, 'source field paths')}
        ${statCard(classifiedFieldCount, 'classified fields')}
        ${statCard(manualGroupCount, 'manual semantic groups')}
        ${statCard(semanticCount, 'semantic rows')}
        ${statCard(gapCount, 'implementation gaps')}
      </div>
    </header>

    <nav class="nav" aria-label="Review sections">
      <a href="#source-inventory">source inventory</a>
      <a href="#audit-truth-contract">audit truth</a>
      <a href="#manual-semantic-translation-groups">manual semantic groups</a>
      <a href="#chat-standard-equivalence">Chat standard equivalence</a>
      <a href="#noncanonical-fields">non-canonical / isolated fields</a>
      <a href="#semantic-correspondence">semantic correspondence</a>
      <a href="#canonical-chat-semantics">canonical semantics</a>
      <a href="#protocol-specific-extensions">protocol extensions</a>
      <a href="#field-classification">field classification</a>
      <a href="#protocol-field-matrix">protocol field matrix</a>
      <a href="#implementation-gaps">implementation gaps</a>
    </nav>

    <section class="section" id="source-inventory">
      <h2>Source inventory / 下载字段清单证据</h2>
      <p>这些 URL、bytes、sha256 是本审计矩阵的来源证据；runtime 不读取本页面或 YAML。</p>
      <div class="grid">
        ${renderSourceCards(matrix)}
      </div>
      ${renderRawSourceInventory(matrix)}
    </section>

    <section class="section" id="audit-truth-contract">
      <span class="marker">audit-truth-contract canonical-textual-truth audited-status-counts gap-audit-closeout</span>
      <h2>Audit truth contract / 文本真相与 gap 审计</h2>
      <p>这部分把当前审计报告固化成可 gate 的文本真相：状态标签含义、精确计数、gap 分类和后续 closeout owner。它不宣称 runtime 全部完成。</p>
      ${renderAuditTruthContract(matrix)}
    </section>

    <section class="section" id="manual-semantic-translation-groups">
      <span class="marker">manual-semantic-translation-groups chat-standard-semantic-meaning protocol-transform-groups</span>
      <h2>Manual semantic translation groups / Chat 标准语义手工分组</h2>
      <p>这张表是人工审计主表：左侧先定义 OpenAI Chat 原生字段或新增扩展字段的标准语义，右侧再按 Responses / Anthropic / Gemini 找同义字段组和 value/shape transform。允许一条 Chat 语义对应多个协议字段，也允许协议字段需要 shape 分支；禁止把源字段按名字硬塞成一一对应。</p>
      ${renderManualSemanticTranslationGroups(matrix)}
    </section>

    <section class="section" id="chat-standard-equivalence">
      <span class="marker">chat-standard-equivalence-matrix chat-standard-request-response-extension</span>
      <h2>Chat standard equivalence / 以 Chat 为标准的等价字段矩阵</h2>
      <p>这一张是主审计表：每行以 OpenAI Chat 字段为主键。若是 OpenAI Chat 原生字段，主键必须和 OpenAI Chat source inventory 完全同名；若 OpenAI Chat 没有该语义，主键才是新增 extension 字段。表中逐字段列出 semantic id、request/response direction、Responses / OpenAI Chat / Anthropic / Gemini 等价字段，以及 owner、current_impl、gap。没有等价语义会明确显示 <code>—</code>，方便审计是否还有超集外语义。</p>
      ${renderChatStandardRequestResponseExtensionMatrix(matrix)}
    </section>

    <section class="section" id="noncanonical-fields">
      <span class="marker">noncanonical-protocol-fields-audit</span>
      <h2>Non-canonical / isolated protocol fields / 标准 Chat 没有的字段</h2>
      <p>这张表列出所有没有进入 <code>canonical_chat_fields</code> 的协议字段：协议专属 extension、edge-only 传输字段、unsupported/lossy 字段，以及未被语义行关联的孤立字段。它回答“是不是全部转完”：不是，<code>source_inventory_only</code> / <code>extension_declared</code> / <code>partial</code> 都是未完成 runtime 语义转换。</p>
      ${renderNonCanonicalFieldsAudit(matrix)}
    </section>

    <section class="section" id="semantic-correspondence">
      <span class="marker">semantic-correspondence</span>
      <h2>Semantic correspondence raw rows / 原始语义行</h2>
      <p>机器矩阵原始行：用于核对 YAML 中的 <code>semantic_correspondence</code> 是否完整，主审计以 Chat standard equivalence 为准。</p>
      ${renderSemanticCorrespondenceTable(matrix)}
    </section>

    <section class="section" id="canonical-chat-semantics">
      <h2>Canonical Chat Process semantics / 标准语义 owner</h2>
      <p>这些语义可以进入标准 Chat Process；协议长尾字段必须进入 protocol-specific extension，而不是 MetadataCenter 或 raw payload dump。</p>
      ${renderCanonicalSemanticsTable(matrix)}
    </section>

    <section class="section" id="protocol-specific-extensions">
      <span class="marker">protocol-specific-chat-extensions</span>
      <h2>Protocol-specific Chat extensions / 协议扩展 owner</h2>
      <p>没有跨协议唯一语义的字段在这里明确 extension owner，避免被 SSE、handler、MetadataCenter 或 provider transport 接管。</p>
      ${renderProtocolExtensionsTable(matrix)}
    </section>

    <section class="section" id="field-classification">
      <span class="marker">field-classification</span>
      <h2>Field classification / 每字段分类</h2>
      <p>每个 source inventory 字段必须且只能属于一个分类：canonical、protocol extension、edge-only、unsupported/lossy。</p>
      ${renderFieldClassification(matrix)}
    </section>

    <section class="section" id="protocol-field-matrix">
      <span class="marker">protocol-field-matrix</span>
      <h2>Protocol field matrix / 协议字段逐项状态</h2>
      <p>按协议与原始字段 section 展开，保留 <code>semantic</code>、<code>chat_extension</code>、<code>current_impl</code> 三列，供 Ctrl-F 审计。</p>
      ${renderProtocolFieldMatrix(matrix)}
    </section>

    <section class="section" id="implementation-gaps">
      <span class="marker">implementation-gaps</span>
      <h2>Implementation gaps / 当前实现 gap</h2>
      <p>本页只锁审计面和 gate；runtime 字段扩展必须另起 owner/test/live 任务。</p>
      ${renderImplementationGaps(matrix)}
    </section>

    <footer class="footer">
      AUTO-GENERATED from <code>${escapeHtml(V3_PROTOCOL_SEMANTIC_FIELD_MATRIX_PATH)}</code>. Do not edit this HTML by hand. Rebuild with <code>npm run render:v3-protocol-semantic-field-matrix</code>.
    </footer>
  </main>
</body>
</html>`;
}

export function renderV3ProtocolSemanticFieldMatrix(root = process.cwd()) {
  const matrix = loadV3ProtocolSemanticFieldMatrix(root);
  return normalizeGeneratedHtml(renderV3ProtocolSemanticFieldMatrixHtml(matrix));
}

export function writeV3ProtocolSemanticFieldMatrixHtml(root = process.cwd()) {
  const html = renderV3ProtocolSemanticFieldMatrix(root);
  const outputPath = path.join(root, V3_PROTOCOL_SEMANTIC_FIELD_MATRIX_HTML_PATH);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, html, 'utf8');
  return html;
}


function normalizeGeneratedHtml(html) {
  return html.replace(/[ \t]+$/gm, '');
}

function statCard(value, label) {
  return `<span class="stat-card"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></span>`;
}

function renderSourceCards(matrix) {
  const sources = matrix?.source_inventory?.sources ?? {};
  return Object.entries(sources).map(([id, source]) => {
    const roots = [...(source.schemas ?? []), ...(source.types ?? [])];
    return `<article class="card">
      <h3><code>${escapeHtml(id)}</code></h3>
      <div class="source-meta">
        <div>URL: <a href="${escapeAttr(source.url ?? '#')}">${escapeHtml(source.url ?? 'missing')}</a></div>
        <div>bytes: <code>${escapeHtml(source.bytes ?? 'missing')}</code></div>
        <div>sha256: <code>${escapeHtml(source.sha256 ?? 'missing')}</code></div>
        <div>roots: ${renderCodeList(roots)}</div>
      </div>
    </article>`;
  }).join('\n');
}

function renderAuditTruthContract(matrix) {
  const contract = matrix?.audit_truth_contract ?? {};
  const statusRows = Object.entries(contract.status_legend ?? {}).map(([status, meaning]) => `<tr>
    <td>${badge(status)}</td>
    <td><code>${escapeHtml(contract?.audited_status_counts?.[status] ?? 'missing')}</code></td>
    <td>${escapeHtml(meaning)}</td>
  </tr>`).join('\n');
  const gapRows = (contract.gap_audit ?? []).map((gap) => `<tr>
    <td><code>${escapeHtml(gap?.gap_id ?? 'missing')}</code></td>
    <td>${badge(gap?.category ?? 'missing')}</td>
    <td>${renderCodeList(gap?.affected_statuses ?? [])}<div>count: <code>${escapeHtml(gap?.affected_count ?? 'missing')}</code></div></td>
    <td>${escapeHtml(gap?.evidence ?? '')}</td>
    <td><code>${escapeHtml(gap?.required_owner ?? '')}</code><br>${badge(gap?.closeout_status ?? 'missing')}<br><span class="muted">${escapeHtml(gap?.closeout_rule ?? '')}</span></td>
  </tr>`).join('\n');
  return `<div class="grid">
    <article class="card"><h3>Truth statement</h3><div class="source-meta">
      <div>${escapeHtml(contract.truth_statement ?? 'missing')}</div>
      <div>text doc: <code>${escapeHtml(contract.canonical_text_doc ?? 'missing')}</code></div>
      <div>closeout plan: <code>${escapeHtml(contract.closeout_goal_doc ?? 'missing')}</code></div>
      <div>gate: <code>${escapeHtml(contract.gate ?? 'missing')}</code></div>
      <div>red fixture: <code>${escapeHtml(contract.red_fixture_gate ?? 'missing')}</code></div>
    </div></article>
    <article class="card"><h3>Forbidden truth sources</h3>${renderCodeList(contract.forbidden_truth_sources ?? [])}</article>
  </div>
  <div class="protocol-title"><h3>Audited status counts</h3><span class="muted">no generic pending_audit</span></div>
  <div class="table-wrap"><table>
    <thead><tr><th>status</th><th>count</th><th>meaning</th></tr></thead>
    <tbody>${statusRows}</tbody>
  </table></div>
  <div class="protocol-title"><h3>Gap audit closeout categories</h3><span class="muted">docs truth vs runtime completion split</span></div>
  <div class="table-wrap"><table>
    <thead><tr><th>gap id</th><th>category</th><th>affected status/count</th><th>evidence</th><th>owner / closeout rule</th></tr></thead>
    <tbody>${gapRows}</tbody>
  </table></div>`;
}

function renderRawSourceInventory(matrix) {
  return PROTOCOLS.map(([protocol, label]) => {
    const sections = matrix?.source_inventory?.[protocol] ?? {};
    const details = Object.entries(sections)
      .filter(([, fields]) => Array.isArray(fields))
      .map(([section, fields]) => `<details>
        <summary>${escapeHtml(label)} · ${escapeHtml(section)} (${fields.length})</summary>
        ${renderCodeList(fields)}
      </details>`).join('\n');
    return `<div class="protocol-title"><h3>${escapeHtml(label)} source fields</h3><span class="muted">${sourceInventoryFields(matrix, protocol).length} fields</span></div>${details}`;
  }).join('\n');
}

function renderChatStandardRequestResponseExtensionMatrix(matrix) {
  const rows = matrix?.extended_openai_chat_semantic_superset?.fields ?? [];
  if (!Array.isArray(rows) || rows.length === 0) {
    return '<p class="muted">extended_openai_chat_semantic_superset.fields is missing.</p>';
  }
  const body = rows.map((row) => `<tr>
    <td class="standard-cell">${renderOpenAiChatFieldCell(row)}</td>
    <td class="standard-cell"><code>${escapeHtml(row?.semantic_id ?? 'missing')}</code></td>
    <td>${badge(row?.direction ?? 'missing')}<br>${badge(row?.mapping_status ?? 'missing')}</td>
    <td>${renderCodeListOrDash(row?.equivalent_fields?.responses, '— no Responses equivalent')}</td>
    <td>${renderCodeListOrDash(row?.equivalent_fields?.openai_chat, '— extended-only, no native OpenAI Chat field')}</td>
    <td>${renderCodeListOrDash(row?.equivalent_fields?.anthropic, '— no Anthropic equivalent')}</td>
    <td>${renderCodeListOrDash(row?.equivalent_fields?.gemini, '— no Gemini equivalent')}</td>
    <td><code>${escapeHtml(row?.semantic_owner ?? 'missing')}</code><br>${badge(row?.current_impl ?? 'missing')}<br><span class="muted">${escapeHtml(row?.gap ?? '')}</span>${renderSupersetExtensionAssociations(row)}</td>
  </tr>`).join('\n');
  return `${renderSupersetSummary(matrix)}<div class="table-wrap"><table>
    <thead><tr><th>OpenAI Chat field (native or extension)</th><th>canonical semantic id</th><th>direction / status</th><th>Responses equivalent fields</th><th>OpenAI Chat native / extended fields</th><th>Anthropic equivalent fields</th><th>Gemini equivalent fields</th><th>owner / current_impl / gap</th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
}

function renderManualSemanticTranslationGroups(matrix) {
  const rows = matrix?.chat_semantic_translation_groups ?? [];
  if (!Array.isArray(rows) || rows.length === 0) {
    return '<p class="muted">chat_semantic_translation_groups is missing.</p>';
  }
  const body = rows.map((row) => `<tr>
    <td class="standard-cell">
      <code>${escapeHtml(row?.standard_chat_field ?? 'missing')}</code>
      <div class="muted">group <code>${escapeHtml(row?.group_id ?? 'missing')}</code></div>
      <div>${renderCodeList(row?.chat_fields ?? [])}</div>
      ${renderCodeListOrDash(row?.chat_extension_fields ?? [], '— native Chat field only')}
    </td>
    <td class="standard-cell">
      <strong>Standard Chat semantic meaning</strong>
      <div>${escapeHtml(row?.standard_semantic_meaning ?? 'missing')}</div>
      <details><summary>Chat shape / value rule</summary><div>${escapeHtml(row?.chat_shape_rule ?? 'missing')}</div></details>
      ${renderShapeBranchCases(row)}
    </td>
    <td>${badge(row?.direction ?? 'missing')}<br>${badge(row?.current_impl ?? 'missing')}<br><span class="muted">${escapeHtml(row?.gap ?? '')}</span></td>
    <td>${renderProtocolTransformCell(row?.protocol_mappings?.responses, 'Responses semantic group')}</td>
    <td>${renderProtocolTransformCell(row?.protocol_mappings?.anthropic, 'Anthropic semantic group')}</td>
    <td>${renderProtocolTransformCell(row?.protocol_mappings?.gemini, 'Gemini semantic group')}</td>
  </tr>`).join('\n');
  return `<div class="table-wrap"><table>
    <thead><tr><th>OpenAI Chat field / extension</th><th>standard semantic meaning</th><th>direction / impl / gap</th><th>Responses semantic group</th><th>Anthropic semantic group</th><th>Gemini semantic group</th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
}

function renderShapeBranchCases(row) {
  const cases = row?.shape_branch_cases;
  if (!cases) return '';
  const positive = Array.isArray(cases.positive) ? cases.positive : [];
  const negative = Array.isArray(cases.negative) ? cases.negative : [];
  return `<details><summary>shape branch cases</summary>
    <h4>positive branches</h4>
    ${renderShapeCaseList(positive, 'positive')}
    <h4>negative branches</h4>
    ${renderShapeCaseList(negative, 'negative')}
  </details>`;
}

function renderShapeCaseList(rows, kind) {
  if (!Array.isArray(rows) || rows.length === 0) return '<span class="muted">— no branch case</span>';
  return `<ul class="field-list">${rows.map((row) => {
    const condition = kind === 'positive' ? row?.source_condition : row?.forbidden_source;
    const target = kind === 'positive' ? row?.maps_to : row?.must_not_map_to;
    return `<li><span class="badge ${escapeAttr(kind)}">${escapeHtml(kind)}</span> <code>${escapeHtml(row?.protocol ?? 'missing')}</code> ${escapeHtml(condition ?? 'missing condition')} → <code>${escapeHtml(target ?? 'missing target')}</code><br><span class="muted">owner <code>${escapeHtml(row?.owner_file ?? 'missing')}</code>; test <code>${escapeHtml(row?.required_test ?? 'missing')}</code></span></li>`;
  }).join('')}</ul>`;
}

function renderProtocolTransformCell(mapping, label) {
  if (!mapping) return `<span class="muted">— missing ${escapeHtml(label)}</span>`;
  return `<div class="equiv-cell">
    <h4>request fields</h4>
    ${renderCodeListOrDash(mapping.request_fields ?? [], '— no request field')}
    <h4>response fields</h4>
    ${renderCodeListOrDash(mapping.response_fields ?? [], '— no response field')}
    <h4>transform</h4>
    <div>${escapeHtml(mapping.transform ?? 'missing transform')}</div>
    ${mapping.missing_or_extension ? `<h4>missing / extension</h4><div>${escapeHtml(mapping.missing_or_extension)}</div>` : ''}
  </div>`;
}

function renderSupersetSummary(matrix) {
  const superset = matrix?.extended_openai_chat_semantic_superset ?? {};
  const fields = superset.fields ?? [];
  const statusCounts = new Map();
  const nativeExactCount = fields.filter((row) => (row?.equivalent_fields?.openai_chat ?? []).includes(row?.extended_openai_chat_field)).length;
  const extensionCount = fields.filter((row) => !(row?.equivalent_fields?.openai_chat ?? []).includes(row?.extended_openai_chat_field) && row?.mapping_status === 'extension_added').length;
  for (const row of fields) statusCounts.set(row.mapping_status ?? 'missing', (statusCounts.get(row.mapping_status ?? 'missing') ?? 0) + 1);
  return `<div class="grid">
    <article class="card"><h3>Contract</h3><div class="source-meta"><div>${escapeHtml(superset.contract ?? '')}</div><div>base protocol: <code>${escapeHtml(superset.standard_protocol ?? 'missing')}</code></div></div></article>
    <article class="card"><h3>Coverage</h3><div class="source-meta"><div>OpenAI Chat superset rows: <code>${escapeHtml(fields.length)}</code></div><div>native OpenAI Chat exact-name rows: <code>${escapeHtml(nativeExactCount)}</code></div><div>added extension rows: <code>${escapeHtml(extensionCount)}</code></div><div>source fields: ${renderCodeList(Object.entries(superset.source_field_counts ?? {}).map(([k, v]) => `${k}=${v}`))}</div></div></article>
    <article class="card"><h3>Mapping status</h3><div class="source-meta">${[...statusCounts.entries()].map(([k, v]) => `<div>${badge(k)} <code>${escapeHtml(v)}</code></div>`).join('')}</div></article>
  </div>`;
}

function renderOpenAiChatFieldCell(row) {
  const field = row?.extended_openai_chat_field ?? 'missing';
  const openAiFields = row?.equivalent_fields?.openai_chat ?? [];
  const isNativeExact = Array.isArray(openAiFields) && openAiFields.includes(field);
  const label = isNativeExact ? 'native exact OpenAI Chat field' : 'added Chat extension field';
  return `<code>${escapeHtml(field)}</code><br><span class="muted">${escapeHtml(label)}</span>`;
}

function renderSupersetExtensionAssociations(row) {
  const associations = row?.chat_extension_association;
  if (!Array.isArray(associations) || associations.length === 0) return '';
  return associations.map((item) => `<details><summary>extension <code>${escapeHtml(item?.extension_id ?? 'missing')}</code></summary><div>owner: <code>${escapeHtml(item?.extension_owner ?? 'missing')}</code></div><div>${badge(item?.current_impl ?? 'missing')}</div></details>`).join('');
}

function renderNonCanonicalFieldsAudit(matrix) {
  const rows = [];
  for (const [protocol, label] of PROTOCOLS) {
    const sourceSections = sourceInventoryFieldSections(matrix, protocol);
    const fieldRows = protocolFieldRowsByField(matrix, protocol);
    const semanticRows = semanticRowsByProtocolField(matrix, protocol);
    const extensionRows = extensionRowsByProtocolField(matrix, protocol);
    const classification = classificationByField(matrix, protocol);
    for (const [field, sourceSection] of sourceSections.entries()) {
      const bucket = classification.get(field) ?? 'unclassified_orphan';
      if (bucket === 'canonical_chat_fields') continue;
      const row = fieldRows.get(field);
      const semantics = semanticRows.get(field) ?? [];
      const extensions = extensionRows.get(field) ?? [];
      rows.push(`<tr>
        <td>${escapeHtml(label)}</td>
        <td><code>${escapeHtml(field)}</code></td>
        <td>${badge(bucket)}</td>
        <td>${badge(row?.current_impl ?? inferCurrentImplFromExtensions(extensions) ?? 'source_inventory_only')}</td>
        <td><code>${escapeHtml(sourceSection)}</code></td>
        <td>${renderDirectionBadge(field)}</td>
        <td>${semantics.length ? renderCodeList(semantics.map((item) => `${item.semantic} -> ${item.canonicalPath}`)) : '<span class="muted">— no semantic_correspondence row</span>'}</td>
        <td>${extensions.length ? extensions.map((item) => `<details><summary><code>${escapeHtml(item.extensionId)}</code> · ${badge(item.currentImpl)}</summary><div>owner: <code>${escapeHtml(item.owner)}</code></div></details>`).join('') : '<span class="muted">— no Chat extension owner</span>'}</td>
      </tr>`);
    }
  }
  const summary = renderNonCanonicalSummary(matrix);
  return `${summary}<div class="table-wrap"><table>
    <thead><tr><th>protocol</th><th>field</th><th>classification</th><th>current_impl</th><th>source section</th><th>direction</th><th>semantic association</th><th>Chat extension association</th></tr></thead>
    <tbody>${rows.join('\n')}</tbody>
  </table></div>`;
}

function renderNonCanonicalSummary(matrix) {
  const cards = PROTOCOLS.map(([protocol, label]) => {
    const classes = classificationByField(matrix, protocol);
    const counts = new Map();
    for (const bucket of classes.values()) if (bucket !== 'canonical_chat_fields') counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
    const missingSemantic = [...sourceInventoryFieldSections(matrix, protocol).keys()].filter((field) => classes.get(field) !== 'canonical_chat_fields' && !(semanticRowsByProtocolField(matrix, protocol).has(field))).length;
    return `<article class="card"><h3>${escapeHtml(label)}</h3><div class="source-meta">
      <div>protocol-specific extension: <code>${escapeHtml(counts.get('protocol_specific_chat_extension_fields') ?? 0)}</code></div>
      <div>edge-only: <code>${escapeHtml(counts.get('edge_only_fields') ?? 0)}</code></div>
      <div>unsupported/lossy: <code>${escapeHtml(counts.get('unsupported_or_lossy_fields') ?? 0)}</code></div>
      <div>without semantic row: <code>${escapeHtml(missingSemantic)}</code></div>
    </div></article>`;
  }).join('');
  return `<div class="grid">${cards}</div>`;
}

function sourceInventoryFieldSections(matrix, protocol) {
  const out = new Map();
  for (const [section, fields] of Object.entries(matrix?.source_inventory?.[protocol] ?? {})) {
    if (!Array.isArray(fields)) continue;
    for (const field of fields) out.set(field, section);
  }
  return out;
}

function protocolFieldRowsByField(matrix, protocol) {
  const out = new Map();
  for (const rows of Object.values(matrix?.protocols?.[protocol] ?? {})) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) if (row?.field) out.set(row.field, row);
  }
  return out;
}

function classificationByField(matrix, protocol) {
  const out = new Map();
  for (const [bucket] of CLASSIFICATION_BUCKETS) {
    for (const field of matrix?.field_classification?.[protocol]?.[bucket] ?? []) out.set(field, bucket);
  }
  return out;
}

function semanticRowsByProtocolField(matrix, protocol) {
  const out = new Map();
  for (const [semantic, row] of Object.entries(matrix?.semantic_correspondence ?? {})) {
    const fields = Array.isArray(row?.paths?.[protocol]) ? row.paths[protocol] : row?.paths?.[protocol] ? [row.paths[protocol]] : [];
    for (const field of fields) {
      if (!out.has(field)) out.set(field, []);
      out.get(field).push({ semantic, canonicalPath: row?.canonical_path ?? 'missing' });
    }
  }
  return out;
}

function extensionRowsByProtocolField(matrix, protocol) {
  const out = new Map();
  for (const [extensionId, extension] of Object.entries(matrix?.protocol_specific_chat_extensions?.[protocol] ?? {})) {
    for (const field of extension?.field_paths ?? []) {
      if (!out.has(field)) out.set(field, []);
      out.get(field).push({ extensionId, owner: extension?.extension_owner ?? 'missing', currentImpl: extension?.current_impl ?? 'missing' });
    }
  }
  return out;
}

function inferCurrentImplFromExtensions(extensions) {
  if (!extensions.length) return null;
  if (extensions.some((item) => item.currentImpl === 'covered')) return 'covered';
  if (extensions.some((item) => item.currentImpl === 'partial')) return 'partial';
  return extensions[0].currentImpl;
}

function renderDirectionBadge(field) {
  if (String(field).startsWith('request.')) return badge('request');
  if (String(field).startsWith('response.')) return badge('response');
  return badge('edge_or_other');
}

function renderSemanticCorrespondenceTable(matrix) {
  const rows = Object.entries(matrix?.semantic_correspondence ?? {}).map(([semantic, row]) => `<tr>
    <td><code>${escapeHtml(semantic)}</code></td>
    <td><code>${escapeHtml(row?.canonical_path ?? 'missing')}</code></td>
    <td>${badge(row?.chat_extension ?? 'missing')}</td>
    <td>${badge(row?.current_impl ?? 'missing')}</td>
    ${PROTOCOLS.map(([protocol]) => `<td>${renderMaybeCodeList(row?.paths?.[protocol])}</td>`).join('')}
  </tr>`).join('\n');
  return `<div class="table-wrap"><table>
    <thead><tr><th>semantic</th><th>canonical_path</th><th>chat_extension</th><th>current_impl</th>${PROTOCOLS.map(([, label]) => `<th>${escapeHtml(label)}</th>`).join('')}</tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function renderCanonicalSemanticsTable(matrix) {
  const rows = Object.entries(matrix?.canonical_chat_semantics ?? {}).map(([semantic, row]) => `<tr>
    <td><code>${escapeHtml(semantic)}</code></td>
    <td><code>${escapeHtml(row?.canonical_path ?? 'missing')}</code></td>
    <td>${escapeHtml(row?.owner ?? row?.extension_owner ?? row?.chat_extension ?? '')}</td>
    <td>${badge(row?.current_impl ?? row?.status ?? 'declared')}</td>
    <td>${renderCodeList(row?.field_paths ?? row?.paths ?? [])}</td>
  </tr>`).join('\n');
  return `<div class="table-wrap"><table>
    <thead><tr><th>semantic</th><th>canonical_path</th><th>owner</th><th>status</th><th>field_paths</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function renderProtocolExtensionsTable(matrix) {
  const rows = [];
  for (const [protocol, label] of PROTOCOLS) {
    for (const [extension, row] of Object.entries(matrix?.protocol_specific_chat_extensions?.[protocol] ?? {})) {
      rows.push(`<tr>
        <td>${escapeHtml(label)}</td>
        <td><code>${escapeHtml(extension)}</code></td>
        <td><code>${escapeHtml(row?.extension_owner ?? 'missing')}</code></td>
        <td>${badge(row?.current_impl ?? 'missing')}</td>
        <td>${renderCodeList(row?.field_paths ?? [])}</td>
      </tr>`);
    }
  }
  return `<div class="table-wrap"><table>
    <thead><tr><th>protocol</th><th>extension</th><th>extension_owner</th><th>current_impl</th><th>field_paths</th></tr></thead>
    <tbody>${rows.join('\n')}</tbody>
  </table></div>`;
}

function renderFieldClassification(matrix) {
  return PROTOCOLS.map(([protocol, label]) => {
    const buckets = CLASSIFICATION_BUCKETS.map(([bucket, bucketLabel]) => {
      const fields = matrix?.field_classification?.[protocol]?.[bucket] ?? [];
      return `<details open>
        <summary>${escapeHtml(bucketLabel)} (${fields.length})</summary>
        ${renderCodeList(fields)}
      </details>`;
    }).join('\n');
    return `<div class="protocol-title"><h3>${escapeHtml(label)}</h3><span class="muted">${classifiedFields(matrix, protocol).length} classified fields</span></div><div class="bucket-grid">${buckets}</div>`;
  }).join('\n');
}

function renderProtocolFieldMatrix(matrix) {
  return PROTOCOLS.map(([protocol, label]) => {
    const sections = matrix?.protocols?.[protocol] ?? {};
    const tables = Object.entries(sections)
      .filter(([, rows]) => Array.isArray(rows))
      .map(([section, rows]) => `<details>
        <summary>${escapeHtml(section)} (${rows.length})</summary>
        <div class="table-wrap"><table>
          <thead><tr><th>field</th><th>semantic</th><th>chat_extension</th><th>current_impl</th></tr></thead>
          <tbody>${rows.map((row) => `<tr><td><code>${escapeHtml(row?.field ?? 'missing')}</code></td><td><code>${escapeHtml(row?.semantic ?? 'missing')}</code></td><td>${badge(row?.chat_extension ?? 'missing')}</td><td>${badge(row?.current_impl ?? 'missing')}</td></tr>`).join('')}</tbody>
        </table></div>
      </details>`).join('\n');
    return `<div class="protocol-title"><h3>${escapeHtml(label)}</h3><span class="muted">${protocolRows(matrix, protocol).length} rows</span></div>${tables}`;
  }).join('\n');
}

function renderImplementationGaps(matrix) {
  const rows = (matrix?.implementation_gaps ?? []).map((gap) => `<tr>
    <td><code>${escapeHtml(gap?.id ?? 'missing')}</code></td>
    <td>${badge(gap?.severity ?? 'missing')}</td>
    <td>${escapeHtml(gap?.evidence ?? '')}</td>
    <td><code>${escapeHtml(gap?.required_owner ?? '')}</code><br>${badge(gap?.closeout_status ?? 'missing')}<br><code>${escapeHtml(gap?.required_gate ?? '')}</code></td>
  </tr>`).join('\n');
  return `<div class="table-wrap"><table>
    <thead><tr><th>id</th><th>severity</th><th>evidence</th><th>required_owner / closeout</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function sourceInventoryFields(matrix, protocol) {
  return Object.values(matrix?.source_inventory?.[protocol] ?? {})
    .filter(Array.isArray)
    .flat();
}

function classifiedFields(matrix, protocol) {
  return CLASSIFICATION_BUCKETS.flatMap(([bucket]) => matrix?.field_classification?.[protocol]?.[bucket] ?? []);
}

function protocolRows(matrix, protocol) {
  return Object.values(matrix?.protocols?.[protocol] ?? {})
    .filter(Array.isArray)
    .flat();
}

function renderCodeListOrDash(values, emptyText = '—') {
  if (!Array.isArray(values) || values.length === 0) return `<span class="muted">${escapeHtml(emptyText)}</span>`;
  return renderCodeList(values);
}

function renderMaybeCodeList(value) {
  if (value == null) return '<span class="muted">—</span>';
  if (Array.isArray(value)) return renderCodeList(value);
  return `<code>${escapeHtml(value)}</code>`;
}

function renderCodeList(values) {
  if (!Array.isArray(values) || values.length === 0) return '<span class="muted">—</span>';
  return `<ul class="field-list">${values.map((value) => `<li><code>${escapeHtml(value)}</code></li>`).join('')}</ul>`;
}

function badge(value) {
  const text = String(value ?? 'missing');
  const cls = text.toLowerCase().replace(/[^a-z0-9_-]+/gu, '_');
  return `<span class="badge ${escapeAttr(cls)}">${escapeHtml(text)}</span>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("'", '&#39;');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.cwd();
  const expected = renderV3ProtocolSemanticFieldMatrix(root);
  const outputPath = path.join(root, V3_PROTOCOL_SEMANTIC_FIELD_MATRIX_HTML_PATH);
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : null;
    if (current !== expected) {
      console.error('[render:v3-protocol-semantic-field-matrix] failed');
      console.error(`- ${V3_PROTOCOL_SEMANTIC_FIELD_MATRIX_HTML_PATH} is out of sync`);
      console.error('- run `npm run render:v3-protocol-semantic-field-matrix`');
      process.exit(1);
    }
    console.log('[render:v3-protocol-semantic-field-matrix] ok');
    console.log(`- ${V3_PROTOCOL_SEMANTIC_FIELD_MATRIX_HTML_PATH} is in sync`);
  } else {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, expected, 'utf8');
    console.log('[render:v3-protocol-semantic-field-matrix] ok');
    console.log(`- wrote ${V3_PROTOCOL_SEMANTIC_FIELD_MATRIX_HTML_PATH}`);
  }
}
