import path from 'node:path';

const TOML_KEY_SOURCE = '(?:[A-Za-z0-9_-]+|"[^"\\n]+"|\'[^\'\\n]+\')';

function tomlKey(raw) {
  return raw.startsWith('"') || raw.startsWith("'") ? raw.slice(1, -1) : raw;
}

function dependencySection(section) {
  const aggregate = section.match(/^(?:target\..+\.)?((?:build-|dev-)?dependencies)$/);
  if (aggregate) return { kind: 'aggregate', dependency: null };
  const table = section.match(new RegExp(
    '^(?:target\\..+\\.)?(?:build-|dev-)?dependencies\\.(' + TOML_KEY_SOURCE + ')$',
  ));
  return table ? { kind: 'table', dependency: tomlKey(table[1]) } : null;
}

function rejectLocalOverrides(source, relativePath) {
  let section = '';
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '').trim();
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      continue;
    }
    if (/^(?:patch\..+|replace)(?:\.|$)/.test(section) && /\bpath\s*=/.test(line)) {
      throw new Error(`${relativePath}: local patch/replace dependency syntax is forbidden: ${line}`);
    }
  }
}

function parseInlineAttributes(body, relativePath, line) {
  const attributes = {};
  for (const match of body.matchAll(/(?:^|,)\s*([A-Za-z0-9_-]+)\s*=\s*("[^"]*"|true|false|[^,]+)\s*(?=,|$)/g)) {
    const raw = match[2].trim();
    attributes[match[1]] = raw.startsWith('"') ? raw.slice(1, -1) : raw;
  }
  if (/\b(path|workspace|package)\s*=/.test(body)
      && !['path', 'workspace', 'package'].every((key) =>
        !new RegExp(`\\b${key}\\s*=`).test(body) || key in attributes)) {
    throw new Error(`${relativePath}: unsupported dependency attributes: ${line}`);
  }
  return attributes;
}

function localDependency(relativePath, alias, attributes, workspaceDependencies) {
  let resolved = attributes;
  let workspaceRootRelative = false;
  if (attributes.workspace === 'true') {
    if (!workspaceDependencies.has(alias)) {
      throw new Error(`${relativePath}: unknown workspace dependency ${alias}`);
    }
    resolved = workspaceDependencies.get(alias);
    workspaceRootRelative = true;
  }
  if (!resolved?.path) return null;
  if (typeof resolved.path !== 'string'
      || resolved.path.length === 0
      || resolved.path.includes('\\')
      || /^(?:\/|[A-Za-z]:[\\/])/.test(resolved.path)) {
    throw new Error(`${relativePath}: local dependency path must remain relative inside V4: ${resolved.path}`);
  }
  const dependencyManifest = path.posix.normalize(workspaceRootRelative
    ? path.posix.join(resolved.path, 'Cargo.toml')
    : path.posix.join(path.posix.dirname(relativePath), resolved.path, 'Cargo.toml'));
  if (dependencyManifest.startsWith('../') || dependencyManifest.includes('/../')) {
    throw new Error(`${relativePath}: local dependency escapes V4: ${resolved.path}`);
  }
  return {
    dependency_name: resolved.package ?? alias,
    manifest_path: dependencyManifest,
  };
}

function parseWorkspaceDependencies(source) {
  rejectLocalOverrides(source, 'Cargo.toml');
  const dependencies = new Map();
  let section = '';
  let table = null;
  const flushTable = () => {
    if (table) dependencies.set(table.alias, table.attributes);
    table = null;
  };
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '').trim();
    if (!line) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      flushTable();
      section = sectionMatch[1];
      const tableMatch = section.match(new RegExp('^workspace\\.dependencies\\.(' + TOML_KEY_SOURCE + ')$'));
      if (tableMatch) table = { alias: tomlKey(tableMatch[1]), attributes: {} };
      continue;
    }
    if (section === 'workspace.dependencies') {
      const inline = line.match(new RegExp('^(' + TOML_KEY_SOURCE + ')\\s*=\\s*\\{([^}]*)\\}\\s*$'));
      if (!inline) continue;
      dependencies.set(tomlKey(inline[1]), parseInlineAttributes(inline[2], 'Cargo.toml', line));
    } else if (table) {
      const property = line.match(/^([A-Za-z0-9_-]+)\s*=\s*("[^"]*"|true|false)\s*$/);
      if (!property) throw new Error(`Cargo.toml: unsupported workspace dependency table syntax: ${line}`);
      table.attributes[property[1]] = property[2].startsWith('"')
        ? property[2].slice(1, -1)
        : property[2];
    }
  }
  flushTable();
  return dependencies;
}

function parseCargoManifest(relativePath, source, workspaceDependencies) {
  rejectLocalOverrides(source, relativePath);
  const packageNameMatch = source.match(/^\s*name\s*=\s*"([^"]+)"\s*$/m);
  if (!packageNameMatch) throw new Error(`${relativePath}: package name is missing`);
  const dependencies = [];
  let section = '';
  let table = null;
  const flushTable = () => {
    if (!table) return;
    const dependency = localDependency(relativePath, table.alias, table.attributes, workspaceDependencies);
    if (dependency) dependencies.push(dependency);
    table = null;
  };
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '').trim();
    if (!line) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      flushTable();
      section = sectionMatch[1];
      const parsedSection = dependencySection(section);
      if (parsedSection?.kind === 'table') {
        table = { alias: parsedSection.dependency, attributes: {} };
      }
      continue;
    }
    const parsedSection = dependencySection(section);
    if (parsedSection?.kind === 'aggregate') {
      const dependencyMatch = line.match(new RegExp('^(' + TOML_KEY_SOURCE + ')\\s*=\\s*\\{([^}]*)\\}\\s*$'));
      if (!dependencyMatch) {
        if (/\b(path|workspace)\s*=/.test(line)) {
          throw new Error(`${relativePath}: unsupported local dependency syntax: ${line}`);
        }
        continue;
      }
      const attributes = parseInlineAttributes(dependencyMatch[2], relativePath, line);
      const dependency = localDependency(
        relativePath, tomlKey(dependencyMatch[1]), attributes, workspaceDependencies,
      );
      if (dependency) dependencies.push(dependency);
    } else if (table) {
      const property = line.match(/^([A-Za-z0-9_-]+)\s*=\s*("[^"]*"|true|false)\s*$/);
      if (!property) throw new Error(`${relativePath}: unsupported dependency table syntax: ${line}`);
      table.attributes[property[1]] = property[2].startsWith('"')
        ? property[2].slice(1, -1)
        : property[2];
    }
  }
  flushTable();
  return {
    package_name: packageNameMatch[1],
    manifest_path: relativePath,
    dependencies: dependencies.sort((left, right) =>
      `${left.dependency_name}:${left.manifest_path}`
        .localeCompare(`${right.dependency_name}:${right.manifest_path}`)),
  };
}

export function parseCargoWorkspace(rootSource, manifestSources) {
  const workspaceDependencies = parseWorkspaceDependencies(rootSource);
  const packages = new Map();
  for (const [manifestPath, source] of [...manifestSources].sort(([left], [right]) =>
    left.localeCompare(right))) {
    const parsed = parseCargoManifest(manifestPath, source, workspaceDependencies);
    if (packages.has(parsed.package_name)) throw new Error(`duplicate Cargo package ${parsed.package_name}`);
    packages.set(parsed.package_name, parsed);
  }
  const byManifest = new Map([...packages.values()].map((pkg) => [pkg.manifest_path, pkg]));
  for (const pkg of packages.values()) {
    for (const dependency of pkg.dependencies) {
      const target = byManifest.get(dependency.manifest_path);
      if (!target || target.package_name !== dependency.dependency_name) {
        throw new Error(`${pkg.manifest_path}: unresolved local dependency ${dependency.dependency_name}`);
      }
    }
  }
  return packages;
}
