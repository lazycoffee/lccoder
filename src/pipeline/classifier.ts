/**
 * 请求路由分类器
 * 判断用户请求的意图、复杂度和应走的流水线类型
 */
import { BaseRole } from '../roles/base-role.js';
import type { LLMProvider } from '../llm/provider.js';
import { RoutingDecisionSchema, type RoutingDecision } from '../schemas/route.js';
import type { RequestedMode } from '../schemas/route.js';

class ClassifierRole extends BaseRole {
  constructor(provider: LLMProvider, model: string, promptsDir?: string) {
    super({
      roleName: 'classifier',
      promptFileName: 'classifier.md',
      provider,
      model,
      promptsDir,
    });
  }
}

import { type SessionRecord } from '../llm/session.js';

/**
 * 分类用户请求
 */
export async function classifyRequest(
  userInput: string,
  provider: LLMProvider,
  model: string,
  promptsDir?: string,
  requestedMode: RequestedMode = 'auto',
): Promise<{ 
  decision: RoutingDecision;
  sessionRecord?: SessionRecord 
}> {
  const classifier = new ClassifierRole(provider, model, promptsDir);
  const modeHint = requestedMode === 'auto'
    ? ''
    : `\n\n用户手动指定了模式：${requestedMode}。除非请求内容与此明显冲突，否则请优先按这个模式路由。`;
  const result = await classifier.execute({
    userMessage: `${userInput}${modeHint}`,
  });

  let decision: RoutingDecision = {
    mode: 'code',
    complexity: 'complex',
    pipelineType: 'coding-pipeline',
    reason: '无法确定，默认进入 coding-pipeline',
  };

  // 尝试解析分类结果
  if (result.document) {
    try {
      decision = RoutingDecisionSchema.parse(result.document);
    } catch {
      const doc = result.document as any;
      if (doc.complexity === 'simple' || doc.complexity === 'complex') {
        decision = {
          mode: doc.complexity === 'simple' ? 'answer' : 'code',
          complexity: doc.complexity,
          pipelineType: doc.complexity === 'simple' ? 'direct-answer' : 'coding-pipeline',
          reason: doc.reason || '从旧版分类结果回退得到',
        };
      }
    }
  } else {
    // 回退：从文本中查找关键词
    const text = result.text.toLowerCase();
    if (text.includes('"simple"') || text.includes("'simple'")) {
      decision = {
        mode: 'answer',
        complexity: 'simple',
        pipelineType: 'direct-answer',
        reason: '从文本推断',
      };
    }
  }

  decision = applyRequestedMode(decision, requestedMode);

  return { 
    decision,
    sessionRecord: result.sessionRecord 
  };
}

function applyRequestedMode(
  decision: RoutingDecision,
  requestedMode: RequestedMode,
): RoutingDecision {
  switch (requestedMode) {
    case 'answer':
      return {
        ...decision,
        mode: 'answer',
        complexity: 'simple',
        pipelineType: 'direct-answer',
        reason: `用户手动指定 answer 模式。${decision.reason}`.trim(),
      };
    case 'code':
      return {
        ...decision,
        mode: 'code',
        complexity: 'complex',
        pipelineType: 'coding-pipeline',
        reason: `用户手动指定 code 模式。${decision.reason}`.trim(),
      };
    case 'debug':
      return {
        ...decision,
        mode: 'debug',
        complexity: 'complex',
        pipelineType: 'debug-pipeline',
        reason: `用户手动指定 debug 模式。${decision.reason}`.trim(),
      };
    case 'auto':
    default:
      return decision;
  }
}
