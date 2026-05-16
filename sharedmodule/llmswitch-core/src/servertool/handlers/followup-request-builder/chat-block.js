import { isFollowupGoalManagedContext } from '../../../conversion/hub/pipeline/hub-pipeline-goal-tools.js';
import { stripChatProcessHistoricalImages } from '../../../router/virtual-router/engine-selection/native-router-hotpath.js';
import { cloneJson } from '../../server-side-tools.js';
import { applyFollowupInjectionOps, hasReasoningStopTool, shouldIncludeReasoningStopToolFromOps, stripToolsByCanonicalName } from './op-blocks.js';
import { extractCapturedChatSeed, resolveFollowupModel, sanitizeFollowupParametersForResolvedModel } from './seed.js';
export function buildChatFollowupPayloadFromInjection(args) {
    const captured = args.adapterContext && typeof args.adapterContext === 'object'
        ? args.adapterContext.capturedChatRequest
        : undefined;
    const seed = extractCapturedChatSeed(captured);
    if (!seed) {
        return null;
    }
    return materializeFollowupChatPayload({
        seed,
        adapterContext: args.adapterContext,
        chatResponse: args.chatResponse,
        injection: args.injection
    });
}
function materializeFollowupChatPayload(args) {
    const followupModel = resolveFollowupModel(args.seed.model, args.adapterContext);
    if (!followupModel) {
        return null;
    }
    let messages = Array.isArray(args.seed.messages) ? cloneJson(args.seed.messages) : [];
    messages = stripChatProcessHistoricalImages(messages, '[Image omitted]').messages;
    const ops = Array.isArray(args.injection?.ops) ? args.injection.ops : [];
    const goalManagedContext = isFollowupGoalManagedContext(args.adapterContext);
    const tools = Array.isArray(args.seed.tools) ? cloneJson(args.seed.tools) : undefined;
    const sanitizedTools = goalManagedContext
        ? stripToolsByCanonicalName(tools, ['reasoning.stop', 'reasoning_stop', 'reasoning-stop'])
        : tools;
    const result = applyFollowupInjectionOps({
        state: {
            messages,
            tools: sanitizedTools,
            parameters: sanitizeFollowupParametersForResolvedModel({
                parameters: args.seed.parameters ? cloneJson(args.seed.parameters) : undefined,
                seedModel: args.seed.model,
                followupModel
            })
        },
        ops,
        context: {
            chatResponse: args.chatResponse,
            includeReasoningStopTool: !goalManagedContext
                && (shouldIncludeReasoningStopToolFromOps(ops) || hasReasoningStopTool(sanitizedTools))
        }
    });
    if (!result) {
        return null;
    }
    return {
        model: followupModel,
        messages: result.messages,
        ...(result.tools ? { tools: result.tools } : {}),
        ...(result.parameters ? { parameters: result.parameters } : {})
    };
}
