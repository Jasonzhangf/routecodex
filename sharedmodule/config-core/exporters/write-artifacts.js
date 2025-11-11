import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
export async function writeArtifacts(outDir, arts) {
    const base = outDir && outDir.startsWith('.') ? path.resolve(process.cwd(), outDir) : (outDir || path.resolve(process.cwd(), 'config'));
    await mkdir(base, { recursive: true });
    const writes = [];
    // determine optional port suffix from canonical
    const canonical = arts.canonical || arts.merged || {};
    const port = canonical?.httpserver?.port || canonical?.modules?.httpserver?.config?.port;
    const suffix = (typeof port === 'number' && port > 0) ? `.${port}` : '';
    const add = (name, data, alsoWithPort = false) => {
        if (typeof data === 'undefined')
            return;
        const p = path.join(base, name);
        writes.push(writeFile(p, JSON.stringify(data, null, 2), 'utf-8'));
        if (alsoWithPort && suffix) {
            const pn = path.join(base, name.replace(/(\.json)$/i, `${suffix}$1`));
            writes.push(writeFile(pn, JSON.stringify(data, null, 2), 'utf-8'));
        }
    };
    add('stage-1.system.parsed.json', arts.systemParsed, true);
    add('stage-2.user.parsed.json', arts.userParsed, true);
    add('stage-3.canonical.json', arts.canonical, true);
    // assembler config也输出端口后缀版本，便于并行诊断
    add('stage-4.assembler.config.json', arts.assemblerConfig, true);
    // merged-config 写入端口后缀版本，作为多实例服务器的读取入口
    const mergedOut = (() => {
        const base = arts.merged || arts.canonical || {};
        try {
            if (arts.assemblerConfig && typeof arts.assemblerConfig === 'object') {
                const enriched = { ...base };
                enriched.pipeline_assembler = arts.assemblerConfig;
                return enriched;
            }
        }
        catch { /* ignore */ }
        return base;
    })();
    add('merged-config.json', mergedOut, true);
    await Promise.all(writes);
}
//# sourceMappingURL=write-artifacts.js.map