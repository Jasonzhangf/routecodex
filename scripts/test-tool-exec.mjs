import { executeTool } from '../dist/server/utils/tool-executor.js';

async function run() {
  const payloads = [
    { name: 'string_cmd_readme_head', args: { command: 'find . -type f -name "README*" | head -20' } },
    { name: 'string_cmd_md_grep', args: { command: 'find . -type f -name "*.md" | grep -i readme | head -20' } },
    { name: 'argv_cmd_simple', args: { command: ['find', '.', '-type', 'f', '-name', 'README*'] } },
  ];

  for (const p of payloads) {
    const argStr = JSON.stringify(p.args);
    const res = await executeTool({ id: 'test', name: 'shell', args: argStr });
    console.log('--- case:', p.name, '---');
    console.log('args:', argStr);
    if (res.error) {
      console.log('ERROR:', res.error);
    } else {
      const out = (res.output || '').split('\n').slice(0, 10).join('\n');
      console.log('OK (first 10 lines)');
      console.log(out);
    }
  }
}

run().catch(e => { console.error(e); process.exit(1); });

