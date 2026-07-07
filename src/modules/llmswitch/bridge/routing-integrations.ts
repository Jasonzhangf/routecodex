/**
 * Routing Integrations Bridge
 *
 * Virtual router bootstrap + hub pipeline constructor + host base dir resolver.
 */

import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { resolveCorePackageDir } from '../core-loader.js';
import { importCoreDist, resolveImplForSubpath } from './module-loader.js';
import type { AnyRecord, LlmsImpl } from './module-loader.js';

function getImportMetaUrlUnsafe(): string | undefined {
  try {
    return Function('return import.meta.url')() as string | undefined;
  } catch {
    return undefined;
  }
}

const nodeRequire = createRequire(getImportMetaUrlUnsafe() || path.join(process.cwd(), 'package.json'));

function parseNativeJsonResult(raw: unknown): unknown {
  const text = String(raw);
  if (text.startsWith('Error: ')) {
    throw new Error(text.slice('Error: '.length));
  }
  return JSON.parse(text) as unknown;
}

type VirtualRouterBootstrapModule = {
  bootstrapVirtualRouterConfig?: (input: AnyRecord) => AnyRecord;
};


export async function bootstrapVirtualRouterConfig(input: AnyRecord): Promise<AnyRecord> {
  const mod = await importCoreDist<VirtualRouterBootstrapModule>('native/router-hotpath/native-virtual-router-bootstrap-config');
  const fn = mod.bootstrapVirtualRouterConfig;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] bootstrapVirtualRouterConfig not available');
  }
  return fn(input);
}

export async function compileRouteCodexRuntimeManifest(input: AnyRecord): Promise<AnyRecord> {
  return compileRouteCodexRuntimeManifestSync(input);
}

export function compileRouteCodexRuntimeManifestSync(input: AnyRecord): AnyRecord {
  const binding = loadNativeBindingForConfigCodec();
  const fn = binding.compileRouteCodexRuntimeManifestJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] compileRouteCodexRuntimeManifestJson not available');
  }
  const raw = String(fn(JSON.stringify(input ?? {})));
  if (raw.startsWith('Error:') || raw.startsWith('VIRTUAL_ROUTER_ERROR:')) {
    throw new Error(raw);
  }
  const output = JSON.parse(raw) as unknown;
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-bridge] RouteCodex runtime config compiler returned invalid payload');
  }
  const manifest = output as AnyRecord;
  if (manifest.manifestVersion !== 'routecodex.runtime-config.v1' ||
      !manifest.virtualRouterBootstrapInput ||
      typeof manifest.virtualRouterBootstrapInput !== 'object' ||
      Array.isArray(manifest.virtualRouterBootstrapInput) ||
      !manifest.pipelineRuntimeConfig ||
      typeof manifest.pipelineRuntimeConfig !== 'object' ||
      Array.isArray(manifest.pipelineRuntimeConfig)) {
    throw new Error('[llmswitch-bridge] RouteCodex runtime config compiler returned invalid manifest');
  }
  return manifest;
}

export function collectRouteCodexV2ConfigSourceErrorsSync(userConfig: AnyRecord): string[] {
  const binding = loadNativeBindingForConfigCodec();
  const fn = binding.collectRouteCodexV2ConfigSourceErrorsJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] collectRouteCodexV2ConfigSourceErrorsJson not available');
  }
  const output = JSON.parse(String(fn(JSON.stringify({ userConfig: userConfig ?? {} })))) as unknown;
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-bridge] RouteCodex config source validator returned invalid payload');
  }
  const errors = (output as AnyRecord).errors;
  if (!Array.isArray(errors) || !errors.every((item) => typeof item === 'string')) {
    throw new Error('[llmswitch-bridge] RouteCodex config source validator returned invalid errors');
  }
  return errors;
}

export function normalizeRouteCodexV2RuntimeSourceSync(userConfig: AnyRecord): AnyRecord {
  const binding = loadNativeBindingForConfigCodec();
  const fn = binding.normalizeRouteCodexV2RuntimeSourceJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] normalizeRouteCodexV2RuntimeSourceJson not available');
  }
  const output = JSON.parse(String(fn(JSON.stringify({ userConfig: userConfig ?? {} })))) as unknown;
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-bridge] RouteCodex runtime source normalizer returned invalid payload');
  }
  const normalized = (output as AnyRecord).userConfig;
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
    throw new Error('[llmswitch-bridge] RouteCodex runtime source normalizer returned invalid userConfig');
  }
  return normalized as AnyRecord;
}

export function resolvePrimaryRouteCodexRoutingPolicyGroupSync(userConfig: AnyRecord): string | undefined {
  const binding = loadNativeBindingForConfigCodec();
  const fn = binding.resolvePrimaryRouteCodexRoutingPolicyGroupJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] resolvePrimaryRouteCodexRoutingPolicyGroupJson not available');
  }
  const output = JSON.parse(String(fn(JSON.stringify({ userConfig: userConfig ?? {} })))) as unknown;
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-bridge] RouteCodex routingPolicyGroup resolver returned invalid payload');
  }
  const group = (output as AnyRecord).routingPolicyGroup;
  if (group === null || typeof group === 'undefined') {
    return undefined;
  }
  if (typeof group !== 'string') {
    throw new Error('[llmswitch-bridge] RouteCodex routingPolicyGroup resolver returned invalid group');
  }
  return group;
}

export function extractRouteCodexMaterializedProviderConfigsSync(userConfig: AnyRecord): AnyRecord | null {
  const binding = loadNativeBindingForConfigCodec();
  const fn = binding.extractRouteCodexMaterializedProviderConfigsJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] extractRouteCodexMaterializedProviderConfigsJson not available');
  }
  const output = JSON.parse(String(fn(JSON.stringify({ userConfig: userConfig ?? {} })))) as unknown;
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-bridge] RouteCodex materialized provider extractor returned invalid payload');
  }
  const providerConfigs = (output as AnyRecord).providerConfigs;
  if (providerConfigs === null || typeof providerConfigs === 'undefined') {
    return null;
  }
  if (!providerConfigs || typeof providerConfigs !== 'object' || Array.isArray(providerConfigs)) {
    throw new Error('[llmswitch-bridge] RouteCodex materialized provider extractor returned invalid providerConfigs');
  }
  return providerConfigs as AnyRecord;
}

export function materializeRouteCodexUserConfigFromManifestSync(userConfig: AnyRecord, manifest: AnyRecord): AnyRecord {
  const binding = loadNativeBindingForConfigCodec();
  const fn = binding.materializeRouteCodexUserConfigFromManifestJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] materializeRouteCodexUserConfigFromManifestJson not available');
  }
  const output = JSON.parse(String(fn(JSON.stringify({
    userConfig: userConfig ?? {},
    manifest: manifest ?? {}
  })))) as unknown;
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-bridge] RouteCodex user config materializer returned invalid payload');
  }
  const materialized = (output as AnyRecord).userConfig;
  if (!materialized || typeof materialized !== 'object' || Array.isArray(materialized)) {
    throw new Error('[llmswitch-bridge] RouteCodex user config materializer returned invalid userConfig');
  }
  return materialized as AnyRecord;
}

export function buildRouteCodexProviderProfilesSync(userConfig: AnyRecord): AnyRecord {
  const binding = loadNativeBindingForConfigCodec();
  const fn = binding.buildRouteCodexProviderProfilesJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] buildRouteCodexProviderProfilesJson not available');
  }
  const raw = String(fn(JSON.stringify({ userConfig: userConfig ?? {} })));
  if (raw.startsWith('Error:') || raw.startsWith('VIRTUAL_ROUTER_ERROR:')) {
    throw new Error(raw);
  }
  const output = JSON.parse(raw) as unknown;
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-bridge] RouteCodex provider profile builder returned invalid payload');
  }
  const providerProfiles = (output as AnyRecord).providerProfiles;
  if (!providerProfiles || typeof providerProfiles !== 'object' || Array.isArray(providerProfiles)) {
    throw new Error('[llmswitch-bridge] RouteCodex provider profile builder returned invalid providerProfiles');
  }
  return providerProfiles as AnyRecord;
}

export function buildRouteCodexForwarderProfilesSync(userConfig: AnyRecord, knownProviderIds: Set<string> | string[]): AnyRecord {
  const binding = loadNativeBindingForConfigCodec();
  const fn = binding.buildRouteCodexForwarderProfilesJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] buildRouteCodexForwarderProfilesJson not available');
  }
  const providerIds = Array.isArray(knownProviderIds) ? knownProviderIds : Array.from(knownProviderIds ?? []);
  const raw = String(fn(JSON.stringify({ userConfig: userConfig ?? {}, knownProviderIds: providerIds })));
  if (raw.startsWith('Error:') || raw.startsWith('VIRTUAL_ROUTER_ERROR:')) {
    throw new Error(raw);
  }
  const output = JSON.parse(raw) as unknown;
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-bridge] RouteCodex forwarder profile builder returned invalid payload');
  }
  const forwarderProfiles = (output as AnyRecord).forwarderProfiles;
  if (!forwarderProfiles || typeof forwarderProfiles !== 'object' || Array.isArray(forwarderProfiles)) {
    throw new Error('[llmswitch-bridge] RouteCodex forwarder profile builder returned invalid forwarderProfiles');
  }
  return forwarderProfiles as AnyRecord;
}

export async function parseRouteCodexTomlRecord(raw: string): Promise<AnyRecord> {
  return parseRouteCodexTomlRecordSync(raw);
}

export function parseRouteCodexTomlRecordSync(raw: string): AnyRecord {
  const binding = loadNativeBindingForConfigCodec();
  const fn = binding.parseRouteCodexTomlRecordJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] parseRouteCodexTomlRecordJson not available');
  }
  return parseNativeTomlRecord(String(fn(String(raw ?? ''))));
}

export async function serializeRouteCodexTomlRecord(record: AnyRecord): Promise<string> {
  return serializeRouteCodexTomlRecordSync(record);
}

export function serializeRouteCodexTomlRecordSync(record: AnyRecord): string {
  const binding = loadNativeBindingForConfigCodec();
  const fn = binding.serializeRouteCodexTomlRecordJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] serializeRouteCodexTomlRecordJson not available');
  }
  return String(fn(JSON.stringify(record ?? {})));
}

export async function updateRouteCodexTomlStringScalarInTable(input: {
  raw: string;
  tablePath: string[];
  key: string;
  value: string;
}): Promise<string> {
  return updateRouteCodexTomlStringScalarInTableSync(input);
}

export function updateRouteCodexTomlStringScalarInTableSync(input: {
  raw: string;
  tablePath: string[];
  key: string;
  value: string;
}): string {
  const binding = loadNativeBindingForConfigCodec();
  const fn = binding.updateRouteCodexTomlStringScalarInTableJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] updateRouteCodexTomlStringScalarInTableJson not available');
  }
  return String(fn(JSON.stringify({
    raw: String(input.raw ?? ''),
    tablePath: Array.isArray(input.tablePath) ? input.tablePath.map(String) : [],
    key: String(input.key ?? ''),
    value: String(input.value ?? '')
  })));
}

export async function coerceRouteCodexProviderConfigV2(
  parsed: AnyRecord,
  fallbackProviderId?: string
): Promise<AnyRecord | null> {
  return coerceRouteCodexProviderConfigV2Sync(parsed, fallbackProviderId);
}

export function coerceRouteCodexProviderConfigV2Sync(
  parsed: AnyRecord,
  fallbackProviderId?: string
): AnyRecord | null {
  const binding = loadNativeBindingForConfigCodec();
  const fn = binding.coerceRouteCodexProviderConfigV2Json;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] coerceRouteCodexProviderConfigV2Json not available');
  }
  const output = parseNativeJsonResult(fn(JSON.stringify({
    parsed: parsed ?? {},
    fallbackProviderId: String(fallbackProviderId ?? '')
  }))) as unknown;
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-bridge] RouteCodex provider config coercer returned invalid payload');
  }
  const config = (output as AnyRecord).config;
  if (config === null) {
    return null;
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('[llmswitch-bridge] RouteCodex provider config coercer returned invalid config');
  }
  return config as AnyRecord;
}

export function planRouteCodexProviderConfigV2FilesSync(fileNames: string[]): Array<{
  fileName: string;
  isBaseFile: boolean;
}> {
  const binding = loadNativeBindingForConfigCodec();
  const fn = binding.planRouteCodexProviderConfigV2FilesJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] planRouteCodexProviderConfigV2FilesJson not available');
  }
  const output = parseNativeJsonResult(fn(JSON.stringify({ fileNames }))) as unknown;
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-bridge] RouteCodex provider config file planner returned invalid payload');
  }
  const files = (output as AnyRecord).files;
  if (!Array.isArray(files)) {
    throw new Error('[llmswitch-bridge] RouteCodex provider config file planner returned invalid files');
  }
  return files.map((file) => {
    if (!file || typeof file !== 'object' || Array.isArray(file)) {
      throw new Error('[llmswitch-bridge] RouteCodex provider config file planner returned invalid file entry');
    }
    const record = file as AnyRecord;
    if (typeof record.fileName !== 'string' || typeof record.isBaseFile !== 'boolean') {
      throw new Error('[llmswitch-bridge] RouteCodex provider config file planner returned invalid file shape');
    }
    return {
      fileName: record.fileName,
      isBaseFile: record.isBaseFile
    };
  });
}

export function resolveRouteCodexProviderConfigV2IdentitySync(input: {
  dirId: string;
  fileName: string;
  filePath: string;
  isBaseFile: boolean;
  parsed: AnyRecord;
  provider: AnyRecord;
}): { providerId: string; provider: AnyRecord } {
  const binding = loadNativeBindingForConfigCodec();
  const fn = binding.resolveRouteCodexProviderConfigV2IdentityJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] resolveRouteCodexProviderConfigV2IdentityJson not available');
  }
  const output = JSON.parse(String(fn(JSON.stringify(input)))) as unknown;
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-bridge] RouteCodex provider config identity resolver returned invalid payload');
  }
  const record = output as AnyRecord;
  if (typeof record.providerId !== 'string' ||
      !record.provider ||
      typeof record.provider !== 'object' ||
      Array.isArray(record.provider)) {
    throw new Error('[llmswitch-bridge] RouteCodex provider config identity resolver returned invalid shape');
  }
  return {
    providerId: record.providerId,
    provider: record.provider as AnyRecord
  };
}

export function loadRouteCodexProviderConfigsV2FromRootSync(rootDir: string): Record<string, AnyRecord> {
  const binding = loadNativeBindingForConfigCodec();
  const fn = binding.loadRouteCodexProviderConfigsV2FromRootJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] loadRouteCodexProviderConfigsV2FromRootJson not available');
  }
  const output = parseNativeJsonResult(fn(JSON.stringify({ rootDir: String(rootDir ?? '') }))) as unknown;
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-bridge] RouteCodex provider config root loader returned invalid payload');
  }
  const configs = (output as AnyRecord).configs;
  if (!configs || typeof configs !== 'object' || Array.isArray(configs)) {
    throw new Error('[llmswitch-bridge] RouteCodex provider config root loader returned invalid configs');
  }
  return configs as Record<string, AnyRecord>;
}

function loadNativeBindingForConfigCodec(): AnyRecord {
  const coreDir = resolveCorePackageDir('ts');
  const nativePath = path.join(coreDir, 'dist', 'native', 'router_hotpath_napi.node');
  return nodeRequire(nativePath) as AnyRecord;
}

function parseNativeTomlRecord(raw: string): AnyRecord {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('[llmswitch-bridge] RouteCodex TOML parser returned invalid payload');
  }
  return parsed as AnyRecord;
}

type HubPipelineModule = {
  HubPipeline?: new (config: AnyRecord) => AnyRecord;
};

type HubPipelineCtorAny = new (config: AnyRecord) => AnyRecord;

const cachedHubPipelineCtorByImpl: Record<LlmsImpl, HubPipelineCtorAny | null> = {
  ts: null,
  engine: null
};

export async function getHubPipelineCtor(): Promise<HubPipelineCtorAny> {
  const impl = resolveImplForSubpath('conversion/hub/pipeline/hub-pipeline');
  if (!cachedHubPipelineCtorByImpl[impl]) {
    const mod = await importCoreDist<HubPipelineModule>('conversion/hub/pipeline/hub-pipeline', impl);
    const Ctor = mod.HubPipeline;
    if (typeof Ctor !== 'function') {
      throw new Error('[llmswitch-bridge] HubPipeline constructor not available');
    }
    cachedHubPipelineCtorByImpl[impl] = Ctor;
  }
  return cachedHubPipelineCtorByImpl[impl]!;
}

export async function getHubPipelineCtorForImpl(impl: LlmsImpl): Promise<HubPipelineCtorAny> {
  if (!cachedHubPipelineCtorByImpl[impl]) {
    const mod = await importCoreDist<HubPipelineModule>('conversion/hub/pipeline/hub-pipeline', impl);
    const Ctor = mod.HubPipeline;
    if (typeof Ctor !== 'function') {
      throw new Error('[llmswitch-bridge] HubPipeline constructor not available');
    }
    cachedHubPipelineCtorByImpl[impl] = Ctor;
  }
  return cachedHubPipelineCtorByImpl[impl]!;
}

export function resolveBaseDir(): string {
  const env = String(process.env.ROUTECODEX_BASEDIR || process.env.RCC_BASEDIR || '').trim();
  if (env) return env;
  const metaUrl = getImportMetaUrlUnsafe();
  if (typeof metaUrl === 'string' && metaUrl.length > 0) {
    try {
      const __filename = fileURLToPath(metaUrl);
      return path.resolve(path.dirname(__filename), '../../../..');
    } catch {
      // fall through
    }
  }
  return process.cwd();
}
