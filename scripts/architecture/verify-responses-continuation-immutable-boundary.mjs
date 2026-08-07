import fs from 'node:fs';
import path from 'node:path';

const requiredFiles = {
  reqInbound: 'v3/crates/routecodex-v3-runtime/src/hub_v1/req_inbound_02_normalized.rs',
  reqRestore: 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs',
  respCommit: 'v3/crates/routecodex-v3-runtime/src/hub_v1/resp_continuation_04_committed.rs',
  respOutbound: 'v3/crates/routecodex-v3-runtime/src/hub_v1/resp_outbound_05_client_semantic.rs',
  serverFrame: 'v3/crates/routecodex-v3-runtime/src/hub_v1/server_resp_outbound_06_client_frame.rs',
  verificationMap: 'docs/architecture/verification-map.yml',
};

function readRequired(root, relativePath, failures) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) {
    failures.push(relativePath + ': required source is missing');
    return '';
  }
  return fs.readFileSync(absolutePath, 'utf8');
}

function requireText(source, expected, message, failures) {
  if (!source.includes(expected)) failures.push(message);
}

function forbidText(source, forbidden, message, failures) {
  if (source.includes(forbidden)) failures.push(message);
}

function featureSection(source, featureId) {
  const marker = '- feature_id: ' + featureId;
  const start = source.indexOf(marker);
  if (start === -1) return '';
  const nextMarker = String.fromCharCode(10) + '  - feature_id:';
  const next = source.indexOf(nextMarker, start + marker.length);
  return source.slice(start, next === -1 ? source.length : next);
}

function functionBody(source, signature) {
  const start = source.indexOf(signature);
  if (start === -1) return '';
  const brace = source.indexOf('{', start);
  if (brace === -1) return '';
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return '';
}

export function verifyResponsesContinuationImmutableBoundary(root) {
  const failures = [];
  const sources = Object.fromEntries(
    Object.entries(requiredFiles).map(([key, relativePath]) => [key, readRequired(root, relativePath, failures)]),
  );

  const reqInbound = functionBody(
    sources.reqInbound,
    'pub fn build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01',
  );
  requireText(reqInbound, 'previous: input', requiredFiles.reqInbound + ': ReqInbound02 must remain an adjacent normalization node', failures);

  const restore = functionBody(sources.reqRestore, 'fn restore_local_context_at_req04');
  requireText(restore, 'restore_local_context_from_store_at_req04', requiredFiles.reqRestore + ': Req04 must remain the local continuation restore owner', failures);
  requireText(sources.reqRestore, 'current_payload_start', requiredFiles.reqRestore + ': Req04 must retain the immutable-history/current-suffix boundary', failures);

  const commit = functionBody(
    sources.respCommit,
    'pub(crate) fn commit_or_release_v3_relay_local_continuation_at_resp04',
  );
  requireText(commit, 'commit_at_resp04', requiredFiles.respCommit + ': Resp04 must remain the local continuation save owner', failures);

  const respOutbound = functionBody(
    sources.respOutbound,
    'pub fn build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04',
  );
  requireText(respOutbound, 'previous: input', requiredFiles.respOutbound + ': Resp05 must remain an adjacent client projection node', failures);

  const serverFrame = functionBody(
    sources.serverFrame,
    'pub fn build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05',
  );
  requireText(serverFrame, 'previous: input', requiredFiles.serverFrame + ': Server06 must remain an adjacent transport frame node', failures);

  const immutableInterval = [
    [requiredFiles.reqInbound, reqInbound],
    [requiredFiles.respOutbound, respOutbound],
    [requiredFiles.serverFrame, serverFrame],
  ];
  for (const [file, source] of immutableInterval) {
    for (const forbidden of [
      'entryOriginRequest',
      'capturedChatRequest',
      'requestSemantics',
      'restore_local_context',
      'commit_at_resp04',
      'stopless',
      'servertool',
      'tool_outputs',
      'function_call_output',
      'custom_tool_call_output',
      'required_action',
      'history',
      'sanitize',
      'cleanup',
      'repair',
    ]) {
      forbidText(source, forbidden, file + ': immutable save->restore interval must not own semantic operation ' + forbidden, failures);
    }
  }

  const continuationFeature = featureSection(sources.verificationMap, 'hub.chat_process_responses_continuation');
  requireText(continuationFeature, 'npm run verify:responses-continuation-immutable-boundary', requiredFiles.verificationMap + ': continuation feature must require immutable boundary gate', failures);
  requireText(continuationFeature, 'save->restore interval is immutable', requiredFiles.verificationMap + ': continuation feature must document immutable interval evidence', failures);

  return failures;
}

if (import.meta.url === 'file://' + process.argv[1]) {
  const failures = verifyResponsesContinuationImmutableBoundary(process.cwd());
  if (failures.length) {
    console.error('Responses continuation immutable boundary verification failed:');
    for (const failure of failures) console.error('- ' + failure);
    process.exit(1);
  }
  console.log('Responses continuation immutable boundary verification passed.');
}
