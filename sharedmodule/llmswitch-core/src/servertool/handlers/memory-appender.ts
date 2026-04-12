import fs from 'node:fs';
import path from 'node:path';

interface AppendLearningOptions {
  learning: string;
  cwd: string;
}

const MAX_LEARNING_LENGTH = 500;

export function appendLearningToMemory(options: AppendLearningOptions): void {
  const { learning, cwd } = options;
  if (!learning || learning.trim().length === 0) {
    return;
  }
  
  const trimmedLearning = learning.trim().slice(0, MAX_LEARNING_LENGTH);
  const memoryPath = path.join(cwd, 'MEMORY.md');
  
  // Check if MEMORY.md exists
  if (!fs.existsSync(memoryPath)) {
    return;
  }
  
  // Read existing content
  const existingContent = fs.readFileSync(memoryPath, 'utf-8');
  
  // Dedup: check if similar learning already exists (simple substring match)
  const normalizedLearning = trimmedLearning.toLowerCase().replace(/\s+/g, ' ');
  const normalizedExisting = existingContent.toLowerCase().replace(/\s+/g, ' ');
  
  if (normalizedExisting.includes(normalizedLearning.slice(0, 50))) {
    return;
  }
  
  // Format new entry
  const date = new Date().toISOString().split('T')[0];
  const newEntry = `\n- ${date}: ${trimmedLearning}\n  Tags: reasoning-stop, learning, auto-captured\n`;
  
  // Find insertion point (after header if exists)
  const lines = existingContent.split('\n');
  let insertIndex = 0;
  
  // Skip header lines (lines starting with #)
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#') || lines[i].trim() === '') {
      insertIndex = i + 1;
    } else {
      break;
    }
  }
  
  // Insert new entry
  lines.splice(insertIndex, 0, newEntry);
  
  // Write back
  fs.writeFileSync(memoryPath, lines.join('\n'), 'utf-8');
}
