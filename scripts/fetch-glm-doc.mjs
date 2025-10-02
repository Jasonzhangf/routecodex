import fs from 'fs/promises';
import TurndownService from 'turndown';
import puppeteer from 'puppeteer';

const url = process.argv[2] || 'https://docs.bigmodel.cn/api-reference/%E6%A8%A1%E5%9E%8B-api/%E5%AF%B9%E8%AF%9D%E8%A1%A5%E5%85%A8';
const out = process.argv[3] || 'docs/glm-chat-completions.md';

(async () => {
  const browser = await puppeteer.launch({args: ['--no-sandbox','--disable-setuid-sandbox']});
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  // Try to extract the primary content area; fallback to body
  const html = await page.evaluate(() => {
    const main = document.querySelector('main') || document.body;
    // Remove nav/footer if present in main
    return main ? main.innerHTML : document.body.innerHTML;
  });
  await browser.close();

  const turndown = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced' });
  const md = turndown.turndown(html);
  await fs.mkdir('docs', { recursive: true });
  await fs.writeFile(out, `# GLM 对话补全（本地快照）\n\n源: ${url}\n\n${md}\n`, 'utf-8');
  console.log(`Saved to ${out}`);
})();
