/**
 * Plugin system for pipeline extensibility
 */

/**
 * Pipeline plugin interface
 */
export interface PipelinePlugin {
  name: string;
  version: string;
  initialize(): Promise<void>;
  execute(context: any): Promise<any>;
  cleanup(): Promise<void>;
}

/**
 * Pipeline plugin manager
 */
export class PipelinePluginManager {
  private plugins: Map<string, PipelinePlugin> = new Map();

  async registerPlugin(plugin: PipelinePlugin): Promise<void> {
    await plugin.initialize();
    this.plugins.set(plugin.name, plugin);
  }

  async executePlugin(name: string, context: any): Promise<any> {
    const plugin = this.plugins.get(name);
    if (!plugin) {
      throw new Error(`Plugin ${name} not found`);
    }
    return await plugin.execute(context);
  }

  async cleanup(): Promise<void> {
    for (const plugin of this.plugins.values()) {
      await plugin.cleanup();
    }
    this.plugins.clear();
  }
}

/**
 * Create a plugin manager
 */
export function createPluginManager(): PipelinePluginManager {
  return new PipelinePluginManager();
}