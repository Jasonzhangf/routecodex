import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const scripts = pkg.scripts || {};

const failures = [];

function assertIncludes(haystack, needle, failure) {
  if (!haystack.includes(needle)) {
    failures.push(failure);
  }
}

const buildDev = scripts['build:dev'] || '';
const buildDevFull = scripts['build:dev:full'] || '';
const installGlobal = scripts['install:global'] || '';
const installRelease = scripts['install:release'] || '';

assertIncludes(
  buildDev,
  'npm run build',
  'build:dev must invoke npm run build as the canonical build entry',
);
assertIncludes(
  buildDevFull,
  'npm run build',
  'build:dev:full must invoke npm run build as the canonical build entry',
);
assertIncludes(
  installGlobal,
  './scripts/install-global.sh',
  'install:global must route through ./scripts/install-global.sh',
);
assertIncludes(
  installRelease,
  './scripts/install-release.sh',
  'install:release must route through ./scripts/install-release.sh',
);

const installGlobalScript = fs.readFileSync(path.join(root, 'scripts/install-global.sh'), 'utf8');
const installReleaseScript = fs.readFileSync(path.join(root, 'scripts/install-release.sh'), 'utf8');

assertIncludes(
  installGlobalScript,
  'npm run build:min',
  'scripts/install-global.sh must build through npm run build:min',
);
assertIncludes(
  installReleaseScript,
  'npm run build:min',
  'scripts/install-release.sh must build through npm run build:min',
);

if (failures.length > 0) {
  console.error('[verify:build-script-tiering] failed');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('[verify:build-script-tiering] ok');
console.log('- build:dev and build:dev:full route through npm run build');
console.log('- install scripts route through build:min');
