# Transparent 429 Failover Strategy Plan

## Objective
Implement a transparent failover strategy for 429 (Too Many Requests) and other recoverable errors within the `RouteCodexHttpServer`. Instead of returning the error to the client and relying on client-side retries, the server should automatically switch to the next available provider and retry the request internally.

## Current Behavior
1. `executePipeline` runs the Hub Pipeline to select a provider.
2. It attempts to send the request via `handle.instance.processIncoming`.
3. If the provider returns a 429 error, the error is caught, reported via `emitProviderError`, and then re-thrown.
4. The Express error handler catches the re-thrown error and sends an error response to the client.
5. The Virtual Router updates its state (via `emitProviderError`), so the *next* client request is routed differently, but the *current* request fails.

## Proposed Strategy
Modify `executePipeline` in `src/server/runtime/http-server/index.ts` to implement an internal retry loop.

### implementation Details

#### 1. Retry Loop in `executePipeline`
Wrap the pipeline execution and provider sending logic in a loop that allows for a configurable number of retries (e.g., 3 attempts).

```typescript
// Conceptual Logic
let attempts = 0;
const maxAttempts = 3;
const excludedProviders = new Set<string>();

while (attempts < maxAttempts) {
  attempts++;
  try {
    // 1. Run Pipeline (Selection)
    // Pass excludedProviders to metadata to hint the router to avoid them
    // (Requires verification that HubPipeline respects 'excludedProviders' or 'blacklist' in metadata)
    const pipelineResult = await this.runHubPipeline(input, { 
      ...metadata,
      excludedProviders: Array.from(excludedProviders) 
    });

    // 2. Prepare Provider
    // ... (existing preparation logic) ...

    // 3. Send to Provider
    const response = await handle.instance.processIncoming(providerPayload);
    
    // Success - return response
    return convertedResponse;

  } catch (error) {
    // 4. Error Handling & Failover Decision
    const status = this.extractResponseStatus(error) || error.status;
    const isRateLimit = status === 429 || error.code === '429';

    // Verify if we should retry
    if (isRateLimit && attempts < maxAttempts) {
      // Log the internal failover
      this.logStage('provider.failover', input.requestId, { ... });
      
      // Report error to update Router health state
      emitProviderError({ ... });
      
      // Add current provider to exclusion list for next iteration
      if (target?.providerKey) {
        excludedProviders.add(target.providerKey);
      }
      
      // Continue to next loop iteration
      continue;
    }
    
    // If not retryable or exhausted, re-throw (existing behavior)
    throw error;
  }
}
```

#### 2. Metadata Handling
Ensure that `runHubPipeline` and the underlying `llmswitch-core` Hub Pipeline can accept an exclusion list. If direct support is missing, we rely on the `emitProviderError` call, which should update the Virtual Router's health state (marking the node as unhealthy/rate-limited). The subsequent `runHubPipeline` call should then naturally pick a different healthy provider.

#### 3. Circuit Breaking
The `emitProviderError` function already integrates with `providerErrorCenter`. We must ensure that 429 errors trigger a temporary "unhealthy" status in the router's load balancer so that the failing provider is skipped in the immediate retry.

### Risks & Mitigations
*   **Infinite Loops**: Strict `maxAttempts` counter prevents indefinite loops.
*   **Latency**: Retries add latency. We should ensure the `attempts` cap is low (e.g., 3) to fail fast if all providers are busy.
*   **State Propagation**: If `emitProviderError` is async or slow to update the Router state, the retry might pick the same provider. Passing `excludedProviders` in metadata is the robust fix, assuming Router support.

## Next Steps
1.  Verify if `HubPipeline.execute` supports `excludedProviders` or `blacklist` in input metadata.
2.  Implement the retry loop in `src/server/runtime/http-server/index.ts`.
3.  Test with a mock provider simulating 429s to verify failover behavior.
