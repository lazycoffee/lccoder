import { z } from 'zod';

export const BugReportSchema = z.object({
  id: z.string().describe('Bug 报告 ID，格式：bug-xxx'),
  created_by: z.literal('bug-triage'),
  timestamp: z.string(),
  user_input: z.string().describe('用户原始输入'),
  observed_behavior: z.string().describe('当前观察到的异常行为'),
  expected_behavior: z.string().describe('预期正确行为'),
  error_signals: z.array(z.string()).describe('报错信息、失败测试、日志片段等信号'),
  suspected_scope: z.array(z.string()).describe('怀疑相关的模块、文件或功能范围'),
  reproduction_steps: z.array(z.string()).describe('复现步骤；若未知可写待确认信息'),
  severity: z.enum(['low', 'medium', 'high']).describe('问题严重程度'),
  acceptance_criteria: z.array(z.string()).describe('修复后应满足的验证条件'),
});

export type BugReport = z.infer<typeof BugReportSchema>;
