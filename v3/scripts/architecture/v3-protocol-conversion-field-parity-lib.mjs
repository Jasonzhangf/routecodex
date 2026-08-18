// Parity-gate helper library: matrix/semantic/shape/superset contract checks.
// Split from verify-v3-protocol-conversion-field-parity.mjs to satisfy the
// v3-file-size ratchet. Helpers close over the gate context (failures/paths/text).

export function attachParityHelpers(context) {
  const { failures, paths, text } = context;

function requireMatrixProtocols(matrix, protocols) {
  for (const protocol of protocols) {
    if (!matrix?.protocols?.[protocol]) failures.push(`${paths.fieldMatrix}: missing protocol ${protocol}`);
  }
}
function requireMatrixFields(matrix, protocol, section, fields) {
  const rows = matrix?.protocols?.[protocol]?.[section];
  if (!Array.isArray(rows)) {
    failures.push(`${paths.fieldMatrix}: missing ${protocol}.${section}`);
    return;
  }
  const actual = new Set(rows.map((row) => row?.field).filter(Boolean));
  for (const field of fields) {
    if (!actual.has(field)) failures.push(`${paths.fieldMatrix}: missing ${protocol}.${section}.${field}`);
  }
}
function requireInventoryFields(matrix, protocol, section, fields) {
  const rows = matrix?.source_inventory?.[protocol]?.[section];
  if (!Array.isArray(rows)) {
    failures.push(`${paths.fieldMatrix}: missing source_inventory.${protocol}.${section}`);
    return;
  }
  const actual = new Set(rows.filter(Boolean));
  for (const field of fields) {
    if (!actual.has(field)) failures.push(`${paths.fieldMatrix}: missing source_inventory.${protocol}.${section}.${field}`);
  }
}
function requireExtensionFields(matrix, protocol, extension, fields) {
  const rows = matrix?.protocol_specific_chat_extensions?.[protocol]?.[extension]?.field_paths;
  if (!Array.isArray(rows)) {
    failures.push(`${paths.fieldMatrix}: missing protocol_specific_chat_extensions.${protocol}.${extension}.field_paths`);
    return;
  }
  const actual = new Set(rows.filter(Boolean));
  for (const field of fields) {
    if (!actual.has(field)) failures.push(`${paths.fieldMatrix}: missing protocol_specific_chat_extensions.${protocol}.${extension}.${field}`);
  }
}
function requireClassificationCoversSourceInventory(matrix) {
  for (const protocol of ['responses', 'openai_chat', 'anthropic', 'gemini']) {
    const source = matrix?.source_inventory?.[protocol];
    const classified = matrix?.field_classification?.[protocol];
    if (!source || !classified) {
      failures.push(`${paths.fieldMatrix}: missing source/classification for ${protocol}`);
      continue;
    }
    const sourceFields = new Set();
    for (const rows of Object.values(source)) {
      if (Array.isArray(rows)) for (const row of rows) sourceFields.add(row);
    }
    const classificationBuckets = [
      'canonical_chat_fields',
      'protocol_specific_chat_extension_fields',
      'edge_only_fields',
      'unsupported_or_lossy_fields',
    ];
    const fieldSeen = new Map();
    for (const bucket of classificationBuckets) {
      const rows = classified?.[bucket];
      if (!Array.isArray(rows)) {
        failures.push(`${paths.fieldMatrix}: missing field_classification.${protocol}.${bucket}`);
        continue;
      }
      for (const row of rows) fieldSeen.set(row, (fieldSeen.get(row) ?? 0) + 1);
    }
    for (const row of sourceFields) {
      const count = fieldSeen.get(row) ?? 0;
      if (count !== 1) failures.push(`${paths.fieldMatrix}: ${protocol} source field ${row} classified ${count} times`);
    }
    for (const row of fieldSeen.keys()) {
      if (!sourceFields.has(row)) failures.push(`${paths.fieldMatrix}: ${protocol} classification field not in source_inventory: ${row}`);
    }
  }
}
function requireSemanticCorrespondence(matrix, semantic, protocol, fields) {
  const row = matrix?.semantic_correspondence?.[semantic];
  if (!row) {
    failures.push(`${paths.fieldMatrix}: missing semantic_correspondence.${semantic}`);
    return;
  }
  if (!row.canonical_path || !row.chat_extension || !row.current_impl) {
    failures.push(`${paths.fieldMatrix}: semantic_correspondence.${semantic} missing canonical_path/chat_extension/current_impl`);
  }
  const pathsForProtocol = row?.paths?.[protocol];
  if (!Array.isArray(pathsForProtocol)) {
    failures.push(`${paths.fieldMatrix}: missing semantic_correspondence.${semantic}.paths.${protocol}`);
    return;
  }
  const actual = new Set(pathsForProtocol);
  for (const field of fields) {
    if (!actual.has(field)) failures.push(`${paths.fieldMatrix}: missing semantic_correspondence.${semantic}.${protocol}.${field}`);
  }
}

function requireNoPendingAuditStatus(matrix) {
  const hits = [];
  walkCurrentImpl(matrix, [], (pathParts, value) => {
    if (value === 'pending_audit') hits.push(pathParts.join('.'));
  });
  if (hits.length) failures.push(`${paths.fieldMatrix}: current_impl must use precise audited statuses, not pending_audit (${hits.slice(0, 8).join(', ')})`);
  const sourceOnlyHits = [];
  walkCurrentImpl(matrix, [], (pathParts, value) => {
    if (value === 'source_inventory_only') sourceOnlyHits.push(pathParts.join('.'));
  });
  if (sourceOnlyHits.length) failures.push(`${paths.fieldMatrix}: current_impl=source_inventory_only is closed and must not reappear (${sourceOnlyHits.slice(0, 8).join(', ')})`);
}

function requireCanonicalExtensionRegistry(matrix) {
  const registry = matrix?.canonical_extension_registry;
  if (!Array.isArray(registry) || registry.length === 0) {
    failures.push(`${paths.fieldMatrix}: missing canonical_extension_registry for OpenAI Chat extension fields`);
    return;
  }
  const registryByField = new Map();
  for (const [index, row] of registry.entries()) {
    for (const key of ['field', 'semantic_id', 'direction', 'stratum', 'owner', 'current_impl', 'source_fields', 'projection_rule']) {
      if (row?.[key] == null) failures.push(`${paths.fieldMatrix}: canonical_extension_registry[${index}] missing ${key}`);
    }
    if (registryByField.has(row?.field)) failures.push(`${paths.fieldMatrix}: duplicate canonical_extension_registry field ${row?.field}`);
    registryByField.set(row?.field, row);
    if (!/^(request|response|edge)\.[A-Za-z0-9_\[\]\.]+$/u.test(row?.field ?? '')) {
      failures.push(`${paths.fieldMatrix}: canonical extension field must be top-level request/response/edge path: ${row?.field}`);
    }
    if (/^(request|response)\.(reasoning|generation|text)\./u.test(row?.field ?? '')) {
      failures.push(`${paths.fieldMatrix}: provider-shaped invented canonical extension hierarchy forbidden: ${row.field}`);
    }
    if (row?.field !== row?.semantic_id) failures.push(`${paths.fieldMatrix}: canonical extension semantic_id must equal field ${row?.field}`);
  }
  for (const row of matrix?.extended_openai_chat_semantic_superset?.fields ?? []) {
    if (row?.mapping_status !== 'extension_added') continue;
    const registered = registryByField.get(row.extended_openai_chat_field);
    if (!registered) {
      failures.push(`${paths.fieldMatrix}: extension field ${row.extended_openai_chat_field} missing canonical_extension_registry entry`);
      continue;
    }
    for (const key of ['semantic_id', 'direction', 'current_impl']) {
      if (registered[key] !== row[key]) failures.push(`${paths.fieldMatrix}: canonical_extension_registry.${row.extended_openai_chat_field}.${key} must match superset row`);
    }
  }
  for (const row of registry) {
    const superset = (matrix?.extended_openai_chat_semantic_superset?.fields ?? []).find((item) => item?.extended_openai_chat_field === row.field);
    if (!superset || superset.mapping_status !== 'extension_added') failures.push(`${paths.fieldMatrix}: canonical_extension_registry.${row.field} must correspond to an extension_added superset row`);
  }
}

function requireAuditTruthContract(matrix) {
  const contract = matrix?.audit_truth_contract;
  if (!contract) {
    failures.push(`${paths.fieldMatrix}: missing audit_truth_contract textual truth gate`);
    return;
  }
  for (const [key, expected] of [
    ['canonical_text_doc', paths.matrixReview],
    ['generated_review_surface', paths.fieldMatrixHtml],
    ['closeout_goal_doc', paths.gapCloseoutPlan],
    ['gate', 'npm run verify:v3-protocol-conversion-field-parity'],
    ['red_fixture_gate', 'npm run test:v3-protocol-conversion-field-parity-red-fixtures'],
  ]) {
    if (contract?.[key] !== expected) failures.push(`${paths.fieldMatrix}: audit_truth_contract.${key} must be ${expected}`);
  }
  for (const phrase of ['OpenAI Chat is the Chat Process base protocol', 'protocol-neutral request/response/edge extension fields', 'semantic meaning']) {
    if (!String(contract?.truth_statement ?? '').includes(phrase)) failures.push(`${paths.fieldMatrix}: audit_truth_contract.truth_statement missing ${phrase}`);
  }
  for (const forbidden of ['MetadataCenter', 'raw payload dump', 'SSE transport', 'server handler', 'provider transport']) {
    if (!(contract?.forbidden_truth_sources ?? []).includes(forbidden)) failures.push(`${paths.fieldMatrix}: audit_truth_contract.forbidden_truth_sources missing ${forbidden}`);
  }
  const requiredStatuses = [
    'covered',
    'covered_but_target_dependent',
    'runtime_conformance_pending',
    'partial',
    'extension_declared',
    'semantic_declared',
    'source_inventory_only',
    'shape_branch_gap',
    'codec_shape_only',
    'edge_only',
  ];
  for (const status of requiredStatuses) {
    if (!contract?.status_legend?.[status]) failures.push(`${paths.fieldMatrix}: audit_truth_contract.status_legend missing ${status}`);
  }
  const actualCounts = currentImplCounts(matrix);
  for (const status of requiredStatuses) {
    const expectedCount = actualCounts.get(status) ?? 0;
    const declared = contract?.audited_status_counts?.[status];
    if (declared !== expectedCount) failures.push(`${paths.fieldMatrix}: audit_truth_contract.audited_status_counts.${status} must equal current_impl count ${expectedCount}, got ${declared}`);
  }
  for (const status of Object.keys(contract?.audited_status_counts ?? {})) {
    if (!requiredStatuses.includes(status)) failures.push(`${paths.fieldMatrix}: audit_truth_contract.audited_status_counts has unknown status ${status}`);
  }
  const gaps = Array.isArray(contract?.gap_audit) ? contract.gap_audit : [];
  const byId = new Map(gaps.map((gap) => [gap?.gap_id, gap]));
  for (const [gapId, status, closeoutStatus] of [
    ['gap.client_metadata.target_dependent', 'runtime_conformance_pending', 'runtime_conformance_pending'],
    ['gap.runtime_extension_declared', 'extension_declared', 'needs_runtime_goal'],
    ['gap.semantic_declared_runtime_closeout', 'semantic_declared', 'needs_runtime_goal'],
    ['gap.partial_cross_protocol_semantics', 'partial', 'needs_runtime_goal'],
    ['gap.source_inventory_only', 'source_inventory_only', 'closed_as_semantic_declared'],
    ['gap.shape_branch_transform', 'shape_branch_gap', 'needs_red_tests'],
    ['gap.gemini_codec_shape_only', 'codec_shape_only', 'needs_runtime_goal'],
    ['gap.edge_only_transport_state', 'edge_only', 'no_business_runtime_closeout'],
  ]) {
    const gap = byId.get(gapId);
    if (!gap) {
      failures.push(`${paths.fieldMatrix}: audit_truth_contract.gap_audit missing ${gapId}`);
      continue;
    }
    if (!(gap?.affected_statuses ?? []).includes(status)) failures.push(`${paths.fieldMatrix}: ${gapId} must cover status ${status}`);
    const expectedCount = actualCounts.get(status) ?? 0;
    if (gap?.affected_count !== expectedCount) failures.push(`${paths.fieldMatrix}: ${gapId}.affected_count must equal ${expectedCount}`);
    if (gap?.closeout_status !== closeoutStatus) failures.push(`${paths.fieldMatrix}: ${gapId}.closeout_status must be ${closeoutStatus}`);
    for (const [key, minLength] of [['category', 5], ['evidence', 20], ['required_owner', 10], ['closeout_rule', 20]]) {
      if (!gap?.[key] || String(gap[key]).length < minLength) failures.push(`${paths.fieldMatrix}: ${gapId} missing descriptive ${key}`);
    }
  }
  for (const gap of matrix?.implementation_gaps ?? []) {
    if (!gap?.closeout_status || !gap?.required_gate) failures.push(`${paths.fieldMatrix}: implementation_gaps.${gap?.id ?? 'missing'} must include closeout_status and required_gate`);
  }
}

function currentImplCounts(matrix) {
  const counts = new Map();
  walkCurrentImpl(matrix, [], (_pathParts, value) => {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  });
  return counts;
}

function walkCurrentImpl(value, pathParts, visit) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkCurrentImpl(item, [...pathParts, `[${index}]`], visit));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'canonical_extension_registry') continue;
    if (key === 'current_impl') visit([...pathParts, key], child);
    else walkCurrentImpl(child, [...pathParts, key], visit);
  }
}

function requireManualSemanticTranslationGroups(matrix) {
  const groups = matrix?.chat_semantic_translation_groups;
  if (!Array.isArray(groups) || groups.length < 30) {
    failures.push(`${paths.fieldMatrix}: chat_semantic_translation_groups must contain hand-audited Chat-standard semantic groups`);
    return;
  }
  const byId = new Map();
  for (const [index, group] of groups.entries()) {
    for (const key of ['group_id', 'standard_chat_field', 'direction', 'standard_semantic_meaning', 'chat_shape_rule', 'protocol_mappings', 'current_impl', 'gap']) {
      if (group?.[key] == null) failures.push(`${paths.fieldMatrix}: chat_semantic_translation_groups[${index}] missing ${key}`);
    }
    if (byId.has(group?.group_id)) failures.push(`${paths.fieldMatrix}: duplicate chat_semantic_translation_groups group_id ${group?.group_id}`);
    byId.set(group?.group_id, group);
    if (String(group?.standard_semantic_meaning ?? '').length < 40) {
      failures.push(`${paths.fieldMatrix}: ${group?.group_id} must define the Chat semantic meaning, not only list fields`);
    }
    if (String(group?.chat_shape_rule ?? '').length < 40) {
      failures.push(`${paths.fieldMatrix}: ${group?.group_id} must define Chat shape/value transform rules`);
    }
    for (const protocol of ['responses', 'anthropic', 'gemini']) {
      const mapping = group?.protocol_mappings?.[protocol];
      if (!mapping) {
        failures.push(`${paths.fieldMatrix}: ${group?.group_id} missing protocol_mappings.${protocol}`);
        continue;
      }
      if (!Array.isArray(mapping.request_fields) || !Array.isArray(mapping.response_fields)) {
        failures.push(`${paths.fieldMatrix}: ${group?.group_id}.protocol_mappings.${protocol} must have request_fields and response_fields arrays`);
      }
      if (!mapping.transform || String(mapping.transform).length < 30) {
        failures.push(`${paths.fieldMatrix}: ${group?.group_id}.protocol_mappings.${protocol} missing manual transform`);
      }
    }
  }
  for (const id of [
    'turn.role',
    'content.text_string',
    'content.image_url',
    'content.inline_media_data',
    'content.media_mime_type',
    'tool.declaration',
    'tool.call.id',
    'tool.call.name',
    'tool.call.arguments',
    'tool.result.call_id',
    'tool.result.output',
    'tool.result.name',
    'tool.result.error_status',
    'response.finish_reason',
    'response.usage_tokens',
  ]) {
    if (!byId.has(id)) failures.push(`${paths.fieldMatrix}: missing manual semantic translation group ${id}`);
  }
  const manyToOne = groups.filter((group) => ['responses', 'anthropic', 'gemini'].some((protocol) => groupProtocolFields(group, protocol).length > 1));
  if (manyToOne.length < 12) failures.push(`${paths.fieldMatrix}: manual semantic groups must include many-to-one/one-to-many mappings; found only ${manyToOne.length}`);

  requireGroupFields(byId, 'tool.call.id', 'request.messages[].tool_calls[].id', {
    responses: ['request.input[].function_call.call_id'],
    anthropic: ['request.messages[].content[].tool_use.id'],
    gemini: ['request.contents[].parts[].functionCall.id'],
  });
  forbidGroupFields(byId, 'tool.call.id', {
    responses: ['request.input[].function_call.arguments', 'request.input[].function_call.name'],
    anthropic: ['request.messages[].content[].tool_use.input', 'request.messages[].content[].tool_use.name'],
    gemini: ['request.contents[].parts[].functionCall.args', 'request.contents[].parts[].functionCall.name'],
  });
  requireGroupFields(byId, 'tool.call.name', 'request.messages[].tool_calls[].function.name', {
    responses: ['request.input[].function_call.name'],
    anthropic: ['request.messages[].content[].tool_use.name'],
    gemini: ['request.contents[].parts[].functionCall.name'],
  });
  requireGroupFields(byId, 'tool.call.arguments', 'request.messages[].tool_calls[].function.arguments', {
    responses: ['request.input[].function_call.arguments'],
    anthropic: ['request.messages[].content[].tool_use.input'],
    gemini: ['request.contents[].parts[].functionCall.args'],
  });
  requireGroupFields(byId, 'tool.result.call_id', 'request.messages[].tool_call_id', {
    responses: ['request.input[].function_call_output.call_id'],
    anthropic: ['request.messages[].content[].tool_result.tool_use_id'],
    gemini: ['request.contents[].parts[].functionResponse.id'],
  });
  forbidGroupFields(byId, 'tool.result.call_id', {
    responses: ['request.input[].function_call_output.output'],
    anthropic: ['request.messages[].content[].tool_result.content', 'request.messages[].content[].tool_result.is_error'],
    gemini: ['request.contents[].parts[].functionResponse.name', 'request.contents[].parts[].functionResponse.response'],
  });
  requireGroupFields(byId, 'tool.result.output', 'request.messages[].tool_result.output', {
    responses: ['request.input[].function_call_output.output'],
    anthropic: ['request.messages[].content[].tool_result.content'],
    gemini: ['request.contents[].parts[].functionResponse.response'],
  });
  requireGroupFields(byId, 'tool.result.name', 'request.messages[].tool_result.name', {
    gemini: ['request.contents[].parts[].functionResponse.name'],
  });
  requireGroupFields(byId, 'tool.result.error_status', 'request.messages[].tool_result.is_error', {
    anthropic: ['request.messages[].content[].tool_result.is_error'],
  });
  requireGroupFields(byId, 'content.image_url', 'request.messages[].content[].image_url.url', {
    responses: ['request.input[].input_image.image_url'],
  });
  forbidGroupFields(byId, 'content.image_url', {
    responses: ['request.input[].input_image.file_id', 'request.input[].input_image.detail'],
    gemini: ['request.contents[].parts[].inlineData.data', 'request.contents[].parts[].inlineData.mimeType', 'request.contents[].parts[].fileData.fileUri'],
  });
  requireGroupFields(byId, 'content.media_mime_type', 'request.messages[].content[].media.mime_type', {
    gemini: ['request.contents[].parts[].inlineData.mimeType', 'request.contents[].parts[].fileData.mimeType'],
  });
  requireGroupFields(byId, 'content.inline_media_data', 'request.messages[].content[].media.inline_data', {
    gemini: ['request.contents[].parts[].inlineData.data'],
  });

  requireSupersetRowFields(matrix, 'request.messages[].tool_calls[].id', {
    responses: ['request.input[].function_call.call_id'],
    anthropic: ['request.messages[].content[].tool_use.id'],
    gemini: ['request.contents[].parts[].functionCall.id'],
  });
  forbidSupersetRowFields(matrix, 'request.messages[].tool_calls[].id', {
    responses: ['request.input[].function_call.arguments', 'request.input[].function_call.name'],
    anthropic: ['request.messages[].content[].tool_use.input', 'request.messages[].content[].tool_use.name'],
    gemini: ['request.contents[].parts[].functionCall.args', 'request.contents[].parts[].functionCall.name'],
  });
  requireSupersetRowFields(matrix, 'request.messages[].tool_calls[].function.arguments', {
    responses: ['request.input[].function_call.arguments'],
    anthropic: ['request.messages[].content[].tool_use.input'],
    gemini: ['request.contents[].parts[].functionCall.args'],
  });
  requireSupersetRowFields(matrix, 'request.messages[].tool_result.output', {
    responses: ['request.input[].function_call_output.output'],
    anthropic: ['request.messages[].content[].tool_result.content'],
    gemini: ['request.contents[].parts[].functionResponse.response'],
  });
  requireSupersetRowFields(matrix, 'request.messages[].tool_result.name', {
    gemini: ['request.contents[].parts[].functionResponse.name'],
  });
  requireSupersetRowFields(matrix, 'request.messages[].content[].media.mime_type', {
    gemini: ['request.contents[].parts[].inlineData.mimeType'],
  });
  forbidSupersetRowFields(matrix, 'request.messages[].content[].image_url.url', {
    responses: ['request.input[].input_image.file_id', 'request.input[].input_image.detail'],
    gemini: ['request.contents[].parts[].inlineData.data', 'request.contents[].parts[].inlineData.mimeType', 'request.contents[].parts[].fileData.fileUri'],
  });
}

function requireShapeBranchTransformContract(matrix) {
  const groups = matrix?.chat_semantic_translation_groups;
  if (!Array.isArray(groups)) return;
  const shapeGroups = groups.filter((group) => group?.current_impl === 'shape_branch_gap');
  if (shapeGroups.length !== 6) {
    failures.push(`${paths.fieldMatrix}: gap.shape_branch_transform must be represented by 6 manual shape_branch_gap groups, got ${shapeGroups.length}`);
  }
  const allowedOwnerFiles = new Set([
    paths.responsesOpenaiCodec,
    paths.requestOutboundFormat,
    paths.anthropicCodec,
    'v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_codec.rs',
  ]);
  const requiredGroups = {
    'content.image_url': {
      positive: ['anthropic', 'responses'],
      negative: ['anthropic', 'gemini'],
      target: 'request.messages[].content[].image_url.url',
      forbiddenTokens: ['inlineData.mimeType', 'fileData.fileUri', 'base64'],
    },
    'content.inline_media_data': {
      positive: ['anthropic', 'gemini'],
      negative: ['anthropic', 'gemini'],
      target: 'request.messages[].content[].media.inline_data',
      forbiddenTokens: ['image.source.type == "url"', 'inlineData.mimeType'],
    },
    'content.media_mime_type': {
      positive: ['anthropic', 'gemini'],
      negative: ['anthropic', 'gemini'],
      target: 'request.messages[].content[].media.mime_type',
      forbiddenTokens: ['source.data', 'fileData.fileUri'],
    },
    'content.file_id': {
      positive: ['responses'],
      negative: ['responses', 'gemini'],
      target: 'request.messages[].content[].file.file_id',
      forbiddenTokens: ['file_data', 'file_url', 'fileData.fileUri'],
    },
    'content.file_data': {
      positive: ['anthropic', 'responses'],
      negative: ['responses', 'gemini'],
      target: 'request.messages[].content[].file.file_data',
      forbiddenTokens: ['file_id', 'file_url', 'inlineData.data without file-kind evidence'],
    },
    'content.file_uri': {
      positive: ['responses', 'gemini'],
      negative: ['responses', 'gemini'],
      target: 'request.messages[].content[].file.file_url',
      forbiddenTokens: ['input_image.image_url', 'inlineData.data'],
    },
  };
  const byId = new Map(groups.map((group) => [group?.group_id, group]));
  for (const [groupId, contract] of Object.entries(requiredGroups)) {
    const group = byId.get(groupId);
    if (!group) {
      failures.push(`${paths.fieldMatrix}: missing shape branch group ${groupId}`);
      continue;
    }
    if (group.current_impl !== 'shape_branch_gap') {
      failures.push(`${paths.fieldMatrix}: ${groupId} must remain shape_branch_gap until runtime branch tests close it`);
    }
    const cases = group?.shape_branch_cases;
    if (!cases) {
      failures.push(`${paths.fieldMatrix}: ${groupId} missing shape_branch_cases positive/negative contract`);
      continue;
    }
    const positive = Array.isArray(cases.positive) ? cases.positive : [];
    const negative = Array.isArray(cases.negative) ? cases.negative : [];
    requireShapeCaseProtocols(groupId, 'positive', positive, contract.positive);
    requireShapeCaseProtocols(groupId, 'negative', negative, contract.negative);
    for (const item of positive) {
      requireShapeCaseFields(groupId, 'positive', item, allowedOwnerFiles);
      if (item?.maps_to !== contract.target) failures.push(`${paths.fieldMatrix}: ${groupId} positive case must map to ${contract.target}`);
    }
    for (const item of negative) {
      requireShapeCaseFields(groupId, 'negative', item, allowedOwnerFiles);
      if (item?.must_not_map_to !== contract.target) failures.push(`${paths.fieldMatrix}: ${groupId} negative case must forbid ${contract.target}`);
    }
    const negativeText = negative.map((item) => String(item?.forbidden_source ?? '')).join('\n');
    for (const token of contract.forbiddenTokens) {
      if (!negativeText.includes(token)) failures.push(`${paths.fieldMatrix}: ${groupId} shape_branch_cases.negative must lock forbidden token ${token}`);
    }
  }
}

function requireShapeCaseProtocols(groupId, kind, rows, protocols) {
  if (!Array.isArray(rows) || rows.length === 0) {
    failures.push(`${paths.fieldMatrix}: ${groupId} shape_branch_cases.${kind} must not be empty`);
    return;
  }
  const actual = new Set(rows.map((row) => row?.protocol));
  for (const protocol of protocols) {
    if (!actual.has(protocol)) failures.push(`${paths.fieldMatrix}: ${groupId} shape_branch_cases.${kind} missing ${protocol} branch`);
  }
}

function requireShapeCaseFields(groupId, kind, item, allowedOwnerFiles) {
  for (const key of ['protocol', 'owner_file', 'required_test']) {
    if (!item?.[key]) failures.push(`${paths.fieldMatrix}: ${groupId} shape_branch_cases.${kind} missing ${key}`);
  }
  const conditionKey = kind === 'positive' ? 'source_condition' : 'forbidden_source';
  const targetKey = kind === 'positive' ? 'maps_to' : 'must_not_map_to';
  if (!item?.[conditionKey] || String(item[conditionKey]).length < 12) {
    failures.push(`${paths.fieldMatrix}: ${groupId} shape_branch_cases.${kind} missing descriptive ${conditionKey}`);
  }
  if (!item?.[targetKey]) {
    failures.push(`${paths.fieldMatrix}: ${groupId} shape_branch_cases.${kind} missing ${targetKey}`);
  }
  if (item?.owner_file && !allowedOwnerFiles.has(item.owner_file)) {
    failures.push(`${paths.fieldMatrix}: ${groupId} shape branch owner_file must be adjacent Rust codec owner, got ${item.owner_file}`);
  }
  if (item?.required_test && !/^[a-z0-9_]+$/u.test(item.required_test)) {
    failures.push(`${paths.fieldMatrix}: ${groupId} shape branch required_test must be a concrete Rust test symbol, got ${item.required_test}`);
  }
  if (item?.protocol === 'anthropic' && item?.owner_file === paths.anthropicCodec) {
    for (const phrase of [
      'collect_v3_anthropic_request_shape_branch_semantics',
      'V3AnthropicChatShapeBranchSemantic',
      'request.messages[].content[].image.source.url',
      'request.messages[].content[].image.source.data',
      'request.messages[].content[].image.source.media_type',
      'ChatImageUrlUrl',
      'ChatInlineMediaData',
      'ChatMediaMimeType',
    ]) requireText(text.anthropicCodec, paths.anthropicCodec, phrase);
    requireNear(text.anthropicCodec, paths.anthropicCodec, '"request.messages[].content[].image.source.url"', 'ChatImageUrlUrl');
    requireNear(text.anthropicCodec, paths.anthropicCodec, '"request.messages[].content[].image.source.data"', 'ChatInlineMediaData');
    requireNear(text.anthropicCodec, paths.anthropicCodec, '"request.messages[].content[].image.source.media_type"', 'ChatMediaMimeType');
    forbidNear(text.anthropicCodec, paths.anthropicCodec, '"request.messages[].content[].image.source.url"', 'ChatInlineMediaData');
    forbidNear(text.anthropicCodec, paths.anthropicCodec, '"request.messages[].content[].image.source.data"', 'ChatMediaMimeType');
    if (item?.required_test) requireText(text.anthropicCodecTests, paths.anthropicCodecTests, item.required_test);
    requireText(text.mainlineMap, paths.mainlineMap, 'v3-protocol-anthropic-shape-branch-01');
    requireText(text.mainlineMap, paths.mainlineMap, 'collect_v3_anthropic_request_shape_branch_semantics');
    requireText(text.functionMap, paths.functionMap, 'collect_v3_anthropic_request_shape_branch_semantics');
    requireText(text.verificationMap, paths.verificationMap, 'collect_v3_anthropic_request_shape_branch_semantics');
  }
  if (item?.protocol === 'gemini' && item?.owner_file === paths.geminiCodec) {
    for (const phrase of [
      'collect_v3_gemini_request_shape_branch_semantics',
      'V3GeminiChatShapeBranchSemantic',
      'request.contents[].parts[].inlineData.data',
      'request.contents[].parts[].inlineData.mimeType',
      'request.contents[].parts[].fileData.mimeType',
      'request.contents[].parts[].fileData.fileUri',
    ]) requireText(text.geminiCodec, paths.geminiCodec, phrase);
    requireNear(text.geminiCodec, paths.geminiCodec, '"request.contents[].parts[].inlineData.data"', 'ChatInlineMediaData');
    requireNear(text.geminiCodec, paths.geminiCodec, '"request.contents[].parts[].inlineData.mimeType"', 'ChatMediaMimeType');
    requireNear(text.geminiCodec, paths.geminiCodec, '"request.contents[].parts[].fileData.mimeType"', 'ChatMediaMimeType');
    requireNear(text.geminiCodec, paths.geminiCodec, '"request.contents[].parts[].fileData.fileUri"', 'ChatFileFileUrl');
    forbidNear(text.geminiCodec, paths.geminiCodec, '"request.contents[].parts[].inlineData.data"', 'ChatImageUrlUrl');
    forbidNear(text.geminiCodec, paths.geminiCodec, '"request.contents[].parts[].inlineData.data"', 'ChatFileFileData');
    forbidNear(text.geminiCodec, paths.geminiCodec, '"request.contents[].parts[].fileData.fileUri"', 'ChatImageUrlUrl');
    forbidNear(text.geminiCodec, paths.geminiCodec, '"request.contents[].parts[].fileData.fileUri"', 'ChatFileFileId');
    if (item?.required_test) requireText(text.geminiTests, paths.geminiTests, item.required_test);
    requireText(text.mainlineMap, paths.mainlineMap, 'v3-protocol-gemini-shape-branch-01');
    requireText(text.mainlineMap, paths.mainlineMap, 'collect_v3_gemini_request_shape_branch_semantics');
    requireText(text.functionMap, paths.functionMap, 'collect_v3_gemini_request_shape_branch_semantics');
    requireText(text.verificationMap, paths.verificationMap, 'collect_v3_gemini_request_shape_branch_semantics');
  }
}

function requireGeminiToolConfigSemanticContract(matrix) {
  const groups = matrix?.chat_semantic_translation_groups ?? [];
  const byId = new Map(groups.map((group) => [group?.group_id, group]));
  const choice = byId.get('tool.choice');
  if (!choice) {
    failures.push(`${paths.fieldMatrix}: missing tool.choice semantic group`);
  } else {
    for (const field of ['request.tool_choice', 'request.tool_choice.allowed_function_names']) {
      if (!(choice.chat_fields ?? []).includes(field)) failures.push(`${paths.fieldMatrix}: tool.choice.chat_fields missing ${field}`);
    }
    for (const field of ['request.toolConfig.functionCallingConfig.mode', 'request.toolConfig.functionCallingConfig.allowedFunctionNames']) {
      if (!(choice.protocol_mappings?.gemini?.request_fields ?? []).includes(field)) failures.push(`${paths.fieldMatrix}: tool.choice Gemini mapping missing ${field}`);
    }
    if (!(choice.chat_extension_fields ?? []).includes('request.tool_choice.allowed_function_names')) {
      failures.push(`${paths.fieldMatrix}: tool.choice must expose request.tool_choice.allowed_function_names extension`);
    }
  }
  const parallel = byId.get('tool.parallelism');
  if (parallel) {
    if ((parallel.protocol_mappings?.gemini?.request_fields ?? []).includes('request.toolConfig.functionCallingConfig.allowedFunctionNames')) {
      failures.push(`${paths.fieldMatrix}: Gemini allowedFunctionNames must not collapse into tool.parallelism`);
    }
    if ((parallel.protocol_mappings?.gemini?.request_fields ?? []).includes('request.toolConfig.functionCallingConfig.mode')) {
      failures.push(`${paths.fieldMatrix}: Gemini mode is tool-choice policy and must not collapse into tool.parallelism`);
    }
    if (parallel.current_impl !== 'partial') failures.push(`${paths.fieldMatrix}: tool.parallelism remains partial until Gemini mode has an explicit boolean contract`);
  }

  const modeBucket = classificationBucketForField(matrix, 'gemini', 'request.toolConfig.functionCallingConfig.mode');
  const allowedBucket = classificationBucketForField(matrix, 'gemini', 'request.toolConfig.functionCallingConfig.allowedFunctionNames');
  if (modeBucket !== 'canonical_chat_fields') failures.push(`${paths.fieldMatrix}: Gemini toolConfig mode must stay canonical_chat_fields`);
  if (allowedBucket !== 'protocol_specific_chat_extension_fields') failures.push(`${paths.fieldMatrix}: Gemini allowedFunctionNames must be a protocol-specific Chat extension field`);
  const topLevelToolConfig = matrix?.protocols?.gemini?.request_top_level_fields?.find((row) => row?.field === 'toolConfig');
  if (topLevelToolConfig?.current_impl !== 'partial') failures.push(`${paths.fieldMatrix}: Gemini top-level toolConfig current_impl must be partial after functionCallingConfig source closeout`);

  const toolChoiceRow = supersetRowByField(matrix, 'request.tool_choice');
  if (toolChoiceRow) {
    const gemini = toolChoiceRow?.equivalent_fields?.gemini ?? [];
    if (!gemini.includes('request.toolConfig.functionCallingConfig.mode')) failures.push(`${paths.fieldMatrix}: request.tool_choice must map Gemini mode`);
    if (gemini.includes('request.toolConfig.functionCallingConfig.allowedFunctionNames')) failures.push(`${paths.fieldMatrix}: request.tool_choice must not collapse Gemini allowedFunctionNames`);
  }
  const allowedNamesRow = supersetRowByField(matrix, 'request.tool_choice.allowed_function_names');
  if (allowedNamesRow) {
    if (allowedNamesRow.mapping_status !== 'extension_added') failures.push(`${paths.fieldMatrix}: request.tool_choice.allowed_function_names must be extension_added`);
    if (allowedNamesRow.current_impl !== 'partial') failures.push(`${paths.fieldMatrix}: request.tool_choice.allowed_function_names current_impl must be partial until cross-protocol/live closeout`);
    const gemini = allowedNamesRow?.equivalent_fields?.gemini ?? [];
    if (!gemini.includes('request.toolConfig.functionCallingConfig.allowedFunctionNames')) failures.push(`${paths.fieldMatrix}: request.tool_choice.allowed_function_names must map Gemini allowedFunctionNames`);
    if (gemini.includes('request.toolConfig.functionCallingConfig.mode')) failures.push(`${paths.fieldMatrix}: request.tool_choice.allowed_function_names must not collapse Gemini mode`);
    const associations = new Set((allowedNamesRow.chat_extension_association ?? []).map((item) => item?.extension_id));
    if (!associations.has('tool_config')) failures.push(`${paths.fieldMatrix}: request.tool_choice.allowed_function_names must bind tool_config extension association`);
  }

  for (const phrase of [
    'collect_v3_gemini_request_tool_config_semantics',
    'V3GeminiChatToolConfigSemantic',
    'V3GeminiChatToolChoicePolicy',
    'V3GeminiToolConfigSemanticValue',
    'ToolConfigAllowedFunctionNameNotString',
    'request.toolConfig.functionCallingConfig.mode',
    'request.toolConfig.functionCallingConfig.allowedFunctionNames',
    'ChatToolChoicePolicy',
    'ChatToolChoiceAllowedFunctionNames',
  ]) requireText(text.geminiCodec, paths.geminiCodec, phrase);
  requireNear(text.geminiCodec, paths.geminiCodec, '"request.toolConfig.functionCallingConfig.mode"', 'ChatToolChoicePolicy');
  requireNear(text.geminiCodec, paths.geminiCodec, '"request.toolConfig.functionCallingConfig.allowedFunctionNames"', 'ChatToolChoiceAllowedFunctionNames');
  forbidNear(text.geminiCodec, paths.geminiCodec, '"request.toolConfig.functionCallingConfig.allowedFunctionNames"', 'ChatToolDeclarationName');
  forbidNear(text.geminiCodec, paths.geminiCodec, '"request.toolConfig.functionCallingConfig.mode"', 'ChatParallelToolCalls');
  for (const testSymbol of [
    'gemini_tool_config_mode_maps_to_chat_tool_choice_policy',
    'gemini_tool_config_allowed_function_names_maps_to_allowed_tool_choice_names',
    'gemini_tool_config_allowed_function_names_do_not_become_tool_declarations',
    'gemini_tool_config_mode_does_not_become_parallel_tool_calls_without_value_contract',
    'gemini_tool_config_malformed_allowed_function_names_fail_closed',
    'gemini_tool_config_semantics_do_not_mutate_provider_wire_payload',
  ]) requireText(text.geminiTests, paths.geminiTests, testSymbol);
  for (const [owner, body] of [
    [paths.mainlineMap, text.mainlineMap],
    [paths.functionMap, text.functionMap],
    [paths.verificationMap, text.verificationMap],
  ]) {
    for (const phrase of ['v3-protocol-gemini-tool-config-01', 'collect_v3_gemini_request_tool_config_semantics']) {
      requireText(body, owner, phrase);
    }
  }
}


function requireGeminiThinkingConfigSemanticContract(matrix) {
  const groups = matrix?.chat_semantic_translation_groups ?? [];
  const byId = new Map(groups.map((group) => [group?.group_id, group]));
  const effort = byId.get('reasoning.request_effort');
  if (effort) {
    const anthropic = new Set(effort.protocol_mappings?.anthropic?.request_fields ?? []);
    if (!anthropic.has('request.output_config.effort')) failures.push(`${paths.fieldMatrix}: reasoning.request_effort must map Anthropic output_config.effort`);
    for (const field of ['request.thinking.type', 'request.thinking.budget_tokens']) {
      if (anthropic.has(field)) failures.push(`${paths.fieldMatrix}: reasoning.request_effort must not collapse into Anthropic ${field}`);
    }
    const gemini = new Set(effort.protocol_mappings?.gemini?.request_fields ?? []);
    if (!gemini.has('request.generationConfig.thinkingConfig.thinkingLevel')) failures.push(`${paths.fieldMatrix}: reasoning.request_effort must map Gemini thinkingLevel`);
    for (const field of ['request.generationConfig.thinkingConfig.includeThoughts', 'request.generationConfig.thinkingConfig.thinkingBudget']) {
      if (gemini.has(field)) failures.push(`${paths.fieldMatrix}: reasoning.request_effort must not collapse Gemini ${field}`);
    }
    if ((effort.protocol_mappings?.gemini?.response_fields ?? []).includes('response.usageMetadata.thoughtsTokenCount')) {
      failures.push(`${paths.fieldMatrix}: reasoning.request_effort must not treat thoughtsTokenCount usage as request effort`);
    }
  }
  const include = byId.get('reasoning.request_include_thoughts');
  if (!include) failures.push(`${paths.fieldMatrix}: missing reasoning.request_include_thoughts semantic group`);
  else {
    if (!(include.chat_fields ?? []).includes('request.reasoning_include_thoughts')) failures.push(`${paths.fieldMatrix}: reasoning.request_include_thoughts missing request.reasoning_include_thoughts chat field`);
    const gemini = include.protocol_mappings?.gemini?.request_fields ?? [];
    if (!gemini.includes('request.generationConfig.thinkingConfig.includeThoughts')) failures.push(`${paths.fieldMatrix}: reasoning.request_include_thoughts must map Gemini includeThoughts`);
  }
  const budget = byId.get('reasoning.request_budget_tokens');
  if (!budget) failures.push(`${paths.fieldMatrix}: missing reasoning.request_budget_tokens semantic group`);
  else {
    if (!(budget.chat_fields ?? []).includes('request.reasoning_budget_tokens')) failures.push(`${paths.fieldMatrix}: reasoning.request_budget_tokens missing request.reasoning_budget_tokens chat field`);
    const gemini = budget.protocol_mappings?.gemini?.request_fields ?? [];
    if (!gemini.includes('request.generationConfig.thinkingConfig.thinkingBudget')) failures.push(`${paths.fieldMatrix}: reasoning.request_budget_tokens must map Gemini thinkingBudget`);
    if ((budget.protocol_mappings?.gemini?.request_fields ?? []).includes('request.generationConfig.maxOutputTokens')) failures.push(`${paths.fieldMatrix}: Gemini thinkingBudget must not collapse into maxOutputTokens`);
  }
  const mode = byId.get('reasoning.request_mode');
  if (!mode || !(mode.chat_fields ?? []).includes('request.reasoning_mode')) failures.push(`${paths.fieldMatrix}: missing independent reasoning.request_mode semantic group`);
  const context = byId.get('reasoning.request_context_policy');
  if ((context?.protocol_mappings?.responses?.request_fields ?? []).includes('request.reasoning.mode')) failures.push(`${paths.fieldMatrix}: reasoning mode must not collapse into context policy`);
  const display = byId.get('reasoning.request_display_policy');
  if (!display || !(display.protocol_mappings?.anthropic?.request_fields ?? []).includes('request.thinking.display')) failures.push(`${paths.fieldMatrix}: missing independent Anthropic reasoning display policy`);
  const summary = byId.get('reasoning.request_summary_policy');
  if ((summary?.protocol_mappings?.anthropic?.request_fields ?? []).includes('request.thinking.display')) failures.push(`${paths.fieldMatrix}: OpenAI summary policy must not collapse into Anthropic display policy`);
  for (const [field, expected, forbidden] of [
    ['request.reasoning_effort', ['request.generationConfig.thinkingConfig.thinkingLevel'], ['request.generationConfig.thinkingConfig.includeThoughts', 'request.generationConfig.thinkingConfig.thinkingBudget']],
    ['request.reasoning_include_thoughts', ['request.generationConfig.thinkingConfig.includeThoughts'], ['request.generationConfig.thinkingConfig.thinkingBudget', 'request.generationConfig.thinkingConfig.thinkingLevel']],
    ['request.reasoning_budget_tokens', ['request.generationConfig.thinkingConfig.thinkingBudget'], ['request.generationConfig.maxOutputTokens', 'response.usageMetadata.thoughtsTokenCount', 'request.generationConfig.thinkingConfig.includeThoughts']],
  ]) {
    const row = supersetRowByField(matrix, field);
    if (!row) continue;
    for (const source of expected) if (!(row.equivalent_fields?.gemini ?? []).includes(source)) failures.push(`${paths.fieldMatrix}: ${field} must map Gemini ${source}`);
    for (const source of forbidden) if ((row.equivalent_fields?.gemini ?? []).includes(source)) failures.push(`${paths.fieldMatrix}: ${field} must not collapse Gemini ${source}`);
    if (field !== 'request.reasoning_effort' && row.mapping_status !== 'extension_added') failures.push(`${paths.fieldMatrix}: ${field} must be extension_added`);
    if (field !== 'request.reasoning_effort' && row.current_impl !== 'partial') failures.push(`${paths.fieldMatrix}: ${field} current_impl must be partial after Gemini source closeout`);
  }
  for (const phrase of [
    'collect_v3_gemini_request_thinking_config_semantics',
    'V3GeminiChatThinkingConfigSemantic',
    'V3GeminiThinkingConfigSemanticValue',
    'ThinkingConfigBudgetNotInteger',
    'request.generationConfig.thinkingConfig.includeThoughts',
    'request.generationConfig.thinkingConfig.thinkingBudget',
    'request.generationConfig.thinkingConfig.thinkingLevel',
    'ChatReasoningIncludeThoughts',
    'ChatReasoningBudgetTokens',
    'ChatReasoningLevel',
  ]) requireText(text.geminiCodec, paths.geminiCodec, phrase);
  requireNear(text.geminiCodec, paths.geminiCodec, '"request.generationConfig.thinkingConfig.includeThoughts"', 'ChatReasoningIncludeThoughts');
  requireNear(text.geminiCodec, paths.geminiCodec, '"request.generationConfig.thinkingConfig.thinkingBudget"', 'ChatReasoningBudgetTokens');
  requireNear(text.geminiCodec, paths.geminiCodec, '"request.generationConfig.thinkingConfig.thinkingLevel"', 'ChatReasoningLevel');
  forbidNear(text.geminiCodec, paths.geminiCodec, '"request.generationConfig.thinkingConfig.thinkingBudget"', 'ChatMaxOutputTokens');
  forbidNear(text.geminiCodec, paths.geminiCodec, '"request.generationConfig.thinkingConfig.includeThoughts"', 'ChatResponseReasoningContent');
  forbidNear(text.geminiCodec, paths.geminiCodec, '"request.generationConfig.thinkingConfig.thinkingLevel"', 'ChatReasoningBudgetTokens');
  for (const testSymbol of [
    'gemini_thinking_config_include_thoughts_maps_to_reasoning_visibility_request',
    'gemini_thinking_config_budget_maps_to_reasoning_budget_request',
    'gemini_thinking_config_level_maps_to_reasoning_effort_level_request',
    'gemini_thinking_budget_does_not_become_max_output_tokens',
    'gemini_include_thoughts_does_not_become_response_reasoning_content',
    'gemini_thinking_level_does_not_collapse_to_numeric_budget',
    'gemini_thinking_config_malformed_fields_fail_closed',
    'gemini_thinking_config_semantics_do_not_mutate_provider_wire_payload',
  ]) requireText(text.geminiTests, paths.geminiTests, testSymbol);
  for (const [owner, body] of [[paths.mainlineMap, text.mainlineMap], [paths.functionMap, text.functionMap], [paths.verificationMap, text.verificationMap]]) {
    for (const phrase of ['v3-protocol-gemini-thinking-config-01', 'collect_v3_gemini_request_thinking_config_semantics']) requireText(body, owner, phrase);
  }
}


function requireGeminiGenerationConfigScalarSemanticContract(matrix) {
  for (const [field, expected, forbidden, status] of [
    ['request.temperature', ['request.generationConfig.temperature'], ['request.generationConfig.topP', 'request.generationConfig.topK'], 'covered'],
    ['request.top_p', ['request.generationConfig.topP'], ['request.generationConfig.temperature', 'request.generationConfig.topK'], 'covered'],
    ['request.top_k', ['request.generationConfig.topK'], ['request.generationConfig.topP'], 'partial'],
    ['request.max_completion_tokens', ['request.generationConfig.maxOutputTokens'], ['request.generationConfig.thinkingConfig.thinkingBudget', 'response.usageMetadata.thoughtsTokenCount'], 'covered'],
    ['request.stop', ['request.generationConfig.stopSequences'], ['response.candidates[].finishReason'], 'partial'],
    ['request.frequency_penalty', ['request.generationConfig.frequencyPenalty'], ['request.generationConfig.presencePenalty', 'request.generationConfig.logprobs', 'request.generationConfig.seed'], 'partial'],
    ['request.presence_penalty', ['request.generationConfig.presencePenalty'], ['request.generationConfig.frequencyPenalty', 'request.generationConfig.logprobs', 'request.generationConfig.seed'], 'partial'],
    ['request.logprobs', ['request.generationConfig.responseLogprobs'], ['request.generationConfig.logprobs'], 'partial'],
    ['request.top_logprobs', ['request.generationConfig.logprobs'], ['request.generationConfig.responseLogprobs'], 'partial'],
    ['request.seed', ['request.generationConfig.seed'], ['request.generationConfig.frequencyPenalty', 'request.generationConfig.logprobs'], 'partial'],
  ]) {
    const row = supersetRowByField(matrix, field);
    if (!row) {
      failures.push(`${paths.fieldMatrix}: missing ${field} superset row`);
      continue;
    }
    const gemini = row.equivalent_fields?.gemini ?? [];
    for (const source of expected) if (!gemini.includes(source)) failures.push(`${paths.fieldMatrix}: ${field} must map Gemini ${source}`);
    for (const source of forbidden) if (gemini.includes(source)) failures.push(`${paths.fieldMatrix}: ${field} must not collapse Gemini ${source}`);
    if (row.current_impl !== status) failures.push(`${paths.fieldMatrix}: ${field} current_impl must be ${status} after Gemini generationConfig scalar source closeout`);
  }
  for (const phrase of [
    'collect_v3_gemini_request_generation_config_scalar_semantics',
    'V3GeminiChatGenerationConfigScalarSemantic',
    'V3GeminiGenerationConfigScalarSemanticValue',
    'GenerationConfigScalarNotInteger',
    'GenerationConfigStopSequenceNotString',
    'request.generationConfig.temperature',
    'request.generationConfig.topP',
    'request.generationConfig.topK',
    'request.generationConfig.maxOutputTokens',
    'request.generationConfig.stopSequences',
    'request.generationConfig.frequencyPenalty',
    'request.generationConfig.presencePenalty',
    'request.generationConfig.responseLogprobs',
    'request.generationConfig.logprobs',
    'request.generationConfig.seed',
    'ChatTemperature',
    'ChatTopP',
    'ChatTopK',
    'ChatMaxCompletionTokens',
    'ChatStop',
    'ChatFrequencyPenalty',
    'ChatPresencePenalty',
    'ChatLogprobs',
    'ChatTopLogprobs',
    'ChatSeed',
  ]) requireText(text.geminiCodec, paths.geminiCodec, phrase);
  requireNear(text.geminiCodec, paths.geminiCodec, '"request.generationConfig.temperature"', 'ChatTemperature');
  requireNear(text.geminiCodec, paths.geminiCodec, '"request.generationConfig.topP"', 'ChatTopP');
  requireNear(text.geminiCodec, paths.geminiCodec, '"request.generationConfig.topK"', 'ChatTopK');
  requireNear(text.geminiCodec, paths.geminiCodec, '"request.generationConfig.maxOutputTokens"', 'ChatMaxCompletionTokens');
  requireNear(text.geminiCodec, paths.geminiCodec, '"request.generationConfig.stopSequences"', 'ChatStop');
  requireNear(text.geminiCodec, paths.geminiCodec, '"request.generationConfig.frequencyPenalty"', 'ChatFrequencyPenalty');
  requireNear(text.geminiCodec, paths.geminiCodec, '"request.generationConfig.presencePenalty"', 'ChatPresencePenalty');
  requireNear(text.geminiCodec, paths.geminiCodec, '"request.generationConfig.responseLogprobs"', 'ChatLogprobs');
  requireNear(text.geminiCodec, paths.geminiCodec, '"request.generationConfig.logprobs"', 'ChatTopLogprobs');
  requireNear(text.geminiCodec, paths.geminiCodec, '"request.generationConfig.seed"', 'ChatSeed');
  forbidNear(text.geminiCodec, paths.geminiCodec, '"request.generationConfig.topP"', 'ChatTopK');
  forbidNear(text.geminiCodec, paths.geminiCodec, '"request.generationConfig.topK"', 'ChatTopP');
  forbidNear(text.geminiCodec, paths.geminiCodec, '"request.generationConfig.maxOutputTokens"', 'ChatReasoningBudgetTokens');
  forbidNear(text.geminiCodec, paths.geminiCodec, '"request.generationConfig.stopSequences"', 'ChatFinishReason');
  forbidNear(text.geminiCodec, paths.geminiCodec, '"request.generationConfig.frequencyPenalty"', 'ChatPresencePenalty');
  forbidNear(text.geminiCodec, paths.geminiCodec, '"request.generationConfig.responseLogprobs"', 'ChatTopLogprobs');
  forbidNear(text.geminiCodec, paths.geminiCodec, '"request.generationConfig.logprobs"', 'ChatLogprobs');
  forbidNear(text.geminiCodec, paths.geminiCodec, '"request.generationConfig.seed"', 'ChatTopLogprobs');
  for (const testSymbol of [
    'gemini_generation_config_temperature_maps_to_chat_temperature',
    'gemini_generation_config_top_p_maps_to_chat_top_p',
    'gemini_generation_config_top_k_maps_to_chat_top_k_extension',
    'gemini_generation_config_max_output_tokens_maps_to_chat_max_completion_tokens',
    'gemini_generation_config_stop_sequences_maps_to_chat_stop',
    'gemini_generation_config_frequency_penalty_maps_to_chat_frequency_penalty',
    'gemini_generation_config_presence_penalty_maps_to_chat_presence_penalty',
    'gemini_generation_config_response_logprobs_maps_to_chat_logprobs_request',
    'gemini_generation_config_logprobs_maps_to_chat_top_logprobs_count',
    'gemini_generation_config_seed_maps_to_chat_seed',
    'gemini_generation_config_penalties_logprobs_and_seed_do_not_collapse',
    'gemini_generation_config_scalar_malformed_fields_fail_closed',
    'gemini_generation_config_scalar_semantics_do_not_mutate_provider_wire_payload',
  ]) requireText(text.geminiTests, paths.geminiTests, testSymbol);
  for (const [owner, body] of [[paths.mainlineMap, text.mainlineMap], [paths.functionMap, text.functionMap], [paths.verificationMap, text.verificationMap]]) {
    for (const phrase of ['v3-protocol-gemini-generation-config-scalar-01', 'collect_v3_gemini_request_generation_config_scalar_semantics']) requireText(body, owner, phrase);
  }
}

function groupProtocolFields(group, protocol) {
  const mapping = group?.protocol_mappings?.[protocol] ?? {};
  return [...(mapping.request_fields ?? []), ...(mapping.response_fields ?? [])];
}

function requireGroupFields(byId, groupId, standardChatField, expectedByProtocol) {
  const group = byId.get(groupId);
  if (!group) return;
  if (group.standard_chat_field !== standardChatField) {
    failures.push(`${paths.fieldMatrix}: ${groupId} must use standard_chat_field ${standardChatField}, got ${group.standard_chat_field}`);
  }
  for (const [protocol, fields] of Object.entries(expectedByProtocol)) {
    const actual = new Set(groupProtocolFields(group, protocol));
    for (const field of fields) {
      if (!actual.has(field)) failures.push(`${paths.fieldMatrix}: ${groupId} missing ${protocol} semantic field ${field}`);
    }
  }
}

function forbidGroupFields(byId, groupId, forbiddenByProtocol) {
  const group = byId.get(groupId);
  if (!group) return;
  for (const [protocol, fields] of Object.entries(forbiddenByProtocol)) {
    const actual = new Set(groupProtocolFields(group, protocol));
    for (const field of fields) {
      if (actual.has(field)) failures.push(`${paths.fieldMatrix}: ${groupId} must not collapse ${protocol}.${field}`);
    }
  }
}

function requireSupersetRowFields(matrix, standardChatField, expectedByProtocol) {
  const row = supersetRowByField(matrix, standardChatField);
  if (!row) return;
  for (const [protocol, fields] of Object.entries(expectedByProtocol)) {
    const actual = new Set(row?.equivalent_fields?.[protocol] ?? []);
    for (const field of fields) {
      if (!actual.has(field)) failures.push(`${paths.fieldMatrix}: superset ${standardChatField} missing ${protocol}.${field}`);
    }
  }
}

function forbidSupersetRowFields(matrix, standardChatField, forbiddenByProtocol) {
  const row = supersetRowByField(matrix, standardChatField);
  if (!row) return;
  for (const [protocol, fields] of Object.entries(forbiddenByProtocol)) {
    const actual = new Set(row?.equivalent_fields?.[protocol] ?? []);
    for (const field of fields) {
      if (actual.has(field)) failures.push(`${paths.fieldMatrix}: superset ${standardChatField} must not collapse ${protocol}.${field}`);
    }
  }
}

function supersetRowByField(matrix, standardChatField) {
  const row = (matrix?.extended_openai_chat_semantic_superset?.fields ?? []).find((candidate) => candidate?.extended_openai_chat_field === standardChatField);
  if (!row) failures.push(`${paths.fieldMatrix}: missing superset field ${standardChatField}`);
  return row;
}

function requireExtendedOpenAiChatSemanticSuperset(matrix) {
  const superset = matrix?.extended_openai_chat_semantic_superset;
  if (!superset) {
    failures.push(`${paths.fieldMatrix}: missing extended_openai_chat_semantic_superset`);
    return;
  }
  if (superset.standard_protocol !== 'openai_chat') {
    failures.push(`${paths.fieldMatrix}: extended_openai_chat_semantic_superset.standard_protocol must be openai_chat`);
  }
  for (const phrase of ['OpenAI Chat plus extension fields', 'all source_inventory fields', 'MetadataCenter/raw payload dump']) {
    if (!String(superset.contract ?? superset.coverage_rule ?? superset.duplicate_rule ?? '').includes(phrase) && !JSON.stringify(superset).includes(phrase)) {
      failures.push(`${paths.fieldMatrix}: extended_openai_chat_semantic_superset missing contract phrase ${phrase}`);
    }
  }
  const rows = superset.fields;
  if (!Array.isArray(rows) || rows.length < 100) {
    failures.push(`${paths.fieldMatrix}: extended_openai_chat_semantic_superset.fields must be a full source-field superset`);
    return;
  }
  const allowedStatuses = new Set(['mapped', 'extension_added', 'edge_only', 'unsupported_blocked']);
  const semanticIds = new Map();
  const extendedFields = new Map();
  const sourceCoverage = new Map();
  const openAiSourceFields = collectSourceInventoryFields(matrix, 'openai_chat');
  for (const [index, row] of rows.entries()) {
    for (const key of ['extended_openai_chat_field', 'semantic_id', 'direction', 'mapping_status', 'semantic_owner', 'current_impl', 'equivalent_fields']) {
      if (row?.[key] == null) failures.push(`${paths.fieldMatrix}: superset.fields[${index}] missing ${key}`);
    }
    if (!allowedStatuses.has(row?.mapping_status)) failures.push(`${paths.fieldMatrix}: superset.fields[${index}] invalid mapping_status ${row?.mapping_status}`);
    addUnique(semanticIds, row?.semantic_id, `duplicate semantic_id ${row?.semantic_id}`);
    addUnique(extendedFields, row?.extended_openai_chat_field, `duplicate extended_openai_chat_field ${row?.extended_openai_chat_field}`);
    if (row?.semantic_id !== row?.extended_openai_chat_field) {
      failures.push(`${paths.fieldMatrix}: canonical semantic_id must equal the OpenAI Chat field/extension path: ${row?.semantic_id} != ${row?.extended_openai_chat_field}`);
    }
    if (/^(chat_native|chat_extension)\./u.test(String(row?.semantic_id ?? ''))) {
      failures.push(`${paths.fieldMatrix}: canonical semantic_id must not use generated chat_native/chat_extension namespace: ${row?.semantic_id}`);
    }
    if (/MetadataCenter|metadata_center|raw_payload|raw payload dump/i.test(String(row?.semantic_owner ?? ''))) {
      failures.push(`${paths.fieldMatrix}: business semantic owner must not be MetadataCenter/raw payload dump: ${row?.semantic_id}`);
    }
    if (/chat\.extensions\.openai_chat/i.test(String(row?.semantic_owner ?? ''))) {
      failures.push(`${paths.fieldMatrix}: OpenAI Chat native/extension semantic owner must not use chat.extensions.openai_chat namespace: ${row?.semantic_id}`);
    }
    if (!/^(request|response|edge)\./u.test(String(row?.extended_openai_chat_field ?? ''))) {
      failures.push(`${paths.fieldMatrix}: extended OpenAI Chat field must be top-level request./response./edge. field: ${row?.extended_openai_chat_field}`);
    }
    if (/openai_chat\.ext|\.responses\.|\.anthropic\.|\.gemini\.|^responses\.|^anthropic\.|^gemini\./u.test(String(row?.extended_openai_chat_field ?? ''))) {
      failures.push(`${paths.fieldMatrix}: extended OpenAI Chat field must not contain source protocol namespace: ${row?.extended_openai_chat_field}`);
    }
    const openAiNativeFields = row?.equivalent_fields?.openai_chat ?? [];
    const mapsToOpenAiNative = Array.isArray(openAiNativeFields) && openAiNativeFields.includes(row?.extended_openai_chat_field);
    if (Array.isArray(openAiNativeFields) && openAiNativeFields.length > 0 && !mapsToOpenAiNative) {
      failures.push(`${paths.fieldMatrix}: OpenAI Chat native field must not be renamed: ${row?.semantic_id} uses ${row?.extended_openai_chat_field} but native fields are ${openAiNativeFields.join(', ')}`);
    }
    if (mapsToOpenAiNative && row?.mapping_status === 'extension_added') {
      failures.push(`${paths.fieldMatrix}: OpenAI Chat native field must be mapped, not extension_added: ${row?.extended_openai_chat_field}`);
    }
    if (!mapsToOpenAiNative && openAiSourceFields.has(row?.extended_openai_chat_field)) {
      failures.push(`${paths.fieldMatrix}: OpenAI Chat source field appears without exact native equivalent row: ${row?.extended_openai_chat_field}`);
    }
    if (!mapsToOpenAiNative && row?.mapping_status === 'mapped') {
      failures.push(`${paths.fieldMatrix}: added Chat extension field must not use mapping_status=mapped without native OpenAI Chat equivalent: ${row?.extended_openai_chat_field}`);
    }
    if (row?.mapping_status === 'extension_added' && !String(row?.semantic_owner ?? '').startsWith('chat.')) {
      failures.push(`${paths.fieldMatrix}: extension_added row must have chat.* owner: ${row?.semantic_id}`);
    }
    if (row?.mapping_status === 'edge_only' && !String(row?.semantic_owner ?? '').startsWith('edge.')) {
      failures.push(`${paths.fieldMatrix}: edge_only row must have edge.* owner: ${row?.semantic_id}`);
    }
    for (const protocol of ['responses', 'openai_chat', 'anthropic', 'gemini']) {
      const fields = row?.equivalent_fields?.[protocol];
      if (!Array.isArray(fields)) failures.push(`${paths.fieldMatrix}: ${row?.semantic_id}.equivalent_fields.${protocol} must be an array`);
      for (const field of fields ?? []) {
        const key = `${protocol}\u0000${field}`;
        if (!sourceCoverage.has(key)) sourceCoverage.set(key, []);
        sourceCoverage.get(key).push(row?.semantic_id);
      }
    }
  }
  for (const protocol of ['responses', 'openai_chat', 'anthropic', 'gemini']) {
    const sourceFields = collectSourceInventoryFields(matrix, protocol);
    const declaredCount = superset?.source_field_counts?.[protocol];
    if (declaredCount !== sourceFields.size) failures.push(`${paths.fieldMatrix}: source_field_counts.${protocol} must equal ${sourceFields.size}`);
    for (const field of sourceFields) {
      const key = `${protocol}\u0000${field}`;
      const hits = sourceCoverage.get(key) ?? [];
      if (hits.length !== 1) failures.push(`${paths.fieldMatrix}: source field ${protocol}.${field} mapped to superset ${hits.length} times (${hits.join(', ')})`);
      const bucket = classificationBucketForField(matrix, protocol, field);
      const row = rows.find((candidate) => candidate?.equivalent_fields?.[protocol]?.includes(field));
      if (!row) continue;
      if (row.source_classification) {
        const mapsToOpenAiNative = Array.isArray(row?.equivalent_fields?.openai_chat) && row.equivalent_fields.openai_chat.includes(row.extended_openai_chat_field);
        if (bucket === 'edge_only_fields' && row.mapping_status !== 'edge_only') failures.push(`${paths.fieldMatrix}: ${protocol}.${field} must be edge_only`);
        if (bucket === 'unsupported_or_lossy_fields' && row.mapping_status !== 'unsupported_blocked') failures.push(`${paths.fieldMatrix}: ${protocol}.${field} must be unsupported_blocked`);
        if (bucket === 'protocol_specific_chat_extension_fields' && !mapsToOpenAiNative && row.mapping_status !== 'extension_added') failures.push(`${paths.fieldMatrix}: ${protocol}.${field} must be extension_added when no OpenAI Chat native field exists`);
        const extensionIds = extensionIdsForField(matrix, protocol, field);
        if (protocol !== 'openai_chat' && extensionIds.length > 0) {
          const actualIds = new Set((row.chat_extension_association ?? []).map((item) => item?.extension_id).filter(Boolean));
          for (const extensionId of extensionIds) {
            if (!actualIds.has(extensionId)) failures.push(`${paths.fieldMatrix}: ${protocol}.${field} missing Chat extension association ${extensionId}`);
          }
        }
      }
    }
    for (const [key, hits] of sourceCoverage.entries()) {
      const [coveredProtocol, field] = key.split('\u0000');
      if (coveredProtocol === protocol && !sourceFields.has(field)) failures.push(`${paths.fieldMatrix}: superset maps unknown source field ${protocol}.${field}`);
    }
  }
  const extendedFieldSet = new Set(rows.map((row) => row?.extended_openai_chat_field));
  for (const field of collectSourceInventoryFields(matrix, 'openai_chat')) {
    if (!extendedFieldSet.has(field)) failures.push(`${paths.fieldMatrix}: every OpenAI Chat source field must appear unchanged as a Chat Process field: ${field}`);
  }
}

function addUnique(map, key, message) {
  if (!key) return;
  if (map.has(key)) failures.push(`${paths.fieldMatrix}: ${message}`);
  map.set(key, true);
}
function collectSourceInventoryFields(matrix, protocol) {
  const fields = new Set();
  for (const rows of Object.values(matrix?.source_inventory?.[protocol] ?? {})) {
    if (Array.isArray(rows)) for (const row of rows) fields.add(row);
  }
  return fields;
}
function extensionIdsForField(matrix, protocol, field) {
  const ids = [];
  for (const [extensionId, extension] of Object.entries(matrix?.protocol_specific_chat_extensions?.[protocol] ?? {})) {
    if ((extension?.field_paths ?? []).includes(field)) ids.push(extensionId);
  }
  return ids;
}

function classificationBucketForField(matrix, protocol, field) {
  for (const bucket of ['canonical_chat_fields', 'protocol_specific_chat_extension_fields', 'edge_only_fields', 'unsupported_or_lossy_fields']) {
    if ((matrix?.field_classification?.[protocol]?.[bucket] ?? []).includes(field)) return bucket;
  }
  return 'unclassified';
}

function requireText(source, owner, phrase) {
  if (!source.includes(phrase)) failures.push(`${owner}: missing ${phrase}`);
}
function requireNear(source, owner, anchor, phrase, window = 260) {
  const index = source.indexOf(anchor);
  if (index < 0) {
    failures.push(`${owner}: missing ${anchor}`);
    return;
  }
  const segment = source.slice(index, index + window);
  if (!segment.includes(phrase)) failures.push(`${owner}: ${anchor} must map near ${phrase}`);
}
function forbidNear(source, owner, anchor, phrase, window = 260) {
  const index = source.indexOf(anchor);
  if (index < 0) {
    failures.push(`${owner}: missing ${anchor}`);
    return;
  }
  const segment = source.slice(index, index + window);
  if (segment.includes(phrase)) failures.push(`${owner}: ${anchor} must not collapse near ${phrase}`);
}
function forbid(source, owner, patterns) {
  for (const pattern of patterns) if (pattern.test(source)) failures.push(`${owner}: forbidden ${pattern}`);
}
function requireOrder(source, owner, phrases) {
  let cursor = 0;
  for (const phrase of phrases) {
    const index = source.indexOf(phrase, cursor);
    if (index < 0) {
      failures.push(`${owner}: missing or reordered ${phrase}`);
      return;
    }
    cursor = index + phrase.length;
  }
}
function functionSlice(source, owner, start, end) {
  const startIndex = source.indexOf(start);
  if (startIndex < 0) {
    failures.push(`${owner}: missing ${start}`);
    return '';
  }
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (endIndex < 0) return source.slice(startIndex);
  return source.slice(startIndex, endIndex);
}
function featureBlock(source, marker) {
  const start = source.indexOf(marker);
  if (start < 0) {
    failures.push(`feature block missing ${marker}`);
    return '';
  }
  // function map 的顶层 feature 项是 0 缩进（`- feature_id:`）；下一个
  // feature 用 0 或 2 空格缩进都算作块边界。
  let next = -1;
  for (const candidate of ['\n- feature_id:', '\n  - feature_id:']) {
    const found = source.indexOf(candidate, start + marker.length);
    if (found >= 0 && (next < 0 || found < next)) {
      next = found;
    }
  }
  return next < 0 ? source.slice(start) : source.slice(start, next);
}
function sectionSlice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start < 0) return '';
  const end = source.indexOf(endMarker, start + startMarker.length);
  return end < 0 ? source.slice(start) : source.slice(start, end);
}

  return {
    requireMatrixProtocols,
    requireMatrixFields,
    requireInventoryFields,
    requireExtensionFields,
    requireClassificationCoversSourceInventory,
    requireSemanticCorrespondence,
    requireNoPendingAuditStatus,
    requireCanonicalExtensionRegistry,
    requireAuditTruthContract,
    currentImplCounts,
    walkCurrentImpl,
    requireManualSemanticTranslationGroups,
    requireShapeBranchTransformContract,
    requireShapeCaseProtocols,
    requireShapeCaseFields,
    requireGeminiToolConfigSemanticContract,
    requireGeminiThinkingConfigSemanticContract,
    requireGeminiGenerationConfigScalarSemanticContract,
    groupProtocolFields,
    requireGroupFields,
    forbidGroupFields,
    requireSupersetRowFields,
    forbidSupersetRowFields,
    supersetRowByField,
    requireExtendedOpenAiChatSemanticSuperset,
    addUnique,
    collectSourceInventoryFields,
    extensionIdsForField,
    classificationBucketForField,
    requireText,
    requireNear,
    forbidNear,
    forbid,
    requireOrder,
    functionSlice,
    sectionSlice,
    featureBlock,
  };
}
