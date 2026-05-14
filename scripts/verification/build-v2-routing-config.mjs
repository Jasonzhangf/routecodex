export function buildSingleGroupV2VirtualRouter(routingByCapability) {
  return {
    routingPolicyGroups: {
      default: {
        routing: routingByCapability
      }
    }
  };
}
