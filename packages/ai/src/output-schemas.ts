import { z } from 'zod';

export const FindingCritiqueSchema = z.object({
  discarded: z
    .array(
      z.object({
        index: z.number().int().min(0),
        reason: z.string().min(3).max(500),
      }),
    )
    .default([]),
  recalibrated: z
    .array(
      z.object({
        index: z.number().int().min(0),
        severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
        confidence: z.number().min(0).max(1),
        reason: z.string().min(3).max(500),
      }),
    )
    .default([]),
  overallAssessment: z.string().max(2000).default(''),
});

export type FindingCritique = z.infer<typeof FindingCritiqueSchema>;

export const ReviewSummarySchema = z.object({
  headline: z.string().min(4).max(200),
  whatChanged: z.string().min(10).max(4000),
  strengths: z.array(z.string().max(600)).max(8).default([]),
  risks: z.array(z.string().max(600)).max(12).default([]),
  nextSteps: z.array(z.string().max(600)).max(10).default([]),
});

export type ReviewSummary = z.infer<typeof ReviewSummarySchema>;

export const EMPTY_CRITIQUE: FindingCritique = {
  discarded: [],
  recalibrated: [],
  overallAssessment: '',
};
