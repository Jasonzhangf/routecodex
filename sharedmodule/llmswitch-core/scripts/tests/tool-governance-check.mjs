#!/usr/bin/env node

import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import chalk from 'chalk';

const DIST_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'dist');
const chalkError = typeof chalk?.redBright === 'function' ? chalk.redBright : (value) => value;

async function loadEngine() {
  const mod = await import(
    pathToFileURL(path.join(DIST_ROOT, 'conversion', 'hub', 'tool-governance', 'index.js')).href
  );
  return new mod.ToolGovernanceEngine();
}

async function loadToolRegistry() {
  return import(pathToFileURL(path.join(DIST_ROOT, 'tools', 'tool-registry.js')).href);
}

function buildApplyPatchArgsWithConcatenation(field) {
  const patch = `*** Begin Patch
*** Delete File: .apply_patch_escape_test.txt
*** End Patch`;
  const stitched = `${patch}\\",\\"${field}\\":\\"*** Begin Patch
*** Delete File: .apply_patch_escape_test.txt
*** End Patch`;
  return JSON.stringify({ patch: stitched, input: stitched });
}

function escapeNewlines(value) {
  return String(value || '').replace(/\n/g, '\\n');
}

function buildStandardizedRequest(longName) {
  return {
    model: 'gpt-tool-governance',
    messages: [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_0',
            type: 'function',
            function: {
              name: longName,
              arguments: '{"ping":true}'
            }
          }
        ]
      },
      {
        role: 'tool',
        tool_call_id: 'call_0',
        name: longName,
        content: 'ok'
      }
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: longName,
          description: 'governance demo tool',
          parameters: {
            type: 'object',
            properties: {},
            additionalProperties: true
          }
        }
      }
    ],
    parameters: {},
    metadata: {
      originalEndpoint: '/v1/chat/completions'
    }
  };
}

function buildChatCompletion(longName) {
  return {
    id: 'chatcmpl-tool-governance',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'gpt-tool',
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_0',
              type: 'function',
              function: {
                name: longName,
                arguments: '{"echo":true}'
              }
            }
          ]
        }
      }
    ]
  };
}

try {
  const engine = await loadEngine();
  const { validateToolCall } = await loadToolRegistry();
  const longName = 'x'.repeat(120);

  const request = buildStandardizedRequest(longName);
  const { request: governedRequest, summary: requestSummary } = engine.governRequest(
    request,
    'openai-responses'
  );
  const governedToolName = governedRequest.tools?.[0]?.function?.name ?? '';
  assert.ok(governedToolName.length <= 64, 'request tool name should be truncated to 64 chars');
  assert.ok(
    governedRequest.messages[0]?.tool_calls?.[0]?.function?.name?.length <= 64,
    'request tool call name should be truncated'
  );
  console.log('🧪 Tool governance (request) summary:', requestSummary);

  const response = buildChatCompletion(longName);
  const { payload: governedResponse, summary: responseSummary } = engine.governResponse(
    response,
    'openai-responses'
  );
  const governedResponseName =
    governedResponse?.choices?.[0]?.message?.tool_calls?.[0]?.function?.name ?? '';
  assert.ok(
    governedResponseName.length <= 64,
    'response tool name should be truncated for client payload'
  );
  console.log('🧪 Tool governance (response) summary:', responseSummary);

  for (const field of ['input', 'patch']) {
    const argsString = buildApplyPatchArgsWithConcatenation(field);
    const validation = validateToolCall('apply_patch', argsString);
    assert.ok(validation.ok, `apply_patch args should validate when concatenation targets "${field}"`);
    assert.ok(validation.normalizedArgs, 'apply_patch should produce normalizedArgs');
    const normalized = JSON.parse(validation.normalizedArgs);
    assert.equal(normalized.patch, normalized.input, 'apply_patch normalized patch/input should match');
    assert.ok(normalized.patch.startsWith('*** Begin Patch'), 'apply_patch normalized patch should start with header');
    assert.ok(normalized.patch.endsWith('*** End Patch'), 'apply_patch normalized patch should end with footer');
    assert.ok(
      !normalized.patch.includes('*** End Patch","input":"*** Begin Patch'),
      'apply_patch normalized patch should not include a stitched input field'
    );
    assert.ok(
      !normalized.patch.includes('*** End Patch","patch":"*** Begin Patch'),
      'apply_patch normalized patch should not include a stitched patch field'
    );
    assert.ok(
      !normalized.patch.includes('*** End Patch\\\\",\\\\"input\\\\":\\\\"*** Begin Patch'),
      'apply_patch normalized patch should not include escaped stitched input field'
    );
    assert.ok(
      !normalized.patch.includes('*** End Patch\\\\",\\\\"patch\\\\":\\\\"*** Begin Patch'),
      'apply_patch normalized patch should not include escaped stitched patch field'
    );
  }

  // Regression: tolerate <arg_key>/<arg_value> artifacts stitched into string fields.
  // Some upstream responses may include these markers inside a JSON string value.
  {
    const patch = `*** Begin Patch
*** Delete File: .apply_patch_escape_test.txt
*** End Patch`;
    const injected = `${patch}</arg_key><arg_value>input</arg_key><arg_value>${patch}`;
    const validation = validateToolCall('apply_patch', JSON.stringify({ patch: injected }));
    assert.ok(validation.ok, 'apply_patch should validate when patch string contains arg_key artifacts');
    const normalized = JSON.parse(validation.normalizedArgs);
    assert.equal(normalized.patch, normalized.input, 'apply_patch patch/input should match after normalization');
    assert.ok(
      !normalized.patch.includes('</arg_key><arg_value>'),
      'apply_patch normalized patch should not include arg_key artifacts'
    );
  }

  // Regression: tolerate <arg_key>/<arg_value> artifacts injected into JSON key positions.
  {
    const injectedJson =
      '{"file":"a.ts","changes":[{"kind":"create_file","lines":["x"],"file</arg_key><arg_value>a.ts"}]}';
    const validation = validateToolCall('apply_patch', injectedJson);
    assert.ok(validation.ok, 'apply_patch should validate JSON with arg_key artifacts in keys');
    const normalized = JSON.parse(validation.normalizedArgs);
    assert.ok(typeof normalized.patch === 'string', 'normalized apply_patch should contain patch text');
  }


  // Regression: star-header unified diff should be normalized into apply_patch envelope.
  {
    const patch = `*** lib/utils/network/bandwidth_tier_strategy.dart
--- lib/utils/network/bandwidth_tier_strategy.dart
@@ -71,7 +71,7 @@
     this.stepDownMinLossFraction = 0.03,
-    this.minVideoBitrateKbps = 25,
+    this.minVideoBitrateKbps = 15,
     this.maxQualityBoostKbps = 1500,
   });`;
    const validation = validateToolCall('apply_patch', JSON.stringify({ patch }));
    assert.equal(validation.ok, true, 'star-header unified diff should validate');
    const normalized = JSON.parse(validation.normalizedArgs);
    assert.ok(normalized.patch.includes('*** Begin Patch'), 'normalized star-header diff should include begin marker');
    assert.ok(
      normalized.patch.includes('*** Update File: lib/utils/network/bandwidth_tier_strategy.dart'),
      'normalized star-header diff should include update file header'
    );
    assert.ok(normalized.patch.endsWith('*** End Patch'), 'normalized star-header diff should include end marker');
  }


  // Regression: star-header unified diff with escaped newlines should still be normalized.
  {
    const patch =
      '*** lib/utils/network/bandwidth_tier_strategy.dart\\n--- lib/utils/network/bandwidth_tier_strategy.dart\\n@@ -71,7 +71,7 @@\\n     this.stepDownMinLossFraction = 0.03,\\n-    this.minVideoBitrateKbps = 25,\\n+    this.minVideoBitrateKbps = 15,\\n     this.maxQualityBoostKbps = 1500,\\n   });';
    const validation = validateToolCall('apply_patch', JSON.stringify({ patch }));
    assert.equal(validation.ok, true, 'escaped-newline star-header unified diff should validate');
    const normalized = JSON.parse(validation.normalizedArgs);
    assert.ok(normalized.patch.includes('*** Begin Patch'), 'normalized escaped-newline diff should include begin marker');
    assert.ok(
      normalized.patch.includes('*** Update File: lib/utils/network/bandwidth_tier_strategy.dart'),
      'normalized escaped-newline diff should include update file header'
    );
    assert.ok(normalized.patch.endsWith('*** End Patch'), 'normalized escaped-newline diff should include end marker');
  }

  // Regression: command-envelope string should recover embedded apply_patch payload.
  {
    const commandEnvelope = '["apply_patch", "*** Begin Patch\n*** Add File: cmd-envelope-regression.txt\n+hello\n*** End Patch\n"]]';
    const validation = validateToolCall('apply_patch', JSON.stringify({ command: commandEnvelope }));
    assert.equal(validation.ok, true, 'command-envelope missing_changes shape should validate');
    const normalized = JSON.parse(validation.normalizedArgs);
    assert.ok(
      normalized.patch.includes('*** Add File: cmd-envelope-regression.txt'),
      'normalized patch should include recovered file header from command envelope'
    );
  }

  // Regression: malformed "Create File" header with trailing stars should be repaired.
  {
    const patch = `*** Create File: /tmp/analyze_cov.py ***
#!/usr/bin/env python3
import sys`;
    const validation = validateToolCall('apply_patch', JSON.stringify({ patch }));
    assert.equal(validation.ok, true, 'create file malformed header should validate');
    const normalized = JSON.parse(validation.normalizedArgs);
    assert.ok(normalized.patch.includes('*** Add File: /tmp/analyze_cov.py'), 'normalized patch should repair add file header');
    assert.ok(normalized.patch.includes('+#!/usr/bin/env python3'), 'normalized add file content should be + prefixed');
    assert.ok(normalized.patch.includes('+import sys'), 'normalized add file content should keep all lines');
  }

  // Regression: top-level 'target' should be treated as file path alias when changes exist.
  {
    const args = JSON.stringify({
      target: 'scripts/xiaohongshu/tests/phase1-4-full-collect.mjs',
      changes: [
        {
          kind: 'replace',
          target: 'const oldLine = 1;',
          lines: 'const newLine = 1;'
        }
      ]
    });
    const validation = validateToolCall('apply_patch', args);
    assert.equal(validation.ok, true, 'top-level target should be mapped to file path');
    const normalized = JSON.parse(validation.normalizedArgs);
    assert.ok(
      normalized.patch.includes('*** Update File: scripts/xiaohongshu/tests/phase1-4-full-collect.mjs'),
      'normalized patch should include update file header from top-level target'
    );
  }

  // Regression: conflict-marker payload with top-level path should be coerced into replace patch.
  {
    const args = JSON.stringify({
      path: 'src/providers/core/runtime/gemini-cli-http-provider.ts',
      patch: [
        '<<<<<<< ORIGINAL',
        "console.log('old')",
        '=======',
        "console.log('new')",
        '>>>>>>> UPDATED'
      ].join('\n')
    });
    const validation = validateToolCall('apply_patch', args);
    assert.equal(validation.ok, true, 'conflict-marker payload with path should validate');
    const normalized = JSON.parse(validation.normalizedArgs);
    assert.ok(
      normalized.patch.includes('*** Update File: src/providers/core/runtime/gemini-cli-http-provider.ts'),
      'conflict-marker payload should map to update file header'
    );
    assert.ok(normalized.patch.includes("-console.log('old')"), 'conflict-marker payload should keep original line');
    assert.ok(normalized.patch.includes("+console.log('new')"), 'conflict-marker payload should keep updated line');
  }

  {
    const addBasic = [
      '*** Begin Patch',
      '*** Add File: .apply_patch_basic_add.txt',
      '+apply_patch basic add ok',
      '+line2',
      '*** End Patch'
    ].join('\n');
    const updateBasic = [
      '*** Begin Patch',
      '*** Update File: .apply_patch_basic_add.txt',
      '@@',
      '-apply_patch basic add ok',
      '+apply_patch basic add+update ok',
      ' line2',
      '*** End Patch'
    ].join('\n');
    const appendBasic = [
      '*** Begin Patch',
      '*** Update File: .apply_patch_basic_add.txt',
      '@@',
      ' apply_patch basic add+update ok',
      ' line2',
      '+line3 (append)',
      '*** End Patch'
    ].join('\n');
    const addEscapeChars = [
      '*** Begin Patch',
      '*** Add File: .apply_patch_escape_chars.txt',
      '+quotes: "double" and \'single\'',
      '+backslash: \\',
      '+json: {"a":1,"b":"x"}',
      '+template: ${notInterpolated}',
      '*** End Patch'
    ].join('\n');
    const addMulti = [
      '*** Begin Patch',
      '*** Add File: .apply_patch_multi_hunk.txt',
      '+Header',
      '+Section A',
      '+Section B',
      '+Footer',
      '*** End Patch'
    ].join('\n');
    const updateMulti = [
      '*** Begin Patch',
      '*** Update File: .apply_patch_multi_hunk.txt',
      '@@',
      ' Header',
      '-Section A',
      '+Section A (updated)',
      ' Section B',
      ' Footer',
      '@@',
      ' Header',
      ' Section A (updated)',
      '-Section B',
      '+Section B (updated)',
      ' Footer',
      '*** End Patch'
    ].join('\n');
    const deleteBasic = [
      '*** Begin Patch',
      '*** Delete File: .apply_patch_basic_add.txt',
      '*** End Patch'
    ].join('\n');
    const deleteEscapeChars = [
      '*** Begin Patch',
      '*** Delete File: .apply_patch_escape_chars.txt',
      '*** End Patch'
    ].join('\n');
    const deleteMulti = [
      '*** Begin Patch',
      '*** Delete File: .apply_patch_multi_hunk.txt',
      '*** End Patch'
    ].join('\n');

    const cases = [
      ['seq_basic_add', addBasic],
      ['seq_basic_update', updateBasic],
      ['seq_basic_append', appendBasic],
      ['seq_escape_chars', addEscapeChars],
      ['seq_multi_add', addMulti],
      ['seq_multi_update', updateMulti],
      ['seq_basic_delete', deleteBasic],
      ['seq_escape_chars_delete', deleteEscapeChars],
      ['seq_multi_delete', deleteMulti]
    ];

    for (const [label, patchText] of cases) {
      for (const [variant, argsString] of [
        ['text', patchText],
        ['json', JSON.stringify({ patch: patchText, input: patchText })],
        ['json_escaped_newlines', JSON.stringify({ patch: escapeNewlines(patchText), input: escapeNewlines(patchText) })]
      ]) {
        const validation = validateToolCall('apply_patch', argsString);
        assert.ok(validation.ok, `${label}:${variant} should validate`);
        const normalized = JSON.parse(validation.normalizedArgs);
        assert.equal(normalized.patch, normalized.input, `${label}:${variant} patch/input should match`);
        assert.ok(normalized.patch.startsWith('*** Begin Patch'), `${label}:${variant} should keep Begin Patch`);
        assert.ok(normalized.patch.endsWith('*** End Patch'), `${label}:${variant} should keep End Patch`);
      }
    }
  }

  console.log('✅ tool governance checks passed');
} catch (error) {
  const msg = error instanceof Error ? (error.stack || error.message) : String(error ?? '');
  console.error(chalkError('❌ tool governance check failed:'));
  console.error(chalkError(msg));
  process.exit(1);
}
