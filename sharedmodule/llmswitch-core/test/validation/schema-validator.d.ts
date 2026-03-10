export interface SchemaValidationResult {
  valid: boolean;
  errors: any[];
  warnings: any[];
}

export class SchemaValidator {
  validateRequest(request: unknown): SchemaValidationResult;
  validateResponse(response: unknown): SchemaValidationResult;
  validateTools(tools: unknown): { errors: any[]; warnings: any[] };
  validateResponsesTools(tools: unknown): { errors: any[]; warnings: any[] };
  validateStream(chunks: unknown, options?: Record<string, unknown>): SchemaValidationResult;
}

