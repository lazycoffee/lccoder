#!/usr/bin/env bun
/**
 * lccoder CLI 入口
 * 小模型流水线编码工具
 */
import { runApp, resumeApp } from './cli/app.js';

const args = process.argv.slice(2);
const command = args[0];

if (command === 'resume') {
  // 断点续传模式
  resumeApp().catch((err) => {
    console.error('致命错误:', err.message);
    process.exit(1);
  });
} else if (command === 'init') {
  // 初始化配置
  const { initApp } = await import('./cli/app.js');
  initApp().catch((err) => {
    console.error('致命错误:', err.message);
    process.exit(1);
  });
} else if (command === 'history') {
  // 查看历史记录
  const { historyApp } = await import('./cli/app.js');
  historyApp().catch((err) => {
    console.error('致命错误:', err.message);
    process.exit(1);
  });
} else if (command === 'inspect') {
  // 查看会话详情
  const { inspectApp } = await import('./cli/app.js');
  const sessionId = args[1];
  inspectApp(sessionId).catch((err) => {
    console.error('致命错误:', err.message);
    process.exit(1);
  });
} else if (command === 'gui') {
  // 启动 GUI 监控面板
  const { guiApp } = await import('./cli/app.js');
  const port = args[1];
  guiApp(port).catch((err) => {
    console.error('致命错误:', err.message);
    process.exit(1);
  });
} else {
  // 正常模式
  runApp().catch((err) => {
    console.error('致命错误:', err.message);
    process.exit(1);
  });
}
