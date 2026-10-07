import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { assertFile, fail } from "./gcm-consumer-utils.mjs";

export function stripTomlComment(line) {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === "\\" && quote === '"') {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "#") {
      return line.slice(0, index);
    }
  }
  return line;
}

export function normalizeTomlKey(raw) {
  return raw
    .split(".")
    .map((part) => {
      const value = part.trim();
      if (value.startsWith('"') && value.endsWith('"')) {
        return JSON.parse(value);
      }
      if (value.startsWith("'") && value.endsWith("'")) {
        return value.slice(1, -1);
      }
      return value;
    })
    .join(".");
}

export function parseTomlScalar(raw) {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    return JSON.parse(value);
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return value;
}

export function parseTomlValues(text) {
  const values = new Map();
  let section = "";
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) {
      continue;
    }
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = normalizeTomlKey(sectionMatch[1]);
      continue;
    }
    const equalsAt = line.indexOf("=");
    if (equalsAt < 0) {
      continue;
    }
    const key = normalizeTomlKey(line.slice(0, equalsAt));
    const fullKey = section ? `${section}.${key}` : key;
    values.set(fullKey, parseTomlScalar(line.slice(equalsAt + 1)));
  }
  return values;
}

export function loadProfileTruth(sourceHome, profileName) {
  const baseConfig = path.join(sourceHome, "config.toml");
  const profileConfig = path.join(sourceHome, `${profileName}.config.toml`);
  assertFile(baseConfig, "base Codex config");
  assertFile(profileConfig, `${profileName} profile config`);

  const base = parseTomlValues(fs.readFileSync(baseConfig, "utf8"));
  const profile = parseTomlValues(fs.readFileSync(profileConfig, "utf8"));
  const providerId = profile.get("model_provider") ?? base.get("model_provider");
  if (!providerId) {
    fail(`could not resolve model_provider from ${profileConfig} or ${baseConfig}`);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(providerId)) {
    fail(`provider id is not a bare TOML key, refusing to guess an override path: ${providerId}`);
  }

  const providerKey = `model_providers.${providerId}.base_url`;
  const profileBaseUrl = profile.get(providerKey);
  const baseBaseUrl = base.get(providerKey);
  const profileBaseUrlSource = profileBaseUrl ? profileConfig : null;
  const baseUrl = profileBaseUrl ?? baseBaseUrl;
  if (!baseUrl) {
    fail(`could not resolve ${providerKey} from ${profileConfig} or ${baseConfig}`);
  }

  return {
    providerId,
    baseUrl,
    baseUrlSource: profileBaseUrlSource ?? baseConfig,
    profileConfig,
    baseConfig,
    providerSource: profile.has("model_provider") ? profileConfig : baseConfig,
  };
}

export function resolveExecutable(command) {
  if (path.isAbsolute(command)) {
    if (!fs.existsSync(command)) {
      fail(`executable does not exist: ${command}`);
    }
    return command;
  }
  const pathEntries = (process.env.PATH || "").split(path.delimiter);
  for (const entry of pathEntries) {
    const candidate = path.join(entry || ".", command);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  fail(`executable not found on PATH: ${command}`);
}

export function inspectCodexCli(codexBin) {
  const versionResult = spawnSync(codexBin, ["--version"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    path: codexBin,
    version: (versionResult.stdout || "").trim() || null,
    version_exit_code: versionResult.status,
    version_error: versionResult.error ? versionResult.error.message : null,
  };
}

export function createIsolatedHome(sourceHome, profileName) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "req02-gcm-consumer-"));
  const home = path.join(root, "codex-home");
  fs.mkdirSync(home, { recursive: true });

  const requiredLinks = ["config.toml", `${profileName}.config.toml`, "auth.json"];
  for (const name of requiredLinks) {
    const source = path.join(sourceHome, name);
    assertFile(source, `source CODEX_HOME ${name}`);
    fs.symlinkSync(source, path.join(home, name));
  }
  const sourceAgents = path.join(sourceHome, "AGENTS.md");
  if (fs.existsSync(sourceAgents)) {
    fs.symlinkSync(sourceAgents, path.join(home, "AGENTS.md"));
  }

  return { root, home };
}
