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
  'V3DirectSseAcceptSkeleton',
  'pending_endpoint_after_responses_admission_inner',
  'tokio::sync::mpsc::channel::<Result<Vec<u8>, std::io::Error>>(32)',
  'v3_io_sse_body(Box::pin(client_stream), Some(keepalive_interval))',
  'v3_responses_request_wants_sse(&request_headers, &payload)',
]) {
  if (!endpoint.includes(marker)) failures.push(`endpoint_handlers.rs: missing fixed skeleton marker ${marker}`);
}

if (!frameBuilders.includes('v3_io_sse_body')) {
  failures.push('frame_builders.rs: direct SSE transport body owner is missing');
}

const canonicalMapMarkers = [
  ['manifest', manifest, ['v3.direct_sse_accept_skeleton', 'V3DirectSseAccept01ClientChannel', 'V3DirectSseAccept02RuntimeWorker', 'V3DirectSseAccept03ProjectedClientFrame', 'v3-direct-sse-accept-skeleton-01', 'v3-direct-sse-accept-skeleton-02']],
  ['resource map', resourceMap, ['v3.sse.direct.accept_skeleton', 'V3DirectSseAccept01ClientChannel']],
  ['function map', functionMap, ['v3.direct_sse_accept_skeleton', 'V3DirectSseAccept01ClientChannel', 'V3DirectSseAccept02RuntimeWorker', 'V3DirectSseAccept03ProjectedClientFrame']],
  ['verification map', verificationMap, ['v3.direct_sse_accept_skeleton']],
  ['mainline map', mainlineMap, ['v3.direct_sse_accept_skeleton', 'V3DirectSseAccept01ClientChannel', 'V3DirectSseAccept02RuntimeWorker', 'V3DirectSseAccept03ProjectedClientFrame', 'v3-direct-sse-accept-skeleton-01', 'v3-direct-sse-accept-skeleton-02']],
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
console.log('- direct SSE accept channel and runtime worker skeleton are map-locked');
console.log('- feature hooks remain inside the existing runtime boundary');
