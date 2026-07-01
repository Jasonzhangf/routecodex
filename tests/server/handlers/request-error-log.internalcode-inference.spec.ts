import { jest } from '@jest/globals';
import { logRequestError } from '../../../src/server/handlers/handler-utils.js';

describe('logRequestError internalCode inference from error object', () => {
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

  beforeEach(() => {
    errorSpy.mockClear();
  });

  afterAll(() => {
    errorSpy.mockRestore();
  });

  it('infers internalCode=500-110 from error.message containing HubPipeline metadata center', () => {
    const err = new Error(
      'HubPipeline requires metadata center runtime_control.providerProtocol'
    );

    logRequestError('/v1/responses', 'req_hubpipeline_missing', err);

    const rendered = errorSpy.mock.calls.map((call) => String(call[0] ?? '')).join('\n');
    expect(rendered).toContain('internalCode=500-110');
  });

  it('infers internalCode=500-210 from error.message containing provider response conversion', () => {
    const err = new Error(
      'Provider response conversion requires metadata center runtime_control.providerProtocol'
    );

    logRequestError('/v1/responses', 'req_resp_conversion_req', err);

    const rendered = errorSpy.mock.calls.map((call) => String(call[0] ?? '')).join('\n');
    expect(rendered).toContain('internalCode=500-210');
  });

  it('infers internalCode=500-120 from code=hub_pipeline_request_native_failed', () => {
    const err: any = new Error('Rust HubPipeline request path failed');
    err.code = 'hub_pipeline_request_native_failed';

    logRequestError('/v1/responses', 'req_native_failed', err);

    const rendered = errorSpy.mock.calls.map((call) => String(call[0] ?? '')).join('\n');
    expect(rendered).toContain('internalCode=500-120');
  });

  it('infers internalCode=500-220 from code=hub_pipeline_response_native_failed', () => {
    const err: any = new Error('Rust HubPipeline response path failed');
    err.code = 'hub_pipeline_response_native_failed';

    logRequestError('/v1/responses', 'resp_native_failed', err);

    const rendered = errorSpy.mock.calls.map((call) => String(call[0] ?? '')).join('\n');
    expect(rendered).toContain('internalCode=500-220');
  });

  it('infers internalCode=500-130 for VIRTUAL_ROUTER_ERROR:PROVIDER_NOT_AVAILABLE', () => {
    const err = new Error(
      'VIRTUAL_ROUTER_ERROR:PROVIDER_NOT_AVAILABLE:No available providers after applying routing instructions'
    );

    logRequestError('/v1/responses', 'req_vr_not_available', err);

    const rendered = errorSpy.mock.calls.map((call) => String(call[0] ?? '')).join('\n');
    expect(rendered).toContain('internalCode=500-130');
  });
});
