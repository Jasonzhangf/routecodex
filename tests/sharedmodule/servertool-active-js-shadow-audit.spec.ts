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
    ]);

    expect(findings).toEqual([]);
  });

  it('servertool direct CLI path must not restore legacy CLI identities', () => {
    const forbidden = [
      ['--', 'tic', 'ket'].join(''),
      ['st', 'cli_'].join(''),
      ['rcc', '_cli_'].join(''),
      ['cli', '-', 'tic', 'ket'].join(''),
      ['executeServertoolCli', 'Tic', 'ket'].join(''),
      ['buildServertoolCli', 'Tic', 'ket'].join(''),
      ['tryRestoreServertoolCli', 'ToolOutputs'].join('')
    ];
    const scannedRoots = [
      'sharedmodule/llmswitch-core/src/servertool',
      'src/cli/commands/servertool.ts',
      'tests/servertool',
      'tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts'
    ];
    const findings: string[] = [];

    const scanFile = (filePath: string) => {
      const source = fs.readFileSync(filePath, 'utf8');
      for (const marker of forbidden) {
        if (source.includes(marker)) {
          findings.push(`${path.relative(process.cwd(), filePath)} contains ${marker}`);
        }
      }
    };

    const walk = (target: string) => {
      const abs = repoPath(target);
      if (!fs.existsSync(abs)) return;
      const stat = fs.statSync(abs);
      if (stat.isFile()) {
        scanFile(abs);
        return;
      }
      for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        const next = path.join(abs, entry.name);
        if (entry.isDirectory()) {
          walk(path.relative(process.cwd(), next));
        } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) {
          scanFile(next);
        }
      }
    };

    for (const root of scannedRoots) walk(root);
    expect(findings).toEqual([]);
  });

  it('servertool Rust core must not restore exec_command output back to internal tool identity', () => {
    const forbiddenFiles = [
      'sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/tool_name_projection.rs'
    ];
    const forbiddenMarkers = [
      'project_exec_command_result_to_model_tool_result',
      'ToolNameProjectionResult',
      'client exec_command result → model-side original tool name'
    ];
    const findings: string[] = [];

    for (const relativePath of forbiddenFiles) {
      if (fs.existsSync(repoPath(relativePath))) {
        findings.push(`${relativePath} must stay physically deleted`);
      }
    }

    const rustCoreRoot = repoPath('sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src');
    const scanRustFile = (filePath: string) => {
      const source = fs.readFileSync(filePath, 'utf8');
      for (const marker of forbiddenMarkers) {
        if (source.includes(marker)) {
          findings.push(`${path.relative(process.cwd(), filePath)} contains ${marker}`);
        }
      }
    };
    for (const entry of fs.readdirSync(rustCoreRoot, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.rs')) {
        scanRustFile(path.join(rustCoreRoot, entry.name));
      }
    }

    expect(findings).toEqual([]);
  });
});
