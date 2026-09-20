import { END, MemorySaver, START, StateGraph } from '@langchain/langgraph';
import { ReviewGraphState, type ReviewGraphStateType } from './state';
import { instrumentNode, type ReviewGraphPorts } from './nodes/instrument';
import { createInspectRepoNode, createLoadPrNode } from './nodes/context';
import {
  createAnalyzeChangesNode,
  createDetermineChecksNode,
  createRunChecksNode,
  createStaticAnalysisNode,
} from './nodes/analysis';
import { createAiReviewNode, createValidateFindingsNode } from './nodes/review';
import { createFinalReviewNode } from './nodes/finalize';

export const GRAPH_NODES = [
  'load_pr',
  'inspect_repo',
  'analyze_changes',
  'determine_checks',
  'run_checks',
  'static_analysis',
  'ai_review',
  'validate_findings',
  'final_review',
] as const;

export type GraphNodeName = (typeof GRAPH_NODES)[number];

export const GRAPH_NAME = 'code-review-agent';

/**
 * The review flow. Checks are only run when the plan asks for them and the
 * sandbox is usable; findings are only validated when something produced them.
 * Every path ends in `final_review`, so a degraded run still reports a verdict.
 */
export function buildReviewGraph(ports: ReviewGraphPorts) {
  const workflow = new StateGraph(ReviewGraphState)
    .addNode('load_pr', instrumentNode(ports, 'load_pr', createLoadPrNode(ports)))
    .addNode('inspect_repo', instrumentNode(ports, 'inspect_repo', createInspectRepoNode(ports)))
    .addNode('analyze_changes', instrumentNode(ports, 'analyze_changes', createAnalyzeChangesNode(ports)))
    .addNode('determine_checks', instrumentNode(ports, 'determine_checks', createDetermineChecksNode(ports)))
    .addNode('run_checks', instrumentNode(ports, 'run_checks', createRunChecksNode(ports)))
    .addNode('static_analysis', instrumentNode(ports, 'static_analysis', createStaticAnalysisNode(ports)))
    .addNode('ai_review', instrumentNode(ports, 'ai_review', createAiReviewNode(ports)))
    .addNode(
      'validate_findings',
      instrumentNode(ports, 'validate_findings', createValidateFindingsNode(ports)),
    )
    .addNode('final_review', instrumentNode(ports, 'final_review', createFinalReviewNode(ports)))
    .addEdge(START, 'load_pr')
    .addEdge('load_pr', 'inspect_repo')
    .addEdge('inspect_repo', 'analyze_changes')
    .addEdge('analyze_changes', 'determine_checks')
    .addConditionalEdges('determine_checks', afterPlan, {
      run_checks: 'run_checks',
      ai_review: 'ai_review',
    })
    .addEdge('run_checks', 'static_analysis')
    .addEdge('static_analysis', 'ai_review')
    .addConditionalEdges('ai_review', afterReview, {
      validate_findings: 'validate_findings',
      final_review: 'final_review',
    })
    .addEdge('validate_findings', 'final_review')
    .addEdge('final_review', END);

  return workflow.compile({ checkpointer: new MemorySaver(), name: GRAPH_NAME });
}

export type CompiledReviewGraph = ReturnType<typeof buildReviewGraph>;

function afterPlan(state: ReviewGraphStateType): 'run_checks' | 'ai_review' {
  const plan = state.plan;
  if (plan === null) {
    return 'ai_review';
  }
  const wantsChecks = plan.analyzeTests || plan.analyzeLint || plan.analyzeTypecheck;
  return wantsChecks ? 'run_checks' : 'ai_review';
}

function afterReview(state: ReviewGraphStateType): 'validate_findings' | 'final_review' {
  return state.findings.length > 0 ? 'validate_findings' : 'final_review';
}
