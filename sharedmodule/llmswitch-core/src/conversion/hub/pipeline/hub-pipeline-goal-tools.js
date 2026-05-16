import { resolveGoalCapableRequestWithNative } from "../../../router/virtual-router/engine-selection/native-chat-process-servertool-orchestration-semantics.js";
export function resolveGoalCapableRequest(args) {
    return resolveGoalCapableRequestWithNative({
        request: args.request,
        adapterContext: args.adapterContext,
    });
}
export function isGoalCapableStandardizedRequest(request) {
    return resolveGoalCapableRequest({ request }).requestGoalCapable;
}
export function isGoalCapableAdapterContext(adapterContext) {
    return resolveGoalCapableRequest({ adapterContext }).adapterContextGoalCapable;
}
export function isFollowupGoalManagedContext(adapterContext) {
    return resolveGoalCapableRequest({ adapterContext }).followupGoalManagedContext;
}
