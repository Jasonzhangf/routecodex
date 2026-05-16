import { isFollowupGoalManagedContext } from '../../../conversion/hub/pipeline/hub-pipeline-goal-tools.js';
import { buildServertoolGenericFollowupPayloadWithNative } from '../../../router/virtual-router/engine-selection/native-chat-process-servertool-orchestration-semantics.js';
import { buildServertoolFollowupConfig } from '../../skeleton-config.js';
import { resolveFollowupInjectionOpsForNative, stripToolsByCanonicalName } from './op-blocks.js';
import { extractCapturedChatSeed, resolveFollowupModel, sanitizeFollowupParametersForResolvedModel } from './seed.js';
import { isTextualToolTransportOnlyAssistantMessage } from './message-blocks.js';
export function isNativeSupportedFollowupInjectionPlan(injection) {
    const injectionOps = Array.isArray(injection?.ops) ? injection.ops : [];
    const followupConfig = buildServertoolFollowupConfig();
    const nativeSupportedOps = new Set(followupConfig.nativeSupportedOps);
    return injectionOps.every((op) => {
        const opName = typeof op?.op === 'string' ? String(op.op).trim() : '';
        return nativeSupportedOps.has(opName);
    });
}
export function buildNativeFollowupPayloadFromInjection(args) {
    const captured = args.adapterContext && typeof args.adapterContext === 'object'
        ? args.adapterContext.capturedChatRequest
        : undefined;
    const seed = extractCapturedChatSeed(captured);
    if (!seed) {
        return null;
    }
    const goalManagedContext = isFollowupGoalManagedContext(args.adapterContext);
    const followupModel = resolveFollowupModel(seed.model, args.adapterContext);
    if (!followupModel) {
        return null;
    }
    const choices = Array.isArray(args.chatResponse?.choices)
        ? args.chatResponse.choices
        : [];
    const firstMessage = choices[0]?.message && typeof choices[0].message === 'object' && !Array.isArray(choices[0].message)
        ? choices[0].message
        : undefined;
    const assistantMessage = firstMessage && !isTextualToolTransportOnlyAssistantMessage(firstMessage)
        ? firstMessage
        : undefined;
    const toolOutputs = Array.isArray(args.chatResponse?.tool_outputs)
        ? args.chatResponse.tool_outputs
        : [];
    const injectionOps = Array.isArray(args.injection?.ops)
        ? args.injection.ops
        : [];
    return buildServertoolGenericFollowupPayloadWithNative({
        model: followupModel,
        messages: seed.messages,
        tools: goalManagedContext
            ? stripToolsByCanonicalName(seed.tools, ['reasoning.stop', 'reasoning_stop', 'reasoning-stop'])
            : seed.tools,
        parameters: sanitizeFollowupParametersForResolvedModel({
            parameters: seed.parameters,
            seedModel: seed.model,
            followupModel
        }),
        assistantMessage,
        toolOutputs,
        followupInjectionOps: resolveFollowupInjectionOpsForNative({
            ops: injectionOps,
            seed,
            allowReasoningStopTool: !goalManagedContext
        })
    });
}
