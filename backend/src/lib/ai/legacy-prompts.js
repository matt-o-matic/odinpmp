import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const promptsPath = path.join(currentDir, 'legacy-prompts.generated.json');

export const legacyPrompts = JSON.parse(readFileSync(promptsPath, 'utf8'));

