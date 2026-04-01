import { payloadContainsVideoInput } from '../../../src/server/utils/video-request-detection.js';

describe('payloadContainsVideoInput', () => {
  it('detects input_video parts', () => {
    const payload = {
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'describe this video' },
            { type: 'input_video', video_url: 'https://example.com/demo.mp4' }
          ]
        }
      ]
    };
    expect(payloadContainsVideoInput(payload)).toBe(true);
  });

  it('detects video mime hints', () => {
    const payload = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'file', url: 'https://example.com/resource', mime_type: 'video/mp4' }
          ]
        }
      ]
    };
    expect(payloadContainsVideoInput(payload)).toBe(true);
  });

  it('detects video link disguised in image_url content', () => {
    const payload = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'https://example.com/media/movie.mov' } }
          ]
        }
      ]
    };
    expect(payloadContainsVideoInput(payload)).toBe(true);
  });

  it('does not treat normal image_url as video', () => {
    const payload = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'https://example.com/media/photo.png' } }
          ]
        }
      ]
    };
    expect(payloadContainsVideoInput(payload)).toBe(false);
  });
});
