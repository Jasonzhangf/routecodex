import { ModuleConfigReader } from '../../utils/module-config-reader.js';

export interface ResponsesConversionConfig {
  useLlmswitch: boolean;
  fallbackEnabled: boolean;
  forceProviderStream: boolean; // provider side stream=false when true
}

export interface ResponsesSSEConfig {
  heartbeatMs: number; // 0 to disable
  emitTextItemLifecycle: boolean;
  emitRequiredAction: boolean;
}

export interface ResponsesConversionMapping {
  request: {
    instructionsPaths: string[];
    inputBlocks: {
      wrapperType: string; // e.g., 'message'
      typeKey: string;     // e.g., 'type'
      roleKey: string;     // e.g., 'role'
      blocksKey: string;   // e.g., 'content'
      textKey: string;     // e.g., 'text'
      allowedContentTypes: string[]; // e.g., ['input_text','text']
      ignoreRoles?: string[];
      dedupe?: boolean;
      dedupeDelimiter?: string;
    };
    fallback: {
      useRawMessages: boolean;
      rawMessagesPath: string; // e.g., 'messages'
      pickLastUser: boolean;
      dedupe?: boolean;
      dedupeDelimiter?: string;
    };
    systemContentPaths?: string[];
    systemJoiner?: string;
  };
  response: {
    textPaths: string[];         // preferred text fields, with simple path syntax
    textArrayTextKey: string;    // e.g., 'text'
    contentBlocksKey: string;    // e.g., 'content'
    messageWrapperType: string;  // e.g., 'message'
  };
  tools: {
    toolCallTypes: string[];     // e.g., ['tool_call','function_call']
    functionArgsPaths: string[]; // e.g., ['arguments','tool_call.function.arguments']
    emitRequiredAction: boolean;
  };
}

export interface ResponsesModuleConfig {
  conversion: ResponsesConversionConfig;
  sse: ResponsesSSEConfig;
  mappings: ResponsesConversionMapping;
}

const DEFAULT_MAPPING: ResponsesConversionMapping = {
  request: {
    instructionsPaths: ['instructions'],
    inputBlocks: {
      wrapperType: 'message',
      typeKey: 'type',
      roleKey: 'role',
      blocksKey: 'content',
      textKey: 'text',
      allowedContentTypes: ['input_text', 'text', 'output_text'],
      ignoreRoles: ['system'],
      dedupe: true,
      dedupeDelimiter: '\n\n'
    },
    fallback: { useRawMessages: true, rawMessagesPath: 'messages', pickLastUser: true, dedupe: true, dedupeDelimiter: '\n\n' },
    systemContentPaths: ['instructions'],
    systemJoiner: '\n\n'
  },
  response: {
    textPaths: ['output_text', 'choices[0].message.content'],
    textArrayTextKey: 'text',
    contentBlocksKey: 'content',
    messageWrapperType: 'message'
  },
  tools: {
    toolCallTypes: ['tool_call', 'function_call'],
    functionArgsPaths: ['arguments', 'tool_call.function.arguments'],
    emitRequiredAction: true
  }
};

const DEFAULTS: ResponsesModuleConfig = {
  conversion: {
    useLlmswitch: true,
    fallbackEnabled: true,
    forceProviderStream: true // default: provider non-stream, server re-stream
  },
  sse: {
    heartbeatMs: Number(process.env.ROUTECODEX_RESPONSES_HEARTBEAT_MS || 5000),
    emitTextItemLifecycle: true,
    emitRequiredAction: true
  },
  mappings: DEFAULT_MAPPING
};

export class ResponsesConfigUtil {
  static async load(): Promise<ResponsesModuleConfig> {
    // First try modules.json
    try {
      const reader = new ModuleConfigReader('./config/modules.json');
      const cfg = await reader.load();
      const mod = reader.getModuleConfigValue<ResponsesModuleConfig>('responses', DEFAULTS) || DEFAULTS;
      const withEnv = this.mergeWithEnv(mod);
      // Load external mappings if configured
      const mappingsPath = (cfg as any)?.modules?.responses?.config?.conversion?.mappingsPath || null;
      try {
        const fs = await import('fs/promises');
        const path = await import('path');
        const { fileURLToPath } = await import('url');
        const moduleDir = path.dirname(fileURLToPath(import.meta.url));
        const pkgRoot = path.resolve(moduleDir, '../../../');

        const resolvePath = (p: string | null): string => {
          if (!p || p.trim() === '') return path.join(pkgRoot, 'config', 'responses-conversion.json');
          const raw = p.trim();
          if (raw.startsWith('~')) {
            const home = process.env.HOME || process.env.USERPROFILE || '';
            return path.join(home, raw.slice(1));
          }
          if (path.isAbsolute(raw)) return raw;
          // treat as package-relative
          return path.join(pkgRoot, raw.replace(/^\.\//, ''));
        };

        const mappingFile = resolvePath(mappingsPath);
        const content = await fs.readFile(mappingFile, 'utf-8');
        const parsed = JSON.parse(content);
        // Validate mapping JSON against schema (AJV)
        const schemaPath = path.join(pkgRoot, 'config', 'schemas', 'responses-conversion.schema.json');
        const { SchemaValidator } = await import('./schema-validator.js');
        await SchemaValidator.validateMapping(parsed, schemaPath);
        withEnv.mappings = { ...(DEFAULT_MAPPING as any), ...(parsed as any) } as ResponsesConversionMapping;
      } catch (e) {
        // No fallback allowed: mapping must be present and valid
        throw e;
      }
      return withEnv;
    } catch {
      // No fallback allowed per requirement
      throw new Error('Failed to load responses module or mapping configuration.');
    }
  }

  private static mergeWithEnv(base: ResponsesModuleConfig): ResponsesModuleConfig {
    const envBool = (v: string | undefined): boolean | undefined => {
      if (v == null) return undefined;
      const s = String(v).trim().toLowerCase();
      if (['1','true','yes','on'].includes(s)) return true;
      if (['0','false','no','off'].includes(s)) return false;
      return undefined;
    };

    const c = { ...base } as ResponsesModuleConfig;
    const useLlmswitch = envBool(process.env.ROUTECODEX_RESP_CONVERT_LLMSWITCH);
    const fallback = envBool(process.env.ROUTECODEX_RESP_CONVERT_FALLBACK);
    const forceNonStream = envBool(process.env.ROUTECODEX_RESP_PROVIDER_NONSTREAM);
    const lifecycle = envBool(process.env.ROUTECODEX_RESP_SSE_LIFECYCLE);
    const requiredAction = envBool(process.env.ROUTECODEX_RESP_SSE_REQUIRED_ACTION);
    const hb = process.env.ROUTECODEX_RESPONSES_HEARTBEAT_MS;

    if (useLlmswitch !== undefined) c.conversion.useLlmswitch = useLlmswitch;
    if (fallback !== undefined) c.conversion.fallbackEnabled = fallback;
    if (forceNonStream !== undefined) c.conversion.forceProviderStream = forceNonStream;
    if (lifecycle !== undefined) c.sse.emitTextItemLifecycle = lifecycle;
    if (requiredAction !== undefined) c.sse.emitRequiredAction = requiredAction;
    if (hb !== undefined && hb !== '') {
      const n = Number(hb);
      if (Number.isFinite(n)) c.sse.heartbeatMs = n;
    }
    return c;
  }
}
