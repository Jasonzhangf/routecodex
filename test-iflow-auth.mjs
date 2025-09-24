#!/usr/bin/env node

// Simple test for iFlow API authentication
import fetch from 'node-fetch';
import fs from 'fs/promises';

async function testIFlowAPI() {
  const tokenData = JSON.parse(await fs.readFile(process.env.HOME + '/.iflow/oauth_creds.json', 'utf8'));
  const baseUrl = 'https://apis.iflow.cn/v1';

  console.log('🔍 Testing iFlow API authentication...');
  console.log('Token data:', {
    access_token: tokenData.access_token.substring(0, 10) + '...',
    token_type: tokenData.token_type,
    expiry_date: new Date(tokenData.expiry_date).toISOString(),
    is_expired: Date.now() >= tokenData.expiry_date
  });

  // Test 1: Try with Bearer token
  console.log('\n📡 Test 1: Bearer token authentication...');
  try {
    const response1 = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${tokenData.access_token}`,
        'Content-Type': 'application/json'
      }
    });

    console.log('Status:', response1.status);
    const text1 = await response1.text();
    console.log('Response:', text1.substring(0, 200));
  } catch (error) {
    console.log('Error:', error.message);
  }

  // Test 2: Try with token_type from OAuth data
  console.log('\n📡 Test 2: OAuth token_type authentication...');
  try {
    const response2 = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: {
        'Authorization': `${tokenData.token_type} ${tokenData.access_token}`,
        'Content-Type': 'application/json'
      }
    });

    console.log('Status:', response2.status);
    const text2 = await response2.text();
    console.log('Response:', text2.substring(0, 200));
  } catch (error) {
    console.log('Error:', error.message);
  }

  // Test 3: Try with API key from OAuth data
  console.log('\n📡 Test 3: API key authentication...');
  try {
    const response3 = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${tokenData.apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    console.log('Status:', response3.status);
    const text3 = await response3.text();
    console.log('Response:', text3.substring(0, 200));
  } catch (error) {
    console.log('Error:', error.message);
  }
}

testIFlowAPI().catch(console.error);