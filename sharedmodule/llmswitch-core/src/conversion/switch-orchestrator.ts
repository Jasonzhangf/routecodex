import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import type { ConversionConfigFile, ConversionContext, ConversionProfile, ConversionResult } from './types.js';
import { CodecRegistry, getDefaultCodecFactories } from './codec-registry.js';
import { SchemaValidator } from './schema-validator.js';

interface SwitchOrchestratorOptions {
  /** Path to profiles JSON; relative to baseDir when not absolute */
  profilesPath?: string;
  /** Required: host package root that contains config/ */
  baseDir?: string;
  defaultProfile?: string;
}

interface RequestBinding {
  profileId: string;
}

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
// Inside a packed install this file lives at: node_modules/@routecodex/llmswitch-core/dist/conversion
// CORE_ROOT resolves to the llmswitch-core package root (…/@routecodex/llmswitch-core)
const CORE_ROOT = path.resolve(MODULE_DIR, '../../..');
const DEFAULT_PROFILES_RELATIVE = 'config/conversion/llmswitch-profiles.json';

export class SwitchOrchestrator {
  private readonly options: SwitchOrchestratorOptions;
  private readonly codecRegistry: CodecRegistry;
  private schemaValidator: SchemaValidator;
  private profiles: Map<string, ConversionProfile> = new Map();
  private endpointBindings: Map<string, string> = new Map();
  private defaultProfileId: string | undefined;
  private initialized = false;
  private readonly requestBindings: Map<string, RequestBinding> = new Map();

  constructor(_dependencies: unknown, options: SwitchOrchestratorOptions) {
    this.options = options;
    this.codecRegistry = new CodecRegistry();
    // Initialize with core root; will be adjusted to host root after profile path resolution
    this.schemaValidator = new SchemaValidator(CORE_ROOT);
    const factories = getDefaultCodecFactories();
    for (const [id, factory] of Object.entries(factories)) this.codecRegistry.register(id, factory);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const { selected, baseDir } = await this.resolveProfilesPath(this.options.profilesPath, this.options.baseDir);
    // Ensure schema resolver anchors at the host package root so relative schema paths like
    // 'config/schemas/...' are read from routecodex package, not from llmswitch-core.
    this.schemaValidator = new SchemaValidator(baseDir);
    const raw = await fs.readFile(selected, 'utf-8');
    const parsed: ConversionConfigFile = JSON.parse(raw);
    const profileEntries = Object.entries(parsed.profiles || {});
    for (const [id, def] of profileEntries) this.profiles.set(id, { id, ...def });
    if (!this.profiles.size) throw new Error('No conversion profiles defined for llmswitch core orchestrator');
    if (parsed.endpointBindings) for (const [ep, pid] of Object.entries(parsed.endpointBindings)) this.endpointBindings.set(ep, pid);
    this.defaultProfileId = this.options.defaultProfile ?? profileEntries[0]?.[0];
    this.initialized = true;
  }

  private async resolveProfilesPath(configuredPath?: string, baseDir?: string): Promise<{ selected: string; baseDir: string }> {
    const root = baseDir || this.options.baseDir;
    if (!root) throw new Error('llmswitch-core: baseDir is required for deterministic profile resolution');
    const rel = configuredPath || DEFAULT_PROFILES_RELATIVE;
    const selected = path.isAbsolute(rel) ? rel : path.resolve(root, rel);
    try { await fs.access(selected); } catch {
      throw new Error(`Unable to locate llmswitch profiles file at '${selected}'. baseDir='${root}' rel='${rel}'`);
    }
    return { selected, baseDir: root };
  }

  /** Allow host to register codec factories dynamically (routecodex will inject its codecs). */
  registerCodec(id: string, factory: import('./codec-registry.js').CodecFactory): void {
    this.codecRegistry.register(id, factory);
  }

  registerFactories(factories: Record<string, import('./codec-registry.js').CodecFactory>): void {
    for (const [id, f] of Object.entries(factories)) this.codecRegistry.register(id, f);
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
    return { profile, payload: converted };
  }

  async prepareOutgoing(payload: any, context: ConversionContext): Promise<ConversionResult> {
    await this.ensureInitialized();
    const requestId = context.requestId ?? `req_${Date.now()}`;
    const binding = this.requestBindings.get(requestId);
    const profile = binding ? this.profiles.get(binding.profileId) : this.resolveProfile(context);
    if (!profile) throw new Error(`Unable to resolve conversion profile for request ${requestId}`);
    const codec = await this.codecRegistry.resolve(profile.codec);
    const converted = await codec.convertResponse(payload, profile, { ...context, requestId });
    if (profile.clientResponseSchema) await this.schemaValidator.validate(profile.clientResponseSchema, converted, `${profile.id}:client-response`);
    if (binding) this.requestBindings.delete(requestId);
    return { profile, payload: converted };
  }

  private resolveProfile(context: ConversionContext): ConversionProfile {
    const explicit = context.metadata && typeof context.metadata['conversionProfileId'] === 'string'
      ? context.metadata['conversionProfileId'] as string
      : undefined;
    if (explicit && this.profiles.has(explicit)) return this.profiles.get(explicit)!;
    const endpoint = context.entryEndpoint ?? context.endpoint;
    if (endpoint && this.endpointBindings.has(endpoint)) {
      const profileId = this.endpointBindings.get(endpoint)!;
      const prof = this.profiles.get(profileId);
      if (prof) return prof;
    }
    if (this.defaultProfileId && this.profiles.has(this.defaultProfileId)) return this.profiles.get(this.defaultProfileId)!;
    const [first] = this.profiles.values();
    if (!first) throw new Error('No conversion profiles available');
    return first;
  }

  private async ensureInitialized(): Promise<void> { if (!this.initialized) await this.initialize(); }
}
