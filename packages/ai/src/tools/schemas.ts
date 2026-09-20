import { z } from 'zod';

/**
 * Single source of truth for every tool argument object. Each schema is
 * exported twice on purpose: once as the validation gate the executor runs
 * before touching a port, and once as JSON Schema for the model.
 */

export const ListChangedFilesInputSchema = z.object({
  pathContains: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(500).default(100),
});

export const ReadFileInputSchema = z.object({
  path: z.string().min(1).max(1024),
  startLine: z.number().int().min(1).max(2_000_000).optional(),
  endLine: z.number().int().min(1).max(2_000_000).optional(),
});

export const SearchCodeInputSchema = z.object({
  /** Literal substring or JavaScript regular expression source. */
  query: z.string().min(2).max(300),
  isRegex: z.boolean().default(false),
  pathGlob: z.string().max(300).optional(),
  maxResults: z.number().int().min(1).max(200).default(40),
});

export const FetchPrContextInputSchema = z.object({
  includeComments: z.boolean().default(true),
  includePreviousFindings: z.boolean().default(true),
  limit: z.number().int().min(1).max(200).default(50),
});

export const RunCheckInputSchema = z.object({
  script: z.string().min(1).max(64),
  args: z.array(z.string().max(200)).max(10).default([]),
});

export const SubmitFindingsInputSchema = z.object({
  findings: z.array(z.record(z.string(), z.unknown())).max(50),
  narrative: z.string().max(4000).optional(),
});

/**
 * JSON Schema view of a tool input, shaped the way chat-completions `function`
 * tools expect it. Zod remains the gate the executor validates against.
 */
export function parametersOf(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12' }) as Record<string, unknown>;
  delete json['$schema'];
  delete json['$defs'];
  delete json['definitions'];
  return { type: 'object', ...json };
}

export type ListChangedFilesInput = z.infer<typeof ListChangedFilesInputSchema>;
export type ReadFileInput = z.infer<typeof ReadFileInputSchema>;
export type SearchCodeInput = z.infer<typeof SearchCodeInputSchema>;
export type FetchPrContextInput = z.infer<typeof FetchPrContextInputSchema>;
export type RunCheckInput = z.infer<typeof RunCheckInputSchema>;
export type SubmitFindingsInput = z.infer<typeof SubmitFindingsInputSchema>;
