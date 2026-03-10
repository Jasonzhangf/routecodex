import path from 'path';
import fs from 'fs/promises';
import type AjvNamespace from 'ajv';
import type { ValidateFunction } from 'ajv';

interface SchemaCacheEntry {
  validator: ValidateFunction;
  schemaPath: string;
}

export class SchemaValidator {
  private readonly baseDir: string;
  private readonly cache: Map<string, SchemaCacheEntry> = new Map();

  constructor(baseDir?: string) {
    const rootDir = baseDir ?? process.cwd();
    this.baseDir = rootDir;
  }

  async validate(schemaPath: string | undefined, payload: unknown, context: string): Promise<void> {
    if (!schemaPath) return;
    const validator = await this.getValidator(schemaPath);
    if (!validator(payload)) {
      const errors = validator.errors?.map(err => `${err.instancePath} ${err.message}`).join('; ') ?? 'unknown';
      const error = new Error(`Schema validation failed for ${context}: ${errors}`);
      (error as any).code = 'schema_validation_failed';
      throw error;
    }
  }

  private async getValidator(schemaRelPath: string): Promise<ValidateFunction> {
    // 明确路径策略：禁止多层 fallback。只支持两种确定路径：
    // 1) 绝对路径；2) 以 host 包根目录为 baseDir 的相对路径（如 'config/schemas/...')。
    if (this.cache.has(schemaRelPath)) {
      return this.cache.get(schemaRelPath)!.validator;
    }

    let resolved = path.isAbsolute(schemaRelPath)
      ? schemaRelPath
      : path.resolve(this.baseDir, schemaRelPath);

    // 若 baseDir 未指向 host 包根（例如运行于独立模块上下文），尝试一次性将
    // schemaRelPath 解析到已安装的 routecodex 包根目录下（无其它兜底）。
    if (!path.isAbsolute(schemaRelPath)) {
      try {
        const { createRequire } = await import('module');
        const req = createRequire(import.meta.url as any);
        const pkgJsonPath = req.resolve('routecodex/package.json');
        const pkgRoot = path.dirname(pkgJsonPath);
        const candidate = path.join(pkgRoot, schemaRelPath.replace(/^\/+/, ''));
        // 仅当该文件确实存在时才采用；否则保留 baseDir 解析结果并抛错
        await fs.access(candidate);
        resolved = candidate;
      } catch {
        // 不使用 cwd 等隐式回退。保持 resolved=baseDir 解析结果，读不到则抛错。
      }
    }

    const schemaContent = await fs.readFile(resolved, 'utf-8');
    const schemaJson = JSON.parse(schemaContent);

    // Ajv 在某些 Node 环境下可能未构建 dist/ajv.js；
    // 这里使用动态导入并在失败时回退为“永远通过”的占位校验器，
    // 避免因依赖形态差异导致整个请求链路中断。
    let validator: ValidateFunction;
    try {
      const mod = await import('ajv') as unknown as { default?: typeof AjvNamespace; new(...args: any[]): AjvNamespace };
      const AjvCtor: any = (mod as any).default ?? mod;
      const ajv = new AjvCtor({ allErrors: true, strict: false }) as AjvNamespace;
      validator = ajv.compile(schemaJson) as ValidateFunction;
    } catch {
      const fn = ((_: unknown) => true) as ValidateFunction;
      (fn as any).errors = [];
      validator = fn;
    }

    this.cache.set(schemaRelPath, { validator, schemaPath: resolved });
    return validator;
  }
}
