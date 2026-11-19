# lccoder

> 小模型流水线编码工具，让本地小模型也能更稳定地完成真实编码任务

`lccoder` 不是另一个把所有工作塞进单一会话的 AI coding agent。  
它用「流水线编排 + 会话隔离 + 文档交接 + 代码强约束」的方式，把复杂编码任务拆成更适合小模型处理的步骤。

目标很明确：

- 让 4B 级别的小模型在本地环境里也能完成更复杂的编码任务
- 用结构化流程提升稳定性、可追踪性和可恢复性
- 在需要成本可控、可审计、本地优先的场景里，提供一种不同于大模型单代理的方案

## 为什么值得试

大多数 AI 编码工具默认假设：

- 一个会话能同时理解需求、规划任务、修改代码、验证结果
- 模型足够大，能持续维持长上下文
- 失败后可以靠继续对话“补救”

这套假设对大模型通常成立，但对本地小模型并不友好。常见问题是：

- 上下文一长就漂移
- 任务一复杂就漏条件
- 工具调用和结果总结混在一起，失去可控性
- 失败后很难知道是哪一步出了问题

`lccoder` 的做法是把流程拆开：

1. 分类器判断任务复杂度
2. 产品经理澄清需求
3. 项目经理拆分计划
4. 办事员逐项执行
5. QA Engineer 复核真实产物和验证结果
6. 评估器决定继续、跳过或暂停

每一步都在独立会话里完成，并通过结构化 JSON 文档交接，而不是把全部状态压在一段越来越长的聊天记录里。

## 适合谁

适合：

- 想在本地运行 AI coding workflow 的开发者
- 对成本、隐私或离线能力有要求的团队
- 想研究“小模型如何通过流程设计获得更好编码表现”的开发者
- 愿意接受 CLI 工作流，并重视过程可审计性的用户

不太适合：

- 只想获得一个即装即用、零配置的大模型商业编码助手
- 期待完全无人监管地执行高风险改动
- 需要大规模跨仓库、跨服务自动化编排的团队

## 30 秒理解它和常见 AI coding agent 的区别

| 维度 | 常见单会话 Agent | lccoder |
| --- | --- | --- |
| 任务处理方式 | 单会话持续追加上下文 | 多角色流水线，步骤隔离 |
| 状态传递 | 主要依赖对话历史 | 结构化 JSON 文档交接 |
| 小模型适配 | 通常较弱 | 明确为小模型优化 |
| 可审计性 | 中等 | 高，每步可检查 |
| 失败恢复 | 继续聊天修补 | 可重试、可恢复、可定位 |
| 运行方式 | 常偏向云端/大模型 | 本地模型优先，当前支持 Ollama 和 MiniMax |

## 快速开始

前提：

- 已安装 [Bun](https://bun.sh) 1.0+
- 已安装并启动 [Ollama](https://ollama.com)
- 已拉取至少一个可用模型

```bash
ollama pull gemma4:latest
npm install -g lccoder
lccoder init
```

然后在你的项目目录中运行：

```bash
lccoder
```

重要说明：

- `lccoder` 当前是一个 `Bun-only CLI`
- 即使通过 `npm install -g lccoder` 安装，目标环境仍然需要本机已安装 Bun
- 当前更适合本地开发者环境，而不是通用 Node CLI 发行方式

如果你想直接从源码运行：

```bash
git clone https://github.com/lazycoffee/lccoder.git
cd lccoder
bun install
bun run src/index.ts
```

## 一个最小使用流程

```bash
lccoder init
lccoder
```

你输入一个较复杂的编码需求后，工具会：

- 判断这是不是一个值得进入流水线的复杂任务
- 生成需求分析文档并请求你确认
- 拆成执行计划并请求你确认
- 逐个执行任务
- 自动运行验证
- 产出最终总结

可用命令：

```bash
lccoder
lccoder init
lccoder resume
lccoder history
lccoder inspect <session-id>
lccoder gui [port]
```

## 当前已经具备的能力

- 多角色流水线：分类器、产品经理、项目经理、办事员、QA Engineer、评估器
- 会话隔离：每个阶段都是独立会话
- 文档交接：Requirement、Plan、Instruction、Result、QA Report、Evaluation、Summary
- 项目级配置：模型、提供商、安全策略、执行策略可配置
- 失败重试：JSON 解析失败自动修复重试
- 自动验证：执行后自动跑类型检查、Lint、测试
- 断点续传：中断后可恢复
- 历史记录：支持查看执行历史和单次会话详情
- 并行任务执行：处理无依赖、无文件冲突的任务
- 多平台支持：本地 Ollama、云端 MiniMax
- 本地监控 GUI：查看当前流水线状态、历史会话和结构化文档

## GUI 监控面板

启动本地监控面板：

```bash
lccoder gui
```

或指定端口：

```bash
lccoder gui 4567
```

当前 GUI 原型支持：

- 查看当前流水线状态
- 查看历史会话列表和详情
- 查看 `.lccoder/documents/` 中的结构化文档
- 轮询刷新 overview / state / sessions / documents

## 配置示例

使用本地 Ollama：

```json
{
  "provider": "ollama",
  "model": "gemma4:latest",
  "ollamaHost": "http://localhost:11434",
  "roles": {
    "clerk": { "model": "gemma4:26b" }
  },
  "execution": {
    "maxRetries": 2,
    "parallelTasks": false,
    "autoConfirm": false
  },
  "safety": {
    "allowShellExec": false,
    "allowFileWrite": true,
    "workingDir": "/absolute/path/to/your/project"
  }
}
```

使用 MiniMax：

```json
{
  "provider": "minimax",
  "model": "MiniMax-M2.5",
  "minimax": {
    "apiKey": "your-minimax-api-key",
    "baseURL": "https://api.minimaxi.com/v1"
  },
  "execution": {
    "maxRetries": 2,
    "parallelTasks": false,
    "autoConfirm": false
  },
  "safety": {
    "allowShellExec": false,
    "allowFileWrite": true,
    "workingDir": "/absolute/path/to/your/project"
  }
}
```

补充说明：

- `roles.<role>.model` 可以给不同角色分配不同模型
- `roles.<role>.provider` 可以给单个角色切换到 `ollama` 或 `minimax`
- `execution.parallelTasks` 会在可安全并行时并发执行任务
- `safety.workingDir` 是工具实际操作的项目根目录
- `safety.allowShellExec` 为 `false` 时，shell 执行前需要确认，危险命令始终会被拦截
- `safety.allowFileWrite` 为 `false` 时，文件修改前需要确认

## 项目结构

```text
lccoder/
├── src/
│   ├── cli/
│   ├── llm/
│   ├── pipeline/
│   ├── roles/
│   ├── schemas/
│   ├── tools/
│   ├── documents/
│   └── config/
├── prompts/
└── .lccoder/
```

## 现阶段的局限

如果你准备公开试用或二次开发，下面这些限制需要先了解：

- 当前 CLI 入口仍然是 `src/index.ts`，因此发行形态仍然依赖 Bun
- 最强价值点在“小模型复杂任务稳定性”，不是全能自动编码
- 真实任务表现仍然强依赖模型质量、Prompt、项目结构和验证手段
- 推理速度受本地模型和硬件影响较大

## 接下来最重要的方向

`lccoder` 接下来不会优先堆更多高级功能，而会优先补齐三件事：

1. 可复现实验和 benchmark，证明流水线比单会话更适合小模型
2. 更低摩擦的上手体验，让陌生用户能在几分钟内跑通
3. 更完整的示例、失败案例和最佳实践，让社区更容易参与改进

更具体的计划见 [ROADMAP.md](./ROADMAP.md)。

## 测试

```bash
bun test
bun run check
bunx tsc --noEmit
bun run tests/e2e-pipeline.ts
```

说明：

- E2E 脚本依赖真实模型环境
- 它会在仓库内和临时 fixture 项目中创建或修改文件
- 适合在本地手动验证完整流水线行为

## 许可证

MIT
