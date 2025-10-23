// Minimal config merger used by tests

export class ConfigMerger {
  public mergeConfigs(
    systemConfig: Record<string, unknown>,
    userConfig: Record<string, unknown>,
    parsedUserConfig: Record<string, unknown>
  ): Record<string, unknown> {
    const result: Record<string, unknown> = { modules: {} as Record<string, unknown> };

    // Start with system modules (shallow copy)
    for (const [name, mod] of Object.entries(systemConfig.modules || {})) {
      (result.modules as Record<string, unknown>)[name] = JSON.parse(JSON.stringify(mod));
    }

    // For moduleConfigs from parsedUserConfig: fully replace config (not deep merge)
    for (const [name, userMod] of Object.entries(parsedUserConfig.moduleConfigs || {})) {
      const base = (result.modules as Record<string, unknown>)[name] || {};
      const safeUserMod = userMod && typeof userMod === 'object' ? (userMod as Record<string, unknown>) : {};
      const safeUserConfig = (safeUserMod as Record<string, unknown>).config && typeof (safeUserMod as Record<string, unknown>).config === 'object' ? (safeUserMod as Record<string, unknown>).config : {};
      (result.modules as Record<string, unknown>)[name] = {
        ...(base as Record<string, unknown>),
        ...(safeUserMod as Record<string, unknown>),
        config: { ...(safeUserConfig as Record<string, unknown>) },
      };
    }

    // Virtual router special handling: attach routeTargets/pipelineConfigs and protocols
    if (!(result.modules as Record<string, unknown>).virtualrouter) {
      (result.modules as Record<string, unknown>).virtualrouter = { enabled: true, config: {} };
    }
    const vrModule = (result.modules as Record<string, unknown>).virtualrouter as Record<string, unknown>;
    const vrCfg = (vrModule.config ||= {}) as Record<string, unknown>;
    vrCfg.routeTargets = parsedUserConfig.routeTargets || {};
    vrCfg.pipelineConfigs = parsedUserConfig.pipelineConfigs || {};
    if (userConfig && typeof userConfig === 'object' && (userConfig as Record<string, unknown>).virtualrouter) {
      const vrConfig = (userConfig as Record<string, unknown>).virtualrouter as Record<string, unknown>;
      vrCfg.inputProtocol = (vrConfig.inputProtocol as string) || vrCfg.inputProtocol;
      vrCfg.outputProtocol = (vrConfig.outputProtocol as string) || vrCfg.outputProtocol;
    }

    return result;
  }

  // deepMerge utility (tested via private access in tests)
  private deepMerge(target: unknown, source: unknown): unknown {
    if (typeof target !== 'object' || target === null) {return source;}
    if (typeof source !== 'object' || source === null) {return target;}
    const result: Record<string, unknown> = { ...(target as Record<string, unknown>) };
    for (const [k, v] of Object.entries(source as Record<string, unknown>)) {
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
