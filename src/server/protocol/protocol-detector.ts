/**
 * Protocol Detector Implementation
 * Automatically detects the protocol format of incoming requests
 */

import type { Request } from 'express';

/**
 * Protocol type enumeration
 */
export type ProtocolType = 'openai' | 'anthropic' | 'responses' | 'unknown';

export interface ProtocolAdapterConfig {
  name?: string;
  version?: string;
  supportedEndpoints?: string[];
  defaultHeaders?: Record<string, string>;
}

export interface IProtocolAdapter {
  detectRequest(payload: unknown): boolean;
  detectResponse(payload: unknown): boolean;
  normalizeRequest(payload: unknown): unknown;
  normalizeResponse(payload: unknown): unknown;
  convertToProtocol(payload: unknown, targetProtocol: ProtocolType): unknown;
  convertFromProtocol(payload: unknown, sourceProtocol: ProtocolType): unknown;
}

/**
 * Detection result interface
 */
export interface DetectionResult {
  protocol: ProtocolType;
  confidence: number;
  endpoint?: string;
  indicators: string[];
}

export interface ProtocolDetectorConfig {
  enableStrictDetection?: boolean;
  minConfidenceThreshold?: number;
  customPatterns?: Record<string, RegExp>;
}

/**
 * Protocol Detector
 * Automatically detects request protocol format based on content and headers
 */
export class ProtocolDetector {
  private config: ProtocolDetectorConfig;

  constructor(config: ProtocolDetectorConfig = {}) {
    this.config = {
      enableStrictDetection: false,
      minConfidenceThreshold: 0.7,
      customPatterns: {},
      ...config,
    };
  }

  /**
   * Detect protocol from Express request
   */
  public detectFromRequest(req: Request): DetectionResult {
    const body = req.body || {};
    const headers = req.headers || {};
    const url = req.url || '';
    const method = req.method || '';

    return this.detectProtocol(body, headers, url, method);
  }

  /**
   * Detect protocol from request data
   */
  public detectProtocol(
    body: any,
    headers: Record<string, any> = {},
    url: string = '',
    method: string = ''
  ): DetectionResult {
    const indicators: string[] = [];
    let confidence = 0;
    let protocol: ProtocolType = 'unknown';

    // Check URL-based indicators
    const urlIndicators = this.analyzeUrl(url);
    indicators.push(...urlIndicators.indicators);
    confidence += urlIndicators.confidence;

    // Check header-based indicators
    const headerIndicators = this.analyzeHeaders(headers);
    indicators.push(...headerIndicators.indicators);
    confidence += headerIndicators.confidence;

    // Check body-based indicators
    const bodyIndicators = this.analyzeBody(body);
    indicators.push(...bodyIndicators.indicators);
    confidence += bodyIndicators.confidence;

    // Determine protocol based on strongest indicators
    const protocolGuess = this.determineProtocol(indicators);

    // Normalize confidence
    confidence = Math.min(confidence, 1.0);
    protocol = confidence >= (this.config.minConfidenceThreshold || 0.7)
      ? protocolGuess
      : 'unknown';

    return {
      protocol,
      confidence,
      endpoint: url,
      indicators: [...new Set(indicators)], // Remove duplicates
    };
  }

  /**
   * Analyze URL for protocol indicators
   */
  private analyzeUrl(url: string): { indicators: string[]; confidence: number } {
    const indicators: string[] = [];
    let confidence = 0;

    if (!url) {
      return { indicators, confidence };
    }

    // OpenAI endpoints
    if (url.includes('/v1/chat/completions')) {
      indicators.push('openai_chat_completions_endpoint');
      confidence += 0.4;
    } else if (url.includes('/v1/completions')) {
      indicators.push('openai_completions_endpoint');
      confidence += 0.4;
    } else if (url.includes('/v1/embeddings')) {
      indicators.push('openai_embeddings_endpoint');
      confidence += 0.3;
    } else if (url.includes('/v1/models')) {
      indicators.push('openai_models_endpoint');
      confidence += 0.2;
    }

    // Anthropic endpoints
    if (url.includes('/v1/messages')) {
      indicators.push('anthropic_messages_endpoint');
      confidence += 0.4;
    } else if (url.includes('/v1/responses')) {
      indicators.push('anthropic_responses_endpoint');
      confidence += 0.4;
    }

    // Generic API indicators
    if (url.startsWith('/v1/')) {
      indicators.push('openai_style_api');
      confidence += 0.1;
    }

    return { indicators, confidence };
  }

  /**
   * Analyze headers for protocol indicators
   */
  private analyzeHeaders(headers: Record<string, any>): { indicators: string[]; confidence: number } {
    const indicators: string[] = [];
    let confidence = 0;

    // Content-Type headers
    const contentType = headers['content-type'] || headers['Content-Type'] || '';
    if (contentType.includes('application/json')) {
      indicators.push('json_content_type');
      confidence += 0.1;
    }

    // Authorization headers
    const authHeader = headers.authorization || headers.Authorization || '';
    if (authHeader.startsWith('Bearer sk-')) {
      indicators.push('openai_style_auth');
      confidence += 0.2;
    } else if (authHeader.startsWith('Bearer sk-ant-')) {
      indicators.push('anthropic_style_auth');
      confidence += 0.3;
    }

    // User-Agent headers
    const userAgent = headers['user-agent'] || headers['User-Agent'] || '';
    if (userAgent.includes('OpenAI') || userAgent.includes('GPT')) {
      indicators.push('openai_user_agent');
      confidence += 0.1;
    } else if (userAgent.includes('Anthropic') || userAgent.includes('Claude')) {
      indicators.push('anthropic_user_agent');
      confidence += 0.1;
    }

    // Custom headers
    if (headers['anthropic-version']) {
      indicators.push('anthropic_version_header');
      confidence += 0.3;
    }

    if (headers['x-api-version'] || headers['api-version']) {
      indicators.push('api_version_header');
      confidence += 0.1;
    }

    return { indicators, confidence };
  }

  /**
   * Analyze request body for protocol indicators
   */
  private analyzeBody(body: any): { indicators: string[]; confidence: number } {
    const indicators: string[] = [];
    let confidence = 0;

    if (!body || typeof body !== 'object') {
      return { indicators, confidence };
    }

    const bodyKeys = Object.keys(body);

    // OpenAI-specific indicators
    if (body.messages && Array.isArray(body.messages)) {
      indicators.push('openai_messages_array');
      confidence += 0.3;
    }

    if (body.model && typeof body.model === 'string') {
      indicators.push('model_field_present');
      confidence += 0.1;
    }

    if (body.temperature !== undefined || body.top_p !== undefined) {
      indicators.push('openai_sampling_params');
      confidence += 0.2;
    }

    if (body.max_tokens !== undefined) {
      indicators.push('max_tokens_field');
      confidence += 0.1;
    }

    if (body.tools && Array.isArray(body.tools)) {
      indicators.push('openai_tools_array');
      confidence += 0.2;
    }

    if (body.tool_choice !== undefined) {
      indicators.push('openai_tool_choice');
      confidence += 0.1;
    }

    if (body.stream !== undefined) {
      indicators.push('stream_field_present');
      confidence += 0.1;
    }

    // Anthropic-specific indicators
    if (body.system !== undefined) {
      indicators.push('anthropic_system_field');
      confidence += 0.2;
    }

    if (body.max_tokens !== undefined && typeof body.max_tokens === 'number') {
      // Anthropic requires max_tokens
      confidence += 0.1;
    }

    // Check for Anthropic-style message structure
    if (body.messages && Array.isArray(body.messages)) {
      const hasAnthropicStructure = body.messages.some((msg: any) =>
        msg && typeof msg === 'object' &&
        msg.role &&
        Array.isArray(msg.content) &&
        msg.content.some((content: any) =>
          content && typeof content === 'object' &&
          content.type
        )
      );

      if (hasAnthropicStructure) {
        indicators.push('anthropic_content_structure');
        confidence += 0.3;
      }
    }

    // Completion-specific indicators
    if (body.prompt !== undefined) {
      indicators.push('prompt_field_present');
      confidence += 0.2;
    }

    if (body.echo !== undefined) {
      indicators.push('completion_echo_field');
      confidence += 0.1;
    }

    if (body.logprobs !== undefined) {
      indicators.push('completion_logprobs_field');
      confidence += 0.1;
    }

    // Responses-specific indicators
    if (body.response_format !== undefined) {
      indicators.push('response_format_field');
      confidence += 0.1;
    }

    if (body.tools && body.tools.some((tool: any) => tool.input_schema)) {
      indicators.push('anthropic_tool_schema');
      confidence += 0.2;
    }

    return { indicators, confidence };
  }

  /**
   * Determine protocol based on indicators
   */
  private determineProtocol(indicators: string[]): ProtocolType {
    const openaiIndicators = [
      'openai_chat_completions_endpoint',
      'openai_completions_endpoint',
      'openai_embeddings_endpoint',
      'openai_models_endpoint',
      'openai_style_auth',
      'openai_user_agent',
      'openai_messages_array',
      'openai_sampling_params',
      'openai_tools_array',
      'openai_tool_choice',
    ];

    const anthropicIndicators = [
      'anthropic_messages_endpoint',
      'anthropic_responses_endpoint',
      'anthropic_style_auth',
      'anthropic_user_agent',
      'anthropic_version_header',
      'anthropic_system_field',
      'anthropic_content_structure',
      'anthropic_tool_schema',
    ];

    const responsesIndicators = [
      'anthropic_responses_endpoint',
      'response_format_field',
    ];

    const openaiScore = indicators.filter(i => openaiIndicators.includes(i)).length;
    const anthropicScore = indicators.filter(i => anthropicIndicators.includes(i)).length;
    const responsesScore = indicators.filter(i => responsesIndicators.includes(i)).length;

    // Determine protocol with highest score
    if (responsesScore > 0 && responsesScore >= Math.max(openaiScore, anthropicScore)) {
      return 'responses';
    } else if (anthropicScore > openaiScore) {
      return 'anthropic';
    } else if (openaiScore > 0) {
      return 'openai';
    }

    return 'unknown';
  }

  /**
   * Validate detected protocol
   */
  public validateDetection(result: DetectionResult, body: any): boolean {
    if (result.protocol === 'unknown') {
      return false;
    }

    try {
      switch (result.protocol) {
        case 'openai':
          return this.validateOpenAIFormat(body);
        case 'anthropic':
          return this.validateAnthropicFormat(body);
        case 'responses':
          return this.validateResponsesFormat(body);
        default:
          return false;
      }
    } catch {
      return false;
    }
  }

  /**
   * Validate OpenAI format
   */
  private validateOpenAIFormat(body: any): boolean {
    if (!body || typeof body !== 'object') {
      return false;
    }

    // Check for required fields based on endpoint type
    if (body.messages) {
      // Chat completions format
      return Array.isArray(body.messages) &&
             body.messages.length > 0 &&
             body.messages.every((msg: any) =>
               msg &&
               typeof msg === 'object' &&
               typeof msg.role === 'string' &&
               msg.content !== undefined
             );
    } else if (body.prompt) {
      // Completions format
      return typeof body.prompt === 'string' || Array.isArray(body.prompt);
    }

    return false;
  }

  /**
   * Validate Anthropic format
   */
  private validateAnthropicFormat(body: any): boolean {
    if (!body || typeof body !== 'object') {
      return false;
    }

    // Check for required Anthropic fields
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return false;
    }

    if (typeof body.max_tokens !== 'number' || body.max_tokens <= 0) {
      return false;
    }

    // Validate message structure
    return body.messages.every((msg: any) =>
      msg &&
      typeof msg === 'object' &&
      typeof msg.role === 'string' &&
      ['user', 'assistant', 'system'].includes(msg.role) &&
      msg.content !== undefined
    );
  }

  /**
   * Validate Responses format
   */
  private validateResponsesFormat(body: any): boolean {
    if (!body || typeof body !== 'object') {
      return false;
    }

    // Responses format is similar to Anthropic but may have additional fields
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return false;
    }

    if (typeof body.max_tokens !== 'number' || body.max_tokens <= 0) {
      return false;
    }

    return true;
  }

  /**
   * Get protocol statistics
   */
  public getDetectionStats(results: DetectionResult[]): {
    total: number;
    byProtocol: Record<ProtocolType, number>;
    avgConfidence: number;
  } {
    const total = results.length;
    const byProtocol = {
      openai: 0,
      anthropic: 0,
      responses: 0,
      unknown: 0,
    };

    let totalConfidence = 0;

    results.forEach(result => {
      byProtocol[result.protocol]++;
      totalConfidence += result.confidence;
    });

    return {
      total,
      byProtocol,
      avgConfidence: total > 0 ? totalConfidence / total : 0,
    };
  }
}
