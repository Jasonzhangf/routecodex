/**
 * Routing Integrations Bridge
 *
 * Virtual router bootstrap + hub pipeline constructor + host base dir resolver.
 */
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { resolveCorePackageDir } from '../core-loader.js';
let cachedNativeHubPipelineOrchestrationSemantics = null;
function getNativeHubPipelineOrchestrationSemantics() {
    if (!cachedNativeHubPipelineOrchestrationSemantics) {
        cachedNativeHubPipelineOrchestrationSemantics =
            loadNativeBindingForConfigCodec();
    }
    return cachedNativeHubPipelineOrchestrationSemantics;
}
function requireNativeHubPipelineFn(name) {
    const fn = getNativeHubPipelineOrchestrationSemantics()[name];
    if (typeof fn !== 'function') {
        throw new Error(`[llmswitch-bridge] ${String(name)} not available`);
    }
    return fn;
}
function getImportMetaUrlUnsafe() {
    try {
        return Function('return import.meta.url')();
    }
    catch {
        return undefined;
    }
}
const nodeRequire = createRequire(getImportMetaUrlUnsafe() || path.join(process.cwd(), 'package.json'));
function parseNativeJsonResult(raw) {
    const text = String(raw);
    if (text.startsWith('Error: ')) {
        throw new Error(text.slice('Error: '.length));
    }
    return JSON.parse(text);
}
function callNativeBindingFn(name, args) {
    const fn = loadNativeBindingForConfigCodec()[name];
    if (typeof fn !== 'function') {
        throw new Error(`[llmswitch-bridge] ${name} not available`);
    }
    return fn(...args);
}
function stringifyNativePayload(name, value) {
    try {
        return JSON.stringify(value) ?? 'null';
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : String(error ?? 'unknown');
        throw new Error(`[llmswitch-bridge] ${name} JSON stringify failed: ${detail}`);
    }
}
function parseNativeRecord(name, raw) {
    const parsed = parseNativeJsonResult(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`[llmswitch-bridge] ${name} returned invalid payload`);
    }
    return parsed;
}
function resolveRccUserDirForNativeRouting() {
    const parsed = parseNativeJsonResult(callNativeBindingFn('resolveRccUserDirJson', [
        stringifyNativePayload('resolveRccUserDirJson', {
            homeDir: process.env.HOME,
            rccHome: process.env.RCC_HOME,
            routecodexUserDir: process.env.ROUTECODEX_USER_DIR,
            routecodexHome: process.env.ROUTECODEX_HOME
        })
    ]));
    return typeof parsed === 'string' && parsed.trim() ? parsed : undefined;
}
function parseHubPipelineNativeJsonResult(raw, label) {
    const text = String(raw);
    if (text.startsWith('Error: ')) {
        throw new Error(text.slice('Error: '.length));
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (error) {
        throw new Error(`[llmswitch-bridge] ${label} returned invalid payload: ${String(error)}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`[llmswitch-bridge] ${label} returned non-object payload`);
    }
    return parsed;
}
export async function bootstrapVirtualRouterConfig(input) {
    const binding = loadNativeBindingForConfigCodec();
    const fn = binding.bootstrapVirtualRouterConfigJson;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] bootstrapVirtualRouterConfigJson not available');
    }
    const output = parseNativeJsonResult(fn(JSON.stringify(input ?? {})));
    if (!output || typeof output !== 'object' || Array.isArray(output)) {
        throw new Error('[llmswitch-bridge] bootstrapVirtualRouterConfigJson returned invalid payload');
    }
    return output;
}
export async function compileRouteCodexRuntimeManifest(input) {
    return compileRouteCodexRuntimeManifestSync(input);
}
export function compileRouteCodexRuntimeManifestSync(input) {
    const binding = loadNativeBindingForConfigCodec();
    const fn = binding.compileRouteCodexRuntimeManifestJson;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] compileRouteCodexRuntimeManifestJson not available');
    }
    const raw = String(fn(JSON.stringify(input ?? {})));
    if (raw.startsWith('Error:') || raw.startsWith('VIRTUAL_ROUTER_ERROR:')) {
        throw new Error(raw);
    }
    const output = JSON.parse(raw);
    if (!output || typeof output !== 'object' || Array.isArray(output)) {
        throw new Error('[llmswitch-bridge] RouteCodex runtime config compiler returned invalid payload');
    }
    const manifest = output;
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
export function collectRouteCodexV2ConfigSourceErrorsSync(userConfig) {
    const binding = loadNativeBindingForConfigCodec();
    const fn = binding.collectRouteCodexV2ConfigSourceErrorsJson;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] collectRouteCodexV2ConfigSourceErrorsJson not available');
    }
    const output = JSON.parse(String(fn(JSON.stringify({ userConfig: userConfig ?? {} }))));
    if (!output || typeof output !== 'object' || Array.isArray(output)) {
        throw new Error('[llmswitch-bridge] RouteCodex config source validator returned invalid payload');
    }
    const errors = output.errors;
    if (!Array.isArray(errors) || !errors.every((item) => typeof item === 'string')) {
        throw new Error('[llmswitch-bridge] RouteCodex config source validator returned invalid errors');
    }
    return errors;
}
export function normalizeRouteCodexV2RuntimeSourceSync(userConfig) {
    const binding = loadNativeBindingForConfigCodec();
    const fn = binding.normalizeRouteCodexV2RuntimeSourceJson;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] normalizeRouteCodexV2RuntimeSourceJson not available');
    }
    const output = JSON.parse(String(fn(JSON.stringify({ userConfig: userConfig ?? {} }))));
    if (!output || typeof output !== 'object' || Array.isArray(output)) {
        throw new Error('[llmswitch-bridge] RouteCodex runtime source normalizer returned invalid payload');
    }
    const normalized = output.userConfig;
    if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
        throw new Error('[llmswitch-bridge] RouteCodex runtime source normalizer returned invalid userConfig');
    }
    return normalized;
}
export function resolvePrimaryRouteCodexRoutingPolicyGroupSync(userConfig) {
    const binding = loadNativeBindingForConfigCodec();
    const fn = binding.resolvePrimaryRouteCodexRoutingPolicyGroupJson;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] resolvePrimaryRouteCodexRoutingPolicyGroupJson not available');
    }
    const output = JSON.parse(String(fn(JSON.stringify({ userConfig: userConfig ?? {} }))));
    if (!output || typeof output !== 'object' || Array.isArray(output)) {
        throw new Error('[llmswitch-bridge] RouteCodex routingPolicyGroup resolver returned invalid payload');
    }
    const group = output.routingPolicyGroup;
    if (group === null || typeof group === 'undefined') {
        return undefined;
    }
    if (typeof group !== 'string') {
        throw new Error('[llmswitch-bridge] RouteCodex routingPolicyGroup resolver returned invalid group');
    }
    return group;
}
export function extractRouteCodexMaterializedProviderConfigsSync(userConfig) {
    const binding = loadNativeBindingForConfigCodec();
    const fn = binding.extractRouteCodexMaterializedProviderConfigsJson;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] extractRouteCodexMaterializedProviderConfigsJson not available');
    }
    const output = JSON.parse(String(fn(JSON.stringify({ userConfig: userConfig ?? {} }))));
    if (!output || typeof output !== 'object' || Array.isArray(output)) {
        throw new Error('[llmswitch-bridge] RouteCodex materialized provider extractor returned invalid payload');
    }
    const providerConfigs = output.providerConfigs;
    if (providerConfigs === null || typeof providerConfigs === 'undefined') {
        return null;
    }
    if (!providerConfigs || typeof providerConfigs !== 'object' || Array.isArray(providerConfigs)) {
        throw new Error('[llmswitch-bridge] RouteCodex materialized provider extractor returned invalid providerConfigs');
    }
    return providerConfigs;
}
export function materializeRouteCodexUserConfigFromManifestSync(userConfig, manifest) {
    const binding = loadNativeBindingForConfigCodec();
    const fn = binding.materializeRouteCodexUserConfigFromManifestJson;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] materializeRouteCodexUserConfigFromManifestJson not available');
    }
    const output = JSON.parse(String(fn(JSON.stringify({
        userConfig: userConfig ?? {},
        manifest: manifest ?? {}
    }))));
    if (!output || typeof output !== 'object' || Array.isArray(output)) {
        throw new Error('[llmswitch-bridge] RouteCodex user config materializer returned invalid payload');
    }
    const materialized = output.userConfig;
    if (!materialized || typeof materialized !== 'object' || Array.isArray(materialized)) {
        throw new Error('[llmswitch-bridge] RouteCodex user config materializer returned invalid userConfig');
    }
    return materialized;
}
export function buildRouteCodexProviderProfilesSync(userConfig) {
    const binding = loadNativeBindingForConfigCodec();
    const fn = binding.buildRouteCodexProviderProfilesJson;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] buildRouteCodexProviderProfilesJson not available');
    }
    const raw = String(fn(JSON.stringify({ userConfig: userConfig ?? {} })));
    if (raw.startsWith('Error:') || raw.startsWith('VIRTUAL_ROUTER_ERROR:')) {
        throw new Error(raw);
    }
    const output = JSON.parse(raw);
    if (!output || typeof output !== 'object' || Array.isArray(output)) {
        throw new Error('[llmswitch-bridge] RouteCodex provider profile builder returned invalid payload');
    }
    const providerProfiles = output.providerProfiles;
    if (!providerProfiles || typeof providerProfiles !== 'object' || Array.isArray(providerProfiles)) {
        throw new Error('[llmswitch-bridge] RouteCodex provider profile builder returned invalid providerProfiles');
    }
    return providerProfiles;
}
export function buildRouteCodexForwarderProfilesSync(userConfig, knownProviderIds) {
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
    const output = JSON.parse(raw);
    if (!output || typeof output !== 'object' || Array.isArray(output)) {
        throw new Error('[llmswitch-bridge] RouteCodex forwarder profile builder returned invalid payload');
    }
    const forwarderProfiles = output.forwarderProfiles;
    if (!forwarderProfiles || typeof forwarderProfiles !== 'object' || Array.isArray(forwarderProfiles)) {
        throw new Error('[llmswitch-bridge] RouteCodex forwarder profile builder returned invalid forwarderProfiles');
    }
    return forwarderProfiles;
}
export async function parseRouteCodexTomlRecord(raw) {
    return parseRouteCodexTomlRecordSync(raw);
}
export function parseRouteCodexTomlRecordSync(raw) {
    const binding = loadNativeBindingForConfigCodec();
    const fn = binding.parseRouteCodexTomlRecordJson;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] parseRouteCodexTomlRecordJson not available');
    }
    return parseNativeTomlRecord(String(fn(String(raw ?? ''))));
}
export async function serializeRouteCodexTomlRecord(record) {
    return serializeRouteCodexTomlRecordSync(record);
}
export function serializeRouteCodexTomlRecordSync(record) {
    const binding = loadNativeBindingForConfigCodec();
    const fn = binding.serializeRouteCodexTomlRecordJson;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] serializeRouteCodexTomlRecordJson not available');
    }
    return String(fn(JSON.stringify(record ?? {})));
}
export async function updateRouteCodexTomlStringScalarInTable(input) {
    return updateRouteCodexTomlStringScalarInTableSync(input);
}
export function updateRouteCodexTomlStringScalarInTableSync(input) {
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
export function decodeRouteCodexUserConfigTextSync(input) {
    const binding = loadNativeBindingForConfigCodec();
    const fn = binding.decodeRouteCodexUserConfigTextJson;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] decodeRouteCodexUserConfigTextJson not available');
    }
    const output = parseNativeJsonResult(fn(JSON.stringify({
        raw: String(input.raw ?? ''),
        ...(typeof input.configPath === 'string' ? { configPath: input.configPath } : {})
    })));
    return parseDecodedConfigTextOutput(output, 'user');
}
export function decodeRouteCodexProviderConfigTextSync(input) {
    const binding = loadNativeBindingForConfigCodec();
    const fn = binding.decodeRouteCodexProviderConfigTextJson;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] decodeRouteCodexProviderConfigTextJson not available');
    }
    const output = parseNativeJsonResult(fn(JSON.stringify({
        raw: String(input.raw ?? ''),
        ...(typeof input.configPath === 'string' ? { configPath: input.configPath } : {})
    })));
    return parseDecodedConfigTextOutput(output, 'provider');
}
export function detectRouteCodexUserConfigFormatSync(configPath) {
    const binding = loadNativeBindingForConfigCodec();
    const fn = binding.detectRouteCodexUserConfigFormatJson;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] detectRouteCodexUserConfigFormatJson not available');
    }
    const output = parseNativeJsonResult(fn(JSON.stringify({ configPath: String(configPath ?? '') })));
    return parseDetectedConfigFormatOutput(output, 'user');
}
export function detectRouteCodexProviderConfigFormatSync(configPath) {
    const binding = loadNativeBindingForConfigCodec();
    const fn = binding.detectRouteCodexProviderConfigFormatJson;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] detectRouteCodexProviderConfigFormatJson not available');
    }
    const output = parseNativeJsonResult(fn(JSON.stringify({ configPath: String(configPath ?? '') })));
    return parseDetectedConfigFormatOutput(output, 'provider');
}
function validatePersistedConfigFileOutput(output, label) {
    if (!output || typeof output !== 'object' || Array.isArray(output)) {
        throw new Error(`[llmswitch-bridge] ${label} writer returned invalid payload`);
    }
    const persisted = output;
    if (typeof persisted.path !== 'string' ||
        persisted.format !== 'toml' ||
        typeof persisted.raw !== 'string' ||
        !persisted.parsed ||
        typeof persisted.parsed !== 'object' ||
        Array.isArray(persisted.parsed)) {
        throw new Error(`[llmswitch-bridge] ${label} writer returned invalid shape`);
    }
    return persisted;
}
export function writeRouteCodexUserConfigFileNativeSync(input) {
    const binding = loadNativeBindingForConfigCodec();
    const fn = binding.writeRouteCodexUserConfigFileJson;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] writeRouteCodexUserConfigFileJson not available');
    }
    return validatePersistedConfigFileOutput(parseNativeJsonResult(fn(JSON.stringify({
        configPath: input.configPath,
        parsed: input.parsed ?? {},
        format: input.format
    }))), 'User config');
}
export function writeRouteCodexProviderConfigFileNativeSync(input) {
    const binding = loadNativeBindingForConfigCodec();
    const fn = binding.writeRouteCodexProviderConfigFileJson;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] writeRouteCodexProviderConfigFileJson not available');
    }
    return validatePersistedConfigFileOutput(parseNativeJsonResult(fn(JSON.stringify({
        configPath: input.configPath,
        parsed: input.parsed ?? {},
        format: input.format
    }))), 'Provider config');
}
export function updateRouteCodexUserConfigStringScalarNativeSync(input) {
    const binding = loadNativeBindingForConfigCodec();
    const fn = binding.updateRouteCodexUserConfigStringScalarJson;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] updateRouteCodexUserConfigStringScalarJson not available');
    }
    return validatePersistedConfigFileOutput(parseNativeJsonResult(fn(JSON.stringify({
        configPath: input.configPath,
        tablePath: input.tablePath,
        key: input.key,
        value: input.value
    }))), 'User config scalar update');
}
export function loadRouteCodexConfigNativeSync(input = {}) {
    const binding = loadNativeBindingForConfigCodec();
    const fn = binding.loadRouteCodexConfigJson;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] loadRouteCodexConfigJson not available');
    }
    const output = parseNativeJsonResult(fn(JSON.stringify({
        explicitPath: input.explicitPath,
        routecodexProviderDir: input.routecodexProviderDir ?? process.env.ROUTECODEX_PROVIDER_DIR,
        rccProviderDir: input.rccProviderDir ?? process.env.RCC_PROVIDER_DIR,
        cwd: safeBridgeCwd(),
        homeDir: process.env.HOME,
        execPath: process.execPath,
        routecodexConfigPath: process.env.ROUTECODEX_CONFIG_PATH,
        routecodexConfig: process.env.ROUTECODEX_CONFIG,
        rccHome: process.env.RCC_HOME,
        routecodexUserDir: process.env.ROUTECODEX_USER_DIR,
        routecodexHome: process.env.ROUTECODEX_HOME
    })));
    if (!output || typeof output !== 'object' || Array.isArray(output)) {
        throw new Error('[llmswitch-bridge] RouteCodex config loader returned invalid payload');
    }
    const loaded = output;
    if (typeof loaded.configPath !== 'string' ||
        !loaded.userConfig ||
        typeof loaded.userConfig !== 'object' ||
        Array.isArray(loaded.userConfig) ||
        !loaded.providerProfiles ||
        typeof loaded.providerProfiles !== 'object' ||
        Array.isArray(loaded.providerProfiles)) {
        throw new Error('[llmswitch-bridge] RouteCodex config loader returned invalid shape');
    }
    return loaded;
}
export async function coerceRouteCodexProviderConfigV2(parsed, fallbackProviderId) {
    return coerceRouteCodexProviderConfigV2Sync(parsed, fallbackProviderId);
}
export function coerceRouteCodexProviderConfigV2Sync(parsed, fallbackProviderId) {
    const binding = loadNativeBindingForConfigCodec();
    const fn = binding.coerceRouteCodexProviderConfigV2Json;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] coerceRouteCodexProviderConfigV2Json not available');
    }
    const output = parseNativeJsonResult(fn(JSON.stringify({
        parsed: parsed ?? {},
        fallbackProviderId: String(fallbackProviderId ?? '')
    })));
    if (!output || typeof output !== 'object' || Array.isArray(output)) {
        throw new Error('[llmswitch-bridge] RouteCodex provider config coercer returned invalid payload');
    }
    const config = output.config;
    if (config === null) {
        return null;
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error('[llmswitch-bridge] RouteCodex provider config coercer returned invalid config');
    }
    return config;
}
export function planRouteCodexProviderConfigV2FilesSync(fileNames) {
    const binding = loadNativeBindingForConfigCodec();
    const fn = binding.planRouteCodexProviderConfigV2FilesJson;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] planRouteCodexProviderConfigV2FilesJson not available');
    }
    const output = parseNativeJsonResult(fn(JSON.stringify({ fileNames })));
    if (!output || typeof output !== 'object' || Array.isArray(output)) {
        throw new Error('[llmswitch-bridge] RouteCodex provider config file planner returned invalid payload');
    }
    const files = output.files;
    if (!Array.isArray(files)) {
        throw new Error('[llmswitch-bridge] RouteCodex provider config file planner returned invalid files');
    }
    return files.map((file) => {
        if (!file || typeof file !== 'object' || Array.isArray(file)) {
            throw new Error('[llmswitch-bridge] RouteCodex provider config file planner returned invalid file entry');
        }
        const record = file;
        if (typeof record.fileName !== 'string' || typeof record.isBaseFile !== 'boolean') {
            throw new Error('[llmswitch-bridge] RouteCodex provider config file planner returned invalid file shape');
        }
        return {
            fileName: record.fileName,
            isBaseFile: record.isBaseFile
        };
    });
}
export function resolveRouteCodexProviderConfigV2IdentitySync(input) {
    const binding = loadNativeBindingForConfigCodec();
    const fn = binding.resolveRouteCodexProviderConfigV2IdentityJson;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] resolveRouteCodexProviderConfigV2IdentityJson not available');
    }
    const output = JSON.parse(String(fn(JSON.stringify(input))));
    if (!output || typeof output !== 'object' || Array.isArray(output)) {
        throw new Error('[llmswitch-bridge] RouteCodex provider config identity resolver returned invalid payload');
    }
    const record = output;
    if (typeof record.providerId !== 'string' ||
        !record.provider ||
        typeof record.provider !== 'object' ||
        Array.isArray(record.provider)) {
        throw new Error('[llmswitch-bridge] RouteCodex provider config identity resolver returned invalid shape');
    }
    return {
        providerId: record.providerId,
        provider: record.provider
    };
}
export function loadRouteCodexProviderConfigsV2FromRootSync(rootDir) {
    const binding = loadNativeBindingForConfigCodec();
    const fn = binding.loadRouteCodexProviderConfigsV2FromRootJson;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] loadRouteCodexProviderConfigsV2FromRootJson not available');
    }
    const output = parseNativeJsonResult(fn(JSON.stringify({ rootDir: String(rootDir ?? '') })));
    if (!output || typeof output !== 'object' || Array.isArray(output)) {
        throw new Error('[llmswitch-bridge] RouteCodex provider config root loader returned invalid payload');
    }
    const configs = output.configs;
    if (!configs || typeof configs !== 'object' || Array.isArray(configs)) {
        throw new Error('[llmswitch-bridge] RouteCodex provider config root loader returned invalid configs');
    }
    return configs;
}
export function resolveRccUserDirNativeSync(homeDir) {
    const binding = loadNativeBindingForConfigCodec();
    const fn = binding.resolveRccUserDirJson;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] resolveRccUserDirJson not available');
    }
    const output = parseNativeJsonResult(fn(JSON.stringify({
        rccHome: process.env.RCC_HOME,
        routecodexUserDir: process.env.ROUTECODEX_USER_DIR,
        routecodexHome: process.env.ROUTECODEX_HOME,
        ...(typeof homeDir === 'string' ? { homeDir } : {})
    })));
    if (typeof output !== 'string' || !output.trim()) {
        throw new Error('[llmswitch-bridge] RouteCodex user dir resolver returned invalid path');
    }
    return output;
}
export function resolveRccPathNativeSync(segments, homeDir) {
    const binding = loadNativeBindingForConfigCodec();
    const fn = binding.resolveRccPathJson;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] resolveRccPathJson not available');
    }
    const output = parseNativeJsonResult(fn(JSON.stringify({
        segments: Array.isArray(segments) ? segments.map(String) : [],
        rccHome: process.env.RCC_HOME,
        routecodexUserDir: process.env.ROUTECODEX_USER_DIR,
        routecodexHome: process.env.ROUTECODEX_HOME,
        ...(typeof homeDir === 'string' ? { homeDir } : {})
    })));
    if (typeof output !== 'string' || !output.trim()) {
        throw new Error('[llmswitch-bridge] RouteCodex path resolver returned invalid path');
    }
    return output;
}
export function resolveRccSnapshotsDirNativeSync(homeDir) {
    const binding = loadNativeBindingForConfigCodec();
    const fn = binding.resolveRccSnapshotsDirJson;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] resolveRccSnapshotsDirJson not available');
    }
    const output = parseNativeJsonResult(fn(JSON.stringify({
        homeDir,
        rccSnapshotDir: process.env.RCC_SNAPSHOT_DIR,
        routecodexSnapshotDir: process.env.ROUTECODEX_SNAPSHOT_DIR,
        rccHome: process.env.RCC_HOME,
        routecodexUserDir: process.env.ROUTECODEX_USER_DIR,
        routecodexHome: process.env.ROUTECODEX_HOME
    })));
    if (!output || typeof output !== 'object' || Array.isArray(output)) {
        throw new Error('[llmswitch-bridge] RouteCodex snapshots dir resolver returned invalid payload');
    }
    const snapshotsDir = output.snapshotsDir;
    if (typeof snapshotsDir !== 'string' || !snapshotsDir.trim()) {
        throw new Error('[llmswitch-bridge] RouteCodex snapshots dir resolver returned invalid path');
    }
    return snapshotsDir;
}
export function planAuthFileResolutionNativeSync(input) {
    const binding = loadNativeBindingForConfigCodec();
    const fn = binding.planAuthFileResolutionJson;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] planAuthFileResolutionJson not available');
    }
    const output = parseNativeJsonResult(fn(JSON.stringify({
        keyId: String(input.keyId ?? ''),
        authDir: input.authDir,
        homeDir: input.homeDir,
        rccHome: process.env.RCC_HOME,
        routecodexUserDir: process.env.ROUTECODEX_USER_DIR,
        routecodexHome: process.env.ROUTECODEX_HOME
    })));
    if (!output || typeof output !== 'object' || Array.isArray(output)) {
        throw new Error('[llmswitch-bridge] AuthFile resolver returned invalid payload');
    }
    const plan = output;
    if (plan.kind !== 'literal' && plan.kind !== 'authFile') {
        throw new Error('[llmswitch-bridge] AuthFile resolver returned invalid kind');
    }
    if (plan.kind === 'literal' && typeof plan.value !== 'string') {
        throw new Error('[llmswitch-bridge] AuthFile resolver returned invalid literal value');
    }
    if (plan.kind === 'authFile' &&
        (typeof plan.filePath !== 'string' || typeof plan.cacheKey !== 'string')) {
        throw new Error('[llmswitch-bridge] AuthFile resolver returned invalid authFile plan');
    }
    return plan;
}
export function resolveAuthFileKeyNativeSync(input) {
    const binding = loadNativeBindingForConfigCodec();
    const fn = binding.resolveAuthFileKeyJson;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] resolveAuthFileKeyJson not available');
    }
    const output = parseNativeJsonResult(fn(JSON.stringify({
        keyId: String(input.keyId ?? ''),
        authDir: input.authDir,
        homeDir: input.homeDir,
        rccHome: process.env.RCC_HOME,
        routecodexUserDir: process.env.ROUTECODEX_USER_DIR,
        routecodexHome: process.env.ROUTECODEX_HOME
    })));
    if (!output || typeof output !== 'object' || Array.isArray(output)) {
        throw new Error('[llmswitch-bridge] AuthFile key resolver returned invalid payload');
    }
    const resolved = output;
    if ((resolved.kind !== 'literal' && resolved.kind !== 'authFile') || typeof resolved.value !== 'string') {
        throw new Error('[llmswitch-bridge] AuthFile key resolver returned invalid shape');
    }
    if (typeof resolved.cacheKey !== 'undefined' && typeof resolved.cacheKey !== 'string') {
        throw new Error('[llmswitch-bridge] AuthFile key resolver returned invalid cache key');
    }
    return resolved;
}
export function planRouteCodexConfigLoaderPathsNativeSync(input) {
    const binding = loadNativeBindingForConfigCodec();
    const fn = binding.planRouteCodexConfigLoaderPathsJson;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] planRouteCodexConfigLoaderPathsJson not available');
    }
    const output = parseNativeJsonResult(fn(JSON.stringify({
        explicitPath: input.explicitPath,
        routecodexProviderDir: input.routecodexProviderDir,
        rccProviderDir: input.rccProviderDir
    })));
    if (!output || typeof output !== 'object' || Array.isArray(output)) {
        throw new Error('[llmswitch-bridge] RouteCodex config loader path planner returned invalid payload');
    }
    const plan = output;
    if (typeof plan.explicitPath !== 'undefined' && typeof plan.explicitPath !== 'string') {
        throw new Error('[llmswitch-bridge] RouteCodex config loader path planner returned invalid explicitPath');
    }
    if (typeof plan.providerRootDir !== 'undefined' && typeof plan.providerRootDir !== 'string') {
        throw new Error('[llmswitch-bridge] RouteCodex config loader path planner returned invalid providerRootDir');
    }
    return plan;
}
export function planProviderConfigRootNativeSync(rootDir) {
    const binding = loadNativeBindingForConfigCodec();
    const fn = binding.planProviderConfigRootJson;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] planProviderConfigRootJson not available');
    }
    const output = parseNativeJsonResult(fn(JSON.stringify({ rootDir })));
    if (!output || typeof output !== 'object' || Array.isArray(output)) {
        throw new Error('[llmswitch-bridge] Provider config root planner returned invalid payload');
    }
    const plan = output;
    if (typeof plan.rootDir !== 'undefined' && typeof plan.rootDir !== 'string') {
        throw new Error('[llmswitch-bridge] Provider config root planner returned invalid rootDir');
    }
    return plan;
}
function safeBridgeCwd() {
    try {
        const cwd = process.cwd();
        return typeof cwd === 'string' && cwd.trim() ? cwd : undefined;
    }
    catch {
        return undefined;
    }
}
function parseDecodedConfigTextOutput(output, kind) {
    if (!output || typeof output !== 'object' || Array.isArray(output)) {
        throw new Error(`[llmswitch-bridge] RouteCodex ${kind} config text decoder returned invalid payload`);
    }
    const record = output;
    if (record.format !== 'toml' ||
        !record.parsed ||
        typeof record.parsed !== 'object' ||
        Array.isArray(record.parsed)) {
        throw new Error(`[llmswitch-bridge] RouteCodex ${kind} config text decoder returned invalid shape`);
    }
    return {
        format: 'toml',
        parsed: record.parsed,
    };
}
export function resolveRouteCodexConfigPathNativeSync(options = {}) {
    const binding = loadNativeBindingForConfigCodec();
    const fn = binding.resolveRouteCodexConfigPathJson;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] resolveRouteCodexConfigPathJson not available');
    }
    const output = parseNativeJsonResult(fn(JSON.stringify({
        preferredPath: options.preferredPath,
        configName: options.configName,
        allowDirectoryScan: options.allowDirectoryScan ?? true,
        baseDir: options.baseDir,
        cwd: safeBridgeCwd(),
        homeDir: process.env.HOME,
        execPath: process.execPath,
        routecodexConfigPath: process.env.ROUTECODEX_CONFIG_PATH,
        routecodexConfig: process.env.ROUTECODEX_CONFIG,
        rccHome: process.env.RCC_HOME,
        routecodexUserDir: process.env.ROUTECODEX_USER_DIR,
        routecodexHome: process.env.ROUTECODEX_HOME
    })));
    if (typeof output !== 'string' || !output.trim()) {
        throw new Error('[llmswitch-bridge] RouteCodex config path resolver returned invalid path');
    }
    return output;
}
function loadNativeBindingForConfigCodec() {
    const coreDir = resolveCorePackageDir();
    const nativePath = path.join(coreDir, 'dist', 'native', 'router_hotpath_napi.node');
    return nodeRequire(nativePath);
}
function parseNativeTomlRecord(raw) {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('[llmswitch-bridge] RouteCodex TOML parser returned invalid payload');
    }
    return parsed;
}
function parseDetectedConfigFormatOutput(output, kind) {
    if (!output || typeof output !== 'object' || Array.isArray(output)) {
        throw new Error(`[llmswitch-bridge] RouteCodex ${kind} config format detector returned invalid payload`);
    }
    const format = output.format;
    if (format !== 'toml') {
        throw new Error(`[llmswitch-bridge] RouteCodex ${kind} config format detector returned invalid format`);
    }
    return 'toml';
}
// ---------------------------------------------------------------------------
// Native handle-mode HubPipeline entry points.
// Server runtime stores opaque handles and calls the native engine directly.
// ---------------------------------------------------------------------------
export function createHubPipelineNative(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error('[llmswitch-bridge] createHubPipelineNative requires a JSON object config');
    }
    const createHubPipelineEngineJson = requireNativeHubPipelineFn('createHubPipelineEngineJson');
    const result = createHubPipelineEngineJson(JSON.stringify(config));
    const parsed = parseHubPipelineNativeJsonResult(result, 'createHubPipelineNative');
    const handle = parsed.handle;
    if (typeof handle !== 'string' || !handle) {
        throw new Error('[llmswitch-bridge] createHubPipelineNative returned invalid handle');
    }
    return handle;
}
export function executeHubPipelineNative(handle, request) {
    if (typeof handle !== 'string' || !handle) {
        throw new Error('[llmswitch-bridge] executeHubPipelineNative requires non-empty handle');
    }
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
        throw new Error('[llmswitch-bridge] executeHubPipelineNative requires JSON object request');
    }
    const hubPipelineExecuteJson = requireNativeHubPipelineFn('hubPipelineExecuteJson');
    const raw = hubPipelineExecuteJson(handle, JSON.stringify(request));
    return parseHubPipelineNativeJsonResult(raw, 'executeHubPipelineNative');
}
export function updateHubPipelineVirtualRouterConfigNative(handle, config) {
    if (typeof handle !== 'string' || !handle) {
        throw new Error('[llmswitch-bridge] updateHubPipelineVirtualRouterConfigNative requires non-empty handle');
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error('[llmswitch-bridge] updateHubPipelineVirtualRouterConfigNative requires JSON object config');
    }
    const updateHubPipelineVirtualRouterConfigJson = requireNativeHubPipelineFn('updateHubPipelineVirtualRouterConfigJson');
    updateHubPipelineVirtualRouterConfigJson(handle, JSON.stringify(config));
}
export function updateHubPipelineEngineDepsNative(handle, deps) {
    if (typeof handle !== 'string' || !handle) {
        throw new Error('[llmswitch-bridge] updateHubPipelineEngineDepsNative requires non-empty handle');
    }
    if (!deps || typeof deps !== 'object' || Array.isArray(deps)) {
        throw new Error('[llmswitch-bridge] updateHubPipelineEngineDepsNative requires JSON object deps');
    }
    const updateHubPipelineEngineDepsJson = requireNativeHubPipelineFn('updateHubPipelineEngineDepsJson');
    updateHubPipelineEngineDepsJson(handle, JSON.stringify(deps));
}
export function routeHubPipelineVirtualRouterNative(handle, request, metadata) {
    if (typeof handle !== 'string' || !handle) {
        throw new Error('[llmswitch-bridge] routeHubPipelineVirtualRouterNative requires non-empty handle');
    }
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
        throw new Error('[llmswitch-bridge] routeHubPipelineVirtualRouterNative requires JSON object request');
    }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        throw new Error('[llmswitch-bridge] routeHubPipelineVirtualRouterNative requires JSON object metadata');
    }
    const hubPipelineVirtualRouterRouteJson = requireNativeHubPipelineFn('hubPipelineVirtualRouterRouteJson');
    const routeHostEffects = createVirtualRouterRouteHostEffectsLocal({ request, metadata });
    const nativeMetadata = injectVirtualRouterRuntimeMetadataLocal(metadata);
    const raw = hubPipelineVirtualRouterRouteJson(handle, JSON.stringify(request), JSON.stringify(nativeMetadata));
    try {
        const parsed = JSON.parse(raw);
        routeHostEffects.finalize(parsed);
        return parsed;
    }
    catch (error) {
        throw new Error(`[llmswitch-bridge] routeHubPipelineVirtualRouterNative returned invalid payload: ${String(error)}`);
    }
}
function parseRoutingInstructionKindsLocal(request) {
    const parsed = parseNativeJsonResult(callNativeBindingFn('parseRoutingInstructionKindsJson', [
        stringifyNativePayload('parseRoutingInstructionKindsJson', request ?? null),
        stringifyNativePayload('parseRoutingInstructionKindsJson', {
            rccUserDir: resolveRccUserDirForNativeRouting()
        })
    ]));
    if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === 'string')) {
        throw new Error('[llmswitch-bridge] parseRoutingInstructionKindsJson returned invalid payload');
    }
    return parsed;
}
function resolveStopMessageScopeLocal(metadata) {
    const parsed = parseNativeJsonResult(callNativeBindingFn('resolveVirtualRouterStopMessageScopeJson', [
        stringifyNativePayload('resolveVirtualRouterStopMessageScopeJson', metadata ?? null)
    ]));
    if (parsed === null || typeof parsed === 'undefined') {
        return undefined;
    }
    if (typeof parsed === 'string' && parsed.trim()) {
        return parsed.trim();
    }
    throw new Error('[llmswitch-bridge] resolveVirtualRouterStopMessageScopeJson returned invalid payload');
}
function buildStopMessageMarkerParseLogLocal(request, metadata) {
    const parsedKinds = parseRoutingInstructionKindsLocal(request);
    const stopScope = resolveStopMessageScopeLocal(metadata);
    const raw = callNativeBindingFn('buildStopMessageMarkerParseLogJson', [
        stringifyNativePayload('buildStopMessageMarkerParseLogJson', request ?? null),
        stringifyNativePayload('buildStopMessageMarkerParseLogJson', metadata ?? null),
        stringifyNativePayload('buildStopMessageMarkerParseLogJson', parsedKinds),
        stopScope
    ]);
    const parsed = parseNativeJsonResult(raw);
    if (parsed === null) {
        return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('[llmswitch-bridge] buildStopMessageMarkerParseLogJson returned invalid payload');
    }
    return parsed;
}
function emitStopMessageMarkerParseLogLocal(log) {
    callNativeBindingFn('emitStopMessageMarkerParseLogJson', [
        log ? stringifyNativePayload('emitStopMessageMarkerParseLogJson', log) : undefined
    ]);
}
function cleanStopMessageMarkersInPlaceLocal(request) {
    const cleaned = parseNativeRecord('cleanStopMessageMarkersInPlaceJson', callNativeBindingFn('cleanStopMessageMarkersInPlaceJson', [
        stringifyNativePayload('cleanStopMessageMarkersInPlaceJson', request ?? null)
    ]));
    for (const key of Object.keys(request)) {
        delete request[key];
    }
    Object.assign(request, cleaned);
}
function resolveSessionLogColorKeyLocal(metadata) {
    const parsed = parseNativeJsonResult(callNativeBindingFn('resolveSessionLogColorKeyJson', [
        stringifyNativePayload('resolveSessionLogColorKeyJson', metadata ?? null)
    ]));
    return typeof parsed === 'string' && parsed.trim() ? parsed.trim() : undefined;
}
function formatStopMessageStatusLabelLocal(scope) {
    const raw = callNativeBindingFn('formatStopMessageStatusLabelJson', [
        undefined,
        scope,
        true
    ]);
    return typeof raw === 'string' ? raw : String(raw ?? '');
}
function emitVirtualRouterHitLogLocal(result, options) {
    const decision = result.decision || {};
    const target = result.target || {};
    const providerKey = typeof decision.providerKey === 'string' && decision.providerKey
        ? decision.providerKey
        : target.providerKey;
    const record = parseNativeRecord('createVirtualRouterHitRecordJson', callNativeBindingFn('createVirtualRouterHitRecordJson', [
        stringifyNativePayload('createVirtualRouterHitRecordJson', {
            requestId: options.requestId,
            sessionId: options.sessionId,
            routeName: decision.routeName,
            poolId: decision.poolId,
            providerKey,
            modelId: target.modelId,
            hitReason: decision.reasoning
        })
    ]));
    const lineRaw = callNativeBindingFn('formatVirtualRouterHitJson', [
        stringifyNativePayload('formatVirtualRouterHitJson', record),
        undefined
    ]);
    const line = typeof lineRaw === 'string' ? lineRaw : String(lineRaw ?? '');
    const forcedStopStatusLabel = options.forceStopStatusLabel
        ? formatStopMessageStatusLabelLocal(options.stopScope)
        : '';
    console.log(forcedStopStatusLabel ? `${line} ${forcedStopStatusLabel}` : line);
}
function resolveVirtualRouterLogRequestIdLocal(metadata) {
    for (const value of [
        metadata.requestId,
        metadata.clientRequestId,
        metadata.inputRequestId,
        metadata.groupRequestId
    ]) {
        if (typeof value === 'string' && value.trim() && !value.includes('unknown')) {
            return value.trim();
        }
    }
    return undefined;
}
function injectVirtualRouterRuntimeMetadataLocal(metadata) {
    const metadataRecord = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
    const existingRt = metadataRecord.__rt && typeof metadataRecord.__rt === 'object' && !Array.isArray(metadataRecord.__rt)
        ? metadataRecord.__rt
        : undefined;
    const runtimeOverrides = { nowMs: Date.now() };
    if (typeof existingRt?.rccUserDir !== 'string' || !existingRt.rccUserDir.trim()) {
        const rccUserDir = resolveRccUserDirForNativeRouting();
        if (rccUserDir) {
            runtimeOverrides.rccUserDir = rccUserDir;
        }
    }
    return {
        ...metadataRecord,
        __rt: { ...(existingRt ?? {}), ...runtimeOverrides }
    };
}
function createVirtualRouterRouteHostEffectsLocal(args) {
    const parseLog = buildStopMessageMarkerParseLogLocal(args.request, args.metadata);
    return {
        finalize: (result) => {
            emitStopMessageMarkerParseLogLocal(parseLog);
            cleanStopMessageMarkersInPlaceLocal(args.request);
            const stopScope = typeof parseLog?.stopScope === 'string' && parseLog.stopScope
                ? parseLog.stopScope
                : resolveStopMessageScopeLocal(args.metadata);
            const stopMessageTypes = Array.isArray(parseLog?.stopMessageTypes)
                ? parseLog.stopMessageTypes
                : [];
            const scopedTypes = Array.isArray(parseLog?.scopedTypes)
                ? parseLog.scopedTypes
                : [];
            const forceStopStatusLabel = Boolean(stopMessageTypes.length ||
                scopedTypes.some((type) => type === 'stopMessageSet' || type === 'stopMessageMode' || type === 'stopMessageClear'));
            const rt = args.metadata.__rt;
            const rtRecord = rt && typeof rt === 'object' && !Array.isArray(rt) ? rt : undefined;
            if (!rtRecord || rtRecord.disableVirtualRouterHitLog !== true) {
                emitVirtualRouterHitLogLocal(result, {
                    requestId: resolveVirtualRouterLogRequestIdLocal(args.metadata),
                    sessionId: resolveSessionLogColorKeyLocal(args.metadata),
                    stopScope,
                    forceStopStatusLabel
                });
            }
        }
    };
}
export function diagnoseHubPipelineVirtualRouterNative(handle, request, metadata) {
    if (typeof handle !== 'string' || !handle) {
        throw new Error('[llmswitch-bridge] diagnoseHubPipelineVirtualRouterNative requires non-empty handle');
    }
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
        throw new Error('[llmswitch-bridge] diagnoseHubPipelineVirtualRouterNative requires JSON object request');
    }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        throw new Error('[llmswitch-bridge] diagnoseHubPipelineVirtualRouterNative requires JSON object metadata');
    }
    const hubPipelineVirtualRouterDiagnoseRouteJson = requireNativeHubPipelineFn('hubPipelineVirtualRouterDiagnoseRouteJson');
    const raw = hubPipelineVirtualRouterDiagnoseRouteJson(handle, JSON.stringify(request), JSON.stringify(metadata));
    try {
        return JSON.parse(raw);
    }
    catch (error) {
        throw new Error(`[llmswitch-bridge] diagnoseHubPipelineVirtualRouterNative returned invalid payload: ${String(error)}`);
    }
}
export function getHubPipelineVirtualRouterStatusNative(handle) {
    if (typeof handle !== 'string' || !handle) {
        throw new Error('[llmswitch-bridge] getHubPipelineVirtualRouterStatusNative requires non-empty handle');
    }
    const hubPipelineVirtualRouterStatusJson = requireNativeHubPipelineFn('hubPipelineVirtualRouterStatusJson');
    const raw = hubPipelineVirtualRouterStatusJson(handle);
    try {
        return JSON.parse(raw);
    }
    catch (error) {
        throw new Error(`[llmswitch-bridge] getHubPipelineVirtualRouterStatusNative returned invalid payload: ${String(error)}`);
    }
}
export function markHubPipelineVirtualRouterConcurrencyScopeBusyNative(handle, scopeKey) {
    if (typeof handle !== 'string' || !handle) {
        throw new Error('[llmswitch-bridge] markHubPipelineVirtualRouterConcurrencyScopeBusyNative requires non-empty handle');
    }
    const hubPipelineVirtualRouterMarkConcurrencyScopeBusyJson = requireNativeHubPipelineFn('hubPipelineVirtualRouterMarkConcurrencyScopeBusyJson');
    hubPipelineVirtualRouterMarkConcurrencyScopeBusyJson(handle, String(scopeKey ?? ''));
}
export function markHubPipelineVirtualRouterConcurrencyScopeIdleNative(handle, scopeKey) {
    if (typeof handle !== 'string' || !handle) {
        throw new Error('[llmswitch-bridge] markHubPipelineVirtualRouterConcurrencyScopeIdleNative requires non-empty handle');
    }
    const hubPipelineVirtualRouterMarkConcurrencyScopeIdleJson = requireNativeHubPipelineFn('hubPipelineVirtualRouterMarkConcurrencyScopeIdleJson');
    hubPipelineVirtualRouterMarkConcurrencyScopeIdleJson(handle, String(scopeKey ?? ''));
}
export function disposeHubPipelineNative(handle) {
    if (typeof handle !== 'string' || !handle) {
        return;
    }
    const disposeHubPipelineEngineJson = requireNativeHubPipelineFn('disposeHubPipelineEngineJson');
    disposeHubPipelineEngineJson(handle);
}
export function resolveBaseDir() {
    const env = String(process.env.ROUTECODEX_BASEDIR || process.env.RCC_BASEDIR || '').trim();
    if (env)
        return env;
    const metaUrl = getImportMetaUrlUnsafe();
    if (typeof metaUrl === 'string' && metaUrl.length > 0) {
        try {
            const __filename = fileURLToPath(metaUrl);
            return path.resolve(path.dirname(__filename), '../../../..');
        }
        catch {
            // fall through
        }
    }
    return process.cwd();
}
//# sourceMappingURL=routing-integrations.js.map
