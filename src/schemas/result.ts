/**
 * 执行结果 Schema
 * 由办事员角色生成
 */
import { z } from 'zod';
import { TaskStatusSchema, FileChangeSchema } from './common.js';

/** 执行结果报告 */
export const ResultSchema = z.object({
  task_id: z.string().describe('对应的任务 ID'),
  executed_by: z.literal('clerk'),
  timestamp: z.string(),
  status: TaskStatusSchema.describe('执行状态：success 或 failed'),
  changes_made: z.array(FileChangeSchema).describe('实际做出的文件变更'),
  output_summary: z.string().describe('执行结果概要'),
  error: z.string().nullable().optional().describe('如果失败，错误原因'),
  notes_for_pm: z.string().nullable().optional().describe('需要知会项目经理的事项'),
});

export type Result = z.infer<typeof ResultSchema>;

/** QA 测试报告 */
export const QaReportSchema = z.object({
  task_id: z.string().describe('对应的任务 ID'),
  tested_by: z.literal('qa-engineer'),
  timestamp: z.string(),
  requirement_coverage: z.object({
    passed: z.boolean(),
    score: z.number().int().min(1).max(10),
    notes: z.array(z.string()),
  }),
  artifact_validation: z.object({
    passed: z.boolean(),
    notes: z.array(z.string()),
  }),
  quality_risks: z.array(z.string()).describe('发现的质量风险'),
  verdict: z.enum(['pass', 'pass-with-risks', 'fail']),
  reason: z.string(),
  suggestions: z.array(z.string()),
});

export type QaReport = z.infer<typeof QaReportSchema>;

/** 评估结论 */
export const EvaluationSchema = z.object({
  task_id: z.string().describe('被评估的任务 ID'),
  evaluated_by: z.literal('evaluator'),
  timestamp: z.string(),
  task_succeeded: z.boolean().describe('任务是否成功'),
  impacts_critical_path: z.boolean().describe('是否影响关键路径'),
  decision: z.enum(['continue', 'continue-skip', 'pause']).describe('决策'),
  reason: z.string().describe('决策理由'),
  suggestion: z.string().nullable().optional().describe('给人类的建议'),
});

export type Evaluation = z.infer<typeof EvaluationSchema>;

/** 最终总结 */
export const SummarySchema = z.object({
  plan_id: z.string(),
  timestamp: z.string(),
  total_tasks: z.number(),
  completed_tasks: z.number(),
  failed_tasks: z.number(),
  skipped_tasks: z.number(),
  completed_items: z.array(z.string()).describe('已完成的任务标题'),
  failed_items: z.array(z.string()).describe('失败的任务标题及原因'),
  overall_summary: z.string().describe('整体工作总结'),
});

export type Summary = z.infer<typeof SummarySchema>;
