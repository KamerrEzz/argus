import { Annotation } from '@langchain/langgraph';
import type {
  AnalysisResult,
  ChangeClassification,
  ChangedFile,
  CheckExecutionRecord,
  FindingDraft,
  FindingValidationOutcome,
  InjectionSignal,
  PullRequestInfo,
  ReviewPlan,
  ReviewTrigger,
  ReviewVerdict,
} from '@acr/shared';
import type { ChatMessage } from './provider/types';

export interface NodeTraceEntry {
  readonly node: string;
  readonly status: 'succeeded' | 'failed' | 'skipped';
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly summary: string;
  readonly error: string | null;
}

/** Last-write-wins channel with an explicit starting value. */
function field<T>(initial: () => T) {
  return Annotation<T>({ reducer: (_left, right) => right, default: initial });
}

/** Append-only channel: nodes report what happened, never rewrite history. */
function appended<T>(initial: () => readonly T[]) {
  return Annotation<readonly T[]>({
    reducer: (left, right) => [...left, ...(Array.isArray(right) ? (right as readonly T[]) : [right as T])],
    default: initial,
  });
}

function counter(initial: () => number) {
  return Annotation<number>({ reducer: (left, right) => left + right, default: initial });
}

/**
 * The graph's serialisable state. Ports, workspaces and providers never live
 * here: they are captured by node closures, so a checkpoint stays pure data.
 */
export const ReviewGraphState = Annotation.Root({
  reviewRunId: field<string>(() => ''),
  agentExecutionId: field<string>(() => ''),
  trigger: field<ReviewTrigger>(() => 'manual'),

  headSha: field<string>(() => ''),
  baseSha: field<string>(() => ''),
  workspaceDir: field<string | null>(() => null),

  pullRequest: field<PullRequestInfo | null>(() => null),
  diff: field<string>(() => ''),
  changedFiles: field<readonly ChangedFile[]>(() => []),
  fileInventory: field<readonly string[]>(() => []),
  classification: field<ChangeClassification | null>(() => null),
  plan: field<ReviewPlan | null>(() => null),

  commands: appended<CheckExecutionRecord>(() => []),
  analyses: appended<AnalysisResult>(() => []),
  findings: appended<FindingDraft>(() => []),
  validated: field<readonly FindingValidationOutcome[]>(() => []),

  transcript: appended<ChatMessage>(() => []),
  iteration: counter(() => 0),
  nodeTrace: appended<NodeTraceEntry>(() => []),
  warnings: appended<string>(() => []),
  skipped: appended<string>(() => []),
  injectionSignals: appended<InjectionSignal>(() => []),

  tokensIn: counter(() => 0),
  tokensOut: counter(() => 0),

  verdict: field<ReviewVerdict | null>(() => null),
  summary: field<string>(() => ''),
  narrative: field<string>(() => ''),
  budgetExhausted: field<boolean>(() => false),
  stoppedReason: field<string | null>(() => null),
});

export type ReviewGraphStateType = typeof ReviewGraphState.State;
