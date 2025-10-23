import path from 'path';
import fs from 'fs/promises';
import Ajv, { type ValidateFunction } from 'ajv';

interface SchemaCacheEntry {
  validator: ValidateFunction;
  schemaPath: string;
}

export class SchemaValidator {
  private readonly baseDir: string;
  private readonly cache: Map<string, SchemaCacheEntry> = new Map();
  private readonly ajv: Ajv;

  constructor(baseDir?: string) {
    const rootDir = baseDir ?? process.cwd();
    this.baseDir = rootDir;
    this.ajv = new Ajv({ allErrors: true, strict: false });
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

  private async getValidator(schemaPath: string): Promise<ValidateFunction> {
    if (this.cache.has(schemaPath)) {
      return this.cache.get(schemaPath)!.validator;
    }
    const resolved = path.isAbsolute(schemaPath) ? schemaPath : path.resolve(this.baseDir, schemaPath);
    const schemaContent = await fs.readFile(resolved, 'utf-8');
    const schemaJson = JSON.parse(schemaContent);
    const validator = this.ajv.compile(schemaJson);
    this.cache.set(schemaPath, { validator, schemaPath: resolved });
    return validator;
  }
}

