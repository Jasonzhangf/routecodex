#!/usr/bin/env node

/**
 * Progressive Module Enhancement Script
 *
 * Command-line tool to enhance existing modules with debugging capabilities
 * one by one, maintaining backward compatibility.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Command-line interface
 */
class ModuleEnhancerCLI {
  constructor() {
    this.commands = {
      'add': this.addModuleEnhancement.bind(this),
      'remove': this.removeModuleEnhancement.bind(this),
      'list': this.listModules.bind(this),
      'config': this.showConfig.bind(this),
      'enable': this.enableModule.bind(this),
      'disable': this.disableModule.bind(this),
      'auto-detect': this.autoDetectModules.bind(this)
    };
  }

  /**
   * Main entry point
   */
  async run(args) {
    if (args.length === 0) {
      this.showHelp();
      return;
    }

    const command = args[0];
    const commandArgs = args.slice(1);

    if (this.commands[command]) {
      await this.commands[command](commandArgs);
    } else {
      console.error(`Unknown command: ${command}`);
      this.showHelp();
    }
  }

  /**
   * Show help
   */
  showHelp() {
    console.log(`
RouteCodex Module Enhancement Tool

USAGE:
  node enhance-module.js <command> [options]

COMMANDS:
  add <module-path> [module-id] [module-type]    Add enhancement to a module
  remove <module-id>                              Remove enhancement from a module
  list                                           List all available modules
  config                                         Show current configuration
  enable <module-id>                             Enable enhancement for a module
  disable <module-id>                            Disable enhancement for a module
  auto-detect                                    Auto-detect modules for enhancement

EXAMPLES:
  # Add enhancement to LM Studio provider
  node enhance-module.js add src/providers/core/runtime/chat-http-provider.ts

  # Add enhancement with custom ID and type
  node enhance-module.js add ./my-module.ts my-module provider

  # Enable enhancement for a module
  node enhance-module.js enable lmstudio-provider

  # Auto-detect modules
  node enhance-module.js auto-detect

OPTIONS:
  --config <path>    Path to configuration file
  --verbose          Enable verbose output
  --dry-run          Show what would be done without making changes
`);
  }

  /**
   * Add enhancement to a module
   */
  async addModuleEnhancement(args) {
    if (args.length === 0) {
      console.error('Module path is required');
      console.log('Usage: add <module-path> [module-id] [module-type]');
      return;
    }

    const modulePath = args[0];
    const moduleId = args[1] || this.extractModuleId(modulePath);
    const moduleType = args[2] || this.determineModuleType(modulePath);

    console.log(`Adding enhancement to module: ${modulePath}`);
    console.log(`Module ID: ${moduleId}`);
    console.log(`Module Type: ${moduleType}`);

    // Read the module file
    const moduleContent = await this.readModuleFile(modulePath);

    // Generate enhanced version
    const enhancedContent = this.generateEnhancedModule(moduleContent, moduleId, moduleType);

    // Show diff
    this.showDiff(moduleContent, enhancedContent);

    // Check if dry run
    if (args.includes('--dry-run')) {
      console.log('Dry run - no changes made');
      return;
    }

    // Ask for confirmation
    if (!args.includes('--yes')) {
      const readline = await import('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });

      const answer = await new Promise(resolve => {
        rl.question('Apply these changes? (y/N): ', resolve);
      });

      rl.close();

      if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
        console.log('Cancelled');
        return;
      }
    }

    // Apply changes
    await this.writeEnhancedModule(modulePath, enhancedContent);

    // Update configuration
    await this.updateConfiguration(moduleId, moduleType, modulePath);

    console.log(`✓ Enhancement added to ${moduleId}`);
  }

  /**
   * Remove enhancement from a module
   */
  async removeModuleEnhancement(args) {
    if (args.length === 0) {
      console.error('Module ID is required');
      console.log('Usage: remove <module-id>');
      return;
    }

    const moduleId = args[0];
    console.log(`Removing enhancement from module: ${moduleId}`);

    // Load configuration
    const config = await this.loadConfiguration();
    const moduleConfig = config.global.modules[moduleId];

    if (!moduleConfig) {
      console.error(`Module ${moduleId} not found in configuration`);
      return;
    }

    if (!moduleConfig.filePath) {
      console.error(`Module ${moduleId} has no file path in configuration`);
      return;
    }

    // Read the module file
    const moduleContent = await this.readModuleFile(moduleConfig.filePath);

    // Remove enhancement
    const originalContent = this.removeEnhancement(moduleContent, moduleId);

    // Show diff
    this.showDiff(moduleContent, originalContent);

    // Check if dry run
    if (args.includes('--dry-run')) {
      console.log('Dry run - no changes made');
      return;
    }

    // Apply changes
    await this.writeEnhancedModule(moduleConfig.filePath, originalContent);

    // Update configuration
    delete config.global.modules[moduleId];
    await this.saveConfiguration(config);

    console.log(`✓ Enhancement removed from ${moduleId}`);
  }

  /**
   * List all modules
   */
  async listModules(args) {
    const config = await this.loadConfiguration();
    const modules = config.global.modules;

    console.log('Available Modules:');
    console.log('='.repeat(50));

    if (Object.keys(modules).length === 0) {
      console.log('No modules configured');
      return;
    }

    for (const [moduleId, moduleConfig] of Object.entries(modules)) {
      const status = moduleConfig.enabled ? '✓' : '✗';
      console.log(`${status} ${moduleId} (${moduleConfig.moduleType})`);
      console.log(`   File: ${moduleConfig.filePath || 'Unknown'}`);
      console.log(`   Level: ${moduleConfig.level}`);
      console.log(`   Console: ${moduleConfig.consoleLogging}`);
      console.log(`   DebugCenter: ${moduleConfig.debugCenter}`);
      console.log();
    }
  }

  /**
   * Show configuration
   */
  async showConfig(args) {
    const config = await this.loadConfiguration();
    console.log(JSON.stringify(config, null, 2));
  }

  /**
   * Enable enhancement for a module
   */
  async enableModule(args) {
    if (args.length === 0) {
      console.error('Module ID is required');
      console.log('Usage: enable <module-id>');
      return;
    }

    const moduleId = args[0];
    const config = await this.loadConfiguration();

    if (!config.global.modules[moduleId]) {
      console.error(`Module ${moduleId} not found in configuration`);
      return;
    }

    config.global.modules[moduleId].enabled = true;
    await this.saveConfiguration(config);

    console.log(`✓ Enhancement enabled for ${moduleId}`);
  }

  /**
   * Disable enhancement for a module
   */
  async disableModule(args) {
    if (args.length === 0) {
      console.error('Module ID is required');
      console.log('Usage: disable <module-id>');
      return;
    }

    const moduleId = args[0];
    const config = await this.loadConfiguration();

    if (!config.global.modules[moduleId]) {
      console.error(`Module ${moduleId} not found in configuration`);
      return;
    }

    config.global.modules[moduleId].enabled = false;
    await this.saveConfiguration(config);

    console.log(`✓ Enhancement disabled for ${moduleId}`);
  }

  /**
   * Auto-detect modules
   */
  async autoDetectModules(args) {
    console.log('Auto-detecting modules...');

    const config = await this.loadConfiguration();
    const patterns = config.global.autoDetection.patterns;
    const excludeDirs = config.global.autoDetection.excludeDirs;

    const glob = await import('glob');
    let detectedCount = 0;

    for (const pattern of patterns) {
      const files = await glob.glob(pattern, {
        ignore: excludeDirs
      });

      for (const file of files) {
        const moduleId = this.extractModuleId(file);
        const moduleType = this.determineModuleType(file);

        if (!config.global.modules[moduleId]) {
          config.global.modules[moduleId] = {
            moduleId,
            moduleType,
            enabled: false,
            level: 'detailed',
            consoleLogging: true,
            debugCenter: true,
            filePath: file
          };
          detectedCount++;
          console.log(`Detected: ${moduleId} (${moduleType})`);
        }
      }
    }

    if (detectedCount > 0) {
      await this.saveConfiguration(config);
      console.log(`✓ ${detectedCount} modules detected and added to configuration`);
    } else {
      console.log('No new modules detected');
    }
  }

  /**
   * Read module file
   */
  async readModuleFile(filePath) {
    try {
      const absolutePath = path.resolve(process.cwd(), filePath);
      return await fs.readFile(absolutePath, 'utf-8');
    } catch (error) {
      throw new Error(`Failed to read module file: ${error}`);
    }
  }

  /**
   * Write enhanced module file
   */
  async writeEnhancedModule(filePath, content) {
    try {
      const absolutePath = path.resolve(process.cwd(), filePath);
      await fs.writeFile(absolutePath, content, 'utf-8');
    } catch (error) {
      throw new Error(`Failed to write enhanced module: ${error}`);
    }
  }

  /**
   * Generate enhanced module content
   */
  generateEnhancedModule(originalContent, moduleId, moduleType) {
    // Add enhancement import
    const imports = this.generateEnhancementImports(moduleType);

    // Add enhancement wrapper
    const enhancementWrapper = this.generateEnhancementWrapper(moduleId, moduleType);

    // Replace class definition
    const enhancedContent = originalContent
      .replace(/^(\s*import.*;$)/gm, (match, p1) => {
        // Add enhancement imports after the first import
        if (originalContent.indexOf(p1) === originalContent.lastIndexOf(p1)) {
          return p1 + '\n' + imports;
        }
        return p1;
      })
      .replace(/(class\s+\w+\s+implements\s+[^{]+\s*{)/, enhancementWrapper);

    return enhancedContent;
  }

  /**
   * Generate enhancement imports
   */
  generateEnhancementImports(moduleType) {
    return `
import { EnhancementConfigManager } from '../../modules/enhancement/enhancement-config-manager.js';
import type { EnhancedModule } from '../../modules/enhancement/module-enhancement-factory.js';
`;
  }

  /**
   * Generate enhancement wrapper
   */
  generateEnhancementWrapper(moduleId, moduleType) {
    return `
/**
 * Enhanced module with debugging capabilities
 * Auto-generated by module enhancement system
 */
class Enhanced${moduleId.charAt(0).toUpperCase() + moduleId.slice(1)} {
  private original: any;
  private enhanced: EnhancedModule<any> | null = null;
  private configManager: EnhancementConfigManager;

  constructor(original: any, debugCenter: any) {
    this.original = original;
    this.configManager = new EnhancementConfigManager(debugCenter);
  }

  async initialize(): Promise<void> {
    // Create enhanced version
    this.enhanced = await this.configManager.enhanceModule(
      this.original,
      '${moduleId}',
      '${moduleType}'
    );

    // Initialize original module
    if (this.original.initialize) {
      await this.original.initialize();
    }
  }

  async processIncoming(request: any): Promise<any> {
    if (!this.enhanced) {
      return this.original.processIncoming(request);
    }
    return this.enhanced.enhanced.processIncoming(request);
  }

  async processOutgoing(response: any): Promise<any> {
    if (!this.enhanced) {
      return this.original.processOutgoing(response);
    }
    return this.enhanced.enhanced.processOutgoing(response);
  }

  async cleanup(): Promise<void> {
    if (this.original.cleanup) {
      await this.original.cleanup();
    }
  }

  getStatus(): any {
    if (!this.enhanced) {
      return this.original.getStatus();
    }
    return {
      ...this.original.getStatus(),
      enhanced: true,
      enhancementTime: this.enhanced.metadata.enhancementTime
    };
  }
}

// Original class with enhancement wrapper
`;
  }

  /**
   * Remove enhancement from module content
   */
  removeEnhancement(enhancedContent, moduleId) {
    // Remove enhancement imports
    const importsRegex = /import\s*{\s*EnhancementConfigManager.*?}\s*from\s*['"][^'"]*['"];\s*\n?/g;

    // Remove enhancement wrapper class
    const wrapperRegex = /\/\*\*[\s\S]*?\*\/\s*class\s+Enhanced[^{]+\{[\s\S]*?\}\s*\n?\s*\/\/\s*Original class with enhancement wrapper\s*/g;

    return enhancedContent
      .replace(importsRegex, '')
      .replace(wrapperRegex, '');
  }

  /**
   * Show diff between original and enhanced content
   */
  showDiff(original, enhanced) {
    console.log('Changes to be made:');
    console.log('='.repeat(50));

    const originalLines = original.split('\n');
    const enhancedLines = enhanced.split('\n');

    const diff = this.calculateDiff(originalLines, enhancedLines);

    diff.forEach(change => {
      switch (change.type) {
        case 'added':
          console.log(`+${change.line}`);
          break;
        case 'removed':
          console.log(`-${change.line}`);
          break;
        case 'unchanged':
          if (change.lineNumber % 10 === 0) {
            console.log(` ${change.line}`);
          }
          break;
      }
    });

    console.log('='.repeat(50));
  }

  /**
   * Calculate diff between two arrays of lines
   */
  calculateDiff(originalLines, enhancedLines) {
    const diff = [];
    const maxLines = Math.max(originalLines.length, enhancedLines.length);

    for (let i = 0; i < maxLines; i++) {
      const originalLine = originalLines[i];
      const enhancedLine = enhancedLines[i];

      if (originalLine === enhancedLine) {
        diff.push({
          type: 'unchanged',
          lineNumber: i + 1,
          line: originalLine || ''
        });
      } else if (!originalLine) {
        diff.push({
          type: 'added',
          lineNumber: i + 1,
          line: enhancedLine
        });
      } else if (!enhancedLine) {
        diff.push({
          type: 'removed',
          lineNumber: i + 1,
          line: originalLine
        });
      } else {
        diff.push({
          type: 'removed',
          lineNumber: i + 1,
          line: originalLine
        });
        diff.push({
          type: 'added',
          lineNumber: i + 1,
          line: enhancedLine
        });
      }
    }

    return diff;
  }

  /**
   * Extract module ID from file path
   */
  extractModuleId(filePath) {
    const relativePath = path.relative(process.cwd(), filePath);
    const normalized = relativePath.replace(/\.ts$/, '').replace(/\.js$/, '');
    const parts = normalized.split(path.sep);

    // Remove 'src' prefix if present
    if (parts[0] === 'src') {
      parts.shift();
    }

    // Create module ID from remaining path
    return parts.join('-');
  }

  /**
   * Determine module type from file path
   */
  determineModuleType(filePath) {
    const lowerPath = filePath.toLowerCase();

    if (lowerPath.includes('provider')) {
      return 'provider';
    } else if (lowerPath.includes('pipeline')) {
      return 'pipeline';
    } else if (lowerPath.includes('compatibility')) {
      return 'compatibility';
    } else if (lowerPath.includes('workflow')) {
      return 'workflow';
    } else if (lowerPath.includes('llmswitch') || lowerPath.includes('switch')) {
      return 'llmswitch';
    } else if (lowerPath.includes('server')) {
      return 'http-server';
    } else {
      return 'generic';
    }
  }

  /**
   * Load configuration
   */
  async loadConfiguration() {
    const configPath = path.join(process.cwd(), 'enhancement-config.json');

    try {
      const configData = await fs.readFile(configPath, 'utf-8');
      return JSON.parse(configData);
    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        // Create default configuration
        const defaultConfig = {
          version: '1.0.0',
          lastUpdated: Date.now(),
          global: {
            enabled: true,
            defaults: {
              enabled: true,
              level: 'detailed',
              consoleLogging: true,
              debugCenter: true,
              maxLogEntries: 1000,
              performanceTracking: true,
              requestLogging: true,
              errorTracking: true,
              transformationLogging: true
            },
            modules: {},
            autoDetection: {
              enabled: true,
              patterns: [
                'src/modules/pipeline/modules/**/*.ts',
                'src/modules/pipeline/core/**/*.ts',
                'src/server/**/*.ts'
              ],
              excludeDirs: [
                'node_modules',
                'dist',
                'tests'
              ]
            },
            performance: {
              enabled: true,
              thresholds: {
                warning: 1000,
                critical: 5000
              }
            }
          }
        };

        await fs.writeFile(configPath, JSON.stringify(defaultConfig, null, 2));
        return defaultConfig;
      } else {
        throw new Error(`Failed to load configuration: ${error}`);
      }
    }
  }

  /**
   * Save configuration
   */
  async saveConfiguration(config) {
    const configPath = path.join(process.cwd(), 'enhancement-config.json');
    config.lastUpdated = Date.now();
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  }

  /**
   * Update configuration with new module
   */
  async updateConfiguration(moduleId, moduleType, modulePath) {
    const config = await this.loadConfiguration();

    config.global.modules[moduleId] = {
      moduleId,
      moduleType,
      enabled: true,
      level: 'detailed',
      consoleLogging: true,
      debugCenter: true,
      filePath: modulePath
    };

    await this.saveConfiguration(config);
  }
}

// Run CLI
const cli = new ModuleEnhancerCLI();
cli.run(process.argv.slice(2));
