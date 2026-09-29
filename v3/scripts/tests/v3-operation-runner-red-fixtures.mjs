#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const verifyRel = 'v3/scripts/architecture/verify-v3-operation-runner-dagpipe.mjs';
const verifyScript = path.join(repo, verifyRel);
const files = [
  'docs/architecture/dagpipe/v3.operation_runner.request.graph.json',
  'docs/architecture/dagpipe/v3.operation_runner.response.graph.json',
  'docs/architecture/dagpipe/v3.operation_runner.error.graph.json',
  'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml',
  'docs/architecture/manifests/v3.operation_runner.lifecycle.manifest.yml',
  'docs/architecture/manifests/error.mainline.yml',
  'docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml',
  'docs/architecture/v3-mainline-call-map.yml',
  'docs/architecture/v3-resource-operation-map.yml',
  'docs/architecture/v3-function-map.yml',
  'docs/architecture/v3-verification-map.yml',
  'v3/crates/routecodex-v3-server/src/endpoint_handlers.rs',
  'v3/crates/routecodex-v3-server/src/websocket.rs',
];

const mutations = [
  {
    name: 'runtime-bound-capture-missing-http-call',
    mutate(tmp) {
      const file = path.join(tmp, 'v3/crates/routecodex-v3-server/src/endpoint_handlers.rs');
      const source = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(file, source.replace('execute_v3_operation_runner_request_capture_client_json(payload)', 'missing_capture_client_json(payload)'));
    },
    expect: /capture_client_json must be called exactly once before Direct\/Relay dispatch/u,
  },
  {
    name: 'runtime-bound-capture-missing-websocket-call',
    mutate(tmp) {
      const file = path.join(tmp, 'v3/crates/routecodex-v3-server/src/websocket.rs');
      const source = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(file, source.replace('execute_v3_operation_runner_request_capture_client_json(payload)', 'missing_capture_client_json(payload)'));
    },
    expect: /capture_client_json must be called exactly once before Direct\/Relay dispatch/u,
  },
  {
    name: 'unmatched-business-value-loses-opaque-inverse',
    mutate(tmp) {
      const file = path.join(tmp, 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml');
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      doc.business_unmatched_value.preserve = 'discard_unmapped_value';
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /unmatched business values must preserve the original value and inverse association without local rejection/u,
  },
  {
    name: 'unrepresentable-request-value-leaks-into-control-resource',
    mutate(tmp) {
      const file = path.join(tmp, 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml');
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      doc.field_walker.error_contract.unrepresentable_request = 'preserve original value in request inverse context';
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /unrepresentable_request must keep business value in the Chat extension/u,
  },
  {
    name: 'business-conflict-restores-local-rejection-policy',
    mutate(tmp) {
      const file = path.join(tmp, 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml');
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      doc.path_consumers.find((row) => row.protocol === 'responses' && row.path === 'request.max_output_tokens')
        .params.direction_bindings.chat_to_provider.collision_policy = 'reject_conflicting_max_output_tokens';
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /obsolete local business rejection policy reject_conflicting_max_output_tokens/u,
  },
  {
    name: 'anthropic-source-type-document-base64-missing-branch',
    mutate(tmp) {
      const file = path.join(tmp, 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml');
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const row = doc.path_consumers.find((item) => item.protocol === 'anthropic'
        && item.section === 'content_block_fields'
        && item.path === 'request.messages[].content[].source.type');
      if (!row) throw new Error('missing Anthropic source.type row');
      row.typed_discriminator_cases.cases = row.typed_discriminator_cases.cases.filter((entry) =>
        !(entry.type_value === 'document' && entry.predicates?.some((predicate) =>
          predicate.path === 'request.messages[].content[].source.type' && predicate.value === 'base64')));
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /Anthropic source.type must distinguish document\/base64/u,
  },
  ...[
    ['url', 'image', 'url', 'request.messages[].content[].media.inline_data'],
    ['data', 'image', 'base64', 'request.messages[].content[].image_url.url'],
    ['data', 'document', 'base64', 'request.messages[].content[].media.inline_data'],
  ].map(([member, contentType, sourceType, forbiddenSemantic]) => ({
    name: `anthropic-media-${contentType}-${sourceType}-${member}-wrong-target`,
    mutate(tmp) {
      const file = path.join(tmp, 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml');
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const row = doc.path_consumers.find((item) => item.protocol === 'anthropic'
        && item.section === 'content_block_fields'
        && item.path === `request.messages[].content[].source.${member}`);
      if (!row) throw new Error(`missing Anthropic media row ${member}`);
      const branch = row.typed_discriminator_cases.cases.find((entry) => entry.type_value === contentType
        && entry.predicates?.some((predicate) => predicate.path === 'request.messages[].content[].source.type'
          && predicate.value === sourceType));
      if (!branch) throw new Error(`missing Anthropic media branch ${contentType}/${sourceType}`);
      branch.semantic_id = forbiddenSemantic;
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /Anthropic media .* must (map|not map) /u,
  })),
  ...[
    ['url', 'image', 'url'],
    ['data', 'image', 'base64'],
    ['data', 'document', 'base64'],
  ].map(([member, contentType, sourceType]) => ({
    name: `anthropic-media-${contentType}-${sourceType}-${member}-missing-branch`,
    mutate(tmp) {
      const file = path.join(tmp, 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml');
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const row = doc.path_consumers.find((item) => item.protocol === 'anthropic'
        && item.section === 'content_block_fields'
        && item.path === `request.messages[].content[].source.${member}`);
      if (!row) throw new Error(`missing Anthropic media row ${member}`);
      row.typed_discriminator_cases.cases = row.typed_discriminator_cases.cases.filter((entry) =>
        entry.type_value !== contentType || !entry.predicates?.some((predicate) =>
          predicate.path === 'request.messages[].content[].source.type' && predicate.value === sourceType));
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /Anthropic media .* must map /u,
  })),
  ...[
    ['content_block_fields', 'request.messages[].content[].input', 'server_tool_use'],
    ['content_block_fields', 'request.messages[].content[].tool_use_id', 'web_search_tool_result'],
    ['response_fields', 'response.content[].id', 'server_tool_use'],
    ['response_fields', 'response.content[].name', 'server_tool_use'],
    ['response_fields', 'response.content[].input', 'server_tool_use'],
    ['response_fields', 'response.content[].tool_use_id', 'web_search_tool_result'],
    ['response_fields', 'response.content[].content', 'web_search_tool_result'],
  ].map(([section, rawPath, typeValue]) => ({
    name: `anthropic-hosted-tool-${rawPath}-${typeValue}`,
    mutate(tmp) {
      const file = path.join(tmp, 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml');
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const row = doc.path_consumers.find((item) => item.protocol === 'anthropic'
        && item.section === section && item.path === rawPath);
      if (!row) throw new Error(`missing Anthropic hosted tool row ${rawPath}`);
      row.typed_discriminator_cases.cases = row.typed_discriminator_cases.cases.filter(
        (entry) => entry.type_value !== typeValue,
      );
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /Anthropic hosted tool .* must accept /u,
  })),
  {
    name: 'generic-arc-schema',
    mutate(tmp) {
      const rel = 'docs/architecture/dagpipe/v3.operation_runner.request.graph.json';
      const file = path.join(tmp, rel);
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      delete parsed.inputs[0].schema_ref;
      fs.writeFileSync(file, JSON.stringify(parsed, null, 2));
    },
    expect: /missing schema_ref/u,
  },
  {
    name: 'unknown-schema-ref',
    mutate(tmp) {
      const rel = 'docs/architecture/dagpipe/v3.operation_runner.request.graph.json';
      const file = path.join(tmp, rel);
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      parsed.inputs[0].schema_ref = 'v3.operation_runner.arc.unknown';
      fs.writeFileSync(file, JSON.stringify(parsed, null, 2));
    },
    expect: /not in project arc_schema_registry/u,
  },
  {
    name: 'raw-arc-inline-schema-mismatch',
    mutate(tmp) {
      const file = path.join(tmp, 'docs/architecture/dagpipe/v3.operation_runner.request.graph.json');
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      parsed.inputs[0].schema = 'Object';
      fs.writeFileSync(file, JSON.stringify(parsed, null, 2));
    },
    expect: /inline schema does not match arc_schema_registry/u,
  },
  {
    name: 'semantic-arc-any-rejected',
    mutate(tmp) {
      const file = path.join(tmp, 'docs/architecture/dagpipe/v3.operation_runner.request.graph.json');
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      parsed.nodes[1].output.schema = 'Any';
      fs.writeFileSync(file, JSON.stringify(parsed, null, 2));
    },
    expect: /uses generic Any schema/u,
  },
  {
    name: 'anthropic-synthetic-block-type-source-path',
    mutate(tmp) {
      const file = path.join(tmp, 'docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml');
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      doc.source_inventory.anthropic.content_block_fields.push('request.messages[].content[].tool_use.id');
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /contains a synthetic block-type segment/u,
  },
  {
    name: 'anthropic-thinking-signature-wrong-branch',
    mutate(tmp) {
      const file = path.join(tmp, 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml');
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const row = doc.path_consumers.find((item) => item.protocol === 'anthropic'
        && item.section === 'response_fields' && item.path === 'response.content[].signature');
      if (!row) throw new Error('missing Anthropic response signature row');
      row.typed_discriminator_cases.cases[0].type_value = 'redacted_thinking';
      row.typed_discriminator_cases.cases[0].predicates[0].value = 'redacted_thinking';
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /signature must be limited to thinking blocks/u,
  },
  {
    name: 'unknown-operator-version',
    mutate(tmp) {
      const rel = 'docs/architecture/dagpipe/v3.operation_runner.response.graph.json';
      const file = path.join(tmp, rel);
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      parsed.nodes[0].operator_version = '99';
      fs.writeFileSync(file, JSON.stringify(parsed, null, 2));
    },
    expect: /not in field profile operator_registry/u,
  },
  {
    name: 'bad-typed-param',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      for (const entry of doc.operator_registry.nodes) {
        if (entry.operator === 'routecodex.v3.operation.resolve_target') {
          entry.params.route_target = true;
        }
      }
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /is not a typed parameter/u,
  },
  {
    name: 'missing-path-binding',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const target = `${doc.contract_id ?? 'v3.operation_runner.field_profiles'}`;
      doc.path_consumers = doc.path_consumers.filter(
        (row) => !(row.protocol === 'responses' && row.section === 'request_fields' && row.path === 'request.background'),
      );
      if (doc.path_consumers.length === 0) throw new Error(`path_consumers emptied for ${target}`);
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /matrix path responses:request_fields:request.background has no path_consumer binding/u,
  },
  {
    name: 'duplicate-path-binding',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const firstResponses = doc.path_consumers.find(
        (row) => row.protocol === 'responses' && row.section === 'request_fields' && row.path === 'request.background',
      );
      if (!firstResponses) throw new Error('missing responses request.background path row');
      doc.path_consumers.push({ ...firstResponses, mapping_record: 'duplicate' });
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /duplicate path_consumer binding/u,
  },
  {
    name: 'overlapping-path-binding',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const source = doc.path_consumers.find(
        (row) => row.protocol === 'responses' && row.section === 'input_fields' && row.path === 'request.input[].id',
      );
      if (!source) throw new Error('missing responses input_fields request.input[].id path row');
      doc.path_consumers.push({ ...source, path: 'request.input[]', mapping_record: 'overlapping-unproven' });
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /parent-child overlap|overlaps a proven matrix path without a source row/u,
  },
  {
    name: 'unregistered-fold',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      doc.fold_contract.registered_folds[0].operator = 'routecodex.v3.field.unknown';
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /not in operator_registry or field_operator_library/u,
  },
  {
    name: 'unknown-finalize-operator',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      doc.fold_contract.registered_folds[0].finalize_operator = 'routecodex.v3.field.unknown@1';
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /not in operator_registry or field_operator_library/u,
  },
  {
    name: 'unknown-schema-type',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      doc.arc_schema_registry.schemas[0].schema = 'ObjectX';
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /not a DAGpipe SDK ValueType/u,
  },
  {
    name: 'unknown-field-operator',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const first = doc.path_consumers[0];
      first.consumers.client_request_to_chat = 'routecodex.v3.field.unknown@1';
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /not a registered field_operator_library entry/u,
  },
  {
    name: 'missing-nested-or-array-child',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      doc.path_consumers = doc.path_consumers.filter(
        (row) => !(row.protocol === 'responses' && row.section === 'input_fields' && row.path === 'request.input[].id'),
      );
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /matrix path responses:input_fields:request.input\[\]\.id has no path_consumer binding/u,
  },
  {
    name: 'missing-required-direction-binding',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const row = doc.path_consumers.find(
        (item) => item.protocol === 'responses' && item.section === 'request_fields' && item.path === 'request.background',
      );
      if (!row) throw new Error('missing responses request.background path row');
      delete row.consumers.chat_to_provider;
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /missing required consumer direction chat_to_provider/u,
  },
  {
    name: 'wrong-direction-mapping',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const row = doc.path_consumers.find(
        (item) => item.protocol === 'responses' && item.section === 'response_fields' && item.path === 'response.id',
      );
      if (!row) throw new Error('missing responses response.id path row');
      row.consumers.client_request_to_chat = row.consumers.provider_response_to_chat;
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /declares wrong direction/u,
  },
  {
    name: 'duplicate-normalized-path-binding',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const source = doc.path_consumers.find(
        (row) => row.protocol === 'gemini' && row.section === 'request_fields' && row.path === 'request.toolConfig.functionCallingConfig.allowedFunctionNames',
      );
      if (!source) throw new Error('missing gemini allowedFunctionNames row');
      doc.path_consumers.push({ ...source, section: 'tool_fields', mapping_record: 'duplicate-normalized' });
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /duplicate normalized path_consumer binding/u,
  },
  {
    name: 'parent-child-overlap',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const child = doc.path_consumers.find(
        (row) => row.protocol === 'responses' && row.section === 'input_fields' && row.path === 'request.input[].id',
      );
      if (!child) throw new Error('missing responses input_fields request.input[].id row');
      doc.path_consumers.push({ ...child, path: 'request.input[]', mapping_record: 'parent-child-overlap' });
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /parent-child overlap|unknown path_consumer binding/u,
  },
  {
    name: 'unknown-extra-path-binding',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const first = doc.path_consumers[0];
      doc.path_consumers.push({ ...first, path: 'request.unknown_semantic_field' });
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /unknown path_consumer binding responses:request_fields:request\.unknown_semantic_field/u,
  },
  {
    name: 'missing-typed-param-shape',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const first = doc.path_consumers.find((row) => row.protocol === 'responses' && row.section === 'request_fields' && row.path === 'request.background');
      if (!first) throw new Error('missing responses request.background row');
      delete first.params.shape;
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /missing typed param shape/u,
  },
  {
    name: 'wrong-tool-argument-operator',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const row = doc.path_consumers.find(
        (r) => r.protocol === 'responses' && r.section === 'input_fields' && r.path === 'request.input[].arguments',
      );
      if (!row) throw new Error('missing responses request.input[].arguments row');
      row.consumers.client_request_to_chat = 'routecodex.v3.field.tool_identity_context@1';
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /must use routecodex.v3.field.opaque_tool_payload@1/u,
  },
  {
    name: 'anthropic-response-tool-input-not-opaque',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const row = doc.path_consumers.find(
        (r) => r.protocol === 'anthropic' && r.section === 'response_fields' && r.path === 'response.content[].input',
      );
      if (!row) throw new Error('missing anthropic response.content[].input row');
      row.consumers.provider_response_to_chat = 'routecodex.v3.field.provider_normalization@1';
      row.consumers.chat_to_client_response = 'routecodex.v3.field.inverse_client_projection@1';
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /must use routecodex.v3.field.opaque_tool_payload@1/u,
  },
  {
    name: 'tool-identity-consuming-output',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const row = doc.extension_path_consumers.find(
        (r) => r.path === 'request.messages[].tool_result.output',
      );
      if (!row) throw new Error('missing extension tool_result.output row');
      row.consumers.client_request_to_chat = 'routecodex.v3.field.tool_identity_context@1';
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /must use routecodex.v3.field.opaque_tool_payload@1/u,
  },
  {
    name: 'bad-extension-alias-missing',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const row = doc.extension_path_consumers.find((r) => r.path === 'request.audio.format');
      if (!row) throw new Error('missing extension request.audio.format alias');
      delete row.alias_of;
      row.consumers = {
        client_request_to_chat: 'routecodex.v3.field.identity_preserve@1',
        chat_to_provider: 'routecodex.v3.field.request_field_whitelist@1',
      };
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /duplicates standard binding; set alias_of/u,
  },
  {
    name: 'bad-extension-alias-with-consumers',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const row = doc.extension_path_consumers.find((r) => r.path === 'request.audio.format');
      if (!row) throw new Error('missing extension request.audio.format alias');
      row.consumers = {
        client_request_to_chat: 'routecodex.v3.field.identity_preserve@1',
        chat_to_provider: 'routecodex.v3.field.request_field_whitelist@1',
      };
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /must not declare consumers/u,
  },
  {
    name: 'structure-only-without-parent-owned',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const row = doc.path_consumers.find((r) => r.structure_only === true && r.parent_owned === true);
      if (!row) throw new Error('missing structure_only row');
      delete row.parent_owned;
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /structure_only row must set parent_owned true/u,
  },
  {
    name: 'missing-error-resource-edge',
    mutate(tmp) {
      const rel = 'docs/architecture/dagpipe/v3.operation_runner.error.graph.json';
      const file = path.join(tmp, rel);
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const node = parsed.nodes.find((item) => item.id === 'error_err01_source_raised');
      if (!node) throw new Error('missing error_err01_source_raised node');
      node.resources.writes = node.resources.writes.filter((resource) => resource !== 'v3.error.chain');
      fs.writeFileSync(file, JSON.stringify(parsed, null, 2));
    },
    expect: /node error_err01_source_raised typed resources mismatch/u,
  },
  {
    name: 'extra-error-resource-edge',
    mutate(tmp) {
      const rel = 'docs/architecture/dagpipe/v3.operation_runner.error.graph.json';
      const file = path.join(tmp, rel);
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const node = parsed.nodes.find((item) => item.id === 'error_err02_host_captured');
      if (!node) throw new Error('missing error_err02_host_captured node');
      node.resources.reads.push('v3.error.unknown_resource');
      fs.writeFileSync(file, JSON.stringify(parsed, null, 2));
    },
    expect: /node error_err02_host_captured typed resources mismatch/u,
  },
  {
    name: 'capture-reads-metadata-center',
    mutate(tmp) {
      const rel = 'docs/architecture/dagpipe/v3.operation_runner.request.graph.json';
      const file = path.join(tmp, rel);
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const node = parsed.nodes.find((item) => item.id === 'capture_client_json');
      if (!node) throw new Error('missing capture_client_json node');
      node.resources.reads.push('v3.operation_runner.metadata_center_control');
      fs.writeFileSync(file, JSON.stringify(parsed, null, 2));
    },
    expect: /capture_client_json must not access v3\.operation_runner\.metadata_center_control/u,
  },
  {
    name: 'capture-writes-request-origin',
    mutate(tmp) {
      const rel = 'docs/architecture/dagpipe/v3.operation_runner.request.graph.json';
      const file = path.join(tmp, rel);
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const node = parsed.nodes.find((item) => item.id === 'capture_client_json');
      if (!node) throw new Error('missing capture_client_json node');
      node.resources.writes.push('v3.operation_runner.request_origin_kind');
      fs.writeFileSync(file, JSON.stringify(parsed, null, 2));
    },
    expect: /capture_client_json must not access v3\.operation_runner\.request_origin_kind/u,
  },
  {
    name: 'capture-slice-missing',
    mutate(tmp) {
      const rel = 'docs/architecture/v3-mainline-call-map.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const chain = doc.chains.find((item) => item.chain_id === 'v3.operation_runner.dagpipe.request');
      if (!chain) throw new Error('missing v3.operation_runner.dagpipe.request chain');
      delete chain.entry_contract.first_delivery_binding.dagpipe_slice;
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /first delivery missing deterministic capture DAGpipe slice contract/u,
  },
  {
    name: 'capture-slice-arc-mismatch',
    mutate(tmp) {
      const rel = 'docs/architecture/dagpipe/v3.operation_runner.request.graph.json';
      const file = path.join(tmp, rel);
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const node = parsed.nodes.find((item) => item.id === 'capture_client_json');
      if (!node) throw new Error('missing capture_client_json node');
      node.inputs = ['bad-request'];
      node.output.id = 'bad-json';
      fs.writeFileSync(file, JSON.stringify(parsed, null, 2));
    },
    expect: /capture dagpipe_slice must preserve the canonical node input\/output ARC contract/u,
  },
  {
    name: 'missing-capture-normalize-edge',
    mutate(tmp) {
      const rel = 'docs/architecture/dagpipe/v3.operation_runner.request.graph.json';
      const file = path.join(tmp, rel);
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      parsed.edges = parsed.edges.filter(
        (edge) => !(edge?.from === 'capture_client_json' && edge?.to === 'normalize_request_losslessly'),
      );
      fs.writeFileSync(file, JSON.stringify(parsed, null, 2));
    },
    expect: /missing or malformed capture_client_json -> normalize_request_losslessly edge \(arc client-json\)/u,
  },
  {
    name: 'capture-normalize-arc-id-mismatch',
    mutate(tmp) {
      const rel = 'docs/architecture/dagpipe/v3.operation_runner.request.graph.json';
      const file = path.join(tmp, rel);
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const edge = parsed.edges.find(
        (item) => item.from === 'capture_client_json' && item.to === 'normalize_request_losslessly',
      );
      if (!edge) throw new Error('missing capture_client_json -> normalize_request_losslessly edge');
      edge.arc_id = 'wrong-json';
      fs.writeFileSync(file, JSON.stringify(parsed, null, 2));
    },
    expect: /missing or malformed capture_client_json -> normalize_request_losslessly edge \(arc client-json\)/u,
  },
  {
    name: 'missing-normalize-plan-graph-edge',
    mutate(tmp) {
      const rel = 'docs/architecture/dagpipe/v3.operation_runner.request.graph.json';
      const file = path.join(tmp, rel);
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      parsed.edges = parsed.edges.filter(
        (edge) => !(edge?.from === 'normalize_request_losslessly' && edge?.to === 'plan_execution'),
      );
      fs.writeFileSync(file, JSON.stringify(parsed, null, 2));
    },
    expect: /missing or malformed normalize_request_losslessly -> plan_execution edge/u,
  },
  {
    name: 'missing-normalize-plan-mainline-edge',
    mutate(tmp) {
      const rel = 'docs/architecture/v3-mainline-call-map.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const chain = doc.chains.find((item) => item.chain_id === 'v3.operation_runner.dagpipe.request');
      if (!chain) throw new Error('missing v3.operation_runner.dagpipe.request chain');
      chain.edges = chain.edges.filter(
        (edge) => !(edge?.from_node === 'V3OperationRunnerNormalizeRequest' && edge?.to_node === 'V3OperationRunnerPlanExecution'),
      );
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /missing normalize_request_losslessly -> plan_execution caller edge/u,
  },
  {
    name: 'missing-transform-id',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const row = doc.path_consumers.find(
        (item) => item.protocol === 'responses' && item.section === 'request_fields' && item.path === 'request.max_output_tokens',
      );
      if (!row) throw new Error('missing responses request.max_output_tokens row');
      delete row.params.direction_bindings.client_request_to_chat.transform_id;
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /missing typed param transform_id/u,
  },
  {
    name: 'missing-nonidentity-destination',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const row = doc.path_consumers.find(
        (item) => item.protocol === 'openai_chat' && item.section === 'request_fields' && item.path === 'request.max_tokens',
      );
      if (!row) throw new Error('missing openai_chat request.max_tokens row');
      delete row.params.direction_bindings.chat_to_provider.destination;
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /missing destination/u,
  },
  {
    name: 'extra-typed-param',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const row = doc.path_consumers.find(
        (item) => item.protocol === 'responses' && item.section === 'request_fields' && item.path === 'request.background',
      );
      if (!row) throw new Error('missing responses request.background row');
      row.params.foo = 'bar';
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /has unexpected param foo not allowed by profile/u,
  },
  {
    name: 'missing-table-resource',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const profile = doc.binding_contract.typed_operator_profiles['routecodex.v3.field.role_value_map@1'];
      if (!profile?.client_request_to_chat) throw new Error('missing role_value_map profile');
      delete profile.client_request_to_chat.table;
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /must declare a table runtime resource/u,
  },
  {
    name: 'field-operator-params-duplicate',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const entry = doc.operator_registry.field_operators.find((item) => item.operator === 'routecodex.v3.field.lossless_preserve');
      if (!entry) throw new Error('missing field_operators lossless_preserve entry');
      entry.params = { direction: 'enum(client_request_to_chat)', semantics: 'enum(preserve_field)' };
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /must not carry params; typed_operator_profiles is the unique field-operator schema truth/u,
  },
  {
    name: 'direction-as-operator-param',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const profile = doc.binding_contract.typed_operator_profiles['routecodex.v3.field.lossless_preserve@1'];
      if (!profile?.client_request_to_chat) throw new Error('missing lossless_preserve profile');
      profile.client_request_to_chat.direction = 'enum(client_request_to_chat)';
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /direction is a binding axis only/u,
  },
  {
    name: 'opaque-tool-payload-by-ordinary-operator',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const row = doc.path_consumers.find(
        (item) => item.protocol === 'responses' && item.section === 'input_fields' && item.path === 'request.input[].arguments',
      );
      if (!row) throw new Error('missing responses request.input[].arguments row');
      row.consumers.client_request_to_chat = 'routecodex.v3.field.usage_value_map@1';
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /must use routecodex.v3.field.opaque_tool_payload@1/u,
  },
  {
    name: 'cross-inventory-parent-child-overlap',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const parent = doc.path_consumers.find(
        (item) => item.protocol === 'openai_chat' && item.section === 'message_fields' && item.path === 'request.messages[].content[].text',
      );
      if (!parent) throw new Error('missing openai_chat request.messages[].content[].text row');
      doc.extension_path_consumers.push({
        ...parent,
        protocol: 'openai_chat_extension',
        section: 'extended_superset',
        path: 'request.messages[].content[].text.text',
        mapping_record: 'cross-inventory-overlap',
      });
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /parent-child overlap/u,
  },
  {
    name: 'responses-parallel-tool-calls-tool-choice-enum',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const row = doc.path_consumers.find(
        (item) => item.protocol === 'responses' && item.section === 'request_fields' && item.path === 'request.parallel_tool_calls',
      );
      if (!row) throw new Error('missing responses request.parallel_tool_calls row');
      row.consumers.client_request_to_chat = 'routecodex.v3.field.tool_choice_value_map@1';
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /must use routecodex.v3.field.parallel_tool_calls_value_map@1/u,
  },
  {
    name: 'responses-parallel-tool-calls-inverse-missing',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const row = doc.path_consumers.find(
        (item) => item.protocol === 'responses' && item.section === 'response_fields' && item.path === 'response.parallel_tool_calls',
      );
      if (!row) throw new Error('missing responses response.parallel_tool_calls row');
      row.params.inverse_boolean = 'enum(true)';
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /inverse_boolean must be enum\(false\)/u,
  },
  {
    name: 'anthropic-tool-choice-name-mode-enum',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const row = doc.path_consumers.find(
        (item) => item.protocol === 'anthropic' && item.section === 'request_fields' && item.path === 'request.tool_choice.name',
      );
      if (!row) throw new Error('missing anthropic request.tool_choice.name row');
      row.consumers.client_request_to_chat = 'routecodex.v3.field.tool_choice_value_map@1';
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /must use routecodex.v3.field.tool_identity_context@1/u,
  },
  {
    name: 'anthropic-disable-parallel-tool-choice-enum',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const row = doc.path_consumers.find(
        (item) => item.protocol === 'anthropic' && item.section === 'request_fields' && item.path === 'request.tool_choice.disable_parallel_tool_use',
      );
      if (!row) throw new Error('missing anthropic disable_parallel_tool_use row');
      row.consumers.client_request_to_chat = 'routecodex.v3.field.tool_choice_value_map@1';
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /must use routecodex.v3.field.parallel_tool_calls_value_map@1/u,
  },
  {
    name: 'anthropic-disable-parallel-inverse-missing',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const row = doc.path_consumers.find(
        (item) => item.protocol === 'anthropic' && item.section === 'request_fields' && item.path === 'request.tool_choice.disable_parallel_tool_use',
      );
      if (!row) throw new Error('missing anthropic disable_parallel_tool_use row');
      row.params.inverse_boolean = 'enum(false)';
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /inverse_boolean must be enum\(true\)/u,
  },
  {
    name: 'attempt-cleanup-terminal-events-missing',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.lifecycle.manifest.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      delete doc.typed_cleanup_events.attempt_cleanup.consumes.disconnect;
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /attempt_cleanup must cover disconnect/u,
  },
  {
    name: 'terminal-cleanup-order-before-finalizer-missing',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.lifecycle.manifest.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const terminal = doc.lifecycle_terminals.find((entry) => entry.name === 'failure');
      if (!terminal) throw new Error('missing failure terminal');
      terminal.release = 'terminal_client_error commits through Server/SSE and then RuntimeRequestFinalizer releases request scope';
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /terminal_client_error must release attempt scope before request scope/u,
  },
  {
    name: 'union-tool-choice-missing-shape-children',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const row = doc.path_consumers.find(
        (item) => item.protocol === 'openai_chat' && item.section === 'request_fields' && item.path === 'request.tool_choice',
      );
      if (!row) throw new Error('missing openai_chat request.tool_choice row');
      delete row.shape_children;
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /must declare shape_children/u,
  },
  {
    name: 'union-tool-choice-missing-scalar-consumer',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const row = doc.path_consumers.find(
        (item) => item.protocol === 'openai_chat' && item.section === 'request_fields' && item.path === 'request.tool_choice',
      );
      if (!row) throw new Error('missing openai_chat request.tool_choice row');
      delete row.scalar_consumer.client_request_to_chat;
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /missing scalar_consumer direction client_request_to_chat/u,
  },
  {
    name: 'union-tool-choice-missing-child-row',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      doc.path_consumers = doc.path_consumers.filter(
        (item) => !(item.protocol === 'responses' && item.section === 'request_fields' && item.path === 'request.tool_choice.function.name'),
      );
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /missing shape_children row responses:request_fields:request.tool_choice.function.name/u,
  },
  {
    name: 'union-tool-choice-child-wrong-operator',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const row = doc.path_consumers.find(
        (item) => item.protocol === 'responses' && item.section === 'request_fields' && item.path === 'request.tool_choice.name',
      );
      if (!row) throw new Error('missing responses request.tool_choice.name row');
      row.consumers.client_request_to_chat = 'routecodex.v3.field.tool_choice_value_map@1';
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /must use routecodex.v3.field.tool_identity_context@1/u,
  },
  {
    name: 'structure-only-leaf-shape',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const row = doc.path_consumers.find(
        (item) => item.protocol === 'gemini' && item.section === 'request_fields' && item.path === 'request.toolConfig',
      );
      if (!row) throw new Error('missing gemini request.toolConfig row');
      row.params.shape = 'leaf';
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /structure_only row .* must be object\/array\/array_item/u,
  },
  {
    name: 'gemini-allowed-names-tool-choice-enum',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const row = doc.path_consumers.find(
        (item) => item.protocol === 'gemini' && item.section === 'request_fields' && item.path === 'request.toolConfig.functionCallingConfig.allowedFunctionNames',
      );
      if (!row) throw new Error('missing gemini allowedFunctionNames row');
      row.consumers.client_request_to_chat = 'routecodex.v3.field.tool_choice_value_map@1';
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /must use routecodex.v3.field.tool_identity_context@1/u,
  },
  {
    name: 'input-union-missing-scalar-consumer',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const row = doc.path_consumers.find(
        (item) => item.protocol === 'responses' && item.section === 'request_fields' && item.path === 'request.input',
      );
      if (!row) throw new Error('missing responses request.input union row');
      delete row.scalar_consumer.client_request_to_chat;
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /missing scalar_consumer direction client_request_to_chat/u,
  },
  {
    name: 'input-union-missing-shape-children',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const row = doc.path_consumers.find(
        (item) => item.protocol === 'responses' && item.section === 'request_fields' && item.path === 'request.input',
      );
      if (!row) throw new Error('missing responses request.input union row');
      delete row.shape_children;
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /must declare shape_children/u,
  },
  {
    name: 'content-union-missing-child-row',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const row = doc.path_consumers.find(
        (item) => item.protocol === 'openai_chat' && item.section === 'message_fields' && item.path === 'request.messages[].content',
      );
      if (!row) throw new Error('missing openai_chat content union row');
      row.shape_children = row.shape_children.filter((child) => child !== 'request.messages[].content[].text');
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /shape_children missing child row openai_chat:message_fields:request\.messages\[\]\.content\[\]\.text/u,
  },
  {
    name: 'input-union-null-preserve-missing',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const row = doc.path_consumers.find(
        (item) => item.protocol === 'responses' && item.section === 'request_fields' && item.path === 'request.input',
      );
      if (!row) throw new Error('missing responses request.input union row');
      delete row.null_behavior;
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /union parent responses:request_fields:request\.input must declare null_behavior enum\(preserve_null\)/u,
  },
  {
    name: 'content-union-null-coerced-to-empty-array',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const row = doc.path_consumers.find(
        (item) => item.protocol === 'openai_chat' && item.section === 'message_fields' && item.path === 'request.messages[].content',
      );
      if (!row) throw new Error('missing openai_chat content union row');
      row.null_behavior = 'enum(empty_array)';
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /union parent openai_chat:message_fields:request\.messages\[\]\.content must declare null_behavior enum\(preserve_null\)/u,
  },
  {
    name: 'content-union-false-shape-no-container',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const row = doc.path_consumers.find(
        (item) => item.protocol === 'openai_chat' && item.section === 'message_fields' && item.path === 'request.messages[].content',
      );
      if (!row) throw new Error('missing openai_chat content union row');
      row.params.shape = 'leaf';
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /union parent openai_chat:message_fields:request\.messages\[\]\.content params\.shape must include leaf and an object\/array container shape/u,
  },
  {
    name: 'input-union-false-shape-no-leaf',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const row = doc.path_consumers.find(
        (item) => item.protocol === 'responses' && item.section === 'request_fields' && item.path === 'request.input',
      );
      if (!row) throw new Error('missing responses request.input union row');
      row.params.shape = 'array';
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /union parent responses:request_fields:request\.input params\.shape must include leaf and an object\/array container shape/u,
  },
  {
    name: 'responses-input-array-content-missing-child-row',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      doc.path_consumers = doc.path_consumers.filter(
        (item) => !(item.protocol === 'responses' && item.section === 'input_fields' && item.path === 'request.input[].content'),
      );
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /union parent responses:request_fields:request\.input missing shape_children row responses:request_fields:request\.input\[\]\.content/u,
  },
  {
    name: 'responses-input-array-content-missing-shape-children',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const row = doc.path_consumers.find(
        (item) => item.protocol === 'responses' && item.section === 'request_fields' && item.path === 'request.input',
      );
      if (!row) throw new Error('missing responses request.input union row');
      row.shape_children = row.shape_children.filter((child) => child !== 'request.input[].content');
      doc.path_consumers = doc.path_consumers.filter(
        (item) => !(item.protocol === 'responses' && item.section === 'input_fields' && item.path === 'request.input[].content'),
      );
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /union parent responses:request_fields:request\.input missing required shape child request\.input\[\]\.content/u,
  },
  {
    name: 'responses-input-array-content-missing-type-consumer',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      doc.path_consumers = doc.path_consumers.filter(
        (item) => !(item.protocol === 'responses' && item.section === 'input_fields' && item.path === 'request.input[].content[].type'),
      );
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /matrix path responses:input_fields:request\.input\[\]\.content\[\]\.type has no path_consumer binding|missing required shape child request\.input\[\]\.content\[\]\.type/u,
  },
  {
    name: 'responses-input-array-content-missing-image-consumer',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      doc.path_consumers = doc.path_consumers.filter(
        (item) => !(item.protocol === 'responses' && item.section === 'input_fields' && item.path === 'request.input[].content[].image_url'),
      );
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /matrix path responses:input_fields:request\.input\[\]\.content\[\]\.image_url has no path_consumer binding|missing required shape child request\.input\[\]\.content\[\]\.image_url/u,
  },
  {
    name: 'responses-input-array-content-missing-url-consumer',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      doc.path_consumers = doc.path_consumers.filter(
        (item) => !(item.protocol === 'responses' && item.section === 'input_fields' && item.path === 'request.input[].content[].url'),
      );
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /matrix path responses:input_fields:request\.input\[\]\.content\[\]\.url has no path_consumer binding|missing required shape child request\.input\[\]\.content\[\]\.url/u,
  },
  {
    name: 'openai-chat-content-array-missing-child-row',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      doc.path_consumers = doc.path_consumers.filter(
        (item) => !(item.protocol === 'openai_chat' && item.section === 'message_fields' && item.path === 'request.messages[].content[].text'),
      );
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /missing shape_children row openai_chat:message_fields:request\.messages\[\]\.content\[\]\.text/u,
  },
  {
    name: 'anthropic-content-union-missing-scalar-consumer',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const row = doc.path_consumers.find(
        (item) => item.protocol === 'anthropic' && item.section === 'content_block_fields' && item.path === 'request.messages[].content',
      );
      if (!row) throw new Error('missing anthropic content union row');
      delete row.scalar_consumer.chat_to_provider;
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /missing scalar_consumer direction chat_to_provider/u,
  },
  {
    name: 'responses-input-array-content-union-missing-scalar-consumer',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const row = doc.path_consumers.find(
        (item) => item.protocol === 'responses' && item.section === 'input_fields' && item.path === 'request.input[].content',
      );
      if (!row) throw new Error('missing responses request.input[].content union row');
      delete row.scalar_consumer.client_request_to_chat;
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /missing scalar_consumer direction client_request_to_chat/u,
  },
  {
    name: 'anthropic-content-union-null-preserve-missing',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const row = doc.path_consumers.find(
        (item) => item.protocol === 'anthropic' && item.section === 'content_block_fields' && item.path === 'request.messages[].content',
      );
      if (!row) throw new Error('missing anthropic content union row');
      delete row.null_behavior;
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /union parent anthropic:content_block_fields:request\.messages\[\]\.content must declare null_behavior enum\(preserve_null\)/u,
  },
  {
    name: 'union-parent-shape-children-self-authorizes-invented-review-only-field',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const parent = doc.path_consumers.find(
        (item) => item.protocol === 'responses' && item.section === 'request_fields' && item.path === 'request.input',
      );
      if (!parent) throw new Error('missing responses request.input union row');
      if (!Array.isArray(parent.shape_children)) parent.shape_children = [];
      parent.shape_children.push('request.input[].invented_review_only_field');
      const source = doc.path_consumers.find(
        (item) => item.protocol === 'responses' && item.section === 'input_fields' && item.path === 'request.input[].type',
      );
      if (!source) throw new Error('missing responses request.input[].type source row');
      doc.path_consumers.push({
        ...source,
        path: 'request.input[].invented_review_only_field',
        mapping_record: 'invented-review-only-field',
      });
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /unknown path_consumer binding responses:input_fields:request\.input\[\]\.invented_review_only_field/u,
  },
  {
    name: 'shape-children-alone-authorizes-invented-field',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const parent = doc.path_consumers.find(
        (item) => item.protocol === 'responses' && item.section === 'request_fields' && item.path === 'request.input',
      );
      if (!parent) throw new Error('missing responses request.input union row');
      if (!Array.isArray(parent.shape_children)) parent.shape_children = [];
      parent.shape_children.push('request.input[].invented_shape_children_only_field');
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /shape_children references unknown source inventory path request\.input\[\]\.invented_shape_children_only_field/u,
  },
  {
    name: 'responses-array-input-does-not-authorize-direct-object-descendant',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const parent = doc.path_consumers.find(
        (item) => item.protocol === 'responses' && item.section === 'request_fields' && item.path === 'request.input',
      );
      const source = doc.path_consumers.find(
        (item) => item.protocol === 'responses' && item.section === 'input_fields' && item.path === 'request.input[].type',
      );
      if (!parent || !source) throw new Error('missing Responses input parent or array item source row');
      parent.shape_children.push('request.input.type');
      doc.path_consumers.push({ ...source, path: 'request.input.type', mapping_record: 'invented-object-path' });
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /unknown path_consumer binding responses:input_fields:request\.input\.type/u,
  },
  {
    name: 'responses-input-item-typed-discriminator-missing',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const row = doc.path_consumers.find(
        (item) => item.protocol === 'responses' && item.section === 'input_fields' && item.path === 'request.input[].call_id',
      );
      if (!row) throw new Error('missing responses request.input[].call_id row');
      delete row.typed_discriminator_cases;
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /responses:input_fields:request\.input\[\]\.call_id must declare typed_discriminator_cases with discriminator_path request\.input\[\]\.type/u,
  },
  {
    name: 'responses-input-item-role-missing-branch-deleted',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const row = doc.path_consumers.find(
        (item) => item.protocol === 'responses' && item.section === 'input_fields' && item.path === 'request.input[].role',
      );
      if (!row) throw new Error('missing responses request.input[].role row');
      row.typed_discriminator_cases.cases = row.typed_discriminator_cases.cases.filter(
        (branch) => !branch.predicates.some((predicate) => predicate.path === 'request.input[].type' && predicate.state === 'missing'),
      );
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /responses:input_fields:request\.input\[\]\.role .* missing branch predicate request\.input\[\]\.type state missing/u,
  },
  {
    name: 'responses-input-item-role-missing-state-confused-with-null',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const row = doc.path_consumers.find(
        (item) => item.protocol === 'responses' && item.section === 'input_fields' && item.path === 'request.input[].role',
      );
      if (!row) throw new Error('missing responses request.input[].role row');
      const branch = row.typed_discriminator_cases.cases.find((item) => item.predicates.some((predicate) => predicate.path === 'request.input[].type' && predicate.state === 'missing'));
      if (!branch) throw new Error('missing responses request.input[].role missing-type branch');
      const predicate = branch.predicates.find((item) => item.path === 'request.input[].type');
      delete predicate.state;
      predicate.value = 'null';
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /responses:input_fields:request\.input\[\]\.role .* missing branch predicate request\.input\[\]\.type state missing/u,
  },
  {
    name: 'responses-input-content-text-reasoning-parent-condition-deleted',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const row = doc.path_consumers.find(
        (item) => item.protocol === 'responses' && item.section === 'input_fields' && item.path === 'request.input[].content[].text',
      );
      if (!row) throw new Error('missing responses request.input[].content[].text row');
      const branch = row.typed_discriminator_cases.cases.find((item) => item.type_value === 'reasoning_text');
      if (!branch) throw new Error('missing responses request.input[].content[].text reasoning_text branch');
      branch.predicates = branch.predicates.filter((predicate) => !(predicate.path === 'request.input[].type' && predicate.value === 'reasoning'));
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /responses:input_fields:request\.input\[\]\.content\[\]\.text .* reasoning_text.*request\.input\[\]\.type.*reasoning/u,
  },
  {
    name: 'responses-output-item-typed-discriminator-operator-mismatch',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const row = doc.path_consumers.find(
        (item) => item.protocol === 'responses' && item.section === 'output_fields' && item.path === 'response.output[].call_id',
      );
      if (!row) throw new Error('missing responses response.output[].call_id row');
      for (const branch of row.typed_discriminator_cases.cases) {
        branch.operator = 'routecodex.v3.field.array_container_shape@1';
      }
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /typed_discriminator_cases operator routecodex\.v3\.field\.array_container_shape@1 must match consumers\.provider_response_to_chat/u,
  },
  {
    name: 'output-text-item-member-wrong-raw-path',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const row = doc.path_consumers.find(
        (item) => item.protocol === 'responses' && item.section === 'output_fields' && item.path === 'response.output[].content[].text',
      );
      if (!row) throw new Error('missing responses response.output[].content[].text row');
      row.path = 'response.output[].text';
      row.typed_discriminator_cases = {
        discriminator_path: 'response.output[].type',
        cases: [
          { type_value: 'output_text', semantic_id: 'output_text.text', operator: 'routecodex.v3.field.lossless_preserve@1' },
        ],
      };
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /unknown path_consumer binding responses:output_fields:response\.output\[\]\.text|matrix path responses:output_fields:response\.output\[\]\.content\[\]\.text has no path_consumer binding/u,
  },
  {
    name: 'output-content-part-wrong-discriminator',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const row = doc.path_consumers.find(
        (item) => item.protocol === 'responses' && item.section === 'output_fields' && item.path === 'response.output[].content[].text',
      );
      if (!row) throw new Error('missing responses response.output[].content[].text row');
      row.typed_discriminator_cases.discriminator_path = 'response.output[].type';
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /content-part path response\.output\[\]\.content\[\]\.(text|type|refusal) must use discriminator_path/u,
  },
  {
    name: 'output-content-parent-shape-children-self-authorizes',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const parent = doc.path_consumers.find(
        (item) => item.protocol === 'responses' && item.section === 'output_fields' && item.path === 'response.output[].content',
      );
      if (!parent) throw new Error('missing responses response.output[].content row');
      if (!Array.isArray(parent.shape_children)) parent.shape_children = [];
      parent.shape_children.push('response.output[].content[].forged_shadow_field');
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /content union parent.*shape_children references unknown source inventory path|shape_children.*forged_shadow_field|must be source-backed and consumer-bound/u,
  },
];

let failed = 0;
const positiveTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-operation-runner-positive-'));
try {
  for (const rel of files) {
    const src = path.join(repo, rel);
    const dest = path.join(positiveTmp, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest);
  }
  const result = spawnSync(process.execPath, [verifyScript], {
    cwd: positiveTmp,
    env: { ...process.env, ROUTECODEX_V3_SOURCE_ROOT: positiveTmp },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    failed += 1;
    console.error(`[v3-operation-runner-red] valid-candidate: expected verifier PASS, got:\n${result.stdout}\n${result.stderr}`);
  } else {
    console.log('[v3-operation-runner-red] valid-candidate: PASS');
  }
} finally {
  fs.rmSync(positiveTmp, { recursive: true, force: true });
}

// Positive fixture: removing deferred response and error graph files must
// not block the Node 01 gate. The verifier should still PASS.
const noDeferredTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-operation-runner-no-deferred-graphs-'));
try {
  for (const rel of files) {
    const src = path.join(repo, rel);
    const dest = path.join(noDeferredTmp, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest);
  }
  fs.rmSync(path.join(noDeferredTmp, 'docs/architecture/dagpipe/v3.operation_runner.response.graph.json'));
  fs.rmSync(path.join(noDeferredTmp, 'docs/architecture/dagpipe/v3.operation_runner.error.graph.json'));
  const result = spawnSync(process.execPath, [verifyScript], {
    cwd: noDeferredTmp,
    env: { ...process.env, ROUTECODEX_V3_SOURCE_ROOT: noDeferredTmp },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    failed += 1;
    console.error(`[v3-operation-runner-red] no-deferred-graphs: expected verifier PASS, got:\n${result.stdout}\n${result.stderr}`);
  } else {
    console.log('[v3-operation-runner-red] no-deferred-graphs: PASS');
  }
} finally {
  fs.rmSync(noDeferredTmp, { recursive: true, force: true });
}

for (const mutation of mutations) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `v3-operation-runner-${mutation.name}-`));
  try {
    for (const rel of files) {
      const src = path.join(repo, rel);
      const dest = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(src, dest);
    }
    mutation.mutate(tmp);
    const result = spawnSync(process.execPath, [verifyScript], {
      cwd: tmp,
      env: { ...process.env, ROUTECODEX_V3_SOURCE_ROOT: tmp },
      encoding: 'utf8',
    });
    const output = `${result.stdout}\n${result.stderr}`;
    if (!mutation.expect.test(output)) {
      failed += 1;
      console.error(`[v3-operation-runner-red] ${mutation.name}: expected ${mutation.expect}, got:\n${output || '<no output>'}`);
    } else {
      console.log(`[v3-operation-runner-red] ${mutation.name}: failed as expected`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (failed > 0) process.exit(1);
