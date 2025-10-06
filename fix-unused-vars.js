#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Get all TypeScript files
const files = execSync('find src -name "*.ts"', { encoding: 'utf8' }).trim().split('\n');

let totalFixed = 0;

files.forEach(file => {
  if (!fs.existsSync(file)) return;
  
  let content = fs.readFileSync(file, 'utf8');
  const originalContent = content;
  
  // Fix unused parameters by adding underscore prefix
  content = content.replace(/(\s+)([a-zA-Z_$][a-zA-Z0-9_$]*)(\s*:\s*[^,)]+)(\s*[,)])(\s*\/\/.*\s*)?$/gm, (match, whitespace, param, type, comma, comment) => {
    // Skip if already prefixed with underscore
    if (param.startsWith('_')) return match;
    
    // Skip if this looks like a destructuring pattern
    if (param.includes('{') || param.includes('[')) return match;
    
    return whitespace + '_' + param + type + comma + (comment || '');
  });
  
  // Fix unused variables in function bodies
  content = content.replace(/^(const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)(\s*=\s*[^;]+;)\s*\/\/.*unused.*$/gm, (match, decl, varName, assignment) => {
    // Skip if already prefixed with underscore
    if (varName.startsWith('_')) return match;
    
    return decl + ' _' + varName + assignment;
  });
  
  // Write back if changed
  if (content !== originalContent) {
    fs.writeFileSync(file, content);
    console.log(`Fixed unused variables in ${file}`);
    totalFixed++;
  }
});

console.log(`\nTotal files fixed: ${totalFixed}`);
