import type { ReviewPlan } from './review-types';
import type { ChangeClassification } from './classification';

export interface ReviewPlanInputs {
  readonly classification: ChangeClassification;
  readonly availableScripts: {
    readonly test: boolean;
    readonly lint: boolean;
    readonly typecheck: boolean;
    readonly build: boolean;
  };
  readonly enableTests: boolean;
  readonly enableLint: boolean;
  readonly enableTypecheck: boolean;
  readonly deepReviewAllowed: boolean;
  readonly maxFiles: number;
}

export function buildReviewPlan(inputs: ReviewPlanInputs): ReviewPlan {
  const { classification } = inputs;
  const reasons: string[] = [];

  if (classification.documentationOnly) {
    reasons.push('documentation_only_change');
    return {
      analyzeTests: false,
      analyzeLint: false,
      analyzeTypecheck: false,
      analyzeSql: false,
      analyzeSecurity: false,
      analyzeDependencies: false,
      analyzePerformance: false,
      deepReview: false,
      reasons,
    };
  }

  if (classification.totalFiles > inputs.maxFiles) {
    reasons.push(`file_limit_exceeded:${classification.totalFiles}>${inputs.maxFiles}`);
  }

  const hasExecutableSource = classification.sourceFiles.length > 0;
  const hasTestsChanged = classification.testFiles.length > 0;
  const hasDependencyChange = classification.touchesDependencies;

  const analyzeTests =
    inputs.enableTests &&
    inputs.availableScripts.test &&
    (hasExecutableSource || hasTestsChanged);
  if (!analyzeTests) {
    reasons.push(
      !inputs.enableTests
        ? 'tests_disabled_by_configuration'
        : !inputs.availableScripts.test
          ? 'test_script_missing'
          : 'no_executable_source_changed',
    );
  }

  const analyzeLint = inputs.enableLint && inputs.availableScripts.lint && hasExecutableSource;
  if (!analyzeLint) {
    reasons.push(
      !inputs.enableLint
        ? 'lint_disabled_by_configuration'
        : !inputs.availableScripts.lint
          ? 'lint_script_missing'
          : 'no_executable_source_changed',
    );
  }

  const analyzeTypecheck =
    inputs.enableTypecheck && inputs.availableScripts.typecheck && hasExecutableSource;
  if (!analyzeTypecheck) {
    reasons.push(
      !inputs.enableTypecheck
        ? 'typecheck_disabled_by_configuration'
        : !inputs.availableScripts.typecheck
          ? 'typecheck_script_missing'
          : 'no_executable_source_changed',
    );
  }

  const analyzeSql =
    classification.sqlFiles.length > 0 ||
    classification.migrationFiles.length > 0 ||
    classification.touchesDatabase;
  if (analyzeSql) {
    reasons.push('database_change_detected');
  }

  const analyzeSecurity =
    classification.touchesAuthentication ||
    classification.touchesSecuritySensitive ||
    hasExecutableSource;
  if (classification.touchesAuthentication) {
    reasons.push('authentication_change_detected');
  }
  if (classification.touchesSecuritySensitive) {
    reasons.push('security_sensitive_paths_changed');
  }

  const analyzeDependencies = hasDependencyChange;
  if (analyzeDependencies) {
    reasons.push('dependency_manifest_changed');
  }

  const analyzePerformance =
    classification.touchesPerformanceSensitive || classification.sourceFiles.length >= 5;
  if (classification.touchesPerformanceSensitive) {
    reasons.push('performance_sensitive_paths_changed');
  }

  const deepReview =
    inputs.deepReviewAllowed &&
    (classification.sourceFiles.length >= 3 ||
      classification.touchesAuthentication ||
      classification.touchesSecuritySensitive ||
      hasDependencyChange);
  if (!deepReview) {
    reasons.push(
      inputs.deepReviewAllowed ? 'change_is_small_enough_for_fast_review' : 'deep_review_disabled',
    );
  }

  return {
    analyzeTests,
    analyzeLint,
    analyzeTypecheck,
    analyzeSql,
    analyzeSecurity,
    analyzeDependencies,
    analyzePerformance,
    deepReview,
    reasons,
  };
}

export function describeReviewPlan(plan: ReviewPlan): string {
  const active = [
    plan.analyzeTests ? 'tests' : null,
    plan.analyzeLint ? 'lint' : null,
    plan.analyzeTypecheck ? 'typecheck' : null,
    plan.analyzeSql ? 'sql' : null,
    plan.analyzeSecurity ? 'security' : null,
    plan.analyzeDependencies ? 'dependencies' : null,
    plan.analyzePerformance ? 'performance' : null,
    plan.deepReview ? 'deep-review' : null,
  ].filter((entry): entry is string => entry !== null);
  return active.length === 0 ? 'minimal review' : active.join(', ');
}
