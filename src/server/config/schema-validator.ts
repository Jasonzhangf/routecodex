export class SchemaValidator {
  static async validateMapping(mapping: unknown, schemaPath: string): Promise<void> {
    try {
      const fs = await import('fs/promises');
      const AjvMod: any = await import('ajv');
      const schemaText = await fs.readFile(schemaPath, 'utf-8');
      const schema = JSON.parse(schemaText);
      const ajv = new AjvMod.default({ allErrors: true, strict: false });
      const validate = ajv.compile(schema);
      const ok = validate(mapping);
      if (!ok) {
        const errs = (validate.errors || []).map((e: any) => `${e.instancePath || ''} ${e.message || ''}`.trim()).join('; ');
        throw new Error(`responses-conversion.json validation failed: ${errs || 'invalid mapping'}`);
      }
    } catch (e: any) {
      // Fail hard per product requirement (no fallback)
      const err = new Error(`Mapping schema validation error: ${e?.message || String(e)}`);
      (err as any).status = 500;
      throw err;
    }
  }
}

