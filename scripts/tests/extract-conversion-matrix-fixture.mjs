#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

function arg(name, fallback = '') {
  const flag = `--${name}=`;
  const hit = process.argv.find((x) => x.startsWith(flag));
  return hit ? hit.slice(flag.length) : fallback;
}

const sourceDir = arg('source-dir');
const errorFile = arg('error-file');
const caseName = arg('case');
const date = new Date().toISOString().slice(0, 10);

if ((!sourceDir && !errorFile) || !caseName) {
  console.error(
    'Usage: node scripts/tests/extract-conversion-matrix-fixture.mjs --source-dir=<req_dir> --case=<case-slug> OR --error-file=<errorsample.json> --case=<case-slug>'
  );
  process.exit(1);
}

const outDir = path.join(process.cwd(), 'tests', 'fixtures', 'conversion-matrix', `${date}-${caseName}`);
fs.mkdirSync(outDir, { recursive: true });

function pickFirst(candidates) {
  for (const file of candidates) {
    const full = path.join(src, file);
    if (fs.existsSync(full)) return full;
  }
  return '';
}

if (errorFile) {
  const srcErr = path.resolve(errorFile);
  if (!fs.existsSync(srcErr)) {
    console.error(`error file not found: ${srcErr}`);
    process.exit(1);
  }
  const doc = JSON.parse(fs.readFileSync(srcErr, 'utf8'));
  fs.copyFileSync(srcErr, path.join(outDir, 'errorsample.json'));
  if (doc?.observation?.providerRequestPayload) {
    fs.writeFileSync(
      path.join(outDir, 'provider-request.json'),
      JSON.stringify({ body: doc.observation.providerRequestPayload }, null, 2)
    );
  }
  if (doc?.observation?.convertedResponse?.body || doc?.observation?.normalizedResponse?.body) {
    const body = doc?.observation?.convertedResponse?.body ?? doc?.observation?.normalizedResponse?.body;
    fs.writeFileSync(path.join(outDir, 'provider-response.json'), JSON.stringify({ body }, null, 2));
  }
} else {
  const src = path.resolve(sourceDir);
  if (!fs.existsSync(src)) {
    console.error(`source dir not found: ${src}`);
    process.exit(1);
  }
  const reqFile = pickFirst(['provider-request.json', 'provider-request_1.json']);
  const respFile = pickFirst(['provider-response.json', 'provider-response_1.json']);
  const runtimeFile = pickFirst(['__runtime.json']);
  if (!reqFile || !respFile) {
    console.error(`missing provider-request/provider-response in ${src}`);
    process.exit(1);
  }
  fs.copyFileSync(reqFile, path.join(outDir, 'provider-request.json'));
  fs.copyFileSync(respFile, path.join(outDir, 'provider-response.json'));
  if (runtimeFile) {
    fs.copyFileSync(runtimeFile, path.join(outDir, '__runtime.json'));
  }
}

const assertionsPath = path.join(outDir, 'assertions.json');
if (!fs.existsSync(assertionsPath)) {
  fs.writeFileSync(
    assertionsPath,
    JSON.stringify(
      {
        case: `${date}-${caseName}`,
        direction: ['request-roundtrip', 'response-roundtrip'],
        assert: {
          preserve_tools_when_tool_choice_requires: true,
          preserve_tool_choice_shape: true,
          preserve_tool_call_pairing: true
        }
      },
      null,
      2
    )
  );
}

console.log(`fixture extracted: ${outDir}`);
