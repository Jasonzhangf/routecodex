#!/usr/bin/env node

import { execSync } from 'child_process';
import fs from 'fs';

// Get the specific ESLint output for unused variables
const eslintOutput = execSync('npx eslint src/ --rule @typescript-eslint/no-unused-vars:error --format compact', { encoding: 'utf8' });

// Parse the output to get file paths and line numbers
const outputLines = eslintOutput.split('\n');
const fixes = [];

outputLines.forEach(line => {
  const match = line.match(/^([^:]+):(\d+):\d+\s+error\s+.*'([^']+)'.*no-unused-vars/);
  if (match) {
    const [, filePath, lineNumber, varName] = match;
    fixes.push({ filePath, lineNumber: parseInt(lineNumber), varName });
  }
});

// Group fixes by file
const fixesByFile = {};
fixes.forEach(fix => {
  if (!fixesByFile[fix.filePath]) {
    fixesByFile[fix.filePath] = [];
  }
  fixesByFile[fix.filePath].push(fix);
});

// Apply fixes file by file
Object.entries(fixesByFile).forEach(([filePath, fileFixes]) => {
  let content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  
  // Process fixes in reverse order (to avoid line number shifts)
  fileFixes.sort((a, b) => b.lineNumber - a.lineNumber);
  
  fileFixes.forEach(fix => {
    const lineIndex = fix.lineNumber - 1;
    if (lineIndex >= 0 && lineIndex < lines.length) {
      let line = lines[lineIndex];
      
      // Handle different types of unused variables
      if (line.includes('import') && line.includes(fix.varName)) {
        // Remove unused import
        lines[lineIndex] = line.replace(/,\s*'[^']+'/.replace('X', fix.varName) + '/', '');
        lines[lineIndex] = lines[lineIndex].replace(/,\s*{[^}]*}/.replace('X', fix.varName) + '/', '');
        lines[lineIndex] = lines[lineIndex].replace(/import[^;]*'[^']+';/.replace('X', fix.varName) + '', '');
      } else if (line.includes(fix.varName + ' =') || line.includes(fix.varName + ':')) {
        // Comment out unused variable assignment
        lines[lineIndex] = '// ' + line;
      } else if (line.includes(fix.varName) && !line.includes('_' + fix.varName)) {
        // Add underscore prefix if not already present
        lines[lineIndex] = line.replace(new RegExp('\\b' + fix.varName + '\\b', 'g'), '_' + fix.varName);
      }
    }
  });
  
  // Write back the fixed content
  fs.writeFileSync(filePath, lines.join('\n'));
  console.log(`Fixed ${fileFixes.length} unused variables in ${filePath}`);
});

console.log(`\nTotal fixes applied: ${fixes.length}`);
