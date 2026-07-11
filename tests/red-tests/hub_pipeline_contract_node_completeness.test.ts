import {
  describeHubPipelineContractsNative,
  describeVirtualRouterContractsNative,
  describePipelineContractNative,
} from '../../src/modules/llmswitch/bridge/native-exports.js';

const HUB_NODES: Array<{ nodeId: string; ownerBuilder: string }> = [
  { nodeId: 'HubReqInbound02Standardized', ownerBuilder: 'build_hub_req_inbound_02_from_payload' },
  { nodeId: 'HubReqChatProcess03Governed', ownerBuilder: 'run_hub_req_chatprocess_03_governed_entrypoint' },
  { nodeId: 'HubReqOutbound05ProviderSemantic', ownerBuilder: 'run_hub_req_outbound_05_provider_semantic_entrypoint' },
  { nodeId: 'ProviderReqOutbound06WirePayload', ownerBuilder: 'build_provider_req_outbound_06_from_hub_req_outbound_05' },
  { nodeId: 'HubRespInbound02Parsed', ownerBuilder: 'parse_hub_resp_inbound_02_from_provider_resp_inbound_01' },
  { nodeId: 'HubRespChatProcess03Governed', ownerBuilder: 'build_hub_resp_chatprocess_03_from_hub_resp_inbound_02' },
  { nodeId: 'HubRespOutbound04ClientSemantic', ownerBuilder: 'project_hub_resp_outbound_04_from_hub_resp_chatprocess_03' },
];

const VR_NODES: Array<{ nodeId: string; ownerBuilder: string }> = [
  { nodeId: 'VrRoute04SelectedTarget', ownerBuilder: 'build_vr_route_04_from_hub_req_chatprocess_03' },
];

describe('hub pipeline contract node completeness (online help)', () => {
  it('returns all 7 typed hub nodes from describeHubPipelineContractsNative', () => {
    const all = describeHubPipelineContractsNative();
    const nodes = (all?.nodes ?? []).map((n: { nodeId: string }) => n.nodeId);
    for (const { nodeId } of HUB_NODES) {
      expect(nodes).toContain(nodeId);
    }
    expect(nodes.length).toBe(7);
  });

  it('returns the 1 virtual router node from describeVirtualRouterContractsNative', () => {
    const vr = describeVirtualRouterContractsNative();
    const vrNodes = (vr?.nodes ?? []).map((n: { nodeId: string }) => n.nodeId);
    for (const { nodeId } of VR_NODES) {
      expect(vrNodes).toContain(nodeId);
    }
    expect(vrNodes.length).toBe(1);
  });

  it('returns complete fields for every node via describePipelineContractNative', () => {
    for (const { nodeId, ownerBuilder } of [...HUB_NODES, ...VR_NODES]) {
      const detail = describePipelineContractNative(nodeId);
      expect(detail?.node?.nodeId).toBe(nodeId);
      expect(detail?.node?.ownerBuilder).toBe(ownerBuilder);
      expect(typeof detail?.node?.help === 'string' && detail.node.help.length > 0).toBe(true);
      expect(Array.isArray(detail?.node?.metaRead)).toBe(true);
      expect(Array.isArray(detail?.node?.metaWrite)).toBe(true);
      expect(Array.isArray(detail?.node?.forbiddenPaths)).toBe(true);
      expect(typeof detail?.node?.dataIn?.typeName === 'string').toBe(true);
      expect(typeof detail?.node?.dataOut?.typeName === 'string').toBe(true);
    }
  });

  it('declares tool-surface validation on every request and response phase', () => {
    const expectedToolValidation: Record<string, string> = {
      HubReqInbound02Standardized: 'tool_surface_validate',
      HubReqChatProcess03Governed: 'tool_surface_validate',
      HubReqOutbound05ProviderSemantic: 'tool_surface_validate',
      ProviderReqOutbound06WirePayload: 'tool_surface_validate_provider_wire',
      HubRespInbound02Parsed: 'tool_surface_validate',
      HubRespChatProcess03Governed: 'tool_surface_validate',
      HubRespOutbound04ClientSemantic: 'tool_surface_validate',
    };

    for (const [nodeId, effect] of Object.entries(expectedToolValidation)) {
      const detail = describePipelineContractNative(nodeId);
      expect(detail?.node?.effects).toContain(effect);
    }
  });
});
