#!/usr/bin/env node

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runReqOutboundStage3Compat } from '../../dist/conversion/hub/pipeline/stages/req_outbound/req_outbound_stage3_compat/index.js'

function countMissingReasoning(messages) {
  const assistantToolCalls = (Array.isArray(messages) ? messages : []).filter(
    (msg) => msg && typeof msg === 'object' && msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0
  )
  const missing = assistantToolCalls.filter(
    (msg) => !(typeof msg.reasoning_content === 'string' && msg.reasoning_content.trim().length > 0)
  )
  return { total: assistantToolCalls.length, missing: missing.length }
}

async function runWithProvider(payload, providerId, suffix, compatibilityProfile) {
  return runReqOutboundStage3Compat({
    payload: structuredClone(payload),
    adapterContext: {
      requestId: `replay_${suffix}_${Date.now()}`,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-chat',
      providerId,
      ...(compatibilityProfile ? { compatibilityProfile } : {})
    }
  })
}

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const fixturePath = path.join(here, '../../tests/fixtures/compat/iflow-reasoning-missing-sample-20260206.json')
  const fixture = JSON.parse(await fs.readFile(fixturePath, 'utf8'))

  const before = countMissingReasoning(fixture.payload.messages)
  assert.ok(before.total > 0, 'fixture must contain assistant tool_call messages')
  assert.ok(before.missing > 0, 'fixture must include missing reasoning_content before compat')

  const iflowOut = await runWithProvider(fixture.payload, fixture.providerId, 'iflow', 'chat:iflow')
  const iflowCounts = countMissingReasoning(iflowOut.messages)
  assert.equal(iflowCounts.total, before.total, 'iflow replay should preserve assistant tool_call count')
  assert.equal(iflowOut?.thinking?.type, 'enabled', 'iflow replay should normalize top-level thinking to enabled')
  assert.equal(
    iflowCounts.missing,
    0,
    'iflow replay should repair missing reasoning_content for assistant tool_call messages'
  )

  const controlOut = await runWithProvider(fixture.payload, fixture.controlProviderId, 'control', undefined)
  const controlCounts = countMissingReasoning(controlOut.messages)
  assert.equal(controlCounts.missing, before.missing, 'control provider should not receive iflow-specific transforms')

  console.log(
    '[matrix:compat-iflow-reasoning-replay-20260206] ok',
    JSON.stringify({
      requestId: fixture.requestId,
      beforeMissing: before.missing,
      afterIflowMissing: iflowCounts.missing,
      afterControlMissing: controlCounts.missing,
      thinkingMode: iflowOut?.thinking ?? null
    })
  )
}

main().catch((err) => {
  console.error('[matrix:compat-iflow-reasoning-replay-20260206] failed', err)
  process.exit(1)
})
