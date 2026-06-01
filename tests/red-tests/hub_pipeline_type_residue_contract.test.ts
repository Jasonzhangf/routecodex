import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const TYPES_DIR = path.join(
  ROOT,
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_types'
);

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  const stat = fs.statSync(dir);
  if (stat.isFile()) {
    if (dir.endsWith('.rs') || dir.endsWith('.ts')) out.push(dir);
    return out;
  }
  for (const entry of fs.readdirSync(dir)) walk(path.join(dir, entry), out);
  return out;
}

describe('Hub Pipeline type residue contract', () => {
  it('does not add generic process naming to new topology types', () => {
    const violations: string[] = [];
    for (const file of walk(TYPES_DIR)) {
      const source = fs.readFileSync(file, 'utf8');
      for (const pattern of [/ReqProc/, /RespProc/, /HubReqProcess/, /HubRespProcess/]) {
        if (pattern.test(source)) violations.push(`${file}: ${pattern}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('does not add temporary topology numbering to new topology types', () => {
    const violations: string[] = [];
    for (const file of walk(TYPES_DIR)) {
      const source = fs.readFileSync(file, 'utf8');
      for (const pattern of [/03b/i, /03_1/, /03\.5/, /03p5/i]) {
        if (pattern.test(source)) violations.push(`${file}: ${pattern}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps unsafe historical live-path deletions documented instead of pretending cleanup', () => {
    const checklist = fs.readFileSync(
      path.join(ROOT, 'docs/goals/hub-pipeline-phase-typing-residue-deletion-checklist.md'),
      'utf8'
    );
    expect(checklist).toContain('No safe live-path deletion in this phase');
    expect(checklist).toContain('req_process_stage1_tool_governance');
    expect(checklist).toContain('resp_process_stage1_tool_governance');
  });
});
