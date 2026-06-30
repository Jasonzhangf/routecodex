import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import YAML from 'yaml';

describe('feature_id: debug.internal_error_numbering mainline assets', () => {
  it('keeps function map, verification map, manifest, and wiki queryable', () => {
    const functionMap = YAML.parse(fs.readFileSync('docs/architecture/function-map.yml', 'utf8'));
    const verificationMap = YAML.parse(fs.readFileSync('docs/architecture/verification-map.yml', 'utf8'));
    const manifest = YAML.parse(fs.readFileSync('docs/architecture/mainline-manifests/internal-error-numbering.mainline.yml', 'utf8'));
    const mainline = YAML.parse(fs.readFileSync('docs/architecture/mainline-call-map.yml', 'utf8'));
    const wiki = fs.readFileSync('docs/architecture/wiki/internal-error-numbering-mainline-source.md', 'utf8');

    expect((functionMap.owners ?? []).some((row: { feature_id?: string }) => row.feature_id === 'debug.internal_error_numbering')).toBe(true);
    expect((verificationMap.verification ?? []).some((row: { feature_id?: string }) => row.feature_id === 'debug.internal_error_numbering')).toBe(true);
    expect(manifest.lifecycle_id).toBe('internal_error_numbering.mainline');
    expect((mainline.chains ?? []).some((row: { chain_id?: string }) => row.chain_id === 'internal_error_numbering.mainline')).toBe(true);
    expect(wiki).toContain('IntErrNum01SourceObserved');
    expect(wiki).toContain('IntErrNum07ClientBoundaryPreserved');
    expect(wiki).toContain('external errors are linked, not wrapped');
  });
});
