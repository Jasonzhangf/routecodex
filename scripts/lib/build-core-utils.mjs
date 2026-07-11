import fs from 'node:fs';
import path from 'node:path';

export function createRequiredCoreOutputs(outDir) {
  return [
    path.join(outDir, 'native', 'router_hotpath_napi.node'),
  ];
}

export function distIsValid(outDir, requiredOutputs = createRequiredCoreOutputs(outDir)) {
  if (!fs.existsSync(outDir)) return false;
  return requiredOutputs.every(file => fs.existsSync(file));
}
