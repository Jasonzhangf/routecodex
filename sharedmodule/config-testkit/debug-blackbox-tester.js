#!/usr/bin/env node

// Debug BlackBoxTester validation
console.log('=== Debug BlackBoxTester Validation ===\n');

import { BlackBoxTester, BLACKBOX_TEST_CASES } from './dist/index.js';

const blackboxTester = new BlackBoxTester();

async function debugTest(testCase) {
  console.log(`Testing: ${testCase.name}`);
  console.log('Input config:', JSON.stringify(testCase.inputConfig, null, 2));

  const result = await blackboxTester.runTest(testCase);

  console.log('\nResult status:', result.status);
  console.log('Result isValid:', result.output?.isValid);
  console.log('Result errors:', result.output?.errors);

  if (result.output?.normalized) {
    console.log('\nActual normalized output:');
    console.log(JSON.stringify(result.output.normalized, null, 2));
  }

  console.log('\nExpected output:');
  console.log(JSON.stringify(testCase.expectedOutput.normalized, null, 2));

  // Check what the validateOutput method is seeing
  const normalized = blackboxTester.getUtilities().createMockConfig();
  const actual = result.output;
  const expected = testCase.expectedOutput;

  console.log('\n=== Validation Check ===');
  console.log('actual.isValid:', actual.isValid);
  console.log('expected.isValid:', expected.isValid);
  console.log('isValid match:', actual.isValid === expected.isValid);

  console.log('\nactual.errors length:', actual.errors?.length);
  console.log('expected.errors length:', expected.errors?.length);
  console.log('errors length match:', actual.errors?.length === expected.errors?.length);

  console.log('\nactual.warnings length:', actual.warnings?.length);
  console.log('expected.warnings length:', expected.warnings?.length);
  console.log('warnings length match:', actual.warnings?.length >= expected.warnings?.length);

  // Check top-level keyAliases field (updated validation logic)
  if (expected.keyAliases !== undefined) {
    console.log('\n=== Top-Level keyAliases Check ===');
    const hasKeyAliases = 'keyAliases' in actual && actual.keyAliases !== undefined;
    console.log('Has top-level keyAliases:', hasKeyAliases);

    if (hasKeyAliases) {
      console.log('Actual keyAliases:', actual.keyAliases);
      console.log('Expected keyAliases:', expected.keyAliases);
      const keyAliasesMatch = Array.isArray(actual.keyAliases) && Array.isArray(expected.keyAliases) &&
                              JSON.stringify(actual.keyAliases) === JSON.stringify(expected.keyAliases);
      console.log('keyAliases match:', keyAliasesMatch);
    } else {
      console.log('Missing top-level keyAliases in actual output');
    }
  }

  if (expected.normalized && actual.normalized) {
    console.log('\n=== Normalized Config Comparison ===');
    const containsExpected = containsExpectedFields(actual.normalized, expected.normalized);
    console.log('Contains expected fields in normalized:', containsExpected);

    if (!containsExpected) {
      console.log('\nField mismatch details:');
      findFieldMismatches(actual.normalized, expected.normalized);
    }
  }

  // Overall validation result
  console.log('\n=== Overall Validation Result ===');
  let validationSuccess = true;

  if (actual.isValid !== expected.isValid) {
    console.log('❌ isValid mismatch');
    validationSuccess = false;
  }

  if (!Array.isArray(actual.errors) || !Array.isArray(expected.errors) || actual.errors.length !== expected.errors.length) {
    console.log('❌ errors length mismatch');
    validationSuccess = false;
  }

  if (!Array.isArray(actual.warnings) || !Array.isArray(expected.warnings) || actual.warnings.length < expected.warnings.length) {
    console.log('❌ warnings length mismatch');
    validationSuccess = false;
  }

  if (expected.keyAliases !== undefined) {
    if (!Array.isArray(actual.keyAliases) || !Array.isArray(expected.keyAliases) ||
        JSON.stringify(actual.keyAliases) !== JSON.stringify(expected.keyAliases)) {
      console.log('❌ keyAliases mismatch');
      validationSuccess = false;
    } else {
      console.log('✅ keyAliases match');
    }
  }

  if (expected.normalized && actual.normalized) {
    if (containsExpectedFields(actual.normalized, expected.normalized)) {
      console.log('✅ normalized config match');
    } else {
      console.log('❌ normalized config mismatch');
      validationSuccess = false;
    }
  }

  console.log('Overall validation success:', validationSuccess ? '✅ PASSED' : '❌ FAILED');

  console.log('\n=== End Debug ===\n');
}

// Helper functions (copied from BlackBoxTester)
function containsExpectedFields(actual, expected) {
  for (const [key, value] of Object.entries(expected)) {
    if (!(key in actual)) {
      console.log(`Missing key: ${key}`);
      return false;
    }

    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      if (typeof actual[key] !== 'object' || actual[key] === null) {
        console.log(`Type mismatch for key ${key}: expected object, got ${typeof actual[key]}`);
        return false;
      }
      if (!containsExpectedFields(actual[key], value)) {
        return false;
      }
    } else if (Array.isArray(value)) {
      if (!Array.isArray(actual[key])) {
        console.log(`Type mismatch for key ${key}: expected array, got ${typeof actual[key]}`);
        return false;
      }
      if (actual[key].length !== value.length) {
        console.log(`Array length mismatch for key ${key}: expected ${value.length}, got ${actual[key].length}`);
        return false;
      }
      for (let i = 0; i < value.length; i++) {
        if (actual[key][i] !== value[i]) {
          console.log(`Array value mismatch for key ${key}[${i}]: expected ${value[i]}, got ${actual[key][i]}`);
          return false;
        }
      }
    } else {
      if (actual[key] !== value) {
        console.log(`Value mismatch for key ${key}: expected ${value}, got ${actual[key]}`);
        return false;
      }
    }
  }
  return true;
}

function findFieldMismatches(actual, expected, path = '') {
  for (const [key, value] of Object.entries(expected)) {
    const currentPath = path ? `${path}.${key}` : key;

    if (!(key in actual)) {
      console.log(`Missing field: ${currentPath}`);
      continue;
    }

    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      if (typeof actual[key] !== 'object' || actual[key] === null) {
        console.log(`Type mismatch at ${currentPath}: expected object, got ${typeof actual[key]}`);
      } else {
        findFieldMismatches(actual[key], value, currentPath);
      }
    } else if (Array.isArray(value)) {
      if (!Array.isArray(actual[key])) {
        console.log(`Type mismatch at ${currentPath}: expected array, got ${typeof actual[key]}`);
      } else if (actual[key].length !== value.length) {
        console.log(`Array length mismatch at ${currentPath}: expected ${value.length}, got ${actual[key].length}`);
      }
    } else {
      if (actual[key] !== value) {
        console.log(`Value mismatch at ${currentPath}: expected ${value}, got ${actual[key]}`);
      }
    }
  }

  // Check for extra fields in actual
  for (const key of Object.keys(actual)) {
    if (!(key in expected)) {
      const currentPath = path ? `${path}.${key}` : key;
      console.log(`Extra field in actual: ${currentPath}`);
    }
  }
}

// Test basic validation case
console.log('=== Testing Basic Validation Case ===');
const basicTestCase = BLACKBOX_TEST_CASES[0]; // basic-validation
await debugTest(basicTestCase);

console.log('\n=== Testing Multi-Provider Validation Case ===');
const multiProviderTestCase = BLACKBOX_TEST_CASES[1]; // multi-provider-validation
await debugTest(multiProviderTestCase);