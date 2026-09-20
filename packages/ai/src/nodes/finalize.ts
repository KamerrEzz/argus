import {
  DEFAULT_CHECK_POLICY,
  checkRecordToOutcome,
  createUntrustedBoundary,
  decideReviewVerdict,
  formatFindingSummary,
  summarizeFindings,
  truncate,
  type FindingDraft,
  type FindingSummary,
  type ReviewVerdict,
} from '@acr/shared';
import { summaryPrompt } from '../prompts';
import { ReviewSummarySchema, type ReviewSummary } from '../output-schemas';
import { publish, type GraphNodeFn, type ReviewGraphPorts } from './instrument';
import type { ReviewGraphStateType } from '../state';

/**
 * Closes the review: the verdict comes from the repository's own policy, then
 * the model writes what it means. If the model cannot produce a narrative the
 * deterministic summary stands, so a review always reports something.
 */
export function createFinalReviewNode(ports: ReviewGraphPorts): GraphNodeFn {
  return async (state) => {
    const publishable = state.validated
      .filter((outcome) => outcome.publishable)
      .map((outcome) => outcome.finding);
    const summary = summarizeFindings(publishable);
    const outcomes = state.commands.map(checkRecordToOutcome);
    const policy = {
      ...DEFAULT_CHECK_POLICY,
      failOnSeverities: ports.settings.failOnSeverities,
    };
    const verdict = decideReviewVerdict(summary, outcomes, policy);

    const headline =
      state.pullRequest === null
        ? `Review of ${ports.repository.fullName}`
        : `Review of #${state.pullRequest.number}: ${truncate(state.pullRequest.title, 80)}`;

    const narrative = await buildNarrative(ports, state, verdict, summary, publishable);

    await publish(ports, {
      reviewRunId: ports.reviewRunId,
      type: 'log',
      message: `Verdict ${verdict}: ${formatFindingSummary(summary)}${narrative.length > 0 ? '; narrative written' : '; deterministic summary only'}`,
      progress: 92,
      data: { verdict, publishable: publishable.length, tokens: ports.costs.totalTokens },
    });

    return {
      verdict,
      narrative,
      summary: `${headline} - ${verdict} (${formatFindingSummary(summary)})`,
    };
  };
}

async function buildNarrative(
  ports: ReviewGraphPorts,
  state: ReviewGraphStateType,
  verdict: ReviewVerdict,
  summary: FindingSummary,
  publishable: readonly FindingDraft[],
): Promise<string> {
  const pullRequest = state.pullRequest;
  if (pullRequest === null) {
    return '';
  }
  if (!ports.settings.enableAiReview || ports.budget.snapshot().remaining.tokens < 2_000) {
    return '';
  }

  const boundary = createUntrustedBoundary();
  try {
    const result = await ports.provider.generateStructured<ReviewSummary>({
      system:
        'You write the closing summary of an automated code review. Be specific, be brief, and never invent work that was not done. Plain sentences, no marketing tone, no emoji.',
      user: summaryPrompt({
        repositoryName: ports.repository.fullName,
        prTitle: pullRequest.title,
        prNumber: pullRequest.number,
        verdict,
        findingLines: publishable.slice(0, 12).map(
          (finding) =>
            `${finding.severity} ${finding.file}${finding.line === null ? '' : `:${finding.line}`} - ${finding.title}`,
        ),
        checkLines: state.commands.map((record) => `${record.kind}: ${record.summary}`),
        narrative: state.narrative,
        warnings: state.warnings,
        boundary,
      }),
      schema: ReviewSummarySchema,
      model: ports.model,
      temperature: 0.2,
    });
    ports.costs.record('final_review:narrative', result.model, result.usage);
    return renderNarrative(result.value, summary);
  } catch (error) {
    ports.logger.warn(
      { reviewRunId: ports.reviewRunId, reason: error instanceof Error ? error.message : 'unknown' },
      'narrative unavailable; falling back to the deterministic summary',
    );
    return '';
  }
}

export function renderNarrative(value: ReviewSummary, summary: FindingSummary): string {
  const sections: string[] = [`### ${value.headline}`, '', value.whatChanged];
  if (value.strengths.length > 0) {
    sections.push('', 'What looks good', ...value.strengths.map((line) => `- ${line}`));
  }
  if (value.risks.length > 0) {
    sections.push('', 'Risks', ...value.risks.map((line) => `- ${line}`));
  }
  if (value.nextSteps.length > 0) {
    sections.push('', 'Next steps', ...value.nextSteps.map((line) => `- [ ] ${line}`));
  }
  if (summary.total === 0) {
    sections.push('', 'No publishable findings were produced by this run.');
  }
  return sections.join('\n');
}
