import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
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
})();
`;

if (!browserExecutable) {
  console.error('[verify:architecture-wiki-browser-smoke] failed');
  console.error('- no Chrome/Chromium executable found; set ROUTECODEX_ARCHITECTURE_WIKI_BROWSER_EXECUTABLE');
  process.exit(1);
}

const browser = await chromium.launch({
  executablePath: browserExecutable,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

try {
  const context = await browser.newContext();
  await context.route(MERMAID_SCRIPT_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript; charset=utf-8',
      body: smokeMermaidRenderer,
    });
  });
  for (const relPath of htmlPaths) {
    const absPath = path.join(root, relPath);
    if (!fs.existsSync(absPath)) {
      failures.push(`${relPath}: missing html artifact`);
      continue;
    }

    const page = await context.newPage();
    const consoleErrors = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => {
      consoleErrors.push(error instanceof Error ? error.message : String(error));
    });

    try {
      await page.goto(pathToFileURL(absPath).href, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      const pageState = await page.evaluate(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const blocks = [...document.querySelectorAll('.mermaid')];
          const svgCount = blocks.filter((block) => block.querySelector('svg')).length;
          if (blocks.length === 0 || svgCount === blocks.length) break;
          await wait(250);
        }
        const blocks = [...document.querySelectorAll('.mermaid')];
        const svgCount = blocks.filter((block) => block.querySelector('svg')).length;
        const svgTextLength = [...document.querySelectorAll('.mermaid svg')]
          .map((svg) => (svg.textContent ?? '').trim().length)
          .reduce((sum, length) => sum + length, 0);
        return {
          title: document.title,
          hasCanonicalSource: document.body.innerText.includes('Canonical Markdown source:'),
          mermaidBlocks: blocks.length,
          mermaidSvgs: svgCount,
          svgTextLength,
          bodyLength: document.body.innerText.trim().length,
        };
      });

      if (!pageState.title) failures.push(`${relPath}: missing document title`);
      if (!pageState.hasCanonicalSource) failures.push(`${relPath}: missing canonical markdown source`);
      if (pageState.bodyLength < 100) failures.push(`${relPath}: body appears empty`);
      if (pageState.mermaidBlocks > 0 && pageState.mermaidSvgs !== pageState.mermaidBlocks) {
        failures.push(`${relPath}: Mermaid did not render all diagrams (${pageState.mermaidSvgs}/${pageState.mermaidBlocks})`);
      }
      if (pageState.mermaidBlocks > 0 && pageState.svgTextLength === 0) {
        failures.push(`${relPath}: Mermaid SVGs rendered blank`);
      }
      if (consoleErrors.length > 0) {
        failures.push(`${relPath}: console/page errors: ${consoleErrors.slice(0, 3).join(' | ')}`);
      }
    } catch (error) {
      failures.push(`${relPath}: browser load failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.error('[verify:architecture-wiki-browser-smoke] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:architecture-wiki-browser-smoke] ok');
console.log(`- checked html pages: ${htmlPaths.length}`);
console.log(`- browser: ${browserExecutable}`);
