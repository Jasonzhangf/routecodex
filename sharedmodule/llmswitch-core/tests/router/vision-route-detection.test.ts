import { describe, expect, test } from '@jest/globals';

import { RoutingClassifier } from '../../src/router/virtual-router/classifier.js';
import { buildRoutingFeatures } from '../../src/router/virtual-router/features.js';

describe('virtual-router vision detection', () => {
  test('does not classify as multimodal when image exists only in historical user message', () => {
    const req = {
      model: 'gpt-test',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Here is an image' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAA' }
          ]
        },
        { role: 'assistant', content: 'ok' },
        { role: 'tool', content: 'tool result' }
      ],
      tools: []
    } as any;

    const features = buildRoutingFeatures(req, { requestId: 'req_test' } as any);
    expect(features.latestMessageFromUser).toBe(false);
    expect(features.hasImageAttachment).toBe(false);

    const classifier = new RoutingClassifier({});
    const result = classifier.classify(features);
    expect(result.routeName).not.toBe('multimodal');
    expect(result.reasoning).not.toContain('multimodal:media-detected');
  });


  test('does not classify as multimodal when responses context latest turn is assistant after an image user turn', () => {
    const req = {
      model: 'gpt-test',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Here is an image' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAA' }
          ]
        }
      ],
      tools: [],
      semantics: {
        responses: {
          context: {
            input: [
              {
                type: 'message',
                role: 'user',
                content: [
                  { type: 'input_text', text: 'Here is an image' },
                  { type: 'input_image', image_url: 'data:image/png;base64,AAA' }
                ]
              },
              {
                type: 'message',
                role: 'assistant',
                content: 'ok'
              }
            ]
          }
        }
      }
    } as any;

    const features = buildRoutingFeatures(req, { requestId: 'req_test' } as any);
    expect(features.latestMessageFromUser).toBe(false);
    expect(features.hasImageAttachment).toBe(false);

    const classifier = new RoutingClassifier({});
    const result = classifier.classify(features);
    expect(result.routeName).not.toBe('multimodal');
    expect(result.reasoning).not.toContain('multimodal:media-detected');
  });

  test('classifies as multimodal when latest user message contains image', () => {
    const req = {
      model: 'gpt-test',
      messages: [
        { role: 'assistant', content: 'prior' },
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Look' },
            { type: 'input_image', image_url: 'data:image/png;base64,BBB' }
          ]
        }
      ],
      tools: []
    } as any;

    const features = buildRoutingFeatures(req, { requestId: 'req_test' } as any);
    expect(features.latestMessageFromUser).toBe(true);
    expect(features.hasImageAttachment).toBe(true);

    const classifier = new RoutingClassifier({});
    const result = classifier.classify(features);
    expect(result.routeName).toBe('multimodal');
    expect(result.reasoning).toContain('multimodal:media-detected');
  });

  test('classifies as multimodal when latest user message contains video', () => {
    const req = {
      model: 'gpt-test',
      messages: [
        { role: 'assistant', content: 'prior' },
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Check this clip' },
            { type: 'input_video', video_url: 'data:video/mp4;base64,CCC' }
          ]
        }
      ],
      tools: []
    } as any;

    const features = buildRoutingFeatures(req, { requestId: 'req_test' } as any);
    expect(features.latestMessageFromUser).toBe(true);
    expect(features.hasImageAttachment).toBe(true);
    expect(features.hasVideoAttachment).toBe(true);
    expect(features.hasRemoteVideoAttachment).toBe(false);
    expect(features.hasLocalVideoAttachment).toBe(true);

    const classifier = new RoutingClassifier({});
    const result = classifier.classify(features);
    expect(result.routeName).toBe('multimodal');
    expect(result.reasoning).toContain('multimodal:media-detected');
  });

  test('marks http(s) video_url as remote video attachment', () => {
    const req = {
      model: 'gpt-test',
      messages: [
        { role: 'assistant', content: 'prior' },
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Check this clip' },
            { type: 'video_url', video_url: { url: 'https://example.com/demo.mp4' } }
          ]
        }
      ],
      tools: []
    } as any;

    const features = buildRoutingFeatures(req, { requestId: 'req_test' } as any);
    expect(features.latestMessageFromUser).toBe(true);
    expect(features.hasImageAttachment).toBe(true);
    expect(features.hasVideoAttachment).toBe(true);
    expect(features.hasRemoteVideoAttachment).toBe(true);
    expect(features.hasLocalVideoAttachment).toBe(false);

    const classifier = new RoutingClassifier({});
    const result = classifier.classify(features);
    expect(result.routeName).toBe('video');
    expect(result.reasoning).toContain('video:remote-video-detected');
  });

  test('does not classify as multimodal when video exists only in historical user message', () => {
    const req = {
      model: 'gpt-test',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'old clip' },
            { type: 'input_video', video_url: 'data:video/mp4;base64,DDD' }
          ]
        },
        { role: 'assistant', content: 'ok' },
        { role: 'tool', content: 'tool result' }
      ],
      tools: []
    } as any;

    const features = buildRoutingFeatures(req, { requestId: 'req_test' } as any);
    expect(features.latestMessageFromUser).toBe(false);
    expect(features.hasImageAttachment).toBe(false);

    const classifier = new RoutingClassifier({});
    const result = classifier.classify(features);
    expect(result.routeName).not.toBe('multimodal');
    expect(result.reasoning).not.toContain('multimodal:media-detected');
  });
});
