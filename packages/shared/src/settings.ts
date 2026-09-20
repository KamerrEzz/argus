import { z } from 'zod';
import { SEVERITIES } from './findings';
import { AGENT_BASE_PERMISSIONS, PERMISSIONS } from './permissions';

export const RepositorySettingsSchema = z.object({
  enabled: z.boolean().default(true),
  reviewDrafts: z.boolean().default(true),
  enableTests: z.boolean().default(true),
  enableLint: z.boolean().default(true),
  enableTypecheck: z.boolean().default(true),
  enableSecurityScan: z.boolean().default(true),
  enableAiReview: z.boolean().default(true),
  deepReview: z.boolean().default(true),
  minPublishConfidence: z.number().min(0).max(1).default(0.6),
  failOnSeverities: z.array(z.enum(SEVERITIES)).default(['critical', 'high']),
  publishSummaryComment: z.boolean().default(true),
  publishFindingsAsComments: z.boolean().default(false),
  createCheckRun: z.boolean().default(true),
  requireApprovalToPublish: z.boolean().default(false),
  ignorePaths: z.array(z.string().max(1024)).max(500).default([]),
  maxFiles: z.number().int().min(1).max(1000).default(50),
  instructionHints: z.string().max(4000).default(''),
  agentPermissions: z
    .object({
      granted: z.array(z.enum(PERMISSIONS)).default([...AGENT_BASE_PERMISSIONS]),
      denied: z.array(z.enum(PERMISSIONS)).default([]),
    })
    .default({ granted: [...AGENT_BASE_PERMISSIONS], denied: [] }),
});

export type RepositorySettings = z.infer<typeof RepositorySettingsSchema>;

export const DEFAULT_REPOSITORY_SETTINGS: RepositorySettings = RepositorySettingsSchema.parse({});

export function parseRepositorySettings(value: unknown): RepositorySettings {
  const result = RepositorySettingsSchema.safeParse(value ?? {});
  return result.success ? result.data : DEFAULT_REPOSITORY_SETTINGS;
}

export function filterIgnoredPaths(
  paths: readonly string[],
  ignorePatterns: readonly string[],
): readonly string[] {
  if (ignorePatterns.length === 0) {
    return paths;
  }
  const matchers = ignorePatterns.map((pattern) => globToRegExp(pattern));
  return paths.filter((path) => !matchers.some((matcher) => matcher.test(path)));
}

/**
 * Minimal glob support for repository ignore rules: `**`, `*` and `?` only.
 * Anything more complex belongs in the repository's own lint configuration.
 */
export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  let source = '';
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index] ?? '';
    if (character === '*') {
      const isDouble = normalized[index + 1] === '*';
      if (isDouble) {
        const isGlobstarSlash = normalized[index + 2] === '/';
        source += isGlobstarSlash ? '(?:.*/)?' : '.*';
        index += isGlobstarSlash ? 2 : 1;
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (character === '?') {
      source += '[^/]';
      continue;
    }
    source += character.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}
