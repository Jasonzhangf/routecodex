import { HttpClient } from '../utils/http-client.js';

export const WINDSURF_CLOUD_IDE_NAME = 'windsurf';
export const WINDSURF_CLOUD_IDE_VERSION = '1.9600.41';
export const WINDSURF_CLOUD_LOCALE = 'en';

export type WindsurfCloudMetadata = {
  apiKey: string;
  ideName: string;
  ideVersion: string;
  extensionName: string;
  extensionVersion: string;
  locale: string;
};

export type WindsurfCloudProbeRequest = {
  endpoint: string;
  path: string;
  body: Record<string, unknown>;
};

export const WINDSURF_GET_USER_STATUS_PATH = '/exa.seat_management_pb.SeatManagementService/GetUserStatus';
export const WINDSURF_GET_CASCADE_MODEL_CONFIGS_PATH = '/exa.api_server_pb.ApiServerService/GetCascadeModelConfigs';

export function buildWindsurfCloudMetadata(apiKey: string): WindsurfCloudMetadata {
  const token = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!token) {
    throw new Error('windsurf api key missing');
  }
  return {
    apiKey: token,
    ideName: WINDSURF_CLOUD_IDE_NAME,
    ideVersion: WINDSURF_CLOUD_IDE_VERSION,
    extensionName: WINDSURF_CLOUD_IDE_NAME,
    extensionVersion: WINDSURF_CLOUD_IDE_VERSION,
    locale: WINDSURF_CLOUD_LOCALE,
  };
}

export function buildWindsurfCloudEndpointCandidates(endpoints: Array<string | undefined | null>): string[] {
  return Array.from(new Set(
    endpoints
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => value.trim().replace(/\/$/, ''))
  ));
}

export function buildWindsurfStatusProbeRequests(options: {
  apiKey: string;
  endpoints: Array<string | undefined | null>;
}): WindsurfCloudProbeRequest[] {
  const metadata = buildWindsurfCloudMetadata(options.apiKey);
  return buildWindsurfCloudEndpointCandidates(options.endpoints).map((endpoint) => ({
    endpoint,
    path: WINDSURF_GET_USER_STATUS_PATH,
    body: { metadata },
  }));
}

export function buildWindsurfModelConfigProbeRequests(options: {
  apiKey: string;
  endpoints: Array<string | undefined | null>;
}): WindsurfCloudProbeRequest[] {
  const metadata = buildWindsurfCloudMetadata(options.apiKey);
  return buildWindsurfCloudEndpointCandidates(options.endpoints).map((endpoint) => ({
    endpoint,
    path: WINDSURF_GET_CASCADE_MODEL_CONFIGS_PATH,
    body: { metadata },
  }));
}

export class WindsurfCloudClient {
  constructor(private readonly httpClient: HttpClient) {}

  async getUserStatus(probes: WindsurfCloudProbeRequest[]): Promise<unknown> {
    return this.postFirstSuccessful(probes);
  }

  async getCascadeModelConfigs(probes: WindsurfCloudProbeRequest[]): Promise<unknown> {
    return this.postFirstSuccessful(probes);
  }

  private async postFirstSuccessful(probes: WindsurfCloudProbeRequest[]): Promise<unknown> {
    let lastError: unknown = null;
    for (const probe of probes) {
      try {
        const response = await this.httpClient.post(`${probe.endpoint}${probe.path}`, probe.body, {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'User-Agent': `windsurf/${WINDSURF_CLOUD_IDE_VERSION}`,
        });
        return response.data;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error('windsurf cloud probe failed');
  }
}
