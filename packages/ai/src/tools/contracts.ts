import type { CommandKind, CommandOutcome } from '@acr/shared';

export interface CheckLaunchRequest {
  readonly kind: CommandKind;
  readonly script: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

export type CheckLauncher = (request: CheckLaunchRequest) => Promise<CommandOutcome>;

/** Script allow-list per command kind, derived from the repository manifest. */
export type AllowedScripts = Partial<Record<CommandKind, readonly string[]>>;

export interface ToolDependencies {
  readonly launchCheck: CheckLauncher;
  readonly allowedScripts: AllowedScripts;
  readonly defaultCheckTimeoutMs: number;
  /** Cached PR comments so the read-only tool does not re-hit GitHub. */
  readonly prComments?: () => Promise<readonly { author: string; body: string; path?: string }[]>;
  readonly sandboxUnavailable?: () => string | null;
}

export interface ToolHandlerResult {
  /** Text handed back to the model as the tool result. */
  readonly output: string;
  /** Findings accepted by submit_findings; empty for every other tool. */
  readonly findings: readonly import('@acr/shared').FindingDraft[];
  readonly metadata: Record<string, unknown> | null;
  readonly isError: boolean;
}

export type ToolHandler = (args: unknown) => Promise<ToolHandlerResult>;

export function toOutcomeSummary(outcome: CommandOutcome): string {
  const head = `${outcome.command} -> ${outcome.status} (exit ${outcome.exitCode ?? 'n/a'}, ${outcome.durationMs}ms, ${outcome.sandbox})`;
  const body = [outcome.stdout, outcome.stderr]
    .filter((part) => part.length > 0)
    .join('\n')
    .trim();
  return body.length === 0 ? head : `${head}\n${body}`;
}
