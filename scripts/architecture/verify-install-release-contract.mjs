import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const script = fs.readFileSync(path.join(root, 'scripts/install-release.sh'), 'utf8');
const failures = [];

function requireText(label, text) {
  if (!script.includes(text)) failures.push(`missing ${label}: ${text}`);
}

requireText('V3 package version source', "require('./v3/package.json').version");
requireText('configured V3 server discovery', 'resolve_v3_verify_ports');
requireText('server table parsing', 'servers\\.');
requireText('fail-fast when no configured V3 listener exists', '无法从配置文件解析 V3 server listener');
requireText('all configured listener verification', 'for verify_port in "${VERIFY_PORTS[@]}"');

if (script.includes('ROUTECODEX_INSTALL_VERIFY_PORT:-5520')) {
  failures.push('V3 release verification must not default to V4 port 5520');
}
if (script.includes("require('./package.json').version")) {
  failures.push('release runtime version must not use the root package version');
}

if (failures.length > 0) {
  console.error('[verify:install-release-contract] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:install-release-contract] ok');
