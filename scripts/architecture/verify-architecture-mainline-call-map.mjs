import { validateMainlineCallMap } from './mainline-call-map-lib.mjs';

const root = process.cwd();
const { failures, parsed } = validateMainlineCallMap(root);

if (failures.length > 0) {
  console.error('[verify:architecture-mainline-call-map] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

const edgeCount = (parsed?.chains ?? []).reduce((sum, chain) => sum + (chain.edges?.length ?? 0), 0);
console.log('[verify:architecture-mainline-call-map] ok');
console.log(`- chains: ${(parsed?.chains ?? []).length}`);
console.log(`- edges: ${edgeCount}`);
console.log(`- shared functions: ${(parsed?.shared_multi_reference_functions ?? []).length}`);
