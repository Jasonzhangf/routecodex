import fs from 'node:fs';
import path from 'node:path';
import { GENERATED_WIKI_PAGES, MANUAL_WIKI_PAGES, WIKI_ROOT } from './architecture-wiki-lib.mjs';
import { renderV3MainlineCallerFlowHtml, V3_CALLER_FLOW_PATH } from './v3-mainline-caller-flow-lib.mjs';
import {
  renderV3Req04ToolGovernanceReviewHtml,
  V3_REQ04_TOOL_GOVERNANCE_REVIEW_PATH,
} from './v3-req04-tool-governance-review-lib.mjs';

export const WIKI_HTML_ROOT = `${WIKI_ROOT}/html`;

export const MERMAID_SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js';

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
    if (markdownPath === V3_CALLER_FLOW_PATH) {
      outputs.set(htmlPathForMarkdown(markdownPath), renderV3MainlineCallerFlowHtml(root));
      continue;
    }
    if (markdownPath === V3_REQ04_TOOL_GOVERNANCE_REVIEW_PATH) {
      outputs.set(htmlPathForMarkdown(markdownPath), renderV3Req04ToolGovernanceReviewHtml(root));
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
