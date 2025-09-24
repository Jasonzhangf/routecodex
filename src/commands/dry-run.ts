/**
 * Dry-Run CLI Commands
 *
 * Comprehensive CLI interface for the Dry-Run Engine supporting:
 * - Request pipeline execution
 * - Response pipeline execution
 * - Response capture functionality
 * - Batch processing
 * - Chain processing
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs';
import path from 'path';
import { homedir } from 'os';
import { DryRunEngine, dryRunEngine } from '../modules/dry-run-engine/index.js';
import type { RunRequestOptions, RunResponseOptions, RunBidirectionalOptions } from '../modules/dry-run-engine/index.js';

// Logger for consistent output
const logger = {
  info: (msg: string) => console.log(chalk.blue('ℹ') + ' ' + msg),
  success: (msg: string) => console.log(chalk.green('✓') + ' ' + msg),
  warning: (msg: string) => console.log(chalk.yellow('⚠') + ' ' + msg),
  error: (msg: string) => console.log(chalk.red('✗') + ' ' + msg),
  debug: (msg: string) => console.log(chalk.gray('◉') + ' ' + msg)
};

// File format detection utilities
function detectFileFormat(filePath: string): 'json' | 'yaml' | 'yml' {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.json':
      return 'json';
    case '.yaml':
    case '.yml':
      return 'yaml';
    default:
      throw new Error(`Unsupported file format: ${ext}. Supported formats: .json, .yaml, .yml`);
  }
}

// File reading utilities
async function loadFile(filePath: string): Promise<any> {
  try {
    const fullPath = path.resolve(filePath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${fullPath}`);
    }

    const format = detectFileFormat(fullPath);
    const content = fs.readFileSync(fullPath, 'utf-8');

    switch (format) {
      case 'json':
        return JSON.parse(content);
      case 'yaml':
      case 'yml':
        // Dynamically import YAML parser
        const yamlModule = await import('yaml');
        return yamlModule.parse(content);
      default:
        throw new Error(`Unsupported format: ${format}`);
    }
  } catch (error) {
    throw new Error(`Failed to load file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Output formatting utilities
function formatOutput(data: any, format: 'json' | 'pretty'): void {
  switch (format) {
    case 'json':
      console.log(JSON.stringify(data, null, 2));
      break;
    case 'pretty':
      console.log(chalk.cyan('Dry-Run Results:'));
      console.log('=' .repeat(50));
      console.log(JSON.stringify(data, null, 2));
      break;
  }
}

// Directory scanning for batch processing
async function scanDirectory(dirPath: string, pattern: string = '*.json'): Promise<string[]> {
  const fullPath = path.resolve(dirPath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Directory not found: ${fullPath}`);
  }

  const files: string[] = [];
  const entries = fs.readdirSync(fullPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isFile()) {
      const fileName = entry.name;
      if (pattern === '*.json' && fileName.endsWith('.json')) {
        files.push(path.join(fullPath, fileName));
      } else if (pattern === '*.yaml' && (fileName.endsWith('.yaml') || fileName.endsWith('.yml'))) {
        files.push(path.join(fullPath, fileName));
      } else if (pattern === '*.*' && (fileName.endsWith('.json') || fileName.endsWith('.yaml') || fileName.endsWith('.yml'))) {
        files.push(path.join(fullPath, fileName));
      }
    }
  }

  return files.sort();
}

// Response capture functionality
class ResponseCapture {
  private captureDir: string;
  private currentSession: string | null = null;

  constructor(captureDir: string = path.join(homedir(), '.routecodex', 'captures')) {
    this.captureDir = captureDir;
    if (!fs.existsSync(captureDir)) {
      fs.mkdirSync(captureDir, { recursive: true });
    }
  }

  startSession(): string {
    this.currentSession = `session_${Date.now()}`;
    const sessionDir = path.join(this.captureDir, this.currentSession);
    fs.mkdirSync(sessionDir, { recursive: true });
    return this.currentSession;
  }

  captureResponse(response: any, metadata: any = {}): void {
    if (!this.currentSession) {
      throw new Error('No active capture session. Call startSession() first.');
    }

    const timestamp = Date.now();
    const filename = `response_${timestamp}.json`;
    const filepath = path.join(this.captureDir, this.currentSession, filename);

    const captureData = {
      timestamp,
      metadata,
      response
    };

    fs.writeFileSync(filepath, JSON.stringify(captureData, null, 2));
  }

  listSessions(): string[] {
    if (!fs.existsSync(this.captureDir)) {
      return [];
    }

    return fs.readdirSync(this.captureDir)
      .filter(entry => fs.statSync(path.join(this.captureDir, entry)).isDirectory())
      .sort();
  }

  getSessionResponses(sessionId: string): any[] {
    const sessionDir = path.join(this.captureDir, sessionId);
    if (!fs.existsSync(sessionDir)) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const files = fs.readdirSync(sessionDir)
      .filter(file => file.endsWith('.json'))
      .sort();

    return files.map(file => {
      const content = fs.readFileSync(path.join(sessionDir, file), 'utf-8');
      return JSON.parse(content);
    });
  }
}

// Create dry-run command group
export function createDryRunCommands(): Command {
  const dryRun = new Command('dry-run')
    .description('Dry-run execution and testing commands');

  // Request command
  dryRun
    .command('request')
    .description('Execute request pipeline dry-run')
    .argument('<input>', 'Input file path (JSON/YAML)')
    .option('-p, --pipeline-id <id>', 'Pipeline ID', 'request-pipeline')
    .option('-m, --mode <mode>', 'Execution mode (normal|dry-run|mixed)', 'dry-run')
    .option('-o, --output <format>', 'Output format (json|pretty)', 'json')
    .option('--save <path>', 'Save results to file')
    .option('--node-config <path>', 'Node configuration file')
    .action(async (input, options) => {
      const spinner = ora('Running request pipeline...').start();

      try {
        // Load request data
        const request = await loadFile(input);

        // Load node configuration if provided
        let nodeConfigs = undefined;
        if (options.nodeConfig) {
          nodeConfigs = await loadFile(options.nodeConfig);
        }

        // Execute pipeline
        const result = await dryRunEngine.runRequest(request, {
          pipelineId: options.pipelineId,
          mode: options.mode,
          nodeConfigs
        });

        spinner.succeed('Request pipeline completed');

        // Output results
        formatOutput(result, options.output);

        // Save results if requested
        if (options.save) {
          const outputPath = path.resolve(options.save);
          fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
          logger.success(`Results saved to: ${outputPath}`);
        }

      } catch (error) {
        spinner.fail('Request pipeline failed');
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  // Response command
  dryRun
    .command('response')
    .description('Execute response pipeline dry-run')
    .argument('<input>', 'Input file path (JSON/YAML)')
    .option('-p, --pipeline-id <id>', 'Pipeline ID', 'response-pipeline')
    .option('-m, --mode <mode>', 'Execution mode (dry-run|mixed)', 'dry-run')
    .option('-o, --output <format>', 'Output format (json|pretty)', 'json')
    .option('--save <path>', 'Save results to file')
    .option('--node-config <path>', 'Node configuration file')
    .action(async (input, options) => {
      const spinner = ora('Running response pipeline...').start();

      try {
        // Load response data
        const response = await loadFile(input);

        // Load node configuration if provided
        let nodeConfigs = undefined;
        if (options.nodeConfig) {
          nodeConfigs = await loadFile(options.nodeConfig);
        }

        // Execute pipeline
        const result = await dryRunEngine.runResponse(response, {
          pipelineId: options.pipelineId,
          mode: options.mode,
          nodeConfigs
        });

        spinner.succeed('Response pipeline completed');

        // Output results
        formatOutput(result, options.output);

        // Save results if requested
        if (options.save) {
          const outputPath = path.resolve(options.save);
          fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
          logger.success(`Results saved to: ${outputPath}`);
        }

      } catch (error) {
        spinner.fail('Response pipeline failed');
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  // Capture command
  dryRun
    .command('capture')
    .description('Capture and manage responses')
    .option('--start', 'Start a new capture session')
    .option('--list', 'List capture sessions')
    .option('--session <id>', 'View session details')
    .option('--output <path>', 'Output captured responses to file')
    .action(async (options) => {
      const capture = new ResponseCapture();

      try {
        if (options.start) {
          const sessionId = capture.startSession();
          logger.success(`Capture session started: ${sessionId}`);
          logger.info('Use response capture during pipeline execution to store responses');
        } else if (options.list) {
          const sessions = capture.listSessions();
          if (sessions.length === 0) {
            logger.info('No capture sessions found');
          } else {
            console.log(chalk.cyan('Capture Sessions:'));
            sessions.forEach(session => {
              console.log(`  - ${session}`);
            });
          }
        } else if (options.session) {
          const responses = capture.getSessionResponses(options.session);
          console.log(chalk.cyan(`Session ${options.session} Responses:`));
          responses.forEach((resp, index) => {
            console.log(`\nResponse ${index + 1}:`);
            console.log(`  Timestamp: ${new Date(resp.timestamp).toISOString()}`);
            if (resp.metadata) {
              console.log(`  Metadata: ${JSON.stringify(resp.metadata, null, 2)}`);
            }
            console.log(`  Response: ${JSON.stringify(resp.response, null, 2)}`);
          });

          // Save to file if requested
          if (options.output) {
            const outputPath = path.resolve(options.output);
            fs.writeFileSync(outputPath, JSON.stringify(responses, null, 2));
            logger.success(`Responses saved to: ${outputPath}`);
          }
        } else {
          logger.info('Use --start, --list, or --session <id> to manage capture sessions');
        }
      } catch (error) {
        logger.error('Capture command failed: ' + (error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });

  // Batch command
  dryRun
    .command('batch')
    .description('Execute batch processing on multiple files')
    .argument('<directory>', 'Directory containing input files')
    .option('-p, --pattern <pattern>', 'File pattern (*.json, *.yaml, *.*)', '*.json')
    .option('--pipeline-id <id>', 'Pipeline ID', 'batch-pipeline')
    .option('-m, --mode <mode>', 'Execution mode (normal|dry-run|mixed)', 'dry-run')
    .option('-o, --output <dir>', 'Output directory for results')
    .option('--parallel', 'Process files in parallel', false)
    .option('--max-concurrent <number>', 'Maximum concurrent processes', '5')
    .action(async (directory, options) => {
      const spinner = ora('Scanning directory...').start();

      try {
        // Scan directory for files
        const files = await scanDirectory(directory, options.pattern);

        if (files.length === 0) {
          spinner.warn('No matching files found');
          return;
        }

        spinner.text = `Found ${files.length} files to process`;

        // Create output directory if specified
        if (options.output) {
          const outputDir = path.resolve(options.output);
          if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
          }
        }

        const results: any[] = [];
        const maxConcurrent = parseInt(options.maxConcurrent);

        // Process files
        if (options.parallel) {
          // Parallel processing
          const chunks: string[][] = [];
          for (let i = 0; i < files.length; i += maxConcurrent) {
            chunks.push(files.slice(i, i + maxConcurrent));
          }

          for (const chunk of chunks) {
            const promises = chunk.map(async (file) => {
              try {
                const request = await loadFile(file);
                const result = await dryRunEngine.runRequest(request, {
                  pipelineId: options.pipelineId,
                  mode: options.mode
                });

                const fileName = path.basename(file, path.extname(file));
                const outputData = {
                  input: file,
                  result,
                  timestamp: new Date().toISOString()
                };

                if (options.output) {
                  const outputPath = path.join(options.output, `${fileName}_result.json`);
                  fs.writeFileSync(outputPath, JSON.stringify(outputData, null, 2));
                }

                return outputData;
              } catch (error) {
                logger.error(`Failed to process ${file}: ${error instanceof Error ? error.message : String(error)}`);
                return null;
              }
            });

            const chunkResults = await Promise.all(promises);
            results.push(...chunkResults.filter(r => r !== null));
          }
        } else {
          // Sequential processing
          for (const file of files) {
            spinner.text = `Processing ${path.basename(file)}...`;

            try {
              const request = await loadFile(file);
              const result = await dryRunEngine.runRequest(request, {
                pipelineId: options.pipelineId,
                mode: options.mode
              });

              const fileName = path.basename(file, path.extname(file));
              const outputData = {
                input: file,
                result,
                timestamp: new Date().toISOString()
              };

              if (options.output) {
                const outputPath = path.join(options.output, `${fileName}_result.json`);
                fs.writeFileSync(outputPath, JSON.stringify(outputData, null, 2));
              }

              results.push(outputData);
            } catch (error) {
              logger.error(`Failed to process ${file}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }

        spinner.succeed(`Batch processing completed. Processed ${results.length}/${files.length} files`);

        // Output summary
        console.log(chalk.cyan('\nBatch Processing Summary:'));
        console.log(`Total files: ${files.length}`);
        console.log(`Successfully processed: ${results.length}`);
        console.log(`Failed: ${files.length - results.length}`);

        if (options.output) {
          logger.success(`Results saved to: ${options.output}`);
        }

      } catch (error) {
        spinner.fail('Batch processing failed');
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  // Chain command
  dryRun
    .command('chain')
    .description('Execute chain of pipelines')
    .argument('<input>', 'Input file path (JSON/YAML)')
    .option('-c, --chain <config>', 'Chain configuration file (JSON/YAML)')
    .option('-o, --output <format>', 'Output format (json|pretty)', 'json')
    .option('--save <path>', 'Save results to file')
    .action(async (input, options) => {
      const spinner = ora('Running chain execution...').start();

      try {
        // Load input data
        const inputData = await loadFile(input);

        // Load chain configuration
        if (!options.chain) {
          throw new Error('Chain configuration file is required. Use --chain <config>');
        }

        const chainConfig = await loadFile(options.chain);

        if (!chainConfig.steps || !Array.isArray(chainConfig.steps)) {
          throw new Error('Chain configuration must contain a "steps" array');
        }

        // Execute chain
        let currentData = inputData;
        const results: any[] = [];

        for (let i = 0; i < chainConfig.steps.length; i++) {
          const step = chainConfig.steps[i];
          spinner.text = `Processing step ${i + 1}/${chainConfig.steps.length}: ${step.name || 'unnamed'}`;

          let result;
          switch (step.type) {
            case 'request':
              result = await dryRunEngine.runRequest(currentData, {
                pipelineId: step.pipelineId || 'request-pipeline',
                mode: step.mode || 'dry-run',
                nodeConfigs: step.nodeConfigs
              });
              break;
            case 'response':
              result = await dryRunEngine.runResponse(currentData, {
                pipelineId: step.pipelineId || 'response-pipeline',
                mode: step.mode || 'dry-run',
                nodeConfigs: step.nodeConfigs
              });
              break;
            case 'bidirectional':
              result = await dryRunEngine.runBidirectional(currentData, {
                pipelineId: step.pipelineId || 'bidirectional-pipeline',
                nodeConfigs: step.nodeConfigs
              });
              break;
            default:
              throw new Error(`Unknown step type: ${step.type}`);
          }

          results.push({
            step: i + 1,
            name: step.name || 'unnamed',
            type: step.type,
            result
          });

          // Update current data for next step
          currentData = result;
        }

        spinner.succeed('Chain execution completed');

        // Format output
        const output = {
          input: inputData,
          steps: results,
          summary: {
            totalSteps: chainConfig.steps.length,
            completedSteps: results.length
          }
        };

        formatOutput(output, options.output);

        // Save results if requested
        if (options.save) {
          const outputPath = path.resolve(options.save);
          fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
          logger.success(`Results saved to: ${outputPath}`);
        }

      } catch (error) {
        spinner.fail('Chain execution failed');
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  return dryRun;
}