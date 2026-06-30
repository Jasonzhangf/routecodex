import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { MERMAID_SCRIPT_URL, renderArchitectureWikiHtmlPages } from './wiki-html-lib.mjs';

const root = process.cwd();

function executableFromPath(name) {
  try {
    return execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function findBrowserExecutable() {
  if (process.env.ROUTECODEX_ARCHITECTURE_WIKI_BROWSER_EXECUTABLE) {
    return process.env.ROUTECODEX_ARCHITECTURE_WIKI_BROWSER_EXECUTABLE;
  }
  const candidates = [
    executableFromPath('google-chrome'),
    executableFromPath('google-chrome-stable'),
    executableFromPath('chromium'),
    executableFromPath('chromium-browser'),
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) ?? '';
}

const failures = [];
const htmlPaths = [...renderArchitectureWikiHtmlPages(root).keys()].sort();
const browserExecutable = findBrowserExecutable();

const smokeMermaidRenderer = String.raw`
(() => {
  function renderBlocks() {
    const blocks = Array.from(document.querySelectorAll('.mermaid'));
    for (const [index, block] of blocks.entries()) {
      if (block.querySelector('svg')) continue;
      const source = (block.textContent || '').trim();
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      svg.setAttribute('role', 'img');
      svg.setAttribute('data-smoke-mermaid-index', String(index));
      svg.setAttribute('width', '960');
      svg.setAttribute('height', '80');
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = 'Mermaid smoke render';
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', '16');
      text.setAttribute('y', '42');
      text.setAttribute('font-size', '14');
      text.textContent = source.slice(0, 220) || 'empty mermaid source';
      svg.append(title, text);
      block.replaceChildren(svg);
    }
  }
  window.mermaid = {
    initialize(options) {
      if (options && options.startOnLoad === false) return;
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', renderBlocks, { once: true });
      } else {
        renderBlocks();
      }
    },
    run: renderBlocks,
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderBlocks, { once: true });
  } else {
    queueMicrotask(renderBlocks);
  }
})();
`;

if (!browserExecutable) {
  console.error('[verify:architecture-wiki-browser-smoke] failed');
  console.error('- no Chrome/Chromium executable found; set ROUTECODEX_ARCHITECTURE_WIKI_BROWSER_EXECUTABLE');
  process.exit(1);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-wiki-browser-smoke-'));

function injectSmokeRenderer(html) {
  const script = `<script>${smokeMermaidRenderer}</script>`;
  const withoutRemoteMermaid = html
    .replace(`<script src="${MERMAID_SCRIPT_URL}"></script>`, script)
    .replace(/<script>mermaid\.initialize\([^<]*<\/script>/u, '<script>window.mermaid.run();</script>');
  if (withoutRemoteMermaid !== html) {
    return withoutRemoteMermaid;
  }
  if (html.includes('</head>')) {
    return html.replace('</head>', `${script}<script>window.mermaid.run();</script></head>`);
  }
  return `${script}<script>window.mermaid.run();</script>${html}`;
}

function countMatches(source, pattern) {
  return source.match(pattern)?.length ?? 0;
}

try {
  for (const relPath of htmlPaths) {
    const absPath = path.join(root, relPath);
    if (!fs.existsSync(absPath)) {
      failures.push(`${relPath}: missing html artifact`);
      continue;
    }

    const tempPath = path.join(tempRoot, relPath);
    fs.mkdirSync(path.dirname(tempPath), { recursive: true });
    fs.writeFileSync(tempPath, injectSmokeRenderer(fs.readFileSync(absPath, 'utf8')));

    try {
      const dumpedDom = execFileSync(browserExecutable, [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--run-all-compositor-stages-before-draw',
        '--virtual-time-budget=3000',
        '--dump-dom',
        pathToFileURL(tempPath).href,
      ], {
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 20 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const titleMatch = dumpedDom.match(/<title>([^<]+)<\/title>/i);
      const title = titleMatch?.[1]?.trim() ?? '';
      const mermaidBlocks = countMatches(dumpedDom, /class="[^"]*\bmermaid\b[^"]*"/g);
      const mermaidSvgs = countMatches(dumpedDom, /data-smoke-mermaid-index="/g);
      const visibleText = dumpedDom.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

      if (!title) failures.push(`${relPath}: missing document title`);
      if (!dumpedDom.includes('Canonical Markdown source:')) failures.push(`${relPath}: missing canonical markdown source`);
      if (visibleText.length < 100) failures.push(`${relPath}: body appears empty`);
      if (mermaidBlocks > 0 && mermaidSvgs !== mermaidBlocks) {
        failures.push(`${relPath}: Mermaid did not render all diagrams (${mermaidSvgs}/${mermaidBlocks})`);
      }
      if (mermaidBlocks > 0 && !dumpedDom.includes('Mermaid smoke render')) {
        failures.push(`${relPath}: Mermaid SVGs rendered blank`);
      }
    } catch (error) {
      failures.push(`${relPath}: browser load failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error('[verify:architecture-wiki-browser-smoke] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:architecture-wiki-browser-smoke] ok');
console.log(`- checked html pages: ${htmlPaths.length}`);
console.log(`- browser: ${browserExecutable}`);
