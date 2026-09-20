import {
  BudgetExceededError,
  compareWithPreviousFindings,
  createUntrustedBoundary,
  dedupeFindings,
  findingFingerprint,
  validateFinding,
  type AgentToolContext,
  type FindingDraft,
  type FindingValidationOutcome,
  type PersistedFindingInput,
  type PullRequestInfo,
  type Severity,
} from '@acr/shared';
import {
  addUsage,
  emptyUsage,
  type ChatMessage,
  type CompletionResponse,
  type TokenUsage,
  type ToolCall,
} from '../provider/types';
import { availableToolSpecs } from '../tools/definitions';
import { executeToolCalls } from '../tools/executor';
import { createToolHandlers } from '../tools/implementations';
import type { ToolHandler } from '../tools/contracts';
import type { ToolName } from '../tools/definitions';
import { buildDiffBlock, planDiffBatches } from '../diff';
import { SEVERITY_LADDER, budgetClosingPrompt, critiquePrompt, reviewerSystemPrompt, reviewTaskPrompt } from '../prompts';
import { FindingCritiqueSchema } from '../output-schemas';
import { publish, skippedNode, type GraphNodeFn, type ReviewGraphPorts } from './instrument';

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

const MAX_DIFF_BATCHES = 4;

function severityLadderText(): string {
  return Object.entries(SEVERITY_LADDER)
    .map(([severity, definition]) => `- ${severity}: ${definition}`)
    .join('\n');
}

function requirePullRequest(
  ports: ReviewGraphPorts,
  pullRequest: PullRequestInfo | null,
): PullRequestInfo {
  if (pullRequest === null) {
    throw new Error(`a review node ran before load_pr for ${ports.reviewRunId}`);
  }
  return pullRequest;
}

/**
 * The capability bundle tools are allowed to use. It is built here, after the
 * pull request is loaded, because tools describe the change under review.
 */
function buildToolContext(
  ports: ReviewGraphPorts,
  pullRequest: PullRequestInfo,
  changedFiles: AgentToolContext['changedFiles'],
): AgentToolContext {
  return {
    reviewRunId: ports.reviewRunId,
    agentExecutionId: ports.agentExecutionId,
    principal: { type: 'agent', id: ports.principalId, permissions: ports.permissions },
    repository: ports.repository,
    pullRequest,
    changedFiles,
    workspace: ports.workspace,
    github: ports.github,
    persistence: ports.persistence,
    logger: ports.logger,
    budget: ports.budget,
    settings: ports.settings,
    maxFileBytes: ports.limits.maxFileBytes,
    usePreviousFindings: ports.usePreviousFindings,
    previousFindings: ports.previousFindings,
    recordToolCall: async (record) => {
      await ports.persistence.recordToolExecution({
        reviewRunId: ports.reviewRunId,
        agentExecutionId: ports.agentExecutionId,
        tool: record.tool,
        status: record.status,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
        durationMs: record.durationMs,
        inputMetadata: record.inputMetadata,
        outputMetadata: record.outputMetadata,
        error: record.error,
      });
      await publish(ports, {
        reviewRunId: ports.reviewRunId,
        type: record.status === 'denied' ? 'warning' : 'tool.finished',
        message: `${record.tool} ${record.status} in ${record.durationMs}ms`,
        tool: record.tool,
        status: record.status,
        data: record.error === null ? {} : { error: record.error },
      });
    },
  };
}

interface AgentLoopResult {
  readonly findings: readonly FindingDraft[];
  readonly messages: readonly ChatMessage[];
  readonly usage: TokenUsage;
  readonly iterations: number;
  readonly toolCalls: number;
  readonly deniedTools: readonly string[];
  readonly warnings: readonly string[];
  readonly stoppedReason: string;
}

interface AgentLoopDeps {
  readonly ctx: AgentToolContext;
  readonly handlers: Record<ToolName, ToolHandler>;
  readonly messages: ChatMessage[];
  readonly label: string;
}

/**
 * Ask the model, honour its tool calls, feed the results back, stop when it
 * submits findings, runs out of turns, or the budget closes. Budget exhaustion
 * is a graceful stop: the model gets one closing turn to report what it found.
 */
async function runAgentLoop(
  ports: ReviewGraphPorts,
  deps: AgentLoopDeps,
): Promise<AgentLoopResult> {
  const toolSpecs = ports.allowToolUse
    ? availableToolSpecs({
        executionEnabled: ports.sandboxUnavailable === null,
        granted: deps.ctx.principal.permissions,
      })
    : [];

  const findings: FindingDraft[] = [];
  const deniedTools = new Set<string>();
  const warnings: string[] = [];
  let usage = emptyUsage();
  let iterations = 0;
  let toolCalls = 0;
  let submitted = false;
  let nudged = false;
  let stoppedReason = 'model_finished';

  const maxTurns = ports.limits.maxAgentIterations;
  const hardCap = maxTurns + 4;

  while (iterations < hardCap) {
    iterations += 1;
    const remaining = ports.budget.snapshot().remaining;

    if (remaining.tokens <= 0 || remaining.durationMs < 30_000) {
      stoppedReason = 'budget_exhausted';
      warnings.push(
        `${deps.label}: budget exhausted after ${iterations - 1} turn(s); findings so far are partial`,
      );
      const closing = await closingTurn(ports, deps);
      findings.push(...closing.findings);
      usage = addUsage(usage, closing.usage);
      submitted = submitted || closing.submitted;
      break;
    }

    if (iterations === maxTurns && !submitted) {
      deps.messages.push({
        role: 'user',
        content: budgetClosingPrompt({
          iteration: iterations,
          maxIterations: maxTurns,
          remainingTokens: remaining.tokens,
          findingsSoFar: findings.length,
        }),
      });
    }

    const response: CompletionResponse = await ports.provider.complete({
      messages: [...deps.messages],
      model: ports.model,
      ...(toolSpecs.length > 0 ? { tools: toolSpecs } : {}),
    });

    usage = addUsage(usage, response.usage);
    ports.budget.addTokens(response.usage.inputTokens + response.usage.outputTokens);
    ports.costs.record(`${deps.label}:turn${iterations}`, response.model, response.usage);
    deps.messages.push({ role: 'assistant', content: response.text });

    if (response.toolCalls.length === 0) {
      if (!submitted && !nudged && ports.allowToolUse) {
        nudged = true;
        deps.messages.push({
          role: 'user',
          content:
            'You ended without calling submit_findings, so nothing you wrote would be reported. Call it now with your findings - an empty list is the correct answer when the change is clean.',
        });
        continue;
      }
      stoppedReason = submitted ? 'findings_submitted' : 'model_finished_without_submitting';
      break;
    }

    for (const call of response.toolCalls) {
      await publish(ports, {
        reviewRunId: ports.reviewRunId,
        type: 'tool.started',
        message: `${call.name} requested`,
        tool: call.name,
        data: { turn: iterations, batch: deps.label },
      });
    }

    toolCalls += response.toolCalls.length;
    const batch = await executeToolCalls(deps.ctx, deps.handlers, response.toolCalls, {
      timeoutMs: ports.limits.toolTimeoutMs,
    });
    deps.messages.push(...batch.messages);
    findings.push(...batch.findings);
    for (const tool of batch.deniedTools) {
      deniedTools.add(tool);
    }
    if (batch.findings.length > 0) {
      submitted = true;
      stoppedReason = 'findings_submitted';
    }
    if (batch.denied > 0) {
      warnings.push(`${deps.label}: ${batch.denied} tool call(s) refused by the permission policy`);
    }

    if (submitted && response.finishReason === 'tool_calls' && batch.failed === 0) {
      // A successful submission is a valid stopping point even without 'stop'.
      break;
    }

    try {
      ports.budget.checkIterations();
      ports.budget.checkToolCalls();
    } catch (error) {
      if (!(error instanceof BudgetExceededError)) {
        throw error;
      }
      stoppedReason = 'budget_exhausted';
      warnings.push(`${deps.label}: ${error.limit} reached`);
      break;
    }
  }

  if (iterations >= hardCap && stoppedReason === 'model_finished') {
    stoppedReason = 'iteration_cap_reached';
    warnings.push(`${deps.label}: stopped at the ${hardCap} turn safety cap`);
  }

  return {
    findings,
    messages: [...deps.messages],
    usage,
    iterations,
    toolCalls,
    deniedTools: [...deniedTools],
    warnings,
    stoppedReason: submitted ? 'findings_submitted' : stoppedReason,
  };
}

/** One last, tool-restricted turn so a cut-short review still reports findings. */
async function closingTurn(
  ports: ReviewGraphPorts,
  deps: AgentLoopDeps,
): Promise<{ submitted: boolean; findings: FindingDraft[]; usage: TokenUsage }> {
  let usage = emptyUsage();
  const findings: FindingDraft[] = [];
  try {
    deps.messages.push({
      role: 'user',
      content: budgetClosingPrompt({
        iteration: ports.limits.maxAgentIterations,
        maxIterations: ports.limits.maxAgentIterations,
        remainingTokens: 0,
        findingsSoFar: 0,
      }),
    });
    const response = await ports.provider.complete({
      messages: [...deps.messages],
      model: ports.model,
      tools: availableToolSpecs({
        executionEnabled: false,
        granted: deps.ctx.principal.permissions,
      }).filter((spec) => spec.name === 'submit_findings'),
    });
    usage = addUsage(usage, response.usage);
    ports.costs.record(`${deps.label}:closing`, response.model, response.usage);
    deps.messages.push({ role: 'assistant', content: response.text });

    const submitCalls: ToolCall[] = response.toolCalls.filter((call) => call.name === 'submit_findings');
    if (submitCalls.length === 0) {
      return { submitted: false, findings, usage };
    }
    const batch = await executeToolCalls(deps.ctx, deps.handlers, submitCalls, {
      timeoutMs: ports.limits.toolTimeoutMs,
    });
    deps.messages.push(...batch.messages);
    findings.push(...batch.findings);
    return { submitted: true, findings, usage };
  } catch (error) {
    if (error instanceof BudgetExceededError || error instanceof Error) {
      ports.logger.warn(
        { reviewRunId: ports.reviewRunId, reason: error.message },
        'closing turn unavailable; review ends with what it has',
      );
      return { submitted: false, findings, usage };
    }
    throw error;
  }
}

/**
 * The model-facing review. Large pull requests are split into batches so each
 * pass sees a real diff instead of an abstract.
 */
export function createAiReviewNode(ports: ReviewGraphPorts): GraphNodeFn {
  return async (state) => {
    if (!ports.settings.enableAiReview) {
      return skippedNode('ai_review', 'ai review disabled by repository settings');
    }
    const pullRequest = requirePullRequest(ports, state.pullRequest);
    if (state.classification === null || state.plan === null) {
      throw new Error('ai_review ran before analyze_changes/determine_checks');
    }

    const batches = planDiffBatches(
      state.changedFiles,
      Math.max(20_000, Math.floor(ports.limits.maxDiffChars / 2)),
    );
    const systemPrompt = `${reviewerSystemPrompt({
      toolsEnabled: ports.allowToolUse,
      executionEnabled: ports.allowToolUse && ports.sandboxUnavailable === null,
      maxFindings: ports.limits.maxFindings,
    })}\n\nSeverity ladder:\n${severityLadderText()}`;

    const ctx = buildToolContext(ports, pullRequest, state.changedFiles);
    const handlers = createToolHandlers(ctx, ports.toolDeps);

    const allFindings: FindingDraft[] = [];
    const transcript: ChatMessage[] = [];
    const warnings: string[] = [];
    const batchStats: string[] = [];
    let usage = emptyUsage();
    let iterations = 0;
    let stoppedReason = 'findings_submitted';

    for (const batch of batches.slice(0, MAX_DIFF_BATCHES)) {
      const boundary = createUntrustedBoundary();
      const diffBlock = buildDiffBlock({
        diff: batch.diff,
        maxChars: ports.limits.maxDiffChars,
        boundary,
      });
      const remaining = ports.budget.snapshot().remaining;
      const task = reviewTaskPrompt({
        repositoryName: ports.repository.fullName,
        prTitle: pullRequest.title,
        prNumber: pullRequest.number,
        author: pullRequest.author,
        baseRef: pullRequest.baseRef,
        headRef: pullRequest.headRef,
        stats: {
          files: batch.files.length,
          additions: batch.files.reduce((total, file) => total + file.additions, 0),
          deletions: batch.files.reduce((total, file) => total + file.deletions, 0),
        },
        classification: state.classification,
        plan: state.plan,
        settings: ports.settings,
        diffBlock: diffBlock.text,
        boundary,
        priorFindings: ports.previousFindings.map(
          (prior) => `${prior.severity} ${prior.status} ${prior.fingerprint}`,
        ),
        remainingBudget: {
          files: remaining.files,
          toolCalls: remaining.toolCalls,
          tokens: remaining.tokens,
        },
      });

      if (diffBlock.truncated) {
        warnings.push(`${batch.label}: diff truncated to fit the prompt budget`);
      }
      if (diffBlock.signals > 0) {
        warnings.push(
          `${batch.label}: ${diffBlock.signals} injection signal(s) in the diff; content was fenced and labelled as data`,
        );
      }

      await publish(ports, {
        reviewRunId: ports.reviewRunId,
        type: 'log',
        message: `Reviewing ${batch.label}: ${batch.files.length} file(s)`,
        progress: 50,
        data: { batch: batch.label, files: batch.files.length, tools: ports.allowToolUse },
      });

      const result = await runAgentLoop(ports, {
        ctx,
        handlers,
        label: batch.label,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: task },
        ],
      });

      allFindings.push(...result.findings);
      transcript.push(...result.messages);
      warnings.push(...result.warnings);
      usage = addUsage(usage, result.usage);
      iterations += result.iterations;
      stoppedReason = result.stoppedReason;
      batchStats.push(`${batch.label}: ${result.iterations} turns, ${result.toolCalls} tool calls`);
    }

    if (batches.length > MAX_DIFF_BATCHES) {
      warnings.push(
        `${batches.length - MAX_DIFF_BATCHES} diff batch(es) were not reviewed; raise MAX_DIFF_BYTES or split the pull request`,
      );
    }

    await publish(ports, {
      reviewRunId: ports.reviewRunId,
      type: 'log',
      message: `Model review produced ${allFindings.length} candidate finding(s) in ${batches.length} batch(es)`,
      progress: 70,
      data: { batches: batchStats, stoppedReason },
    });

    return {
      findings: allFindings,
      transcript,
      tokensIn: usage.inputTokens,
      tokensOut: usage.outputTokens,
      iteration: iterations,
      warnings,
      stoppedReason,
      summary: `model review: ${allFindings.length} candidate finding(s)`,
    };
  };
}

/**
 * Adversarial second pass. Deterministic rules first - they are cheap and
 * explainable - then one model call that may only remove or soften findings.
 */
export function createValidateFindingsNode(ports: ReviewGraphPorts): GraphNodeFn {
  return async (state) => {
    const policy = {
      minPublishConfidence: ports.settings.minPublishConfidence,
      minKeepConfidence: Math.min(0.4, ports.settings.minPublishConfidence),
      allowedFiles: state.changedFiles.map((file) => file.path),
      requireEvidenceForSeverities: ['critical', 'high'] as const,
      severityDowngradeConfidence: 0.7,
    };

    const deduped = dedupeFindings(state.findings);
    const unique = deduped.unique;
    const validated = unique.map((finding) => validateFinding(finding, policy));

    const keptDrafts = validated
      .filter((outcome) => outcome.decision === 'keep')
      .map((outcome) => outcome.finding);
    const comparison = compareWithPreviousFindings(
      keptDrafts,
      ports.usePreviousFindings ? ports.previousFindings : [],
    );
    const dismissed = new Set(comparison.previouslyDismissed.map((finding) => findingFingerprint(finding)));
    const alreadyReported = new Set(comparison.previouslyReported.map((finding) => findingFingerprint(finding)));

    let outcomes: FindingValidationOutcome[] = validated.map((outcome) => {
      if (dismissed.has(outcome.fingerprint)) {
        return {
          ...outcome,
          decision: 'discard' as const,
          publishable: false,
          reasons: [...outcome.reasons, 'already_dismissed_on_this_pull_request'],
        };
      }
      if (alreadyReported.has(outcome.fingerprint) && outcome.publishable) {
        return {
          ...outcome,
          publishable: false,
          reasons: [...outcome.reasons, 'already_reported_on_this_pull_request'],
        };
      }
      return outcome;
    });

    const candidates = outcomes.filter((outcome) => outcome.decision === 'keep').length;
    if (ports.settings.enableAiReview && ports.allowToolUse && candidates > 1) {
      outcomes = await applyModelCritique(ports, outcomes, policy.allowedFiles);
    }

    const kept = outcomes.filter((outcome) => outcome.decision === 'keep');
    const publishable = kept.filter((outcome) => outcome.publishable);

    // "N discarded" without the reasons is not auditable: a review that silently
    // drops a critical candidate looks identical to a clean one.
    const discarded = outcomes.filter((outcome) => outcome.decision === 'discard');
    const reasonCounts = new Map<string, number>();
    for (const outcome of discarded) {
      for (const reason of outcome.reasons) {
        reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
      }
    }
    const reasonSummary = [...reasonCounts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 4)
      .map(([reason, count]) => `${reason} ×${count}`)
      .join(', ');

    const persisted: readonly PersistedFindingInput[] = kept.map((outcome) => ({
      draft: outcome.finding,
      fingerprint: outcome.fingerprint,
      publishable: outcome.publishable,
      status: outcome.publishable ? ('validated' as const) : ('suppressed' as const),
      validationReasons: outcome.reasons,
      confidenceBand: outcome.confidenceBand,
    }));

    const stored = await ports.persistence.saveFindings(ports.reviewRunId, persisted);

    await publish(ports, {
      reviewRunId: ports.reviewRunId,
      type: 'finding.created',
      message: `Validated ${outcomes.length} candidate(s): ${kept.length} kept, ${publishable.length} publishable`,
      progress: 80,
      data: {
        candidates: outcomes.length,
        kept: kept.length,
        publishable: publishable.length,
        discarded: outcomes.length - kept.length,
        duplicates: deduped.duplicates.length,
        stored: stored.length,
      },
    });

    return {
      validated: outcomes,
      findings: kept.map((outcome) => outcome.finding),
      warnings:
        discarded.length > 0
          ? [
              `${discarded.length} finding(s) discarded during validation${reasonSummary.length > 0 ? `: ${reasonSummary}` : ''}`,
            ]
          : [],
      summary: `${kept.length} validated finding(s), ${publishable.length} publishable`,
    };
  };
}

async function applyModelCritique(
  ports: ReviewGraphPorts,
  outcomes: readonly FindingValidationOutcome[],
  allowedFiles: readonly string[],
): Promise<FindingValidationOutcome[]> {
  const keepers: FindingValidationOutcome[] = outcomes.filter(
    (outcome) => outcome.decision === 'keep',
  );
  const indexed = keepers.map((outcome, index) => ({
    index,
    severity: outcome.finding.severity,
    title: outcome.finding.title,
    file: outcome.finding.file,
    line: outcome.finding.line,
    description: outcome.finding.description,
    confidence: outcome.finding.confidence,
  }));

  let critique;
  try {
    const result = await ports.provider.generateStructured({
      system: `You are the reviewing lead auditing another reviewer's findings. You may only discard findings or lower their severity and confidence. Never add findings, never raise severity, never rewrite text. If a finding is generic, unverified, or about code this pull request did not change, discard it.\nSeverity ladder:\n${severityLadderText()}`,
      user: critiquePrompt(indexed),
      schema: FindingCritiqueSchema,
      model: ports.model,
      temperature: 0,
    });
    critique = result.value;
    ports.costs.record('validate_findings:critique', result.model, result.usage);
  } catch (error) {
    ports.logger.warn(
      { reviewRunId: ports.reviewRunId, reason: error instanceof Error ? error.message : 'unknown' },
      'findings critique pass unavailable; deterministic validation stands',
    );
    return [...outcomes];
  }

  const discarded = new Map(critique.discarded.map((entry) => [entry.index, entry.reason]));
  const recalibrated = new Map(critique.recalibrated.map((entry) => [entry.index, entry]));
  const keeperByFingerprint = new Map(keepers.map((outcome) => [outcome.fingerprint, outcome]));

  const updated: FindingValidationOutcome[] = [];
  for (const outcome of outcomes) {
    if (outcome.decision !== 'keep') {
      updated.push(outcome);
      continue;
    }
    const keeper = keeperByFingerprint.get(outcome.fingerprint);
    const position = keeper === undefined ? -1 : keepers.indexOf(keeper);
    const discardReason = position < 0 ? undefined : discarded.get(position);

    if (discardReason !== undefined) {
      updated.push({
        ...outcome,
        decision: 'discard' as const,
        publishable: false,
        reasons: [...outcome.reasons, `second_reviewer_discarded: ${discardReason}`],
      });
      continue;
    }

    const adjustment = position < 0 ? undefined : recalibrated.get(position);
    if (adjustment === undefined) {
      updated.push(outcome);
      continue;
    }
    const current = outcome.finding;
    const lowersSeverity = SEVERITY_RANK[adjustment.severity] < SEVERITY_RANK[current.severity];
    const lowersConfidence = adjustment.confidence < current.confidence;
    if (!lowersSeverity && !lowersConfidence) {
      // The critique may never strengthen a claim; record the attempt instead.
      updated.push({ ...outcome, reasons: [...outcome.reasons, 'critique_uplift_ignored'] });
      continue;
    }

    const softened: FindingDraft = {
      ...current,
      severity: lowersSeverity ? adjustment.severity : current.severity,
      confidence: lowersConfidence ? adjustment.confidence : current.confidence,
    };
    const revalidated = validateFinding(softened, {
      minPublishConfidence: ports.settings.minPublishConfidence,
      allowedFiles,
      requireEvidenceForSeverities: ['critical', 'high'],
    });
    updated.push({
      ...revalidated,
      reasons: [
        ...outcome.reasons,
        `second_reviewer_recalibrated: ${adjustment.reason}`,
        ...revalidated.reasons.filter((reason) => reason !== 'validated'),
      ],
    });
  }
  return updated;
}
