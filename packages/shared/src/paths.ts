import { ValidationError } from './errors';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export function isSafeRelativePath(input: string): boolean {
  if (input.length === 0 || input.length > 1024) {
    return false;
  }
  if (input.includes('\0') || CONTROL_CHARACTERS.test(input)) {
    return false;
  }
  if (input.startsWith('/') || input.startsWith('\\')) {
    return false;
  }
  if (/^[a-zA-Z]:/.test(input)) {
    return false;
  }
  const segments = input.split(/[\\/]/);
  if (segments.some((segment) => segment === '..' || segment === '')) {
    return false;
  }
  return true;
}

/**
 * Joins a repository-relative path onto a root directory, rejecting anything
 * that could escape the root (absolute paths, drive letters, `..` segments).
 */
export function resolveWithinRoot(root: string, relativePath: string): string {
  if (!isSafeRelativePath(relativePath)) {
    throw new ValidationError('Unsafe repository path', { path: relativePath });
  }
  const normalizedRoot = root.endsWith('\\') || root.endsWith('/') ? root.slice(0, -1) : root;
  const separator = normalizedRoot.includes('\\') ? '\\' : '/';
  const normalizedRelative = relativePath.split(/[\\/]/).join(separator);
  return `${normalizedRoot}${separator}${normalizedRelative}`;
}

export function normalizeRepoPath(input: string): string {
  return input.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function dirnameOfRepoPath(input: string): string {
  const normalized = normalizeRepoPath(input);
  const index = normalized.lastIndexOf('/');
  return index === -1 ? '' : normalized.slice(0, index);
}

export function basenameOfRepoPath(input: string): string {
  const normalized = normalizeRepoPath(input);
  const index = normalized.lastIndexOf('/');
  return index === -1 ? normalized : normalized.slice(index + 1);
}

export function extensionOfRepoPath(input: string): string {
  const base = basenameOfRepoPath(input);
  const index = base.lastIndexOf('.');
  return index <= 0 ? '' : base.slice(index).toLowerCase();
}
