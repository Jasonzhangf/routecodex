#!/usr/bin/env node

/**
 * Debug Schema Validation
 */

import { AjvSchemaMapper } from './dist/core/schema-mapper.js';

const schemaMapper = new AjvSchemaMapper();

// Test with a simple OpenAI request that should validate
const simpleOpenAIRequest = {
  model: "gpt-4",
  messages: [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Hello" }
  ],
  temperature: 0.7,
  max_tokens: 100
};

// Test with a simple OpenAI response that should validate
const simpleOpenAIResponse = {
  id: "chat-123",
  object: "chat.completion",
  created: 1234567890,
  model: "gpt-4",
  choices: [{
    index: 0,
    message: {
      role: "assistant",
      content: "Hello! How can I help you?"
    },
    finish_reason: "stop"
  }],
  usage: {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15
  }
};

console.log('🧪 Testing simple OpenAI request validation...');
const requestValidation = schemaMapper.validateOpenAIRequest(simpleOpenAIRequest);
console.log('Request valid:', requestValidation.valid);
if (!requestValidation.valid) {
  console.log('Request errors:', requestValidation.errors);
}

console.log('\n🧪 Testing simple OpenAI response validation...');
const responseValidation = schemaMapper.validateOpenAIResponse(simpleOpenAIResponse);
console.log('Response valid:', responseValidation.valid);
if (!responseValidation.valid) {
  console.log('Response errors:', responseValidation.errors);
}

console.log('\n🧪 Testing Anthropic request validation...');
const simpleAnthropicRequest = {
  model: "claude-3-sonnet-20240229",
  messages: [
    { role: "user", content: "Hello" }
  ],
  max_tokens: 100
};

const anthropicRequestValidation = schemaMapper.validateAnthropicRequest(simpleAnthropicRequest);
console.log('Anthropic request valid:', anthropicRequestValidation.valid);
if (!anthropicRequestValidation.valid) {
  console.log('Anthropic request errors:', anthropicRequestValidation.errors);
}

console.log('\n🧪 Testing Anthropic response validation...');
const simpleAnthropicResponse = {
  id: "msg-123",
  type: "message",
  role: "assistant",
  content: [{
    type: "text",
    text: "Hello! How can I help you?"
  }],
  model: "claude-3-sonnet-20240229",
  stop_reason: "end_turn",
  usage: {
    input_tokens: 10,
    output_tokens: 5
  }
};

const anthropicResponseValidation = schemaMapper.validateAnthropicResponse(simpleAnthropicResponse);
console.log('Anthropic response valid:', anthropicResponseValidation.valid);
if (!anthropicResponseValidation.valid) {
  console.log('Anthropic response errors:', anthropicResponseValidation.errors);
}