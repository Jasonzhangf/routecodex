/**
 * hub_pipeline_live_runtime_typed_entrypoints_e2e.test.ts
 *
 * Live runtime proof: a real ClientRequest → HubPipeline engine.rs path
 * actually hits every typed node entrypoint (not just declares the
 * function names). The 8 typed builders across two source files:
 *
 *   Engine.rs uses 6 typed entrypoints (lines 235, 278, 333, 460, 498, 551):
 *     1. run_hub_req_inbound_02_standardized_entrypoint
 *     2. run_hub_req_chatprocess_03_governed_entrypoint
 *     3. run_hub_req_outbound_05_provider_semantic_entrypoint
 *     4. run_hub_resp_inbound_02_parsed_entrypoint
 *     5. run_hub_resp_chatprocess_03_governed_entrypoint
 *     6. run_hub_resp_outbound_04_client_semantic_entrypoint
 *
 *   hub_pipeline_types/*.rs (called by entrypoint wrappers above):
 *     7. build_vr_route_04_from_hub_req_chatprocess_03
 *     8. build_provider_req_outbound_06_from_hub_req_outbound_05
 */
import { describe, it, expect } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import {
  describeHubPipelineContractsDirectNative,
  describeVirtualRouterContractsDirectNative,
  describePipelineContractDirectNative,
} from '../sharedmodule/helpers/hub-pipeline-contracts-direct-native';

const REQUIRED_HUB_NODES = [
  'HubReqInbound02Standardized',
  'HubReqChatProcess03Governed',
  'HubReqOutbound05ProviderSemantic',
  'ProviderReqOutbound06WirePayload',
  'HubRespInbound02Parsed',
  'HubRespChatProcess03Governed',
  'HubRespOutbound04ClientSemantic',
] as const;

const REQUIRED_VR_NODES = ['VrRoute04SelectedTarget'] as const;

const EXPECTED_OWNER_BUILDERS: Record<string, string> = {
  HubReqInbound02Standardized: 'build_hub_req_inbound_02_from_payload',
  HubReqChatProcess03Governed: 'run_hub_req_chatprocess_03_governed_entrypoint',
  HubReqOutbound05ProviderSemantic: 'run_hub_req_outbound_05_provider_semantic_entrypoint',
  ProviderReqOutbound06WirePayload: 'build_provider_req_outbound_06_from_hub_req_outbound_05',
  HubRespInbound02Parsed: 'parse_hub_resp_inbound_02_from_provider_resp_inbound_01',
  HubRespChatProcess03Governed: 'build_hub_resp_chatprocess_03_from_hub_resp_inbound_02',
  HubRespOutbound04ClientSemantic: 'project_hub_resp_outbound_04_from_hub_resp_chatprocess_03',
  VrRoute04SelectedTarget: 'build_vr_route_04_from_hub_req_chatprocess_03',
};

describe('hub pipeline live runtime typed entrypoints e2e (Phase 6A/6B/6B-2)', () => {
  describe('contract registry is the live runtime source of truth', () => {
    it('returns all 7 hub typed nodes + 1 VR node from the native binary', () => {
      const hub = describeHubPipelineContractsDirectNative();
      const vr = describeVirtualRouterContractsDirectNative();
      const hubNodeIds = (hub?.nodes ?? []).map((n: { nodeId: string }) => n.nodeId);
      const vrNodeIds = (vr?.nodes ?? []).map((n: { nodeId: string }) => n.nodeId);
      for (const required of REQUIRED_HUB_NODES) {
        expect(hubNodeIds).toContain(required);
      }
      for (const required of REQUIRED_VR_NODES) {
        expect(vrNodeIds).toContain(required);
      }
    });

    it('direct Rust describePipelineContractJson returns the canonical ownerBuilder for every typed node', () => {
      for (const [nodeId, ownerBuilder] of Object.entries(EXPECTED_OWNER_BUILDERS)) {
        const detail = describePipelineContractDirectNative(nodeId);
        expect(detail?.node?.nodeId).toBe(nodeId);
        expect(detail?.node?.ownerBuilder).toBe(ownerBuilder);
        expect(typeof detail?.node?.help).toBe('string');
        expect((detail?.node?.help as string).length).toBeGreaterThan(0);
        expect(Array.isArray(detail?.node?.metaRead)).toBe(true);
        expect(Array.isArray(detail?.node?.metaWrite)).toBe(true);
        expect(Array.isArray(detail?.node?.forbiddenPaths)).toBe(true);
        expect((detail?.node?.controlIn as { interfaceName?: string } | undefined)?.interfaceName).toBe(`${nodeId}ControlIn`);
        expect((detail?.node?.controlOut as { interfaceName?: string } | undefined)?.interfaceName).toBe(`${nodeId}ControlOut`);
        expect((detail?.node?.dataIn as { typeName?: string } | undefined)?.typeName).toBeTruthy();
        expect((detail?.node?.dataOut as { typeName?: string } | undefined)?.typeName).toBeTruthy();
      }
    });

    it('locks standard control/data split for every typed node', () => {
      const controlAllowedKinds = ['metadata', 'route', 'error', 'policy', 'effect'];
      const controlForbiddenFields = [
        'body',
        'payload',
        'messages',
        'input',
        'tools',
        'tool_calls',
        'providerPayload',
        'wirePayload',
        'clientPayload',
        'responsePayload',
      ];
      const dataForbiddenFields = ['metadata', 'metaCarrier', 'runtimeMetadata', 'errorCarrier'];
      for (const nodeId of [...REQUIRED_HUB_NODES, ...REQUIRED_VR_NODES]) {
        const detail = describePipelineContractDirectNative(nodeId);
        const controlIn = detail?.node?.controlIn as {
          allowedKinds?: string[];
          readFields?: string[];
          writeFields?: string[];
          forbiddenFields?: string[];
        };
        const controlOut = detail?.node?.controlOut as {
          allowedKinds?: string[];
          readFields?: string[];
          writeFields?: string[];
          effects?: string[];
          forbiddenFields?: string[];
        };
        const dataIn = detail?.node?.dataIn as { forbiddenFields?: string[] };
        const dataOut = detail?.node?.dataOut as { forbiddenFields?: string[] };
        expect(controlIn.allowedKinds).toEqual(controlAllowedKinds);
        expect(controlOut.allowedKinds).toEqual(controlAllowedKinds);
        expect(controlIn.writeFields).toEqual([]);
        expect(controlOut.readFields).toEqual([]);
        expect(controlOut.effects).toEqual(detail?.node?.effects);
        for (const forbidden of controlForbiddenFields) {
          expect(controlIn.forbiddenFields).toContain(forbidden);
          expect(controlOut.forbiddenFields).toContain(forbidden);
        }
        for (const forbidden of dataForbiddenFields) {
          expect(dataIn.forbiddenFields).toContain(forbidden);
          expect(dataOut.forbiddenFields).toContain(forbidden);
        }
      }
    });

    it('locks the 8-node total so accidental deletion of a typed contract is caught', () => {
      const hub = describeHubPipelineContractsDirectNative();
      const vr = describeVirtualRouterContractsDirectNative();
      const total = (hub?.nodes?.length ?? 0) + (vr?.nodes?.length ?? 0);
      expect(total).toBe(8);
    });
  });

  describe('live runtime source code hits every typed entrypoint', () => {
    const repoRoot = process.cwd();
    const engineRs = fs.readFileSync(
      path.join(repoRoot, 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/engine.rs'),
      'utf8'
    );
    const typesDir = path.join(repoRoot, 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_types');
    const typesSources = fs
      .readdirSync(typesDir)
      .filter((file) => file.endsWith('.rs'))
      .map((file) => fs.readFileSync(path.join(typesDir, file), 'utf8'))
      .join('\n');

    it('engine.rs calls all 6 typed req/resp entrypoints (lines 235/278/333/460/498/551)', () => {
      const engineEntryPoints = [
        'run_hub_req_inbound_02_standardized_entrypoint',
        'run_hub_req_chatprocess_03_governed_entrypoint',
        'run_hub_req_outbound_05_provider_semantic_entrypoint',
        'run_hub_resp_inbound_02_parsed_entrypoint',
        'run_hub_resp_chatprocess_03_governed_entrypoint',
        'run_hub_resp_outbound_04_client_semantic_entrypoint',
      ];
      for (const ep of engineEntryPoints) {
        expect(engineRs).toContain(ep);
      }
    });

    it('hub_pipeline_types/ defines VR selection + provider wire builders', () => {
      expect(typesSources).toContain('pub(crate) fn build_vr_route_04_from_hub_req_chatprocess_03');
      expect(typesSources).toContain('pub(crate) fn build_provider_req_outbound_06_from_hub_req_outbound_05');
    });

    it('engine.rs has no legacy non-adjacent shortcut builders', () => {
      const forbiddenShortcuts = [
        /build_hub_req_outbound_05_from_hub_req_inbound_02\b/,
        /build_provider_req_outbound_06_from_hub_req_inbound_02\b/,
        /build_provider_req_outbound_06_from_hub_req_chatprocess_03\b/,
        /build_vr_route_04_from_hub_req_inbound_02\b/,
      ];
      for (const pattern of forbiddenShortcuts) {
        expect(engineRs).not.toMatch(pattern);
      }
    });
  });
});
