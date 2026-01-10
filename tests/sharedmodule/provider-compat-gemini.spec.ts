import { describe, it, expect } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

describe('Gemini provider compat', () => {
  const samplesPath = path.join('samples/mock-provider', 'gemini-native');

  it('has mock samples for basic chat', () => {
    const basic = path.join(samplesPath, 'chat-basic.json');
    expect(fs.existsSync(basic)).toBe(true);
    const content = JSON.parse(fs.readFileSync(basic, 'utf-8'));
    expect(content.request).toBeDefined();
    expect(content.response).toBeDefined();
  });

  it('has mock samples for tool calling', () => {
    const tool = path.join(samplesPath, 'chat-tool.json');
    expect(fs.existsSync(tool)).toBe(true);
    const content = JSON.parse(fs.readFileSync(tool, 'utf-8'));
    expect(content.request).toBeDefined();
  });

  it('has mock samples for streaming', () => {
    const stream = path.join(samplesPath, 'chat-stream.json');
    expect(fs.existsSync(stream)).toBe(true);
    const content = JSON.parse(fs.readFileSync(stream, 'utf-8'));
    expect(content.request).toBeDefined();
  });

  it('validates Gemini native request format', () => {
    const basic = path.join(samplesPath, 'chat-basic.json');
    const content = JSON.parse(fs.readFileSync(basic, 'utf-8'));
    expect(content.request.model).toMatch(/^models\//);
    expect(content.request.messages).toBeInstanceOf(Array);
    expect(content.request.messages[0].role).toBe('user');
  });
});
