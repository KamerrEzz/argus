import {
  detectInjectionSignals,
  filterIgnoredPaths,
  truncate,
  type ChangedFile,
} from '@acr/shared';
import { publish, type GraphNodeFn, type ReviewGraphPorts } from './instrument';

/**
 * Pull request metadata, the diff and the file list. Everything downstream is
 * derived from what this node stores, so it is the only node that talks to
 * GitHub for review inputs.
 */
export function createLoadPrNode(ports: ReviewGraphPorts): GraphNodeFn {
  return async (state) => {
    const input = { repository: ports.repository, number: ports.pullRequestNumber };
    const pullRequest = await ports.github.getPullRequest(input);

    if (state.headSha.length > 0 && pullRequest.headSha !== state.headSha) {
      // The head moved between queueing and running; the review must be re-scoped.
      throw new Error(
        `pull request head changed from ${state.headSha.slice(0, 7)} to ${pullRequest.headSha.slice(0, 7)} before the review started`,
      );
    }

    const [rawDiff, rawFiles] = await Promise.all([
      ports.github.getPullRequestDiff(input),
      ports.github.getChangedFiles(input),
    ]);

    const keptPaths = new Set(
      filterIgnoredPaths(
        rawFiles.map((file) => file.path),
        ports.settings.ignorePaths,
      ),
    );
    const changedFiles: readonly ChangedFile[] = rawFiles.filter((file) => keptPaths.has(file.path));
    const ignoredCount = rawFiles.length - changedFiles.length;

    const diff = truncate(rawDiff, ports.limits.maxDiffChars);
    const truncated = diff.length < rawDiff.length;

    const injectionSignals = [
      ...detectInjectionSignals(`${pullRequest.title}\n${pullRequest.body}`),
      ...detectInjectionSignals(diff),
    ];

    await ports.persistence.saveChangedFiles(ports.reviewRunId, changedFiles, diff);
    await publish(ports, {
      reviewRunId: ports.reviewRunId,
      type: 'run.started',
      message: `Loaded PR #${pullRequest.number} "${truncate(pullRequest.title, 120)}" with ${changedFiles.length} changed file(s)`,
      progress: 5,
      data: {
        files: changedFiles.length,
        ignored: ignoredCount,
        diffChars: diff.length,
        diffTruncated: truncated,
        injectionSignals: injectionSignals.length,
      },
    });

    return {
      pullRequest,
      changedFiles,
      diff,
      headSha: pullRequest.headSha,
      baseSha: pullRequest.baseSha,
      workspaceDir: ports.workspace.root,
      injectionSignals,
      warnings: truncated
        ? [`diff truncated to ${ports.limits.maxDiffChars} characters; review is partial`]
        : [],
    };
  };
}

/**
 * Cheap repository survey from the checked-out head. Used to ground the model's
 * file reads and to make search budgets predictable.
 */
export function createInspectRepoNode(ports: ReviewGraphPorts): GraphNodeFn {
  return async () => {
    const inventory = await ports.workspace.fileList();
    const capped = inventory.slice(0, ports.limits.maxFileInventory);

    await publish(ports, {
      reviewRunId: ports.reviewRunId,
      type: 'node.finished',
      message: `Repository checkout exposes ${capped.length} file(s)${
        inventory.length > capped.length ? ` of ${inventory.length}` : ''
      }`,
      node: 'inspect_repo',
      status: 'succeeded',
      data: { files: capped.length, truncated: inventory.length > capped.length },
    });

    return {
      fileInventory: capped,
      workspaceDir: ports.workspace.root,
      warnings:
        inventory.length > capped.length
          ? [`file inventory capped at ${ports.limits.maxFileInventory} entries`]
          : [],
    };
  };
}
