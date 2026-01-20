import fs from 'node:fs';
import path from 'node:path';

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full));
      continue;
    }
    if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function isAllowedImportSite(filepath: string): boolean {
  const rel = filepath.split(path.sep).join('/');
  if (rel.startsWith('src/modules/llmswitch/')) return true;
  if (rel.startsWith('src/types/')) return true;
  return false;
}

describe('Unified Hub V1 Phase 5: single import surface', () => {
  test('no direct @jsonstudio/llms imports outside llmswitch bridge', () => {
    const repoRoot = process.cwd();
    const srcRoot = path.join(repoRoot, 'src');
    const files = walkFiles(srcRoot).filter((f) => f.endsWith('.ts') || f.endsWith('.d.ts'));

    const offenders: Array<{ file: string; line: number; text: string }> = [];
    for (const file of files) {
      if (isAllowedImportSite(path.relative(repoRoot, file))) {
        continue;
      }
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (!line.includes('@jsonstudio/llms')) continue;
        offenders.push({
          file: path.relative(repoRoot, file),
          line: i + 1,
          text: line.trim()
        });
      }
    }

    if (offenders.length) {
      const preview = offenders
        .slice(0, 20)
        .map((o) => `${o.file}:${o.line} ${o.text}`)
        .join('\n');
      throw new Error(
        `Found direct @jsonstudio/llms imports outside src/modules/llmswitch/** or src/types/**.\n${preview}`
      );
    }
  });
});

