import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const WORKSPACE_MARKER = 'tsconfig.base.json';
const MAX_ANCESTOR_DEPTH = 6;

export function findWorkspaceRoot(startDir: string = process.cwd()): string {
  let current = resolve(startDir);
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth += 1) {
    if (existsSync(join(current, WORKSPACE_MARKER)) && existsSync(join(current, 'package.json'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return resolve(startDir);
}

export function resolveFromWorkspaceRoot(...segments: string[]): string {
  return join(findWorkspaceRoot(), ...segments);
}
