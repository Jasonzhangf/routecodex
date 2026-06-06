import fs from 'node:fs';
import path from 'node:path';

export function createRequiredCoreOutputs(outDir) {
  return [
    path.join(outDir, 'conversion', 'hub', 'response', 'provider-response.js'),
    path.join(outDir, 'router', 'virtual-router', 'engine.js'),
    path.join(outDir, 'router', 'virtual-router', 'engine-selection', 'native-hub-pipeline-resp-semantics.js'),
  ];
}

export function distIsValid(outDir, requiredOutputs = createRequiredCoreOutputs(outDir)) {
  if (!fs.existsSync(outDir)) return false;
  return requiredOutputs.every(file => fs.existsSync(file));
}
