// Local unit test for streaming textual tool extractor
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Prefer vendored core in workspace
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const corePath = path.resolve(__dirname, '../../vendor/rcc-llmswitch-core/dist/v2/conversion/shared/streaming-text-extractor.js');
const { createStreamingToolExtractor } = await import('file://' + corePath);

const extractor = createStreamingToolExtractor({ idPrefix: 'test' });

function testCase(name, chunks) {
  extractor.reset();
  let all = [];
  for (const c of chunks) {
    const out = extractor.feedText(c);
    all = all.concat(out);
  }
  console.log(`CASE: ${name}`);
  for (const tc of all) {
    console.log(' tool_call:', JSON.stringify(tc));
  }
  if (all.length === 0) {
    throw new Error(`No tool_calls extracted for case: ${name}`);
  }
}

// rcc.tool.v1 JSON (skipped in this quick smoke; covered by compat-post replay)

// <function=execute>
testCase('function_execute', [
  '<function=execute>\n<parameter=command>bash -lc "ls -la"</parameter>\n</function=execute>'
]);

// unified diff (apply_patch)
testCase('apply_patch', [
  '*** Begin Patch\n*** Add File: hello.txt\n+Hello\n*** End Patch\n'
]);

console.log('OK: streaming extractor produced tool_calls for all cases');
