import { AppError } from '@acr/shared';
import { z } from 'zod';

export interface CliOptions {
  readonly help: boolean;
  readonly repository: string;
  readonly pullRequestNumber: number;
  /** Off by default: a local trial must never surprise the pull request author. */
  readonly publish: boolean;
  readonly checks: boolean;
  readonly json: boolean;
  readonly quiet: boolean;
  /** Force a new review run instead of reusing the run for this head commit. */
  readonly fresh: boolean;
  readonly model: string | null;
}

export const USAGE = `acr-review — run one pull-request review from the command line

Usage:
  npm run review -- --repo <owner/name> --pr <number> [options]

Options:
  --repo, --repository   repository to review, as owner/name         (required)
  --pr, --number         pull request number                          (required)
  --publish              post the summary comment and check run to GitHub
  --no-checks            skip test/lint/typecheck execution entirely
  --model <name>         override LLM_MODEL for this run
  --json                 print one machine-readable result object
  --quiet                only print the final result
  --fresh                force a new review run for the same head commit
  -h, --help             show this text

Environment:
  DATABASE_URL           required: the run is recorded like any other review
  LLM_API_KEY            required unless LLM_PROVIDER points at a local gateway
  GITHUB_TOKEN           used when the GitHub App is not configured

Requires no Redis and no queue: checks run inline and events stay in-process.
`;

const OptionsSchema = z.object({
  repository: z
    .string()
    .regex(/^[^/\s]+\/[^/\s]+$/, 'expected "owner/name"')
    .max(200),
  pullRequestNumber: z.coerce.number().int().positive().max(2_000_000),
  publish: z.boolean().default(false),
  checks: z.boolean().default(true),
  json: z.boolean().default(false),
  quiet: z.boolean().default(false),
  fresh: z.boolean().default(false),
  model: z.string().min(1).max(120).nullable().default(null),
});

const VALUE_FLAGS = new Set(['--repo', '--repository', '--pr', '--number', '--model']);

/**
 * Small hand-rolled parser: one flag per value, `--no-x` negates, and anything
 * unrecognised is an error rather than a silently ignored argument.
 */
export function parseArgs(argv: readonly string[]): CliOptions {
  const flags = new Map<string, string>();
  const bare = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (token === '-h' || token === '--help') {
      return helpOnly();
    }
    if (!token.startsWith('--')) {
      throw new AppError(`unexpected argument "${token}"`, { code: 'validation_error' });
    }

    const equals = token.indexOf('=');
    if (equals > 0) {
      flags.set(token.slice(0, equals), token.slice(equals + 1));
      continue;
    }
    if (VALUE_FLAGS.has(token)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new AppError(`${token} requires a value`, { code: 'validation_error' });
      }
      flags.set(token, value);
      index += 1;
      continue;
    }
    bare.add(token);
  }

  const parsed = OptionsSchema.safeParse({
    repository: flags.get('--repo') ?? flags.get('--repository'),
    pullRequestNumber: flags.get('--pr') ?? flags.get('--number'),
    publish: bare.has('--publish'),
    checks: !bare.has('--no-checks'),
    json: bare.has('--json'),
    quiet: bare.has('--quiet'),
    fresh: bare.has('--fresh'),
    model: flags.get('--model') ?? null,
  });

  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new AppError(
      `invalid arguments: ${first?.path.join('.') ?? 'input'} — ${first?.message ?? 'see --help'}`,
      { code: 'validation_error' },
    );
  }

  return { help: false, ...parsed.data };
}

export function helpOnly(): CliOptions {
  return {
    help: true,
    repository: '',
    pullRequestNumber: 0,
    publish: false,
    checks: true,
    json: false,
    quiet: false,
    fresh: false,
    model: null,
  };
}
