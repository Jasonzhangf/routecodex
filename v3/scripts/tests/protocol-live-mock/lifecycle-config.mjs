import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { allocateLoopbackPort, requirePort } from './lifecycle-network.mjs';

const FAKE_TASK_TOKEN = 'fake-loopback-token';
const PROTOCOLS = ['openai_chat', 'responses', 'anthropic', 'gemini'];
const MODEL_FOR_PROTOCOL = {
  openai_chat: 'chat-model',
  responses: 'responses-model',
  anthropic: 'anthropic-model',
  gemini: 'gemini-model',
};
const PROVIDER_BASE_SUFFIX = {
  openai_chat: '/v1',
  responses: '/v1',
  anthropic: '',
  gemini: '/v1beta',
};

// Authoring keys of the V3 `attempt_store` policy, in the owner's field order.
// The Rust owner is `deny_unknown_fields` and defaults every field, so only
// fixture-declared keys are written through.
const ATTEMPT_STORE_KEYS = [
  'request_max_attempts',
  'attempt_max_bytes',
  'attempt_max_frames',
  'request_max_bytes',
  'process_max_bytes',
  'residence_timeout_ms',
];
const PROVIDER_CONCURRENCY_KEYS = [
  'maxInFlight',
  'acquireTimeoutMs',
  'staleLeaseMs',
];

/**
 * Write a task-owned V3 config and its referenced provider directory.
 *
 * The root file uses the supported simplified V3 authoring surface. The
 * provider directory keeps the current V3 provider file name (`config.v2.toml`)
 * because V3ConfigStore owns that parser; this function does not create a V2
 * runtime, reader, migration, or backup path.
 *
 * The internal `admin_webui` listener defaults to `127.0.0.1:8777` and is
 * appended to the managed listener set by the V3 lifecycle. A shared 8777 would
 * make every matrix instance collide on release preflight, so this function
 * allocates a task-owned loopback admin port and returns the
 * `ROUTECODEX_V3_ADMIN_BIND` override that `startRcc` passes to the child.
 */
export async function generateRccConfig(options = {}) {
  const mockPort = requirePort(options.mockPort, 'mockPort');
  const rccPort = requirePort(options.rccPort, 'rccPort');
  const adminHost = options.adminHost ?? '127.0.0.1';
  const inheritedAdminBind = options.inheritedAdminBind ?? process.env.ROUTECODEX_V3_ADMIN_BIND ?? null;
  let adminPort = options.adminPort !== undefined
    ? requirePort(options.adminPort, 'adminPort')
    : await allocateLoopbackPort(adminHost);
  while (adminPort === rccPort || adminPort === mockPort) {
    adminPort = await allocateLoopbackPort(adminHost);
  }
  const adminBind = `${adminHost}:${adminPort}`;
  const providerProtocol = requireProtocol(options.providerProtocol ?? 'responses');
  const mode = options.mode ?? null;
  if (mode !== null && mode !== 'direct' && mode !== 'relay') {
    throw new Error('mode must be direct or relay');
  }
  const attemptStore = normalizeAttemptStore(options.runtimeSetup?.attempt_store);
  const providerConcurrency = normalizeProviderConcurrency(options.runtimeSetup?.provider_concurrency);
  const serverId = requireIdentifier(options.serverId ?? 'loopback', 'serverId');
  const defaultProviderId = requireIdentifier(options.providerId ?? `mock-${providerProtocol}`, 'providerId');
  const defaultModel = options.model ?? `mock.${MODEL_FOR_PROTOCOL[providerProtocol]}`;
  const defaultWireModel = options.wireModel ?? MODEL_FOR_PROTOCOL[providerProtocol];
  const runtimeSetup = options.runtimeSetup ?? null;
  const plan = resolveCandidatePlan({
    runtimeSetup,
    defaultProviderId,
    defaultModel,
    defaultWireModel,
  });
  const wireModel = plan.wireModel;
  const workRoot = resolve(options.workRoot ?? process.cwd());
  mkdirSync(workRoot, { recursive: true });
  const root = mkdtempSync(join(workRoot, 'v3-protocol-live-mock-lifecycle-'));
  const state = join(root, 'state');
  const providerRoot = join(root, 'provider');
  const configPath = join(root, 'config.toml');

  mkdirSync(providerRoot, { recursive: true });
  mkdirSync(state, { recursive: true });

  const baseURL = `http://127.0.0.1:${mockPort}${PROVIDER_BASE_SUFFIX[providerProtocol]}`;
  const providerFiles = plan.candidates.map((candidate) => {
    const providerDir = join(providerRoot, candidate.providerId);
    const providerPath = join(providerDir, 'config.v2.toml');
    mkdirSync(providerDir, { recursive: true });
    const text = renderProviderFile({
      providerId: candidate.providerId,
      providerProtocol,
      baseURL,
      wireModel: candidate.wireModel,
      model: candidate.model,
      token: candidate.token,
      providerConcurrency,
    });
    writeFileSync(providerPath, text);
    validateProviderFile(providerPath, candidate);
    return {
      candidate_id: candidate.candidateId,
      provider_id: candidate.providerId,
      path: providerPath,
      text,
      model: candidate.model,
      wire_model: candidate.wireModel,
      token: candidate.token,
    };
  });
  if (providerFiles.length !== plan.candidates.length) {
    throw new Error(
      `runtimeSetup declared ${plan.candidates.length} candidates but authored ${providerFiles.length} provider files`,
    );
  }
  const primary = providerFiles[0];

  const configText = `version = 3

[servers.${tomlKey(serverId)}]
bind = "127.0.0.1"
port = ${rccPort}
endpoints = ${tomlStringArray(PROTOCOLS)}
${renderExecutionSection(serverId, mode, attemptStore)}

[servers.${tomlKey(serverId)}.routes.default]
tiers = ${renderDefaultTier(plan.candidates)}
`;

  writeFileSync(configPath, configText);
  // Receipt the authoring file, rather than echoing the requested option.
  // Config check and public-entry evidence remain separate runtime gates.
  const writtenConfig = readFileSync(configPath, 'utf8');
  const writtenMode = writtenConfig.match(/^allowed_modes = \["(direct|relay)"\]$/m)?.[1] ?? null;

  const listeners = [
    { role: 'primary', server_id: serverId, host: '127.0.0.1', port: rccPort },
    { role: 'admin_webui', server_id: 'admin_webui', host: adminHost, port: adminPort },
  ];
  const env = { ROUTECODEX_V3_ADMIN_BIND: adminBind };

  // Independent candidate identity receipt. The fixture's `auth_orders` stay
  // the source of truth for allowed identity orders; this receipt only names
  // the identities that were authored, so G4 can bind config evidence.
  const candidateIdentityReceipts = {
    validated: true,
    protocol: providerProtocol,
    wire_model: wireModel,
    tier_count: 1,
    candidates: providerFiles.map((file) => ({
      candidate_id: file.candidate_id,
      provider_id: file.provider_id,
      model: file.model,
      wire_model: file.wire_model,
      provider_path: file.path,
      auth_token: file.token,
      authorization: `Bearer ${file.token}`,
      declared: true,
    })),
  };

  return {
    root,
    home: root,
    state,
    path: configPath,
    text: configText,
    env,
    provider_root: providerRoot,
    provider_dir: dirname(primary.path),
    provider_path: primary.path,
    provider_text: primary.text,
    provider_files: providerFiles.map((file) => ({
      provider_id: file.provider_id,
      path: file.path,
      text: file.text,
      model: file.model,
      wire_model: file.wire_model,
    })),
    candidate_identity_receipts: candidateIdentityReceipts,
    mock_port: mockPort,
    rcc_port: rccPort,
    admin_host: adminHost,
    admin_port: adminPort,
    admin_bind: adminBind,
    inherited_admin_bind: inheritedAdminBind,
    listeners,
    provider_protocol: providerProtocol,
    mode: writtenMode,
    mode_receipt: writtenMode ? {
      field: `servers.${serverId}.execution.allowed_modes`,
      allowed_modes: [writtenMode],
    } : null,
    attempt_store: attemptStore,
    attempt_store_receipt: {
      configured: Boolean(attemptStore),
      policy: attemptStore,
      config_section: attemptStore ? `servers.${serverId}.execution.attempt_store` : null,
    },
    provider_concurrency: providerConcurrency,
    provider_concurrency_receipt: {
      configured: Boolean(providerConcurrency),
      policy: providerConcurrency,
      config_section: providerConcurrency ? 'provider.concurrency' : null,
    },
    provider_id: primary.provider_id,
    model: primary.model,
    model_alias: primary.model,
    wire_model: wireModel,
    runtime_setup: runtimeSetup,
    candidate_ids: plan.candidates.map((candidate) => candidate.candidateId),
    server_id: serverId,
    binary: options.binary ?? null,
    fixture_root: options.fixtureRoot ?? null,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Resolve the authored provider/model candidates from the runtime setup.
 *
 * A single declared candidate keeps the legacy task token and the
 * `provider_id`/`model`/`wire_model` options. Multiple candidates declare one
 * provider each inside one default pool tier; every candidate gets a distinct
 * explicit fake token, and the declared model/wire model are shared. The plan
 * is validated here so generation never silently collapses a multi-candidate
 * request onto a single default provider.
 */
function resolveCandidatePlan({ runtimeSetup, defaultProviderId, defaultModel, defaultWireModel }) {
  if (!runtimeSetup) {
    return {
      wireModel: defaultWireModel,
      candidates: [{
        candidateId: `${defaultProviderId}/${defaultModel}`,
        providerId: defaultProviderId,
        model: defaultModel,
        wireModel: defaultWireModel,
        token: FAKE_TASK_TOKEN,
      }],
    };
  }
  const rawCandidates = runtimeSetup.candidate_ids;
  if (!Array.isArray(rawCandidates) || rawCandidates.length === 0) {
    throw new Error('runtimeSetup.candidate_ids must declare at least one provider/model candidate');
  }
  const declaredModel = runtimeSetup.model ?? defaultModel;
  const declaredWireModel = runtimeSetup.wire_model ?? defaultWireModel;
  const parsed = rawCandidates.map((raw) => {
    const parts = String(raw).split('/');
    if (parts.length !== 2 || parts.some((part) => !part)) {
      throw new Error(`runtimeSetup candidate ${raw} must be provider/model`);
    }
    return {
      candidateId: String(raw),
      providerId: requireIdentifier(parts[0], 'runtimeSetup provider'),
      model: parts[1],
    };
  });
  if (parsed.length === 1) {
    const [only] = parsed;
    if (only.providerId !== defaultProviderId) {
      throw new Error(`runtimeSetup provider ${only.providerId} does not match generated provider ${defaultProviderId}`);
    }
    return {
      wireModel: declaredWireModel,
      candidates: [{
        ...only,
        wireModel: declaredWireModel,
        token: FAKE_TASK_TOKEN,
      }],
    };
  }
  const seenProviders = new Set();
  for (const entry of parsed) {
    if (seenProviders.has(entry.providerId)) {
      throw new Error(`runtimeSetup declares duplicate provider ${entry.providerId} in one tier`);
    }
    seenProviders.add(entry.providerId);
    if (entry.model !== declaredModel) {
      throw new Error(`runtimeSetup candidate ${entry.candidateId} model ${entry.model} must match declared model ${declaredModel}`);
    }
  }
  return {
    wireModel: declaredWireModel,
    candidates: parsed.map((entry) => ({
      ...entry,
      wireModel: declaredWireModel,
      token: `${FAKE_TASK_TOKEN}-${entry.providerId}`,
    })),
  };
}

function renderProviderFile({
  providerId,
  providerProtocol,
  baseURL,
  wireModel,
  model,
  token,
  providerConcurrency,
}) {
  const concurrency = providerConcurrency
    ? `\n[provider.concurrency]\n${PROVIDER_CONCURRENCY_KEYS
      .filter((key) => providerConcurrency[key] !== undefined)
      .map((key) => `${key} = ${providerConcurrency[key]}`)
      .join('\n')}\n`
    : '';
  return `version = "2.0.0"
providerId = "${providerId}"

[provider]
id = "${providerId}"
enabled = true
type = "${providerProtocol}"
baseURL = "${baseURL}"
defaultModel = "${wireModel}"
${concurrency}

[provider.auth]
type = "apikey"
apiKey = "${token}"

[provider.models."${model}"]
wireName = "${wireModel}"
capabilities = ["text", "tools", "reasoning", "multimodal"]
supportsStreaming = true
`;
}

function renderDefaultTier(candidates) {
  if (candidates.length === 1) {
    return `[[{ use = "${candidates[0].providerId}/${candidates[0].model}" }]]`;
  }
  const members = candidates.map((candidate) => `  { use = "${candidate.providerId}/${candidate.model}" },`);
  members[members.length - 1] = members[members.length - 1].replace(/,$/, '');
  return `[[\n${members.join('\n')}\n]]`;
}

function renderExecutionSection(serverId, mode, attemptStore) {
  if (!mode && !attemptStore) return '';
  const allowedModes = mode ? [mode] : ['direct', 'relay'];
  const lines = [
    `[servers.${tomlKey(serverId)}.execution]`,
    `allowed_modes = ${tomlStringArray(allowedModes)}`,
    'allowed_invocation_sources = ["client", "refill", "dry_run"]',
    'allowed_transports = ["json", "sse"]',
  ];
  if (attemptStore) {
    const entries = ATTEMPT_STORE_KEYS
      .filter((key) => attemptStore[key] !== undefined)
      .map((key) => `${key} = ${attemptStore[key]}`);
    lines.push(`attempt_store = { ${entries.join(', ')} }`);
  }
  return `\n${lines.join('\n')}\n`;
}

function normalizeAttemptStore(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('runtime_setup.attempt_store must be an object when present');
  }
  const normalized = {};
  for (const key of Object.keys(raw)) {
    if (!ATTEMPT_STORE_KEYS.includes(key)) {
      throw new Error(`runtime_setup.attempt_store.${key} is not a supported field`);
    }
    const value = raw[key];
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`runtime_setup.attempt_store.${key} must be a positive integer`);
    }
    normalized[key] = value;
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeProviderConcurrency(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('runtime_setup.provider_concurrency must be an object when present');
  }
  const normalized = {};
  for (const key of Object.keys(raw)) {
    if (!PROVIDER_CONCURRENCY_KEYS.includes(key)) {
      throw new Error(`runtime_setup.provider_concurrency.${key} is not a supported field`);
    }
    const value = raw[key];
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`runtime_setup.provider_concurrency.${key} must be a positive integer`);
    }
    normalized[key] = value;
  }
  if (Object.keys(normalized).length === 0) {
    throw new Error('runtime_setup.provider_concurrency must declare at least one field');
  }
  return normalized;
}

/**
 * Re-read an authored provider file and prove the candidate identity it
 * declares. This is the guard that a candidate profile is backed by a real
 * declared model entry, its wire name, and its explicit token.
 */
function validateProviderFile(path, candidate) {
  const text = readFileSync(path, 'utf8');
  const required = [
    `providerId = "${candidate.providerId}"`,
    `[provider.models."${candidate.model}"]`,
    `wireName = "${candidate.wireModel}"`,
    `apiKey = "${candidate.token}"`,
  ];
  const missing = required.filter((needle) => !text.includes(needle));
  if (missing.length > 0) {
    throw new Error(`generated provider file ${path} is missing ${missing.join(', ')}`);
  }
}

function requireProtocol(value) {
  if (!PROTOCOLS.includes(value)) {
    throw new Error(`providerProtocol must be one of ${PROTOCOLS.join(', ')}`);
  }
  return value;
}

function requireIdentifier(value, name) {
  const text = String(value);
  if (!/^[A-Za-z0-9_.-]+$/.test(text)) {
    throw new Error(`${name} must match [A-Za-z0-9_.-]+`);
  }
  return text;
}

function tomlStringArray(values) {
  return `[${values.map((value) => `"${value}"`).join(', ')}]`;
}

function tomlKey(value) {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : JSON.stringify(value);
}
