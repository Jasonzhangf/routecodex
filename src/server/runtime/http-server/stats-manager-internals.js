import { buildHistoricalProviderRow, formatProviderLabel, logProviderSummaryTable } from './stats-manager-table.js';
export { buildHistoricalProviderRow, buildSessionProviderRow, formatIso, formatProviderLabel, logProviderSummaryTable } from './stats-manager-table.js';
export function composeBucketKey(providerKey, model, entryPort) {
    const portSegment = typeof entryPort === 'number' && Number.isFinite(entryPort) && entryPort > 0
        ? `|port-${Math.floor(entryPort)}`
        : '';
    return `${providerKey}|${model ?? '-'}${portSegment}`;
}
export function computeProviderTotals(buckets) {
    return Array.from(buckets.values()).map((bucket) => ({
        ...bucket,
        averageLatencyMs: bucket.requestCount ? bucket.totalLatencyMs / bucket.requestCount : 0,
        averagePromptTokens: bucket.requestCount ? bucket.totalPromptTokens / bucket.requestCount : 0,
        averageCompletionTokens: bucket.requestCount ? bucket.totalCompletionTokens / bucket.requestCount : 0,
        averageOutputTokens: bucket.requestCount ? bucket.totalOutputTokens / bucket.requestCount : 0
    }));
}
export function snapshotTools(options) {
    if (options.totalToolCalls <= 0 && options.totalToolResponses <= 0) {
        return undefined;
    }
    const byToolName = {};
    for (const [name, bucket] of options.toolBuckets.entries()) {
        byToolName[name] = { ...bucket };
    }
    const byProviderKey = {};
    for (const [providerKey, providerTools] of options.toolBucketsByProvider.entries()) {
        const totals = options.toolProviderTotals.get(providerKey);
        const byTool = {};
        for (const [name, bucket] of providerTools.entries()) {
            byTool[name] = { ...bucket };
        }
        byProviderKey[providerKey] = {
            providerKey: totals?.providerKey ?? providerKey,
            model: totals?.model,
            totalCalls: totals?.totalCalls ?? 0,
            totalResponses: totals?.totalResponses ?? 0,
            byToolName: byTool
        };
    }
    return {
        totalCalls: options.totalToolCalls,
        totalResponses: options.totalToolResponses,
        byToolName,
        byProviderKey
    };
}
export function logToolSummary(snapshot, formatLabel) {
    if (!snapshot || snapshot.totalCalls <= 0) {
        return;
    }
    console.log('\n[Stats] Tools:');
    console.log('  total tool calls : %d (responses with tools=%d)', snapshot.totalCalls, snapshot.totalResponses);
    const sorted = Object.values(snapshot.byToolName)
        .sort((a, b) => b.callCount - a.callCount)
        .slice(0, 10);
    if (sorted.length) {
        console.log('  top tools:');
        for (const bucket of sorted) {
            console.log('    %s → calls=%d responses=%d', bucket.toolName, bucket.callCount, bucket.responseCount);
        }
    }
    const providerEntries = Object.values(snapshot.byProviderKey ?? {});
    if (providerEntries.length) {
        console.log('  by provider:');
        const sortedProviders = providerEntries
            .slice()
            .sort((a, b) => b.totalCalls - a.totalCalls)
            .slice(0, 10);
        for (const provider of sortedProviders) {
            const label = formatLabel(provider.providerKey, provider.model);
            console.log('    %s → calls=%d responses=%d', label, provider.totalCalls, provider.totalResponses);
        }
    }
}
export function logHistoricalToolSummary(toolAggregate, toolByProvider, formatLabel) {
    if (toolAggregate.size === 0) {
        return;
    }
    const totalCalls = Array.from(toolAggregate.values()).reduce((sum, bucket) => sum + bucket.callCount, 0);
    const totalResponses = Array.from(toolAggregate.values()).reduce((sum, bucket) => sum + bucket.responseCount, 0);
    console.log('\n[Stats] Historical tools summary (total calls=%d, responses with tools=%d)', totalCalls, totalResponses);
    const sorted = Array.from(toolAggregate.values())
        .sort((a, b) => b.callCount - a.callCount)
        .slice(0, 10);
    if (sorted.length) {
        console.log('  top tools:');
        for (const bucket of sorted) {
            console.log('    %s → calls=%d responses=%d', bucket.toolName, bucket.callCount, bucket.responseCount);
        }
    }
    if (toolByProvider.size) {
        console.log('  by provider:');
        const entries = Array.from(toolByProvider.entries()).sort((a, b) => a[0].localeCompare(b[0]));
        for (const [, bucket] of entries) {
            const label = formatLabel(bucket.providerKey, bucket.model);
            console.log('    %s → calls=%d responses=%d', label, bucket.totalCalls, bucket.totalResponses);
        }
    }
}
export function mergeToolAggregate(toolAggregate, toolByProvider, tools) {
    for (const bucket of Object.values(tools.byToolName ?? {})) {
        if (!bucket || !bucket.toolName) {
            continue;
        }
        const existing = toolAggregate.get(bucket.toolName);
        if (!existing) {
            toolAggregate.set(bucket.toolName, { ...bucket });
        }
        else {
            existing.callCount += bucket.callCount;
            existing.responseCount += bucket.responseCount;
            if (bucket.firstSeenAt < existing.firstSeenAt) {
                existing.firstSeenAt = bucket.firstSeenAt;
            }
            if (bucket.lastSeenAt > existing.lastSeenAt) {
                existing.lastSeenAt = bucket.lastSeenAt;
            }
        }
    }
    for (const providerRecord of Object.values(tools.byProviderKey ?? {})) {
        if (!providerRecord || !providerRecord.providerKey) {
            continue;
        }
        const providerKey = providerRecord.providerKey;
        const bucketKey = composeBucketKey(providerKey, providerRecord.model);
        const entry = toolByProvider.get(bucketKey) ?? {
            providerKey,
            model: providerRecord.model,
            totalCalls: 0,
            totalResponses: 0,
            byToolName: new Map()
        };
        entry.totalCalls += providerRecord.totalCalls ?? 0;
        entry.totalResponses += providerRecord.totalResponses ?? 0;
        for (const toolBucket of Object.values(providerRecord.byToolName ?? {})) {
            if (!toolBucket || !toolBucket.toolName) {
                continue;
            }
            const existing = entry.byToolName.get(toolBucket.toolName);
            if (!existing) {
                entry.byToolName.set(toolBucket.toolName, { ...toolBucket });
            }
            else {
                existing.callCount += toolBucket.callCount;
                existing.responseCount += toolBucket.responseCount;
                if (toolBucket.firstSeenAt < existing.firstSeenAt) {
                    existing.firstSeenAt = toolBucket.firstSeenAt;
                }
                if (toolBucket.lastSeenAt > existing.lastSeenAt) {
                    existing.lastSeenAt = toolBucket.lastSeenAt;
                }
            }
        }
        toolByProvider.set(bucketKey, entry);
    }
}
function canonicalizeToolNameForStats(rawName) {
    if (typeof rawName !== 'string') {
        return '';
    }
    const trimmed = rawName.trim();
    if (!trimmed) {
        return '';
    }
    const withoutFunctionsPrefix = trimmed.toLowerCase().startsWith('functions.')
        ? trimmed.slice('functions.'.length).trim()
        : trimmed;
    if (!withoutFunctionsPrefix) {
        return '';
    }
    switch (withoutFunctionsPrefix.toLowerCase()) {
        case 'execute_command':
        case 'execute-command':
        case 'shell_command':
        case 'shell':
        case 'bash':
        case 'terminal':
            return 'exec_command';
        default:
            return withoutFunctionsPrefix;
    }
}
export function extractToolCalls(payload) {
    if (!payload || typeof payload !== 'object') {
        return [];
    }
    const record = payload;
    const calls = [];
    const seenIds = new Set();
    const addCall = (nameRaw, idRaw) => {
        const name = canonicalizeToolNameForStats(nameRaw);
        if (!name) {
            return;
        }
        const id = typeof idRaw === 'string' && idRaw.trim() ? idRaw.trim() : undefined;
        if (id && seenIds.has(id)) {
            return;
        }
        if (id) {
            seenIds.add(id);
        }
        calls.push({ name, ...(id ? { id } : {}) });
    };
    const toolCalls = (record.tool_calls ??
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        record.required_action?.submit_tool_outputs?.tool_calls);
    if (Array.isArray(toolCalls)) {
        for (const toolCall of toolCalls) {
            if (!toolCall || typeof toolCall !== 'object') {
                continue;
            }
            const toolRec = toolCall;
            const fn = toolRec.function;
            addCall(fn?.name ?? toolRec.name, toolRec.id ?? toolRec.call_id ?? toolRec.tool_call_id);
        }
    }
    const output = record.output;
    if (Array.isArray(output)) {
        for (const entry of output) {
            if (!entry || typeof entry !== 'object') {
                continue;
            }
            const node = entry;
            const type = typeof node.type === 'string' ? node.type.trim().toLowerCase() : '';
            if (type === 'function_call' || type === 'tool_call' || type === 'function') {
                addCall(node.name ?? node.tool_name ??
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    node.function?.name, node.call_id ?? node.id);
            }
            if (Array.isArray(node.content)) {
                for (const contentItem of node.content) {
                    if (!contentItem || typeof contentItem !== 'object') {
                        continue;
                    }
                    const contentNode = contentItem;
                    const contentType = typeof contentNode.type === 'string' ? contentNode.type.trim().toLowerCase() : '';
                    if (contentType === 'tool_call' || contentType === 'function_call') {
                        addCall(contentNode.name ?? contentNode.tool_name ??
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            contentNode.function?.name, contentNode.call_id ?? contentNode.id);
                    }
                }
            }
        }
    }
    const choices = record.choices;
    if (Array.isArray(choices)) {
        for (const choice of choices) {
            if (!choice || typeof choice !== 'object') {
                continue;
            }
            const message = choice.message;
            if (!message || typeof message !== 'object') {
                continue;
            }
            const toolCallsNode = message.tool_calls;
            if (Array.isArray(toolCallsNode)) {
                for (const toolCall of toolCallsNode) {
                    if (!toolCall || typeof toolCall !== 'object') {
                        continue;
                    }
                    const toolRec = toolCall;
                    const fn = toolRec.function;
                    addCall(fn?.name ?? toolRec.name, toolRec.id ?? toolRec.tool_call_id);
                }
            }
        }
    }
    return calls;
}
export function mergeSnapshotIntoHistorical(options) {
    const snapshot = options.snapshot;
    if (!snapshot) {
        return {
            historicalSnapshotCount: options.historicalSnapshotCount,
            historicalSampleCount: options.historicalSampleCount
        };
    }
    let historicalSnapshotCount = options.historicalSnapshotCount + 1;
    let historicalSampleCount = options.historicalSampleCount;
    const totals = Array.isArray(snapshot.totals) ? snapshot.totals : [];
    let snapshotSamples = 0;
    for (const bucket of totals) {
        const key = composeBucketKey(bucket.providerKey, bucket.model);
        const existing = options.historicalBuckets.get(key);
        const promptTokens = bucket.totalPromptTokens ?? 0;
        const completionTokens = bucket.totalCompletionTokens ?? 0;
        const outputTokens = bucket.totalOutputTokens ?? 0;
        const latency = bucket.totalLatencyMs ?? 0;
        const firstAt = typeof bucket.firstRequestAt === 'number' ? bucket.firstRequestAt : Date.now();
        const lastAt = typeof bucket.lastRequestAt === 'number' ? bucket.lastRequestAt : Date.now();
        if (!existing) {
            options.historicalBuckets.set(key, {
                providerKey: bucket.providerKey,
                providerType: bucket.providerType,
                model: bucket.model,
                requestCount: bucket.requestCount ?? 0,
                errorCount: bucket.errorCount ?? 0,
                totalLatencyMs: latency,
                totalPromptTokens: promptTokens,
                totalCompletionTokens: completionTokens,
                totalOutputTokens: outputTokens,
                firstRequestAt: firstAt,
                lastRequestAt: lastAt
            });
        }
        else {
            existing.requestCount += bucket.requestCount ?? 0;
            existing.errorCount += bucket.errorCount ?? 0;
            existing.totalLatencyMs += latency;
            existing.totalPromptTokens += promptTokens;
            existing.totalCompletionTokens += completionTokens;
            existing.totalOutputTokens += outputTokens;
            if (firstAt < existing.firstRequestAt) {
                existing.firstRequestAt = firstAt;
            }
            if (lastAt > existing.lastRequestAt) {
                existing.lastRequestAt = lastAt;
            }
        }
        snapshotSamples += bucket.requestCount ?? 0;
    }
    historicalSampleCount += snapshotSamples;
    if (snapshot.tools && typeof snapshot.tools === 'object') {
        mergeToolAggregate(options.historicalToolAggregate, options.historicalToolByProvider, snapshot.tools);
    }
    return { historicalSnapshotCount, historicalSampleCount };
}
export function logHistoricalFromMemory(options) {
    if (!options.historicalBuckets.size) {
        console.log('[Stats] No historical provider activity recorded');
        return;
    }
    console.log('\n[Stats][historical] Provider summary (snapshots=%d · samples=%d)', options.historicalSnapshotCount, options.historicalSampleCount);
    const sorted = Array.from(options.historicalBuckets.values()).sort((a, b) => a.providerKey.localeCompare(b.providerKey));
    logProviderSummaryTable(sorted.map((bucket) => buildHistoricalProviderRow(bucket)), true);
    logHistoricalToolSummary(options.historicalToolAggregate, options.historicalToolByProvider, formatProviderLabel);
}
