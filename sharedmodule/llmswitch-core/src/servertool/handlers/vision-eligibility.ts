import { planVisionEligibilityWithNative } from '../../native/router-hotpath/native-servertool-core-semantics.js';

export function shouldRunVisionFlowForAdapterContext(adapterContext: unknown): boolean {
  return planVisionEligibilityWithNative(adapterContext).shouldRunVisionFlow;
}

export function shouldBypassStopMessageForMediaContext(adapterContext: unknown): boolean {
  return planVisionEligibilityWithNative(adapterContext).shouldBypassStopMessage;
}
