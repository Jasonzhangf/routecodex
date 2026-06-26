import { deriveFinishReasonNative } from '../../modules/llmswitch/bridge.js';
const FINISH_REASON_DEBUG_ENABLED = process.env.ROUTECODEX_DEBUG_FINISH_REASON === '1' ||
    process.env.RCC_DEBUG_FINISH_REASON === '1';
function logFinishReasonDebug(...args) {
    if (!FINISH_REASON_DEBUG_ENABLED) {
        return;
    }
    console.log(...args);
}
export function deriveFinishReason(body) {
    logFinishReasonDebug('[FINISH-REASON:DEBUG] input body keys:', body && typeof body === 'object' ? Object.keys(body).join(',') : typeof body);
    const finishReason = deriveFinishReasonNative(body);
    logFinishReasonDebug('[FINISH-REASON:DEBUG] derived:', finishReason);
    return finishReason;
}
