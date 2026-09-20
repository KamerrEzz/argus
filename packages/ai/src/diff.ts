import { buildUntrustedBlock, truncate } from '@acr/shared';
import type { ChangedFile } from '@acr/shared';

export interface DiffBlock {
  readonly text: string;
  readonly truncated: boolean;
  readonly signals: number;
}

/**
 * Renders the unified diff as one labelled untrusted block. The whole diff is
 * attacker-controlled text, so it never appears outside the boundary.
 */
export function buildDiffBlock(input: {
  readonly diff: string;
  readonly maxChars: number;
  readonly boundary: string;
}): DiffBlock {
  const block = buildUntrustedBlock({
    id: 'pull-request-diff',
    kind: 'unified_diff',
    content: input.diff,
    maxLength: input.maxChars,
    boundary: input.boundary,
  });
  return {
    text: `<<${block.boundary} id="${block.id}" kind="${block.kind}"${
      block.truncated ? ' truncated="true"' : ''
    }>>\n${block.content}\n<</${block.boundary}>>`,
    truncated: block.truncated,
    signals: block.signals.length,
  };
}

export function renderFileTable(files: readonly ChangedFile[]): string {
  return files
    .map((file) => `${file.status.toUpperCase().padEnd(8)} +${file.additions}/-${file.deletions} ${file.path}`)
    .join('\n');
}

export interface DiffBatch {
  readonly label: string;
  readonly files: readonly ChangedFile[];
  readonly diff: string;
  readonly truncatedFiles: readonly string[];
}

/**
 * Splits a large pull request into review passes that each fit the prompt
 * budget. Files keep their order, so related changes stay together where the
 * diff allows it.
 */
export function planDiffBatches(
  files: readonly ChangedFile[],
  maxCharsPerBatch: number,
): readonly DiffBatch[] {
  const batches: DiffBatch[] = [];
  let current: ChangedFile[] = [];
  let currentLength = 0;
  let truncatedFiles: string[] = [];

  const flush = (): void => {
    if (current.length === 0) {
      return;
    }
    batches.push({
      label: `batch ${batches.length + 1}`,
      files: current,
      diff: current.map((file) => file.patch ?? '').filter((patch) => patch.length > 0).join('\n'),
      truncatedFiles,
    });
    current = [];
    currentLength = 0;
    truncatedFiles = [];
  };

  for (const file of files) {
    const patch = file.patch ?? '';
    if (patch.length === 0) {
      current.push(file);
      continue;
    }
    if (patch.length > maxCharsPerBatch) {
      // A single enormous file still gets reviewed, with an honest cut.
      flush();
      current.push({ ...file, patch: truncate(patch, maxCharsPerBatch) });
      truncatedFiles.push(file.path);
      flush();
      continue;
    }
    if (currentLength + patch.length > maxCharsPerBatch) {
      flush();
    }
    current.push(file);
    currentLength += patch.length;
  }
  flush();

  if (batches.length === 0 && files.length > 0) {
    batches.push({ label: 'batch 1', files, diff: '', truncatedFiles: [] });
  }
  return batches;
}

/** Keeps only the hunk headers and context around them for a cheap overview. */
export function summarizeDiff(diff: string, maxChars: number): string {
  const kept: string[] = [];
  let length = 0;
  for (const line of diff.split('\n')) {
    if (/^(diff --git|---|\+\+\+|@@|new file|deleted file|rename from|rename to)/.test(line)) {
      if (length + line.length > maxChars) {
        break;
      }
      kept.push(line);
      length += line.length + 1;
    }
  }
  return kept.join('\n');
}
