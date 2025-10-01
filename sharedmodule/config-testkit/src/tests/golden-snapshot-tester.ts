/**
 * RouteCodex Golden Snapshot Testing Framework
 * Manages golden snapshots for configuration testing
 */

import { ConfigParser } from 'routecodex-config-engine';
import { CompatibilityEngine } from 'routecodex-config-compat';
import type {
  GoldenSnapshot,
  SnapshotTolerance,
  SnapshotResult,
  TestResult,
  TestError
} from '../types/testkit-types.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';

export class GoldenSnapshotTester {
  private configParser: ConfigParser;
  private compatibilityEngine: CompatibilityEngine;
  private snapshotsDir: string;

  constructor(snapshotsDir: string = './snapshots') {
    this.configParser = new ConfigParser();
    this.compatibilityEngine = new CompatibilityEngine();
    this.snapshotsDir = snapshotsDir;
    this.ensureSnapshotsDirectory();
  }

  /**
   * Test configuration against golden snapshot
   */
  async testAgainstSnapshot(
    snapshotId: string,
    inputConfig: any,
    updateSnapshots = false
  ): Promise<SnapshotResult> {
    const snapshot = await this.loadSnapshot(snapshotId);

    // Process the input configuration
    const validationResult = await this.configParser.parseFromString(
      JSON.stringify(inputConfig)
    );

    const compatibilityResult = validationResult.isValid
      ? await this.compatibilityEngine.processCompatibility(
          JSON.stringify(inputConfig)
        )
      : validationResult;

    const actualOutput = this.normalizeOutput(compatibilityResult);

    if (updateSnapshots) {
      // Update the snapshot with new output
      const updatedSnapshot: GoldenSnapshot = {
        ...snapshot,
        expectedOutput: actualOutput,
        metadata: {
          ...snapshot.metadata,
          timestamp: Date.now()
        }
      };

      await this.saveSnapshot(updatedSnapshot);
      return {
        id: snapshotId,
        status: 'updated'
      };
    }

    // Compare against expected output
    const comparison = this.compareWithTolerance(
      actualOutput,
      snapshot.expectedOutput,
      snapshot.tolerance
    );

    return {
      id: snapshotId,
      status: comparison.matches ? 'passed' : 'failed',
      diff: comparison.diff,
      toleranceApplied: comparison.toleranceApplied
    };
  }

  /**
   * Create a new golden snapshot
   */
  async createSnapshot(
    snapshotId: string,
    name: string,
    description: string,
    inputConfig: any,
    tags: string[] = [],
    tolerance?: SnapshotTolerance
  ): Promise<GoldenSnapshot> {
    // Process the input configuration
    const validationResult = await this.configParser.parseFromString(
      JSON.stringify(inputConfig)
    );

    const compatibilityResult = validationResult.isValid
      ? await this.compatibilityEngine.processCompatibility(
          JSON.stringify(inputConfig)
        )
      : validationResult;

    const expectedOutput = this.normalizeOutput(compatibilityResult);

    const snapshot: GoldenSnapshot = {
      id: snapshotId,
      name,
      description,
      input: inputConfig,
      expectedOutput,
      metadata: {
        version: '1.0.0',
        timestamp: Date.now(),
        author: 'test',
        tags
      },
      tolerance
    };

    await this.saveSnapshot(snapshot);
    return snapshot;
  }

  /**
   * Load a snapshot from disk
   */
  async loadSnapshot(snapshotId: string): Promise<GoldenSnapshot> {
    const snapshotPath = this.getSnapshotPath(snapshotId);

    if (!existsSync(snapshotPath)) {
      throw new Error(`Snapshot not found: ${snapshotId}`);
    }

    try {
      const content = readFileSync(snapshotPath, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      throw new Error(`Failed to load snapshot ${snapshotId}: ${error}`);
    }
  }

  /**
   * Save a snapshot to disk
   */
  async saveSnapshot(snapshot: GoldenSnapshot): Promise<void> {
    const snapshotPath = this.getSnapshotPath(snapshot.id);
    const content = JSON.stringify(snapshot, null, 2);

    try {
      writeFileSync(snapshotPath, content, 'utf8');
    } catch (error) {
      throw new Error(`Failed to save snapshot ${snapshot.id}: ${error}`);
    }
  }

  /**
   * Test all snapshots against current implementation
   */
  async testAllSnapshots(updateSnapshots = false): Promise<SnapshotResult[]> {
    const results: SnapshotResult[] = [];
    const snapshots = await this.listAllSnapshots();

    for (const snapshot of snapshots) {
      try {
        const result = await this.testAgainstSnapshot(
          snapshot.id,
          snapshot.input,
          updateSnapshots
        );
        results.push(result);
      } catch (error) {
        results.push({
          id: snapshot.id,
          status: 'failed',
          diff: `Error loading snapshot: ${error}`
        });
      }
    }

    return results;
  }

  /**
   * List all available snapshots
   */
  async listAllSnapshots(): Promise<GoldenSnapshot[]> {
    const snapshots: GoldenSnapshot[] = [];

    if (!existsSync(this.snapshotsDir)) {
      return snapshots;
    }

    const files = readdirSync(this.snapshotsDir)
      .filter(file => file.endsWith('.json'))
      .map(file => file.replace('.json', ''));

    for (const snapshotId of files) {
      try {
        const snapshot = await this.loadSnapshot(snapshotId);
        snapshots.push(snapshot);
      } catch (error) {
        console.warn(`Failed to load snapshot ${snapshotId}:`, error);
      }
    }

    return snapshots;
  }

  /**
   * Validate all snapshots (check if they can be loaded)
   */
  async validateSnapshots(): Promise<{ valid: GoldenSnapshot[]; invalid: string[] }> {
    const valid: GoldenSnapshot[] = [];
    const invalid: string[] = [];

    if (!existsSync(this.snapshotsDir)) {
      return { valid, invalid };
    }

    const files = readdirSync(this.snapshotsDir)
      .filter(file => file.endsWith('.json'))
      .map(file => file.replace('.json', ''));

    for (const snapshotId of files) {
      try {
        const snapshot = await this.loadSnapshot(snapshotId);
        valid.push(snapshot);
      } catch (error) {
        invalid.push(snapshotId);
      }
    }

    return { valid, invalid };
  }

  /**
   * Compare actual output with expected output using tolerance settings
   */
  private compareWithTolerance(
    actual: any,
    expected: any,
    tolerance?: SnapshotTolerance
  ): { matches: boolean; diff?: string; toleranceApplied?: boolean } {
    if (tolerance?.custom) {
      const matches = tolerance.custom(actual, expected);
      return {
        matches,
        toleranceApplied: true
      };
    }

    return this.deepCompare(actual, expected, tolerance);
  }

  /**
   * Deep comparison with tolerance settings
   */
  private deepCompare(
    actual: any,
    expected: any,
    tolerance?: SnapshotTolerance,
    path = ''
  ): { matches: boolean; diff?: string; toleranceApplied?: boolean } {
    // Handle primitive types
    if (typeof actual !== 'object' || actual === null || expected === null) {
      return this.comparePrimitive(actual, expected, path, tolerance);
    }

    // Handle arrays
    if (Array.isArray(actual) && Array.isArray(expected)) {
      return this.compareArrays(actual, expected, path, tolerance);
    }

    // Handle objects
    return this.compareObjects(actual, expected, path, tolerance);
  }

  /**
   * Compare primitive values with tolerance
   */
  private comparePrimitive(
    actual: any,
    expected: any,
    path: string,
    tolerance?: SnapshotTolerance
  ): { matches: boolean; diff?: string; toleranceApplied?: boolean } {
    // Handle numeric tolerance
    if (typeof actual === 'number' && typeof expected === 'number' && tolerance?.numeric) {
      const diff = Math.abs(actual - expected);
      const matches = diff <= tolerance.numeric;
      return {
        matches,
        diff: matches ? undefined : `${path}: Expected ${expected}, got ${actual} (diff: ${diff})`,
        toleranceApplied: true
      };
    }

    // Handle string tolerance
    if (typeof actual === 'string' && typeof expected === 'string' && tolerance?.string === 'fuzzy') {
      const matches = actual.toLowerCase().includes(expected.toLowerCase()) ||
                     expected.toLowerCase().includes(actual.toLowerCase());
      return {
        matches,
        diff: matches ? undefined : `${path}: String mismatch (fuzzy comparison failed)`,
        toleranceApplied: true
      };
    }

    // Exact comparison
    const matches = actual === expected;
    return {
      matches,
      diff: matches ? undefined : `${path}: Expected ${expected}, got ${actual}`
    };
  }

  /**
   * Compare arrays with tolerance
   */
  private compareArrays(
    actual: any[],
    expected: any[],
    path: string,
    tolerance?: SnapshotTolerance
  ): { matches: boolean; diff?: string; toleranceApplied?: boolean } {
    if (actual.length !== expected.length) {
      return {
        matches: false,
        diff: `${path}: Array length mismatch. Expected ${expected.length}, got ${actual.length}`
      };
    }

    if (tolerance?.array === 'unordered') {
      // Unordered comparison - check if all elements exist (order doesn't matter)
      const remainingExpected = [...expected];
      let allMatched = true;
      const diffs: string[] = [];

      for (const item of actual) {
        let foundMatch = false;
        for (let i = 0; i < remainingExpected.length; i++) {
          const result = this.deepCompare(item, remainingExpected[i], tolerance, `${path}[?]`);
          if (result.matches) {
            remainingExpected.splice(i, 1);
            foundMatch = true;
            break;
          }
        }

        if (!foundMatch) {
          allMatched = false;
          diffs.push(`${path}: Item ${JSON.stringify(item)} not found in expected array`);
        }
      }

      return {
        matches: allMatched && remainingExpected.length === 0,
        diff: diffs.length > 0 ? diffs.join(', ') : undefined,
        toleranceApplied: tolerance?.array === 'unordered'
      };
    } else {
      // Ordered comparison
      for (let i = 0; i < actual.length; i++) {
        const result = this.deepCompare(actual[i], expected[i], tolerance, `${path}[${i}]`);
        if (!result.matches) {
          return result;
        }
      }
    }

    return { matches: true };
  }

  /**
   * Compare objects with tolerance
   */
  private compareObjects(
    actual: any,
    expected: any,
    path: string,
    tolerance?: SnapshotTolerance
  ): { matches: boolean; diff?: string; toleranceApplied?: boolean } {
    const actualKeys = Object.keys(actual);
    const expectedKeys = Object.keys(expected);

    if (tolerance?.object === 'subset-keys') {
      // Check if actual is a subset of expected
      for (const key of actualKeys) {
        if (!expectedKeys.includes(key)) {
          return {
            matches: false,
            diff: `${path}: Extra key '${key}' in actual object`,
            toleranceApplied: true
          };
        }
      }

      // Only compare keys that exist in actual
      for (const key of actualKeys) {
        const result = this.deepCompare(actual[key], expected[key], tolerance, `${path}.${key}`);
        if (!result.matches) {
          return result;
        }
      }
    } else {
      // Exact key comparison
      if (actualKeys.length !== expectedKeys.length) {
        return {
          matches: false,
          diff: `${path}: Object key count mismatch. Expected ${expectedKeys.length}, got ${actualKeys.length}`
        };
      }

      for (const key of actualKeys) {
        if (!expectedKeys.includes(key)) {
          return {
            matches: false,
            diff: `${path}: Extra key '${key}' in actual object`
          };
        }

        const result = this.deepCompare(actual[key], expected[key], tolerance, `${path}.${key}`);
        if (!result.matches) {
          return result;
        }
      }
    }

    return { matches: true };
  }

  /**
   * Normalize output for snapshot comparison
   */
  private normalizeOutput(result: any): any {
    const normalized = JSON.parse(JSON.stringify(result));

    // Remove dynamic fields that shouldn't be part of snapshots
    this.removeDynamicFields(normalized);

    return normalized;
  }

  /**
   * Remove dynamic fields that change between runs
   */
  private removeDynamicFields(obj: any, path = ''): void {
    if (typeof obj !== 'object' || obj === null) return;

    // Remove timestamp fields
    if (path.includes('timestamp') || path.includes('duration') || path.includes('metadata')) {
      return;
    }

    // Remove compatibility warnings that might be dynamic
    if (path.includes('compatibilityWarnings')) {
      return;
    }

    // Recursively process object properties
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        if (typeof obj[key] === 'object' && obj[key] !== null) {
          this.removeDynamicFields(obj[key], `${path}.${key}`);
        }
      }
    }
  }

  /**
   * Get file path for a snapshot
   */
  private getSnapshotPath(snapshotId: string): string {
    return join(this.snapshotsDir, `${snapshotId}.json`);
  }

  /**
   * Ensure snapshots directory exists
   */
  private ensureSnapshotsDirectory(): void {
    if (!existsSync(this.snapshotsDir)) {
      mkdirSync(this.snapshotsDir, { recursive: true });
    }
  }

  /**
   * Generate diff string for detailed reporting
   */
  generateDiff(actual: any, expected: any): string {
    const actualStr = JSON.stringify(actual, null, 2);
    const expectedStr = JSON.stringify(expected, null, 2);

    if (actualStr === expectedStr) {
      return '';
    }

    // Simple line-by-line diff
    const actualLines = actualStr.split('\n');
    const expectedLines = expectedStr.split('\n');
    const diffLines: string[] = [];

    const maxLines = Math.max(actualLines.length, expectedLines.length);
    for (let i = 0; i < maxLines; i++) {
      const actualLine = actualLines[i] || '';
      const expectedLine = expectedLines[i] || '';

      if (actualLine !== expectedLine) {
        diffLines.push(`- ${expectedLine}`);
        diffLines.push(`+ ${actualLine}`);
      } else {
        diffLines.push(`  ${actualLine}`);
      }
    }

    return diffLines.join('\n');
  }
}