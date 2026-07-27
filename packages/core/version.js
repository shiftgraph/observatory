import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageJsonPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

export const TOOL_VERSION = packageJson.version;
