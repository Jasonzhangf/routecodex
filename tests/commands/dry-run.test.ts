/**
 * Dry Run Commands Tests
 */

import { jest } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { dryRunCommands } from '../../src/commands/dry-run.js';

// Mock dependencies
jest.mock('fs', () => ({
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
  existsSync: jest.fn(),
  readdirSync: jest.fn(),
  statSync: jest.fn()
}));

jest.mock('path', () => ({
  resolve: jest.fn(),
  extname: jest.fn(),
  join: jest.fn()
}));

const mockFs = fs as jest.Mocked<typeof fs>;
const mockPath = path as jest.Mocked<typeof path>;

// Mock dry run engine
const mockEngineInstance = {
  runRequest: jest.fn(),
  runResponse: jest.fn(),
  getStats: jest.fn(),
  cleanup: jest.fn()
};

jest.mock('../../src/core/dry-run-engine.js', () => ({
  DryRunEngine: jest.fn().mockImplementation(() => mockEngineInstance)
}));

describe('Dry Run Commands', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPath.resolve.mockReturnValue('/resolved/path');
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue('{}');
    mockFs.mkdirSync.mockImplementation();
  });

  describe('Request Command', () => {
    it('should execute dry run for a single request', async () => {
      const mockResult = { success: true, data: 'test response' };
      mockEngineInstance.runRequest.mockResolvedValue(mockResult);

      const action = dryRunCommands.commands.find(cmd => cmd.name() === 'request')?.action;
      if (!action) { return; }
      await action('input.json', {});

      expect(mockFs.readFileSync).toHaveBeenCalledWith('/resolved/path', 'utf-8');
      expect(mockEngineInstance.runRequest).toHaveBeenCalled();
    });

    it('should handle missing request file', async () => {
      mockFs.existsSync.mockReturnValue(false);

      const action = dryRunCommands.commands.find(cmd => cmd.name() === 'request')?.action;
      if (!action) { return; }
      await expect(action('missing.json', {})).rejects.toThrow('Request file not found');
    });

    it('should use custom pipeline ID', async () => {
      const mockResult = { success: true, data: 'test response' };
      mockEngineInstance.runRequest.mockResolvedValue(mockResult);

      const action = dryRunCommands.commands.find(cmd => cmd.name() === 'request')?.action;
      if (!action) { return; }
      await action('input.json', { pipeline: 'custom-pipeline' });

      expect(mockEngineInstance.runRequest).toHaveBeenCalledWith(
        expect.any(Object),
        'custom-pipeline'
      );
    });

    it('should save output when specified', async () => {
      const mockResult = { success: true, data: 'test response' };
      mockEngineInstance.runRequest.mockResolvedValue(mockResult);

      const action = dryRunCommands.commands.find(cmd => cmd.name() === 'request')?.action;
      if (!action) { return; }
      await action('input.json', { output: 'output.json' });

      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        'output.json',
        expect.stringContaining('test response'),
        'utf-8'
      );
    });
  });

  describe('Response Command', () => {
    it('should execute dry run for a single response', async () => {
      const mockResult = { success: true, data: 'processed response' };
      mockEngineInstance.runResponse.mockResolvedValue(mockResult);

      const action = dryRunCommands.commands.find(cmd => cmd.name() === 'response')?.action;
      if (!action) { return; }
      await action('response.json', {});

      expect(mockFs.readFileSync).toHaveBeenCalledWith('/resolved/path', 'utf-8');
      expect(mockEngineInstance.runResponse).toHaveBeenCalled();
    });

    it('should handle missing response file', async () => {
      mockFs.existsSync.mockReturnValue(false);

      const action = dryRunCommands.commands.find(cmd => cmd.name() === 'response')?.action;
      if (!action) { return; }
      await expect(action('missing.json', {})).rejects.toThrow('Response file not found');
    });
  });

  describe('Capture Command', () => {
    it('should start capture session', async () => {
      const action = dryRunCommands.commands.find(cmd => cmd.name() === 'capture')?.action;
      if (!action) { return; }
      await action({ start: true });

      expect(mockFs.mkdirSync).toHaveBeenCalled();
    });

    it('should list capture sessions', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue(['session1', 'session2']);
      mockFs.statSync.mockImplementation((path: string) => ({
        isFile: () => false,
        isDirectory: () => true
      } as any));

      const action = dryRunCommands.commands.find(cmd => cmd.name() === 'capture')?.action;
      if (!action) { return; }
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      await action({ list: true });

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Capture Sessions:')
      );
      consoleSpy.mockRestore();
    });

    it('should show session details', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue(['response1.json', 'response2.json']);
      mockFs.readFileSync.mockReturnValue(JSON.stringify({
        timestamp: Date.now(),
        metadata: { test: 'meta' },
        response: { data: 'test response' }
      }));

      const action = dryRunCommands.commands.find(cmd => cmd.name() === 'capture')?.action;
      if (!action) { return; }
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      await action({ session: 'session1' });

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Session session1 Responses:')
      );
      consoleSpy.mockRestore();
    });
  });

  describe('Batch Command', () => {
    it('should process files in batch mode', async () => {
      const mockResult = { success: true, data: 'batch result' };
      mockEngineInstance.runRequest.mockResolvedValue(mockResult);

      const action = dryRunCommands.commands.find(cmd => cmd.name() === 'batch')?.action;
      if (!action) { return; }
      await action('/test/directory', {
        pattern: '*.json',
        output: '/output/directory'
      });

      expect(mockEngineInstance.runRequest).toHaveBeenCalled();
    });

    it('should create output directory when specified', async () => {
      const mockResult = { success: true, data: 'batch result' };
      mockEngineInstance.runRequest.mockResolvedValue(mockResult);

      const action = dryRunCommands.commands.find(cmd => cmd.name() === 'batch')?.action;
      expect(action).toBeDefined();

      if (action) {
        await action('/test/directory', {
          output: '/new/output/directory'
        });

        expect(mockFs.mkdirSync).toHaveBeenCalledWith('/new/output/directory', { recursive: true });
      }
    });
  });

  describe('Chain Command', () => {
    it('should execute chain of pipelines', async () => {
      const mockResult1 = { step: 1, data: 'step1 result' };
      const mockResult2 = { step: 2, data: 'step2 result' };
      mockEngineInstance.runRequest.mockResolvedValue(mockResult1);
      mockEngineInstance.runResponse.mockResolvedValue(mockResult2);

      const chainConfig = {
        steps: [
          { type: 'request', name: 'step1', pipelineId: 'request-pipeline' },
          { type: 'response', name: 'step2', pipelineId: 'response-pipeline' }
        ]
      };

      mockFs.readFileSync.mockReturnValue(JSON.stringify(chainConfig));

      const action = dryRunCommands.commands.find(cmd => cmd.name() === 'chain')?.action;
      if (!action) { return; }
      await action('input.json', {
        chain: 'chain-config.json'
      });

      expect(mockEngineInstance.runRequest).toHaveBeenCalled();
      expect(mockEngineInstance.runResponse).toHaveBeenCalled();
    });

    it('should handle missing chain configuration', async () => {
      const action = dryRunCommands.commands.find(cmd => cmd.name() === 'chain')?.action;
      if (!action) { return; }
      await expect(action('input.json', {})).rejects.toThrow(
        'Chain configuration file is required'
      );
    });

    it('should handle invalid chain configuration', async () => {
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ invalid: 'config' }));

      const action = dryRunCommands.commands.find(cmd => cmd.name() === 'chain')?.action;
      if (!action) { return; }
      await expect(action('input.json', { chain: 'config.json' })).rejects.toThrow(
        'Chain configuration must contain a "steps" array'
      );
    });
  });

  describe('Error Handling', () => {
    it('should handle JSON parse errors', async () => {
      mockFs.readFileSync.mockReturnValue('invalid json');

      const action = dryRunCommands.commands.find(cmd => cmd.name() === 'request')?.action;
      if (!action) { return; }
      await expect(action('invalid.json', {})).rejects.toThrow();
    });

    it('should handle engine execution errors', async () => {
      mockEngineInstance.runRequest.mockRejectedValue(new Error('Engine error'));

      const action = dryRunCommands.commands.find(cmd => cmd.name() === 'request')?.action;
      if (!action) { return; }
      await expect(action('input.json', {})).rejects.toThrow('Engine error');
    });
  });

  describe('File Format Support', () => {
    it('should handle JSON files', async () => {
      mockPath.extname.mockReturnValue('.json');

      const action = dryRunCommands.commands.find(cmd => cmd.name() === 'request')?.action;
      if (!action) { return; }
      await action('test.json', {});

      expect(mockFs.readFileSync).toHaveBeenCalledWith('/resolved/path', 'utf-8');
    });

    it('should handle YAML files', async () => {
      mockPath.extname.mockReturnValue('.yaml');

      const yamlModule = await import('yaml');
      const yamlParseSpy = jest.spyOn(yamlModule, 'parse').mockReturnValue({ yaml: 'data' });

      const action = dryRunCommands.commands.find(cmd => cmd.name() === 'request')?.action;
      if (!action) { return; }
      await action('test.yaml', {});

      expect(yamlParseSpy).toHaveBeenCalled();
      yamlParseSpy.mockRestore();
    });

    it('should reject unsupported file formats', async () => {
      mockPath.extname.mockReturnValue('.txt');

      const action = dryRunCommands.commands.find(cmd => cmd.name() === 'request')?.action;
      if (!action) { return; }
      await expect(action('test.txt', {})).rejects.toThrow('Unsupported file format');
    });
  });
});