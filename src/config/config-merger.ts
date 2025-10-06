// Minimal config merger used by tests

export class ConfigMerger {
  public mergeConfigs(
    systemConfig: Record<string, any>,
    userConfig: Record<string, any>,
    parsedUserConfig: Record<string, any>
  ): Record<string, any> {
    const result: Record<string, any> = { modules: {} };

    // Start with system modules (shallow copy)
    for (const [name, mod] of Object.entries(systemConfig.modules || {})) {
      result.modules[name] = JSON.parse(JSON.stringify(mod));
    }

    // For moduleConfigs from parsedUserConfig: fully replace config (not deep merge)
    for (const [name, userMod] of Object.entries(parsedUserConfig.moduleConfigs || {})) {
      const base = result.modules[name] || {};
      const safeUserMod = userMod && typeof userMod === 'object' ? (userMod as Record<string, any>) : {};
      const safeUserConfig = (safeUserMod as any).config && typeof (safeUserMod as any).config === 'object' ? (safeUserMod as any).config : {};
      result.modules[name] = {
        ...base,
        ...safeUserMod,
        config: { ...safeUserConfig },
      };
    }

    // Virtual router special handling: attach routeTargets/pipelineConfigs and protocols
    if (!result.modules.virtualrouter) {
      result.modules.virtualrouter = { enabled: true, config: {} };
    }
    const vrCfg = (result.modules.virtualrouter.config ||= {});
    vrCfg.routeTargets = parsedUserConfig.routeTargets || {};
    vrCfg.pipelineConfigs = parsedUserConfig.pipelineConfigs || {};
    if (userConfig?.virtualrouter) {
      vrCfg.inputProtocol = userConfig.virtualrouter.inputProtocol || vrCfg.inputProtocol;
      vrCfg.outputProtocol = userConfig.virtualrouter.outputProtocol || vrCfg.outputProtocol;
    }

    return result;
  }

  // deepMerge utility (tested via private access in tests)
  private deepMerge(target: any, source: any): any {
    if (typeof target !== 'object' || target === null) {return source;}
    if (typeof source !== 'object' || source === null) {return target;}
    const result: Record<string, any> = { ...target };
    for (const [k, v] of Object.entries(source)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        result[k] = this.deepMerge(result[k], v);
      } else {
        result[k] = v;
      }
    }
    return result;
  }
}

export default ConfigMerger;
