import { ValidationError, type CommandSpec } from '@acr/shared';

const SCRIPT_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,63}$/;
const ARGUMENT_PATTERN = /^[a-zA-Z0-9@/._:=-]{1,200}$/;
// The allow-list above permits `/` and `.` (legitimate flags like
// `--filter=packages/x` or `--maxWorkers=2`), so path escapes are checked
// separately: traversal (`..`), absolute targets (`/etc/passwd`, `C:/...`)
// and flag values pointing at absolute paths (`--out=/tmp/x`,
// `--file=D:/secrets/key`) are rejected.
const ARGUMENT_PATH_ESCAPE = /\.\.|^\/|^[a-zA-Z]:\/|=\/|=[a-zA-Z]:\//;

export const DEFAULT_ARGUMENT_SEPARATOR = '--';

/**
 * The agent never supplies a raw command line. It selects a script name, and
 * both the script and every argument must match a strict allow-list pattern
 * that excludes whitespace and shell metacharacters, so the assembled command
 * line is safe even through the Windows cmd.exe wrapper. Arguments may not be
 * empty and may not reference paths outside the workspace (`..`, absolute
 * paths, or flag values pointing at them).
 */
export function assertSafeCommandSpec(spec: CommandSpec): void {
  // `RegExp.test` stringifies its input, so a value that is not a string at
  // runtime (crossed in via JSON from a model/tool call) could slip past the
  // pattern check after coercion. Verify the runtime type before the pattern.
  if (typeof spec.script !== 'string' || !SCRIPT_PATTERN.test(spec.script)) {
    throw new ValidationError('Unsafe package script name', { script: spec.script });
  }
  for (const argument of spec.args) {
    if (
      typeof argument !== 'string' ||
      !ARGUMENT_PATTERN.test(argument) ||
      ARGUMENT_PATH_ESCAPE.test(argument)
    ) {
      throw new ValidationError('Unsafe command argument', { argument });
    }
  }
  if (
    typeof spec.timeoutMs !== 'number' ||
    !Number.isFinite(spec.timeoutMs) ||
    spec.timeoutMs < 1000
  ) {
    throw new ValidationError('Sandbox timeout must be at least 1000ms', {
      timeoutMs: spec.timeoutMs,
    });
  }
}

const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;

/**
 * Keys the fixed sandbox environment owns. A command spec may carry extra
 * variables, but it may never override these: PATH/HOME hijacks and
 * `NODE_OPTIONS`/`LD_PRELOAD` injection would otherwise turn a repository
 * script into host-process code execution.
 */
const PROTECTED_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'USERPROFILE',
  'SystemRoot',
  'ComSpec',
  'TEMP',
  'TMP',
  'CI',
  'NODE_ENV',
  'GIT_TERMINAL_PROMPT',
  'GIT_ASKPASS',
  'DOCKER_HOST',
  'NODE_OPTIONS',
]);

/**
 * Extra environment from a command spec, stripped of anything that could
 * widen the sandbox. Unknown keys outside `^[A-Z_][A-Z0-9_]*$` and the
 * protected set above are dropped rather than rejected: the safe default
 * always wins over caller-supplied configuration.
 */
export function sanitizeSpecEnv(env: Readonly<Record<string, string>> | undefined): Record<string, string> {
  if (env === undefined) {
    return {};
  }
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') {
      continue;
    }
    if (!ENV_KEY_PATTERN.test(key) || PROTECTED_ENV_KEYS.has(key)) {
      continue;
    }
    if (key.startsWith('GIT_') || key.startsWith('NPM_CONFIG_') || key.startsWith('LD_')) {
      continue;
    }
    output[key] = value;
  }
  return output;
}

export interface ResolvedCommand {
  readonly binary: string;
  readonly args: readonly string[];
  readonly display: string;
}

function joinScriptAndArgs(script: string, args: readonly string[]): string {
  return args.length === 0 ? `npm run ${script}` : `npm run ${script} -- ${args.join(' ')}`;
}

export function resolveNpmCommand(spec: CommandSpec, platform: NodeJS.Platform = process.platform): ResolvedCommand {
  assertSafeCommandSpec(spec);
  if (platform === 'win32') {
    return {
      binary: process.env['ComSpec'] ?? 'cmd.exe',
      args: ['/d', '/s', '/c', joinScriptAndArgs(spec.script, spec.args)],
      display: joinScriptAndArgs(spec.script, spec.args),
    };
  }
  return {
    binary: 'npm',
    args: spec.args.length === 0 ? ['run', spec.script] : ['run', spec.script, '--', ...spec.args],
    display: joinScriptAndArgs(spec.script, spec.args),
  };
}

export function toShellCommandLine(spec: CommandSpec): string {
  assertSafeCommandSpec(spec);
  return joinScriptAndArgs(spec.script, spec.args);
}
