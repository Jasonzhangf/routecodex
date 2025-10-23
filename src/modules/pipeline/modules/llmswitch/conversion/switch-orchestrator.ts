import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import type { ModuleDependencies } from '../../../interfaces/pipeline-interfaces.js';
import type { ConversionConfigFile, ConversionContext, ConversionProfile, ConversionResult } from './types.js';
import { CodecRegistry } from './codec-registry.js';
import { getDefaultCodecFactories } from './codecs/index.js';
import { SchemaValidator } from './schema-validator.js';

interface SwitchOrchestratorOptions {
  profilesPath?: string;
  defaultProfile?: string;
}

interface RequestBinding {
  profileId: string;
}

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(MODULE_DIR, '../../../../../..');
const DEFAULT_PROFILES_RELATIVE = 'config/conversion/llmswitch-profiles.json';
const DEFAULT_PROFILES_PATH = path.resolve(PACKAGE_ROOT, DEFAULT_PROFILES_RELATIVE);

export class SwitchOrchestrator {
  private readonly dependencies: ModuleDependencies;
  private readonly options: SwitchOrchestratorOptions;
  private readonly codecRegistry: CodecRegistry;
  private readonly schemaValidator: SchemaValidator;
  private profiles: Map<string, ConversionProfile> = new Map();
  private endpointBindings: Map<string, string> = new Map();
  private defaultProfileId: string | undefined;
  private initialized = false;
  private readonly requestBindings: Map<string, RequestBinding> = new Map();

  constructor(dependencies: ModuleDependencies, options: SwitchOrchestratorOptions) {
    this.dependencies = dependencies;
    this.options = options;
    this.codecRegistry = new CodecRegistry(dependencies);
    this.schemaValidator = new SchemaValidator(PACKAGE_ROOT);

    const factories = getDefaultCodecFactories();
    for (const [id, factory] of Object.entries(factories)) {
      this.codecRegistry.register(id, factory);
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const profilesPath = await this.resolveProfilesPath(this.options.profilesPath);

    const raw = await fs.readFile(profilesPath, 'utf-8');
    const parsed: ConversionConfigFile = JSON.parse(raw);

    const profileEntries = Object.entries(parsed.profiles || {});
    for (const [id, def] of profileEntries) {
      const profile: ConversionProfile = { id, ...def };
      this.profiles.set(id, profile);
    }
    if (!this.profiles.size) {
      throw new Error('No conversion profiles defined for llmswitch conversion orchestrator');
    }

    if (parsed.endpointBindings) {
      for (const [endpoint, profileId] of Object.entries(parsed.endpointBindings)) {
        this.endpointBindings.set(endpoint, profileId);
      }
    }

    this.defaultProfileId = this.options.defaultProfile ?? profileEntries[0]?.[0];
    this.initialized = true;
  }

  private async resolveProfilesPath(configuredPath?: string): Promise<string> {
    const candidate = configuredPath
      ? (path.isAbsolute(configuredPath)
        ? configuredPath
        : path.resolve(PACKAGE_ROOT, configuredPath))
      : DEFAULT_PROFILES_PATH;

    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      const message = configuredPath
        ? `Unable to locate llmswitch profiles file at '${candidate}'.`
        : `Unable to locate default llmswitch profiles file at '${candidate}'.`;
      throw new Error(message);
    }
  }

  async prepareIncoming(payload: any, context: ConversionContext): Promise<ConversionResult> {
    await this.ensureInitialized();
    const profile = this.resolveProfile(context);
    const requestId = context.requestId ?? `req_${Date.now()}`;

    await this.schemaValidator.validate(profile.inputSchema, payload, `${profile.id}:incoming`);

    const codec = await this.codecRegistry.resolve(profile.codec);
    const converted = await codec.convertRequest(payload, profile, { ...context, requestId });

    await this.schemaValidator.validate(profile.canonicalRequestSchema, converted, `${profile.id}:canonical-request`);

    this.requestBindings.set(requestId, { profileId: profile.id });

    return {
      profile,
      payload: converted
    };
  }

  async prepareOutgoing(payload: any, context: ConversionContext): Promise<ConversionResult> {
    await this.ensureInitialized();
    const requestId = context.requestId ?? `req_${Date.now()}`;
    const binding = this.requestBindings.get(requestId);
    const profile = binding ? this.profiles.get(binding.profileId) : this.resolveProfile(context);
    if (!profile) {
      throw new Error(`Unable to resolve conversion profile for request ${requestId}`);
    }

    const codec = await this.codecRegistry.resolve(profile.codec);
    const converted = await codec.convertResponse(payload, profile, { ...context, requestId });

    // Schema validation should happen AFTER conversion, not before
    if (profile.clientResponseSchema) {
      await this.schemaValidator.validate(profile.clientResponseSchema, converted, `${profile.id}:client-response`);
    }

    if (binding) {
      this.requestBindings.delete(requestId);
    }

    return {
      profile,
      payload: converted
    };
  }

  private resolveProfile(context: ConversionContext): ConversionProfile {
    const explicit = context.metadata && typeof context.metadata['conversionProfileId'] === 'string'
      ? context.metadata['conversionProfileId'] as string
      : undefined;
    if (explicit && this.profiles.has(explicit)) {
      return this.profiles.get(explicit)!;
    }

    const endpoint = context.entryEndpoint ?? context.endpoint;
    if (endpoint && this.endpointBindings.has(endpoint)) {
      const profileId = this.endpointBindings.get(endpoint)!;
      const profile = this.profiles.get(profileId);
      if (profile) {
        return profile;
      }
    }

    if (this.defaultProfileId && this.profiles.has(this.defaultProfileId)) {
      return this.profiles.get(this.defaultProfileId)!;
    }

    const [first] = this.profiles.values();
    if (!first) {
      throw new Error('No conversion profiles available');
    }
    return first;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }
}
