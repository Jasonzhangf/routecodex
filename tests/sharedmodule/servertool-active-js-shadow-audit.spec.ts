import fs from 'node:fs';
import path from 'node:path';

type ShadowAuditCase = {
  tsEntry: string;
  jsShadow: string;
  why: string;
};

function repoPath(relativePath: string): string {
  return path.join(process.cwd(), relativePath);
}

function collectJsSiblingResidue(cases: ShadowAuditCase[]): string[] {
  const findings: string[] = [];

  for (const item of cases) {
    const tsPath = repoPath(item.tsEntry);
    const jsPath = repoPath(item.jsShadow);
    const tsExists = fs.existsSync(tsPath);
    const jsExists = fs.existsSync(jsPath);

    if (tsExists && jsExists) {
      findings.push(`${item.jsShadow} shadows ${item.tsEntry} (${item.why})`);
    }
  }

  return findings;
}

describe('servertool active js shadow audit', () => {
  it('P0 servertool root must not keep same-name src/*.js sibling shadows beside live TS sources', () => {
    const findings = collectJsSiblingResidue([
      {
        tsEntry: 'sharedmodule/llmswitch-core/src/servertool/server-side-tools.ts',
        jsShadow: 'sharedmodule/llmswitch-core/src/servertool/server-side-tools.js',
        why: 'servertool root runtime still has sibling JS shadow'
      }
    ]);

    expect(findings).toEqual([]);
  });
});
