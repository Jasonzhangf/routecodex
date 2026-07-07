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
export async function bootstrapVirtualRouterConfig(input) {
    const mod = await importCoreDist('native/router-hotpath/native-virtual-router-bootstrap-config');
    const fn = mod.bootstrapVirtualRouterConfig;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] bootstrapVirtualRouterConfig not available');
    }
    return fn(input);
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
    if (output.manifestVersion !== 'routecodex.runtime-config.v1' ||
        !output.virtualRouterBootstrapInput ||
        typeof output.virtualRouterBootstrapInput !== 'object' ||
        Array.isArray(output.virtualRouterBootstrapInput) ||
        !output.pipelineRuntimeConfig ||
        typeof output.pipelineRuntimeConfig !== 'object' ||
        Array.isArray(output.pipelineRuntimeConfig)) {
        throw new Error('[llmswitch-bridge] RouteCodex runtime config compiler returned invalid manifest');
    }
    return output;
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
        if (typeof file.fileName !== 'string' || typeof file.isBaseFile !== 'boolean') {
            throw new Error('[llmswitch-bridge] RouteCodex provider config file planner returned invalid file shape');
        }
        return {
            fileName: file.fileName,
            isBaseFile: file.isBaseFile
        };
    });
}
export function resolveRouteCodexProviderConfigV2IdentitySync(input) {
    const binding = loadNativeBindingForConfigCodec();
    const fn = binding.resolveRouteCodexProviderConfigV2IdentityJson;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] resolveRouteCodexProviderConfigV2IdentityJson not available');
    }
    const output = parseNativeJsonResult(fn(JSON.stringify(input)));
    if (!output || typeof output !== 'object' || Array.isArray(output)) {
        throw new Error('[llmswitch-bridge] RouteCodex provider config identity resolver returned invalid payload');
    }
    if (typeof output.providerId !== 'string' ||
        !output.provider ||
        typeof output.provider !== 'object' ||
        Array.isArray(output.provider)) {
        throw new Error('[llmswitch-bridge] RouteCodex provider config identity resolver returned invalid shape');
    }
    return {
        providerId: output.providerId,
        provider: output.provider
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
function loadNativeBindingForConfigCodec() {
    const coreDir = resolveCorePackageDir('ts');
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
const cachedHubPipelineCtorByImpl = {
    ts: null,
    engine: null
};
export async function getHubPipelineCtor() {
    const impl = resolveImplForSubpath('conversion/hub/pipeline/hub-pipeline');
    if (!cachedHubPipelineCtorByImpl[impl]) {
        const mod = await importCoreDist('conversion/hub/pipeline/hub-pipeline', impl);
        const Ctor = mod.HubPipeline;
        if (typeof Ctor !== 'function') {
            throw new Error('[llmswitch-bridge] HubPipeline constructor not available');
        }
        cachedHubPipelineCtorByImpl[impl] = Ctor;
    }
    return cachedHubPipelineCtorByImpl[impl];
}
export async function getHubPipelineCtorForImpl(impl) {
    if (!cachedHubPipelineCtorByImpl[impl]) {
        const mod = await importCoreDist('conversion/hub/pipeline/hub-pipeline', impl);
        const Ctor = mod.HubPipeline;
        if (typeof Ctor !== 'function') {
            throw new Error('[llmswitch-bridge] HubPipeline constructor not available');
        }
        cachedHubPipelineCtorByImpl[impl] = Ctor;
    }
    return cachedHubPipelineCtorByImpl[impl];
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
