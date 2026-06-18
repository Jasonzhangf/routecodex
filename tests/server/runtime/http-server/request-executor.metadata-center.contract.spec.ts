import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

const ROOT = process.cwd();
const REQUEST_EXECUTOR_PATH = path.join(
  ROOT,
  'src/server/runtime/http-server/request-executor.ts'
);

describe('request-executor metadata center contract', () => {
  it('reuses mergedMetadata instead of cloning when building conversionPipelineMetadata', () => {
    const source = fs.readFileSync(REQUEST_EXECUTOR_PATH, 'utf8');

    expect(source).not.toContain('function cloneMetadataPreservingBoundCenter(');
    expect(source).toContain('mergedMetadata.routeName = pipelineRouteName;');
    expect(source).toContain('mergedMetadata.responseSemantics = responseSemantics;');
    expect(source).toContain('const conversionPipelineMetadata = mergedMetadata;');
  });
});
