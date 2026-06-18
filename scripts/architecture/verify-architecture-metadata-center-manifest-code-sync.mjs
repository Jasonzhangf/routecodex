import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const root = process.cwd();
const manifestPath = 'docs/architecture/metadata-center-manifest.yml';
const typesPath = 'src/server/runtime/http-server/metadata-center/metadata-center-types.ts';
const centerPath = 'src/server/runtime/http-server/metadata-center/metadata-center.ts';

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

function pascalCaseFamily(family) {
  return String(family)
    .split('_')
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join('');
}

function camelCaseFamily(family) {
  const pascal = pascalCaseFamily(family);
  return `${pascal[0].toLowerCase()}${pascal.slice(1)}`;
}

function extractTypeBody(source, typeName) {
  const pattern = new RegExp(`export\\s+type\\s+${typeName}\\s*=\\s*\\{([\\s\\S]*?)\\};`, 'u');
  const match = source.match(pattern);
  return match ? match[1] : '';
}

function hasSlot(typeBody, slot) {
  return new RegExp(`\\b${slot}\\?\\s*:`, 'u').test(typeBody);
}

function methodName(prefix, family) {
  return `${prefix}${pascalCaseFamily(family)}`;
}

const manifest = YAML.parse(read(manifestPath));
const typesSource = read(typesPath);
const centerSource = read(centerPath);
const failures = [];

const families = manifest?.families && typeof manifest.families === 'object'
  ? manifest.families
  : {};

for (const [family, config] of Object.entries(families)) {
  const slots = Array.isArray(config?.slots) ? config.slots : [];
  if (slots.length === 0) {
    failures.push(`${manifestPath}: family ${family} has no slots`);
    continue;
  }

  if (!typesSource.includes(`| '${family}'`)) {
    failures.push(`${typesPath}: MetadataCenterFamily missing ${family}`);
  }

  const typeName = `MetadataCenter${pascalCaseFamily(family)}`;
  const typeBody = extractTypeBody(typesSource, typeName);
  if (!typeBody) {
    failures.push(`${typesPath}: missing exported type ${typeName}`);
  } else {
    for (const slot of slots) {
      if (!hasSlot(typeBody, slot)) {
        failures.push(`${typesPath}: ${typeName} missing slot ${slot}`);
      }
    }
  }

  const stateKey = camelCaseFamily(family);
  if (!new RegExp(`\\b${stateKey}:\\s*Partial<Record<keyof ${typeName}, MetadataCenterSlot>>`, 'u').test(typesSource)) {
    failures.push(`${typesPath}: MetadataCenterState missing ${stateKey} keyed by ${typeName}`);
  }
  if (!new RegExp(`${stateKey}:\\s*\\{\\}`, 'u').test(centerSource)) {
    failures.push(`${centerPath}: constructor missing state initializer for ${stateKey}`);
  }

  const writeMethod = methodName('write', family);
  const readMethod = methodName('read', family);
  if (!new RegExp(`\\b${writeMethod}<K extends keyof ${typeName}>`, 'u').test(centerSource)) {
    failures.push(`${centerPath}: missing writer ${writeMethod}<K extends keyof ${typeName}>`);
  }
  if (!new RegExp(`\\b${readMethod}\\(\\): ${typeName}`, 'u').test(centerSource)) {
    failures.push(`${centerPath}: missing reader ${readMethod}(): ${typeName}`);
  }
  if (!new RegExp(`family:\\s*'${family}'`, 'u').test(centerSource)) {
    failures.push(`${centerPath}: writer for ${family} does not stamp family`);
  }
  if (!new RegExp(`Object\\.keys\\(this\\.state\\.${stateKey}\\)`, 'u').test(centerSource)) {
    failures.push(`${centerPath}: markReleased does not release ${stateKey}`);
  }
  for (const slot of slots) {
    if (!new RegExp(`\\b${slot}:\\s*this\\.state\\.${stateKey}\\.${slot}\\?\\.value`, 'u').test(centerSource)) {
      failures.push(`${centerPath}: ${readMethod} missing slot readback for ${slot}`);
    }
  }
}

const provenance = manifest?.provenance?.required_fields;
for (const requiredField of Array.isArray(provenance) ? provenance : []) {
  const token = String(requiredField).split('.').at(-1);
  if (token && !typesSource.includes(`${token}:`)) {
    failures.push(`${typesPath}: provenance required field not represented in slot/history types: ${requiredField}`);
  }
}

if (failures.length > 0) {
  console.error('[verify:architecture-metadata-center-manifest-code-sync] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:architecture-metadata-center-manifest-code-sync] ok');
console.log(`- manifest: ${manifestPath}`);
console.log(`- families: ${Object.keys(families).length}`);
