import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
let cachedLlmsVersion;
function getImportMetaUrlUnsafe() {
    try {
        return Function('return import.meta.url')();
    }
    catch {
        return undefined;
    }
}
export function resolveLlmswitchCoreVersion() {
    if (cachedLlmsVersion !== undefined) {
        return cachedLlmsVersion ?? undefined;
    }
    cachedLlmsVersion = null;
    try {
        const metaUrl = getImportMetaUrlUnsafe();
        const moduleDir = typeof metaUrl === 'string' && metaUrl.length > 0
            ? path.dirname(fileURLToPath(metaUrl))
            : path.resolve(process.cwd(), 'src', 'utils');
        const packageRoot = path.resolve(moduleDir, '..', '..');
        const candidates = [
            path.resolve(process.cwd(), 'sharedmodule', 'llmswitch-core', 'package.json'),
            path.resolve(packageRoot, 'sharedmodule', 'llmswitch-core', 'package.json'),
            path.resolve(process.cwd(), 'node_modules', 'rcc-llmswitch-core', 'package.json'),
            path.resolve(packageRoot, 'node_modules', 'rcc-llmswitch-core', 'package.json')
        ];
        for (const pkgPath of candidates) {
            try {
                if (!fs.existsSync(pkgPath)) {
                    continue;
                }
                const text = fs.readFileSync(pkgPath, 'utf-8');
                const parsed = JSON.parse(text);
                if (parsed && typeof parsed.version === 'string' && parsed.version.trim()) {
                    cachedLlmsVersion = parsed.version.trim();
                    return cachedLlmsVersion;
                }
            }
            catch {
                // try next
            }
        }
    }
    catch {
        cachedLlmsVersion = null;
    }
    return undefined;
}
