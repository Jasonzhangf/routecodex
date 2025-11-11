import fs from 'fs/promises';
import path from 'path';
import Ajv from 'ajv';
async function readJson(p) {
    const abs = p.startsWith('.') || !path.isAbsolute(p) ? path.resolve(process.cwd(), p) : p;
    const raw = await fs.readFile(abs, 'utf-8');
    return JSON.parse(raw);
}
async function loadSchema(schemaRelPath) {
    const base = path.resolve(process.cwd(), 'sharedmodule', 'config-core', 'schema');
    const abs = path.isAbsolute(schemaRelPath) ? schemaRelPath : path.join(base, schemaRelPath);
    const raw = await fs.readFile(abs, 'utf-8');
    return JSON.parse(raw);
}
export async function loadSystemConfig(systemPath) {
    try {
        const data = await readJson(systemPath);
        const schema = await loadSchema('system.schema.json');
        const ajv = new Ajv({ allErrors: true, strict: false });
        const validate = ajv.compile(schema);
        const ok = validate(data);
        if (!ok) {
            const errs = (validate.errors || []).map(e => `${e.instancePath || '/'} ${e.message || ''}`.trim());
            return { ok: false, errors: errs };
        }
        return { ok: true, data };
    }
    catch (e) {
        return { ok: false, errors: [e?.message || String(e)] };
    }
}
export async function loadUserConfig(userPath) {
    try {
        const data = await readJson(userPath);
        const schema = await loadSchema('user.schema.json');
        const ajv = new Ajv({ allErrors: true, strict: false });
        const validate = ajv.compile(schema);
        const ok = validate(data);
        if (!ok) {
            const errs = (validate.errors || []).map(e => `${e.instancePath || '/'} ${e.message || ''}`.trim());
            return { ok: false, errors: errs };
        }
        return { ok: true, data };
    }
    catch (e) {
        return { ok: false, errors: [e?.message || String(e)] };
    }
}
export async function writeJsonPretty(filePath, data) {
    const abs = filePath.startsWith('.') || !path.isAbsolute(filePath) ? path.resolve(process.cwd(), filePath) : filePath;
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, JSON.stringify(data, null, 2), 'utf-8');
}
//# sourceMappingURL=loaders.js.map