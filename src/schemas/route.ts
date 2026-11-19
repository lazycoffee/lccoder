import { z } from 'zod';
import { ComplexitySchema } from './common.js';

export const RequestModeSchema = z.enum([
  'answer',
  'code',
  'debug',
  'doc',
  'review',
]);

export const PipelineTypeSchema = z.enum([
  'direct-answer',
  'coding-pipeline',
  'debug-pipeline',
]);

export const RoutingDecisionSchema = z.object({
  mode: RequestModeSchema,
  complexity: ComplexitySchema,
  pipelineType: PipelineTypeSchema,
  reason: z.string(),
});

export type RequestMode = z.infer<typeof RequestModeSchema>;
export type PipelineType = z.infer<typeof PipelineTypeSchema>;
export type RoutingDecision = z.infer<typeof RoutingDecisionSchema>;

export type RequestedMode = 'auto' | 'answer' | 'code' | 'debug';
