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
    passthroughFields?: string[]; // additional fields to copy from provider to response
    defaultValues?: Record<string, unknown>;
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
    messageWrapperType: 'message',
    passthroughFields: [
      'background',
      'error',
      'incomplete_details',
      'instructions',
      'reasoning',
      'tool_choice',
      'tools',
      'parallel_tool_calls',
      'max_output_tokens',
      'max_tool_calls',
      'previous_response_id',
      'prompt_cache_key',
      'safety_identifier',
      'service_tier',
      'store',
      'temperature',
      'top_p',
      'top_logprobs',
      'truncation',
      'metadata',
      'user',
      'text',
      'usage'
    ],
    defaultValues: {
      background: false,
      error: null,
      incomplete_details: null,
      service_tier: 'default',
      store: false,
      temperature: 1,
      top_p: 1,
      top_logprobs: 0,
      truncation: 'disabled',
      metadata: {},
      user: null,
      text: { format: { type: 'text' }, verbosity: 'medium' },
      max_output_tokens: null,
      max_tool_calls: null,
      previous_response_id: null,
      prompt_cache_key: null,
      reasoning: null,
      safety_identifier: null
    }
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
    fallbackEnabled: false,
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
    const fs = await import('fs/promises');
    const path = await import('path');
    const { fileURLToPath } = await import('url');
    const fallbackDisabled = String(process.env.ROUTECODEX_DISABLE_CONFIG_FALLBACK || process.env.RCC_DISABLE_CONFIG_FALLBACK || '0') === '1';

    // Helper: ascend from a starting dir to locate the package root (directory containing package.json)
    const findPackageRoot = async (startDir: string): Promise<string> => {
      let dir = startDir;
      for (let i = 0; i < 6; i++) {
        try {
          const cand = path.join(dir, 'package.json');
          const stat = await fs.stat(cand).catch(() => null as any);
          if (stat && stat.isFile()) {return dir;}
        } catch { /* continue */ }
        const parent = path.dirname(dir);
        if (parent === dir) {break;}
        dir = parent;
      }
      return startDir; // best effort
    };

    // Resolve default mapping/schema paths relative to package root
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const pkgRoot = await findPackageRoot(moduleDir);
    const defaultMappingPath = path.join(pkgRoot, 'config', 'responses-conversion.json');
    const defaultSchemaPath = path.join(pkgRoot, 'config', 'schemas', 'responses-conversion.schema.json');

    // First: try to load modules.json (optional). If missing and fallback allowed, continue with defaults.
    let withEnv: ResponsesModuleConfig = DEFAULTS;
    let mappingsPathFromConfig: string | null = null;
    try {
      const reader = new ModuleConfigReader('./config/modules.json');
      const cfg = await reader.load();
      const mod = reader.getModuleConfigValue<ResponsesModuleConfig>('responses', DEFAULTS) || DEFAULTS;
      withEnv = this.mergeWithEnv(mod);
      mappingsPathFromConfig = (cfg as any)?.modules?.responses?.config?.conversion?.mappingsPath || null;
    } catch (e) {
      if (fallbackDisabled) {
        throw new Error('Failed to load responses module or mapping configuration.');
      }
      // Use DEFAULTS with env overrides
      withEnv = this.mergeWithEnv(DEFAULTS);
    }

    // Env override for mappings path
    const envMappingPath = (process.env.ROUTECODEX_RESP_MAPPINGS_PATH || process.env.RCC_RESP_MAPPINGS_PATH || '').trim();
    const preferPath = envMappingPath || (mappingsPathFromConfig || '').trim();

    // Resolve final mapping file path
    const resolveMappingPath = (p: string | null): string => {
      const raw = (p || '').trim();
      if (!raw) {return defaultMappingPath;}
      if (raw.startsWith('~')) {
        const home = process.env.HOME || process.env.USERPROFILE || '';
        return path.join(home, raw.slice(1));
      }
      if (path.isAbsolute(raw)) {return raw;}
      // Treat as package-root relative or process CWD relative depending on prefix
      if (raw.startsWith('./') || raw.startsWith('config/')) {return path.join(pkgRoot, raw.replace(/^\.\//, ''));}
      return path.join(pkgRoot, raw);
    };

    // Load and validate mapping; if fails, fallback to DEFAULT_MAPPING when allowed
    try {
      const mappingFile = resolveMappingPath(preferPath || null);
      const content = await fs.readFile(mappingFile, 'utf-8');
      const parsed = JSON.parse(content);
      const { SchemaValidator } = await import('./schema-validator.js');
      await SchemaValidator.validateMapping(parsed, defaultSchemaPath);
      withEnv.mappings = { ...(DEFAULT_MAPPING as any), ...(parsed as any) } as ResponsesConversionMapping;
      return withEnv;
    } catch (e) {
      if (fallbackDisabled) {
        throw new Error('Failed to load responses module or mapping configuration.');
      }
      // Fallback to DEFAULT_MAPPING embedded
      withEnv.mappings = DEFAULT_MAPPING;
      return withEnv;
    }
  }

  private static mergeWithEnv(base: ResponsesModuleConfig): ResponsesModuleConfig {
    const envBool = (v: string | undefined): boolean | undefined => {
      if (v == null) {return undefined;}
      const s = String(v).trim().toLowerCase();
      if (['1','true','yes','on'].includes(s)) {return true;}
      if (['0','false','no','off'].includes(s)) {return false;}
      return undefined;
    };

    const c = { ...base } as ResponsesModuleConfig;
    const useLlmswitch = envBool(process.env.ROUTECODEX_RESP_CONVERT_LLMSWITCH);
    const fallback = envBool(process.env.ROUTECODEX_RESP_CONVERT_FALLBACK);
    const forceNonStream = envBool(process.env.ROUTECODEX_RESP_PROVIDER_NONSTREAM);
    const lifecycle = envBool(process.env.ROUTECODEX_RESP_SSE_LIFECYCLE);
    const requiredAction = envBool(process.env.ROUTECODEX_RESP_SSE_REQUIRED_ACTION);
    const hb = process.env.ROUTECODEX_RESPONSES_HEARTBEAT_MS;

    if (useLlmswitch !== undefined) {c.conversion.useLlmswitch = useLlmswitch;}
    if (fallback !== undefined) {c.conversion.fallbackEnabled = fallback;}
    if (forceNonStream !== undefined) {c.conversion.forceProviderStream = forceNonStream;}
    if (lifecycle !== undefined) {c.sse.emitTextItemLifecycle = lifecycle;}
    if (requiredAction !== undefined) {c.sse.emitRequiredAction = requiredAction;}
    if (hb !== undefined && hb !== '') {
      const n = Number(hb);
      if (Number.isFinite(n)) {c.sse.heartbeatMs = n;}
    }
    return c;
  }
}
