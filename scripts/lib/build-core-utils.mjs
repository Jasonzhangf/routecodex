import fs from 'node:fs';
import path from 'node:path';

export function createRequiredCoreOutputs(outDir) {
  return [
    path.join(outDir, 'native', 'servertool-wrapper.js'),
    path.join(outDir, 'native', 'servertool-wrapper.d.ts'),
    path.join(outDir, 'native', 'router-hotpath', 'native-virtual-router-runtime.js'),
    path.join(outDir, 'native', 'router-hotpath', 'native-hub-pipeline-resp-semantics.js'),
  ];
}

export function distIsValid(outDir, requiredOutputs = createRequiredCoreOutputs(outDir)) {
  if (!fs.existsSync(outDir)) return false;
  return requiredOutputs.every(file => fs.existsSync(file));
}
