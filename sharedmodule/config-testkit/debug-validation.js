#!/usr/bin/env node

// Simple test to debug validation logic
console.log('=== Testing Validation Logic ===\n');

import { BlackBoxTester, BLACKBOX_TEST_CASES } from './dist/index.js';

const blackboxTester = new BlackBoxTester();

async function testValidation() {
  // Test basic validation case
  const testCase = BLACKBOX_TEST_CASES[0]; // basic-validation
  console.log('Testing:', testCase.name);

  const result = await blackboxTester.runTest(testCase);
  console.log('Result status:', result.status);
  console.log('Expected: passed');
  console.log('Match:', result.status === 'passed');

  // Let's manually check the validation logic
  const actual = result.output;
  const expected = testCase.expectedOutput;

  console.log('\n=== Manual Validation Check ===');

  // Check isValid
  const isValidMatch = actual.isValid === expected.isValid;
  console.log('isValid match:', isValidMatch, `(actual: ${actual.isValid}, expected: ${expected.isValid})`);

  // Check errors
  const errorsMatch = Array.isArray(actual.errors) && Array.isArray(expected.errors) &&
                     actual.errors.length === expected.errors.length;
  console.log('errors match:', errorsMatch, `(actual: ${actual.errors?.length}, expected: ${expected.errors?.length})`);

  // Check warnings
  const warningsMatch = Array.isArray(actual.warnings) && Array.isArray(expected.warnings) &&
                       actual.warnings.length >= expected.warnings.length;
  console.log('warnings match:', warningsMatch, `(actual: ${actual.warnings?.length}, expected: ${expected.warnings?.length})`);

  // Check keyAliases
  let keyAliasesMatch = true;
  if (expected.keyAliases !== undefined) {
    keyAliasesMatch = Array.isArray(actual.keyAliases) && Array.isArray(expected.keyAliases) &&
                     JSON.stringify(actual.keyAliases) === JSON.stringify(expected.keyAliases);
  }
  console.log('keyAliases match:', keyAliasesMatch, `(actual: ${JSON.stringify(actual.keyAliases)}, expected: ${JSON.stringify(expected.keyAliases)})`);

  // Check normalized
  let normalizedMatch = true;
  if (expected.normalized && actual.normalized) {
    // Simple check - let's just compare the structure
    normalizedMatch = JSON.stringify(Object.keys(actual.normalized).sort()) ===
                     JSON.stringify(Object.keys(expected.normalized).sort());
  }
  console.log('normalized keys match:', normalizedMatch);

  if (actual.normalized && expected.normalized) {
    console.log('Actual normalized keys:', Object.keys(actual.normalized).sort());
    console.log('Expected normalized keys:', Object.keys(expected.normalized).sort());
  }

  // Overall validation result
  const overallMatch = isValidMatch && errorsMatch && warningsMatch && keyAliasesMatch && normalizedMatch;
  console.log('\nOverall validation should pass:', overallMatch);

  console.log('\n=== End Debug ===\n');
}

testValidation().catch(console.error);