#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const admissionWorkspace = process.env.ROUTECODEX_V3_ADMISSION_WORKSPACE === '1';
const failures = [];

function read(relativePath, { required = true } = {}) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) {
    if (required) failures.push(`${relativePath}: missing skeleton-boundary file`);
    return '';
  }
  return fs.readFileSync(absolutePath, 'utf8');
}

function readFirst(relativePaths, { required = true } = {}) {
  for (const relativePath of relativePaths) {
    const absolutePath = path.join(root, relativePath);
    if (fs.existsSync(absolutePath)) return fs.readFileSync(absolutePath, 'utf8');
  }
  if (required) failures.push(`${relativePaths.join(' | ')}: missing skeleton-boundary file`);
  return '';
}

const endpoint = read('crates/routecodex-v3-server/src/endpoint_handlers.rs');
const serverLib = read('crates/routecodex-v3-server/src/lib.rs');
const clientSseTransport = read('crates/routecodex-v3-server/src/client_sse_transport.rs');
const directServerOutcome = read('crates/routecodex-v3-server/src/responses_direct_server_outcome.rs');
const frameBuilders = read('crates/routecodex-v3-server/src/frame_builders.rs');
const manifest = readFirst(admissionWorkspace
  ? ['docs/architecture/mainline-manifests/v3.direct_sse_accept_skeleton.mainline.yml', 'docs/architecture/manifests/v3.direct_sse_accept_skeleton.mainline.yml']
  : ['../docs/architecture/manifests/v3.direct_sse_accept_skeleton.mainline.yml'],
  { required: !admissionWorkspace });
const resourceMap = readFirst(admissionWorkspace
  ? ['docs/architecture/resource-operation-map.yml', 'docs/architecture/v3-resource-operation-map.yml']
  : ['../docs/architecture/v3-resource-operation-map.yml']);
const functionMap = readFirst(admissionWorkspace
  ? ['docs/architecture/function-map.yml', 'docs/architecture/v3-function-map.yml']
  : ['../docs/architecture/v3-function-map.yml']);
const verificationMap = readFirst(admissionWorkspace
  ? ['docs/architecture/verification-map.yml', 'docs/architecture/v3-verification-map.yml']
  : ['../docs/architecture/v3-verification-map.yml']);
const mainlineMap = readFirst(admissionWorkspace
  ? ['docs/architecture/mainline-call-map.yml', 'docs/architecture/v3-mainline-call-map.yml']
  : ['../docs/architecture/v3-mainline-call-map.yml']);

for (const marker of [
  'pending_endpoint_after_responses_admission',
  'pending_endpoint_after_responses_admission_inner',
  'let client_keepalive_interval = Some(Duration::from_millis(state.server.http_sse_keepalive_ms));',
  'let requested_stream = v3_request_wants_sse(&request_headers, &payload);',
  'v3_request_wants_sse(&request_headers, &payload)',
]) {
  if (!endpoint.includes(marker)) failures.push(`endpoint_handlers.rs: missing fixed skeleton marker ${marker}`);
}

for (const forbidden of [
  'V3FrontSseAcceptSkeleton',
  'tokio::sync::mpsc::channel::<Result<Vec<u8>, std::io::Error>>(32)',
  'front_transport_owns_keepalive',
  'AssertUnwindSafe',
]) {
  if (endpoint.includes(forbidden)) {
    failures.push(`endpoint_handlers.rs: obsolete pre-runtime client commit marker ${forbidden}`);
  }
}

if (!serverLib.includes('fn v3_request_wants_sse(')) {
  failures.push('lib.rs: canonical SSE intent helper owner is missing');
}
if (!serverLib.includes('accept_v3_client_sse_transport')) {
  failures.push('lib.rs: the declared client SSE accept channel must be entered through its transport module');
}

// The declared client accept channel is implemented by the independent SSE
// transport module, not by pre-runtime front code inside endpoint_handlers.rs.
// The channel owns transport framing and transport-only keepalives; it must not
// inspect business payloads and must not reach provider or Runtime code.
for (const marker of [
  'V3DirectSseAccept01ClientChannel',
  'V3DirectSseAccept03ProjectedClientFrame',
  'build_v3_sse_transport_out_04_keepalive_comment',
]) {
  if (!clientSseTransport.includes(marker)) {
    failures.push(`client_sse_transport.rs: declared client accept channel missing ${marker}`);
  }
}
for (const line of clientSseTransport.split('\n')) {
  if (/^\s*use\s+(serde_json|routecodex_v3_runtime|routecodex_v3_provider)/.test(line)) {
    failures.push(`client_sse_transport.rs: client accept channel must not import business-payload or provider/runtime code: ${line.trim()}`);
  }
}
if (!directServerOutcome.includes('v3_request_wants_sse(request_headers, &payload)')) {
  failures.push('responses_direct_server_outcome.rs: direct runtime caller is missing');
}

if (!frameBuilders.includes('v3_io_sse_body')) {
  failures.push('frame_builders.rs: direct SSE transport body owner is missing');
}

const canonicalMapMarkers = [
  ['manifest', manifest, ['v3.direct_sse_accept_skeleton', 'V3DirectSseAccept01ClientChannel', 'V3DirectSseAccept02RuntimeWorker', 'V3DirectSseAccept03ProjectedClientFrame', 'v3-direct-sse-accept-skeleton-01', 'v3-direct-sse-accept-skeleton-02']],
  ['resource map', resourceMap, ['v3.sse.direct.accept_skeleton', 'V3DirectSseAccept01ClientChannel', 'v3_request_wants_sse', 'accept_v3_client_sse_transport']],
  ['function map', functionMap, ['v3.direct_sse_accept_skeleton', 'V3DirectSseAccept01ClientChannel', 'V3DirectSseAccept02RuntimeWorker', 'V3DirectSseAccept03ProjectedClientFrame', 'v3_request_wants_sse']],
  ['verification map', verificationMap, ['v3.direct_sse_accept_skeleton']],
  ['mainline map', mainlineMap, ['v3.direct_sse_accept_skeleton', 'V3DirectSseAccept01ClientChannel', 'V3DirectSseAccept02RuntimeWorker', 'V3DirectSseAccept03ProjectedClientFrame', 'v3_request_wants_sse', 'execute_responses_direct_server_outcome', 'v3-direct-sse-accept-skeleton-01', 'v3-direct-sse-accept-skeleton-02', 'v3-direct-sse-accept-skeleton-intent-01', 'v3-direct-sse-accept-skeleton-intent-02']],
];

for (const [name, document, markers] of canonicalMapMarkers) {
  if (admissionWorkspace) continue;
  for (const marker of markers) {
    if (!document.includes(marker)) failures.push(`${name}: missing skeleton marker ${marker}`);
  }
}

if (admissionWorkspace && (!resourceMap || !functionMap || !verificationMap || !mainlineMap)) {
  failures.push('admission workspace must expose all architecture map classes for skeleton validation');
}

for (const forbidden of [
  'routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs',
  'routecodex-v3-runtime/src/hub_v1/req_chat_process_04_governed.rs',
  'MetadataCenter',
  'provider.wire_payload',
]) {
  if (manifest.includes(forbidden)) failures.push(`skeleton manifest must not own semantic/control payload ${forbidden}`);
}

if (failures.length > 0) {
  console.error('[verify:v3-direct-sse-accept-skeleton] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:v3-direct-sse-accept-skeleton] ok');
console.log('- Client SSE semantic commit stays buffered until runtime projection completes');
console.log('- the declared client accept channel is the independent SSE transport module');
console.log('- obsolete pre-runtime front commit paths remain absent');
