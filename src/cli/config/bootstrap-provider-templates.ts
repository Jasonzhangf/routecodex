import { getInitProviderCatalogEntry, type InitProviderTemplate } from './init-provider-catalog.js';

function cloneTemplate(template: InitProviderTemplate): InitProviderTemplate {
  return JSON.parse(JSON.stringify(template)) as InitProviderTemplate;
}

function apikeyAuthEnv(envVar: string) {
  return {
    type: 'apikey',
    apiKey: `\${${envVar}}`
  };
}

const GENERIC_STANDARD_TEMPLATES: InitProviderTemplate[] = [
  {
    id: 'openai',
    label: 'OpenAI-Compatible (Guided)',
    description: 'Generic OpenAI Chat template. Fill in provider id/baseURL/model/API key for your provider.',
    provider: {
      id: 'openai',
      enabled: true,
      type: 'openai',
      baseURL: 'https://api.example.com/v1',
      auth: apikeyAuthEnv('OPENAI_API_KEY'),
      models: {
        'default-model': { supportsStreaming: true }
      }
    },
    defaultModel: 'default-model'
  },
  {
    id: 'responses',
    label: 'OpenAI Responses (Guided)',
    description: 'Generic OpenAI Responses template. Fill in provider id/baseURL/model/API key for your provider.',
    provider: {
      id: 'responses',
      enabled: true,
      type: 'responses',
      baseURL: 'https://api.example.com/v1',
      auth: apikeyAuthEnv('RESPONSES_API_KEY'),
      models: {
        'default-model': { supportsStreaming: true }
      },
      responses: { process: 'chat', streaming: 'always' },
      config: { responses: { streaming: 'always' } }
    },
    defaultModel: 'default-model'
  },
  {
    id: 'anthropic',
    label: 'Anthropic-Compatible (Guided)',
    description: 'Generic Anthropic Messages template. Fill in provider id/baseURL/model/API key for your provider.',
    provider: {
      id: 'anthropic',
      enabled: true,
      type: 'anthropic',
      baseURL: 'https://api.anthropic.com/v1',
      auth: apikeyAuthEnv('ANTHROPIC_API_KEY'),
      models: {
        'default-model': { supportsStreaming: true }
      }
    },
    defaultModel: 'default-model'
  },
  {
    id: 'gemini',
    label: 'Gemini-Compatible (Guided)',
    description: 'Generic Gemini template. Fill in provider id/baseURL/model/API key for your provider.',
    provider: {
      id: 'gemini',
      enabled: true,
      type: 'gemini',
      baseURL: 'https://generativelanguage.googleapis.com/v1beta',
      auth: apikeyAuthEnv('GEMINI_API_KEY'),
      models: {
        'default-model': { supportsStreaming: true }
      }
    },
    defaultModel: 'default-model'
  }
];

const MANAGED_TEMPLATE_IDS = ['qwen', 'iflow', 'gemini-cli', 'antigravity', 'deepseek-web'] as const;

function requireCatalogTemplate(id: string): InitProviderTemplate {
  const entry = getInitProviderCatalogEntry(id);
  if (!entry) {
    throw new Error(`[bootstrap-provider-templates] missing init catalog entry for ${id}`);
  }
  return cloneTemplate(entry);
}

export function getBootstrapProviderTemplates(): InitProviderTemplate[] {
  return [
    ...GENERIC_STANDARD_TEMPLATES.map(cloneTemplate),
    ...MANAGED_TEMPLATE_IDS.map((id) => requireCatalogTemplate(id))
  ];
}

export function getBootstrapProviderTemplateEntry(id: string): InitProviderTemplate | undefined {
  const normalized = id.trim();
  const generic = GENERIC_STANDARD_TEMPLATES.find((entry) => entry.id === normalized);
  if (generic) {
    return cloneTemplate(generic);
  }
  if ((MANAGED_TEMPLATE_IDS as readonly string[]).includes(normalized)) {
    return requireCatalogTemplate(normalized);
  }
  return undefined;
}

export function isManagedBootstrapTemplate(id: string): boolean {
  return (MANAGED_TEMPLATE_IDS as readonly string[]).includes(id.trim());
}
