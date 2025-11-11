import fs from 'fs/promises';
import path from 'path';
import Ajv from 'ajv';

export interface ParsedResult<T=any> {
  ok: boolean;
  data?: T;
  errors?: string[];
}

async function readJson(p: string): Promise<any> {
  const abs = p.startsWith('.') || !path.isAbsolute(p) ? path.resolve(process.cwd(), p) : p;
  const raw = await fs.readFile(abs, 'utf-8');
  return JSON.parse(raw);
}

async function loadSchema(schemaRelPath: string): Promise<any> {
  const base = path.resolve(process.cwd(), 'sharedmodule', 'config-core', 'schema');
  const abs = path.isAbsolute(schemaRelPath) ? schemaRelPath : path.join(base, schemaRelPath);
  const raw = await fs.readFile(abs, 'utf-8');
  return JSON.parse(raw);
}

export async function loadSystemConfig(systemPath: string): Promise<ParsedResult> {
  try {
    const data = await readJson(systemPath);
    const schema = await loadSchema('system.schema.json');
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    const ok = validate(data) as boolean;
    if (!ok) {
      const errs = (validate.errors || []).map(e => `${e.instancePath || '/'} ${e.message || ''}`.trim());
      return { ok: false, errors: errs };
    }
    return { ok: true, data };
  } catch (e: any) {
    return { ok: false, errors: [e?.message || String(e)] };
  }
}

export async function loadUserConfig(userPath: string): Promise<ParsedResult> {
  try {
    const data = await readJson(userPath);
    const schema = await loadSchema('user.schema.json');
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    const ok = validate(data) as boolean;
    if (!ok) {
      const errs = (validate.errors || []).map(e => `${e.instancePath || '/'} ${e.message || ''}`.trim());
      return { ok: false, errors: errs };
    }
    return { ok: true, data };
  } catch (e: any) {
    return { ok: false, errors: [e?.message || String(e)] };
  }
}

export async function writeJsonPretty(filePath: string, data: any): Promise<void> {
  const abs = filePath.startsWith('.') || !path.isAbsolute(filePath) ? path.resolve(process.cwd(), filePath) : filePath;
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, JSON.stringify(data, null, 2), 'utf-8');
}
