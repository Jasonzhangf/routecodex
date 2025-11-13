import fs from 'fs/promises';
import path from 'path';

export async function writeJsonPretty(filePath, data) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

async function readJsonMaybe(p) {
  try {
    const content = await fs.readFile(p, 'utf-8');
    return JSON.parse(content);
  } catch (e) {
    return null;
  }
}

function ok(data) { return { ok: true, data, errors: [] }; }
function fail(errors) { return { ok: false, data: null, errors: Array.isArray(errors) ? errors : [String(errors)] }; }

export async function loadSystemConfig(systemPath) {
  const s = await readJsonMaybe(systemPath);
  if (!s) return fail([`system config not found or invalid: ${systemPath}`]);
  return ok(s);
}

export async function loadUserConfig(userPath) {
  const u = await readJsonMaybe(userPath);
  if (!u) return fail([`user config not found or invalid: ${userPath}`]);
  return ok(u);
}

