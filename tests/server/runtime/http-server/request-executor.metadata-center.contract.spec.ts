import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from '@jest/globals';

const ROOT = process.cwd();
const REQUEST_EXECUTOR_PATH = path.join(ROOT, 'src/server/runtime/http-server/request-executor.ts');
let MetadataCenter: any;
let writeProviderProtocolRuntimeControl: any;

beforeAll(async () => {
  ({ MetadataCenter } = await import(
    '../../../../src/server/runtime/http-server/metadata-center/metadata-center.ts'
  ));
  ({ writeProviderProtocolRuntimeControl } = await import(
    '../../../../src/server/runtime/http-server/request-executor.ts'
  ));
});

describe('request-executor metadata center contract', () => {
  it('reuses mergedMetadata instead of cloning when building conversionPipelineMetadata', () => {
    const source = fs.readFileSync(REQUEST_EXECUTOR_PATH, 'utf8');

    expect(source).not.toContain('function cloneMetadataPreservingBoundCenter(');
    expect(source).toContain('mergedMetadata.routeName = pipelineRouteName;');
    expect(source).toContain('mergedMetadata.responseSemantics = responseSemantics;');
    expect(source).toContain('const conversionPipelineMetadata = mergedMetadata;');
  });

  it('writes providerProtocol into the bound MetadataCenter runtime control', () => {
    const metadata: Record<string, unknown> = {};
    const center = MetadataCenter.attach(metadata);

    writeProviderProtocolRuntimeControl(metadata, 'openai-responses');

    expect(center.readRuntimeControl().providerProtocol).toBe('openai-responses');
    expect(metadata.providerProtocol).toBeUndefined();
  });
});
