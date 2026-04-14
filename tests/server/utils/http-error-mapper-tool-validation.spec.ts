import { mapErrorToHttp } from '../../../src/server/utils/http-error-mapper.js';

describe('http-error-mapper tool validation handling', () => {
  it('surfaces structured tool validation details in HTTP payloads', () => {
    const payload = mapErrorToHttp({
      message: 'Converted provider tool call has invalid client arguments at choices[0].message.tool_calls[0]: exec_command. exec_command requires input.cmd as a non-empty string.',
      code: 'CLIENT_TOOL_ARGS_INVALID',
      status: 502,
      statusCode: 502,
      toolName: 'exec_command',
      validationReason: 'missing_cmd',
      validationMessage: 'exec_command requires input.cmd as a non-empty string.',
      missingFields: ['cmd']
    });

    expect(payload.status).toBe(502);
    expect(payload.body.error.code).toBe('CLIENT_TOOL_ARGS_INVALID');
    expect(payload.body.error.tool_name).toBe('exec_command');
    expect(payload.body.error.validation_reason).toBe('missing_cmd');
    expect(payload.body.error.validation_message).toBe(
      'exec_command requires input.cmd as a non-empty string.'
    );
    expect(payload.body.error.missing_fields).toEqual(['cmd']);
  });
});
