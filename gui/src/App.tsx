import { useEffect, useMemo, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type Requirement = {
  id: string;
  requirement: {
    summary: string;
    detailed_description: string;
    goals: string[];
    non_goals: string[];
    acceptance_criteria: string[];
  };
  clarifications?: Array<{
    question: string;
    answer: string;
    answered_by: 'user' | 'inferred';
  }>;
};

type Plan = {
  id: string;
  summary: string;
  tasks: Array<{
    id: string;
    order: number;
    type: string;
    title: string;
    estimated_complexity: string;
    depends_on: string[];
  }>;
};

type Summary = {
  total_tasks: number;
  completed_tasks: number;
  failed_tasks: number;
  skipped_tasks: number;
  completed_items: string[];
  failed_items: string[];
  overall_summary: string;
};

type GuiInteraction =
  | {
      id: string;
      type: 'questions';
      title: string;
      payload: { questions: string[] };
    }
  | {
      id: string;
      type: 'requirement-review';
      title: string;
      payload: { requirement: Requirement };
    }
  | {
      id: string;
      type: 'plan-review';
      title: string;
      payload: { plan: Plan };
    }
  | {
      id: string;
      type: 'pause';
      title: string;
      payload: { reason: string };
    }
  | {
      id: string;
      type: 'tool-confirm';
      title: string;
      payload: { toolName: string; args: Record<string, unknown>; reason: string };
    };

type GuiState = {
  running: boolean;
  activeRunId: string | null;
  pendingInteraction: GuiInteraction | null;
  latestSummary: Summary | null;
  latestSimpleResponse: string | null;
  latestError: string | null;
};

type Overview = {
  workingDir: string;
  provider: string;
  model: string;
  pipelineState: Record<string, unknown> | null;
  sessionCount: number;
  documentCount: number;
  latestSession: { id: string; role: string; model: string; startedAt: string } | null;
  latestDocument: { name: string; updatedAt: string } | null;
  guiState: GuiState;
  canResume: boolean;
};

type SessionListItem = {
  id: string;
  role: string;
  model: string;
  startedAt: string;
};

type SessionRecord = {
  id: string;
  role: string;
  model: string;
  startedAt: string;
  messages: Array<{ role: string; content: string }>;
  toolCallLog: Array<{ call: { name: string; arguments: Record<string, unknown> }; result: unknown }>;
};

type DocumentItem = {
  name: string;
  updatedAt: string;
};

type RuntimeEvent = {
  type: string;
  timestamp: string;
  payload: Record<string, unknown>;
};

type SnapshotPayload = {
  overview: Overview;
  sessions: SessionListItem[];
  documents: DocumentItem[];
  runtimeEvents: RuntimeEvent[];
  guiState: GuiState;
  canResume: boolean;
};

type RequestedMode = 'auto' | 'answer' | 'code' | 'debug';
type PipelineType = 'auto' | 'direct-answer' | 'coding-pipeline' | 'debug-pipeline';
type RoleCardStatus = 'pending' | 'active' | 'done';
type NavPage = 'dashboard' | 'tasks' | 'roles' | 'pipelines';

type RoleCardDefinition = {
  id: string;
  label: string;
  description: string;
};

type RoleCard = RoleCardDefinition & { status: RoleCardStatus };

type PipelineDefinition = {
  id: Exclude<PipelineType, 'auto'>;
  label: string;
  summary: string;
  trigger: string;
  verification: string;
  approval: string;
  roleIds: string[];
};

type TaskRunItem = {
  id: string;
  title: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'success' | 'failed';
  summary: string;
};

const PAGE_LABELS: Record<NavPage, string> = {
  dashboard: 'Dashboard',
  tasks: 'Tasks',
  roles: 'Roles',
  pipelines: 'Pipelines',
};

const ROLE_META: Record<string, RoleCardDefinition> = {
  classifier: { id: 'classifier', label: '路由分类', description: '判断请求复杂度，并选择合适的流水线。' },
  'direct-answer': { id: 'direct-answer', label: '直接回答', description: '处理无需工程编排的简单问答。' },
  'product-manager': { id: 'product-manager', label: '需求分析', description: '整理需求、补齐上下文、输出 requirement。' },
  'bug-triage': { id: 'bug-triage', label: '问题分诊', description: '将 bug 描述转成可执行的缺陷报告。' },
  'project-manager': { id: 'project-manager', label: '计划拆解', description: '把目标转换为任务清单、依赖和顺序。' },
  clerk: { id: 'clerk', label: '任务执行', description: '落地代码、命令和文件修改。' },
  'qa-engineer': { id: 'qa-engineer', label: 'QA 复核', description: '黑盒验收执行结果，判断是否达到目标。' },
  evaluator: { id: 'evaluator', label: '评估决策', description: '综合结果与 QA 结论，决定是否继续。' },
  summary: { id: 'summary', label: '结果总结', description: '输出最终总结、结论与残留风险。' },
};

const PIPELINE_DEFINITIONS: PipelineDefinition[] = [
  {
    id: 'direct-answer',
    label: 'Direct Answer',
    summary: '处理简单问题，直接由模型给出答复，不进入任务分发。',
    trigger: '适用于解释、咨询、轻量问答。',
    verification: '以回答完整性和可读性为主。',
    approval: '通常无审批节点。',
    roleIds: ['classifier', 'direct-answer'],
  },
  {
    id: 'coding-pipeline',
    label: 'Coding Pipeline',
    summary: '标准编码工作流，覆盖需求分析、计划、执行、QA 和总结。',
    trigger: '适用于实现功能、重构、测试补齐、工程改造。',
    verification: '以代码验证和任务验收为主。',
    approval: '需求确认、计划确认、必要时暂停确认。',
    roleIds: ['classifier', 'product-manager', 'project-manager', 'clerk', 'qa-engineer', 'evaluator', 'summary'],
  },
  {
    id: 'debug-pipeline',
    label: 'Debug Pipeline',
    summary: '针对缺陷定位和修复，强调分诊、修复验证和风险控制。',
    trigger: '适用于定位 bug、修复异常、处理回归。',
    verification: '以调试验证、回归验证和修复有效性为主。',
    approval: 'bug 报告确认、修复计划确认、必要时暂停确认。',
    roleIds: ['classifier', 'bug-triage', 'project-manager', 'clerk', 'qa-engineer', 'evaluator', 'summary'],
  },
];

function getRoleMeta(roleId: string): RoleCardDefinition {
  return ROLE_META[roleId] || {
    id: roleId,
    label: roleId,
    description: '角色元信息尚未配置。',
  };
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : `Request failed: ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

export function App() {
  const [activePage, setActivePage] = useState<NavPage>('dashboard');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [guiState, setGuiState] = useState<GuiState | null>(null);
  const [canResume, setCanResume] = useState(false);
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [selectedDocument, setSelectedDocument] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [documentContent, setDocumentContent] = useState<Record<string, unknown> | null>(null);
  const [sessionContent, setSessionContent] = useState<SessionRecord | null>(null);
  const [runtimeEvents, setRuntimeEvents] = useState<RuntimeEvent[]>([]);
  const [taskInput, setTaskInput] = useState('');
  const [requestedMode, setRequestedMode] = useState<RequestedMode>('auto');
  const [questionAnswers, setQuestionAnswers] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<'connecting' | 'live' | 'offline'>('connecting');
  const [submitting, setSubmitting] = useState(false);
  const pendingInteraction = guiState?.pendingInteraction || null;

  useEffect(() => {
    const hash = window.location.hash.replace('#', '');
    if (hash === 'dashboard' || hash === 'tasks' || hash === 'roles' || hash === 'pipelines') {
      setActivePage(hash);
    }

    const onHashChange = () => {
      const next = window.location.hash.replace('#', '');
      if (next === 'dashboard' || next === 'tasks' || next === 'roles' || next === 'pipelines') {
        setActivePage(next);
      }
    };

    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    if (window.location.hash.replace('#', '') !== activePage) {
      window.location.hash = activePage;
    }
  }, [activePage]);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        const [overviewData, docsData, sessionsData] = await Promise.all([
          fetchJson<Overview>('/api/overview'),
          fetchJson<{ documents: DocumentItem[] }>('/api/documents'),
          fetchJson<{ sessions: SessionListItem[] }>('/api/sessions'),
        ]);

        if (cancelled) return;
        setOverview(overviewData);
        setGuiState(overviewData.guiState);
        setCanResume(overviewData.canResume);
        setDocuments(docsData.documents);
        setSessions(sessionsData.sessions);
        setSelectedDocument((prev) => prev || docsData.documents[0]?.name || null);
        setSelectedSession((prev) => prev || sessionsData.sessions[0]?.id || null);
        setError(null);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    }

    bootstrap();

    const events = new EventSource('/api/events');
    events.addEventListener('ready', () => {
      if (!cancelled) setConnection('live');
    });
    events.addEventListener('snapshot', (event) => {
      if (cancelled) return;
      const payload = JSON.parse((event as MessageEvent).data) as SnapshotPayload;
      setOverview(payload.overview);
      setGuiState(payload.guiState);
      setCanResume(payload.canResume);
      setSessions(payload.sessions);
      setDocuments(payload.documents);
      setRuntimeEvents(payload.runtimeEvents);
      setSelectedDocument((prev) => prev || payload.documents[0]?.name || null);
      setSelectedSession((prev) => prev || payload.sessions[0]?.id || null);
      setError(null);
      setConnection('live');
    });
    events.addEventListener('error', () => {
      if (!cancelled) setConnection('offline');
    });

    return () => {
      cancelled = true;
      events.close();
    };
  }, []);

  useEffect(() => {
    if (!selectedDocument) {
      setDocumentContent(null);
      return;
    }

    let cancelled = false;
    fetchJson<{ document: Record<string, unknown> }>(`/api/documents/${selectedDocument}`)
      .then((data) => {
        if (!cancelled) setDocumentContent(data.document);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [selectedDocument]);

  useEffect(() => {
    if (!selectedSession) {
      setSessionContent(null);
      return;
    }

    let cancelled = false;
    fetchJson<{ session: SessionRecord }>(`/api/sessions/${selectedSession}`)
      .then((data) => {
        if (!cancelled) setSessionContent(data.session);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [selectedSession]);

  useEffect(() => {
    if (pendingInteraction?.type === 'questions') {
      setQuestionAnswers((prev) => {
        const next = { ...prev };
        for (const question of pendingInteraction.payload.questions) {
          next[question] = next[question] || '';
        }
        return next;
      });
      return;
    }
    setQuestionAnswers({});
  }, [pendingInteraction]);

  const latestStatus = useMemo(() => {
    if (guiState?.running) return 'running';
    if (overview?.pipelineState) return 'paused';
    return 'idle';
  }, [guiState?.running, overview?.pipelineState]);

  const pipelineType = useMemo<PipelineType>(() => {
    const raw = overview?.pipelineState?.pipelineType;
    if (raw === 'direct-answer' || raw === 'coding-pipeline' || raw === 'debug-pipeline') {
      return raw;
    }
    if (guiState?.latestSimpleResponse) return 'direct-answer';
    return 'auto';
  }, [overview?.pipelineState, guiState?.latestSimpleResponse]);

  const pipelineTypeLabel = useMemo(() => {
    return pipelineType === 'auto' ? 'auto' : pipelineType;
  }, [pipelineType]);

  const currentStageLabel = useMemo(() => {
    for (let index = runtimeEvents.length - 1; index >= 0; index -= 1) {
      const event = runtimeEvents[index];
      if (event?.type === 'stage-start') {
        const description = event.payload.description;
        if (typeof description === 'string' && description.trim()) return description;
        const stage = event.payload.stage;
        if (typeof stage === 'string' && stage.trim()) return stage;
      }
    }
    if (pendingInteraction) return pendingInteraction.title;
    return '等待新任务';
  }, [runtimeEvents, pendingInteraction]);

  const latestStartedStage = useMemo(() => {
    return [...runtimeEvents]
      .reverse()
      .find((event) => event.type === 'stage-start' && typeof event.payload.stage === 'string')
      ?.payload.stage as string | undefined;
  }, [runtimeEvents]);

  const completedStages = useMemo(() => {
    return new Set(
      runtimeEvents
        .filter((event) => event.type === 'stage-complete' && typeof event.payload.stage === 'string')
        .map((event) => String(event.payload.stage)),
    );
  }, [runtimeEvents]);

  const roleCards = useMemo<RoleCard[]>(() => {
    const currentPipeline = PIPELINE_DEFINITIONS.find((item) => item.id === pipelineType);
    if (!currentPipeline) return [];

    const completedRoles = new Set(sessions.map((session) => session.role));
    const fallbackActiveRole = currentPipeline.roleIds.find(
      (roleId) => !completedStages.has(roleId) && !completedRoles.has(roleId),
    );
    const activeRole = latestStartedStage || (pendingInteraction ? fallbackActiveRole : undefined);

    return currentPipeline.roleIds.map((roleId) => {
      let status: RoleCardStatus = 'pending';
      if (roleId === activeRole && (guiState?.running || pendingInteraction)) {
        status = 'active';
      } else if (completedStages.has(roleId) || completedRoles.has(roleId)) {
        status = 'done';
      }
      return { ...getRoleMeta(roleId), status };
    });
  }, [pipelineType, sessions, completedStages, latestStartedStage, guiState?.running, pendingInteraction]);

  const roleCatalog = useMemo(() => {
    return Object.values(ROLE_META).map((role) => {
      const latestSession = sessions.find((session) => session.role === role.id) || null;
      const pipelines = PIPELINE_DEFINITIONS.filter((item) => item.roleIds.includes(role.id)).map((item) => item.label);
      return {
        ...role,
        pipelines,
        latestModel: latestSession?.model || overview?.model || '-',
        latestRunAt: latestSession?.startedAt || null,
      };
    });
  }, [sessions, overview?.model]);

  const pipelineCards = useMemo(() => {
    return PIPELINE_DEFINITIONS.map((pipeline) => ({
      ...pipeline,
      roles: pipeline.roleIds.map((roleId) => getRoleMeta(roleId)),
      active: pipeline.id === pipelineType,
    }));
  }, [pipelineType]);

  const taskRuns = useMemo<TaskRunItem[]>(() => {
    const runs = new Map<string, TaskRunItem>();

    for (const event of runtimeEvents) {
      if (event.type === 'task-start') {
        const taskId = typeof event.payload.taskId === 'string' ? event.payload.taskId : `task-${event.timestamp}`;
        const title = typeof event.payload.title === 'string' ? event.payload.title : taskId;
        runs.set(taskId, {
          id: taskId,
          title,
          startedAt: event.timestamp,
          finishedAt: null,
          status: 'running',
          summary: '执行中',
        });
      }

      if (event.type === 'task-complete') {
        const taskId = typeof event.payload.taskId === 'string' ? event.payload.taskId : `task-${event.timestamp}`;
        const existing = runs.get(taskId);
        const summary = typeof event.payload.summary === 'string' ? event.payload.summary : '任务已结束';
        const success = event.payload.success === true;

        runs.set(taskId, {
          id: taskId,
          title: existing?.title || taskId,
          startedAt: existing?.startedAt || event.timestamp,
          finishedAt: event.timestamp,
          status: success ? 'success' : 'failed',
          summary,
        });
      }
    }

    return [...runs.values()].sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  }, [runtimeEvents]);

  async function startRun() {
    setSubmitting(true);
    try {
      await fetchJson('/api/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userInput: taskInput, requestedMode }),
      });
      setTaskInput('');
      setError(null);
      setActivePage('dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function resumeRun() {
    setSubmitting(true);
    try {
      await fetchJson('/api/run/resume', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      setError(null);
      setActivePage('dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function submitInteraction(response: unknown) {
    if (!pendingInteraction) return;
    setSubmitting(true);
    try {
      await fetchJson(`/api/interactions/${pendingInteraction.id}/respond`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ response }),
      });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="shell">
      <div className="app-layout">
        <aside className="sidebar">
          <div className="brand-block">
            <p className="eyebrow">lccoder monitor</p>
            <h1>Ops Console</h1>
            <p className="subtitle">把运行态、任务、角色和流水线拆成独立工作区，避免首页继续膨胀。</p>
          </div>

          <nav className="nav-stack">
            {(Object.keys(PAGE_LABELS) as NavPage[]).map((page) => (
              <button
                key={page}
                className={`nav-item ${activePage === page ? 'active' : ''}`}
                onClick={() => setActivePage(page)}
              >
                <strong>{PAGE_LABELS[page]}</strong>
                <span>{getPageSubtitle(page)}</span>
              </button>
            ))}
          </nav>

          <div className={`connection-pill ${connection}`}>
            {connection === 'live' ? '实时连接中' : connection === 'connecting' ? '正在连接实时流' : '实时流断开'}
          </div>

          <div className="sidebar-meta">
            <Snapshot label="Provider" value={overview?.provider || '-'} detail={overview?.model || '-'} />
            <Snapshot label="Sessions" value={String(overview?.sessionCount || 0)} detail={overview?.latestSession?.role || 'no session'} />
            <Snapshot label="Documents" value={String(overview?.documentCount || 0)} detail={overview?.latestDocument?.name || 'no document'} />
          </div>
        </aside>

        <div className="content-area">
          <div className="sticky-status">
            <div className={`status-chip ${guiState?.running ? 'live' : overview?.pipelineState ? 'paused' : 'idle'}`}>
              <span className="status-chip-label">Pipeline</span>
              <strong>{guiState?.running ? '执行中' : overview?.pipelineState ? '已暂停' : '空闲'}</strong>
            </div>
            <div className="status-chip quiet">
              <span className="status-chip-label">Pipeline Type</span>
              <strong>{pipelineTypeLabel}</strong>
            </div>
            <div className="status-chip status-main">
              <span className="status-chip-label">Current Stage</span>
              <strong>{currentStageLabel}</strong>
            </div>
            <div className={`status-chip ${pendingInteraction ? 'attention' : 'quiet'}`}>
              <span className="status-chip-label">Action</span>
              <strong>{pendingInteraction ? pendingInteraction.title : '无待处理确认'}</strong>
            </div>
          </div>

          {error ? <div className="error-banner">连接失败：{error}</div> : null}

          {activePage === 'dashboard' ? (
            <DashboardPage
              guiState={guiState}
              latestStatus={latestStatus}
              canResume={canResume}
              taskInput={taskInput}
              requestedMode={requestedMode}
              submitting={submitting}
              roleCards={roleCards}
              runtimeEvents={runtimeEvents}
              currentStageLabel={currentStageLabel}
              overview={overview}
              onTaskInputChange={setTaskInput}
              onRequestedModeChange={setRequestedMode}
              onStartRun={startRun}
              onResumeRun={resumeRun}
            />
          ) : null}

          {activePage === 'tasks' ? (
            <TasksPage
              taskRuns={taskRuns}
              sessions={sessions}
              selectedSession={selectedSession}
              sessionContent={sessionContent}
              onSelectSession={setSelectedSession}
              documents={documents}
              selectedDocument={selectedDocument}
              documentContent={documentContent}
              onSelectDocument={setSelectedDocument}
            />
          ) : null}

          {activePage === 'roles' ? (
            <RolesPage
              roles={roleCatalog}
              roleCards={roleCards}
              running={Boolean(guiState?.running)}
              pendingInteraction={pendingInteraction}
            />
          ) : null}

          {activePage === 'pipelines' ? (
            <PipelinesPage
              pipelines={pipelineCards}
              currentPipelineType={pipelineType}
              overview={overview}
            />
          ) : null}
        </div>
      </div>

      {pendingInteraction ? (
        <InteractionDialog
          interaction={pendingInteraction}
          answers={questionAnswers}
          submitting={submitting}
          onAnswerChange={(question, answer) => {
            setQuestionAnswers((prev) => ({ ...prev, [question]: answer }));
          }}
          onApprove={() => submitInteraction(true)}
          onReject={() => submitInteraction(false)}
          onContinue={() => submitInteraction('continue')}
          onAbort={() => submitInteraction('abort')}
          onQuestionSubmit={() => submitInteraction(questionAnswers)}
        />
      ) : null}
    </div>
  );
}

function DashboardPage(props: {
  guiState: GuiState | null;
  latestStatus: string;
  canResume: boolean;
  taskInput: string;
  requestedMode: RequestedMode;
  submitting: boolean;
  roleCards: RoleCard[];
  runtimeEvents: RuntimeEvent[];
  currentStageLabel: string;
  overview: Overview | null;
  onTaskInputChange: (value: string) => void;
  onRequestedModeChange: (value: RequestedMode) => void;
  onStartRun: () => void;
  onResumeRun: () => void;
}) {
  const {
    guiState,
    latestStatus,
    canResume,
    taskInput,
    requestedMode,
    submitting,
    roleCards,
    runtimeEvents,
    currentStageLabel,
    overview,
    onTaskInputChange,
    onRequestedModeChange,
    onStartRun,
    onResumeRun,
  } = props;

  return (
    <main className="page-grid">
      <section className="panel panel-wide">
        <PanelHeader title="Run Pipeline" meta={guiState?.running ? '执行中' : '等待新任务'} />
        <div className="composer">
          <div className="composer-controls">
            <label className="mode-select">
              <span>流水线模式</span>
              <select
                value={requestedMode}
                onChange={(event) => onRequestedModeChange(event.target.value as RequestedMode)}
                disabled={submitting || Boolean(guiState?.running)}
              >
                <option value="auto">Auto</option>
                <option value="code">Coding</option>
                <option value="debug">Debug</option>
                <option value="answer">Answer</option>
              </select>
            </label>
          </div>
          <textarea
            className="composer-input"
            value={taskInput}
            onChange={(event) => onTaskInputChange(event.target.value)}
            placeholder="例如：设计一条 review 流水线，并补齐对应角色和 GUI 配置页"
            disabled={submitting || Boolean(guiState?.running)}
          />
          <div className="composer-actions">
            <button
              className="primary-button"
              onClick={onStartRun}
              disabled={submitting || Boolean(guiState?.running) || !taskInput.trim()}
            >
              启动任务
            </button>
            <button
              className="secondary-button"
              onClick={onResumeRun}
              disabled={submitting || Boolean(guiState?.running) || !canResume}
            >
              恢复上次流水线
            </button>
          </div>
        </div>
        <div className="snapshot-grid">
          <Snapshot label="Pipeline" value={latestStatus} detail={guiState?.activeRunId || 'no active run'} />
          <Snapshot label="Current Stage" value={currentStageLabel} detail={overview?.workingDir || 'no workspace'} />
          <Snapshot label="Latest Result" value={guiState?.latestSummary ? 'summary ready' : guiState?.latestSimpleResponse ? 'answer ready' : '-'} detail={guiState?.latestError || guiState?.latestSummary?.overall_summary || guiState?.latestSimpleResponse || ''} />
        </div>
      </section>

      <section className="panel panel-wide">
        <PanelHeader title="Runtime Roles" meta={roleCards.length ? `${roleCards.length} roles` : '等待一次运行后展示'} />
        {roleCards.length === 0 ? (
          <div className="empty-state">当前还没有可展示的运行角色。启动一次任务后，这里会显示该流水线涉及的角色和执行状态。</div>
        ) : (
          <div className="role-grid">
            {roleCards.map((role) => (
              <article className={`role-card ${role.status}`} key={role.id}>
                <div className="role-card-top">
                  <span className="role-name">{role.label}</span>
                  <span className={`role-badge ${role.status}`}>{formatRoleStatus(role.status)}</span>
                </div>
                <code className="role-id">{role.id}</code>
                <p className="role-description">{role.description}</p>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <PanelHeader title="Current State" meta={overview?.workingDir || 'No workspace'} />
        <pre className="json-block">{JSON.stringify(overview?.pipelineState || { status: latestStatus }, null, 2)}</pre>
      </section>

      <section className="panel">
        <PanelHeader title="Latest Output" meta={guiState?.latestSummary ? 'summary' : guiState?.latestSimpleResponse ? 'response' : 'No output'} />
        <ResultPanel guiState={guiState} />
      </section>

      <section className="panel panel-wide">
        <PanelHeader title="Runtime Events" meta={`${runtimeEvents.length} events`} />
        <div className="event-list">
          {runtimeEvents.length === 0 ? (
            <div className="empty-state">暂无运行事件。你可以直接在上方输入需求并启动流水线。</div>
          ) : (
            runtimeEvents
              .slice()
              .reverse()
              .map((event, index) => (
                <div className="event-card" key={`${event.timestamp}-${event.type}-${index}`}>
                  <div className="event-top">
                    <strong>{event.type}</strong>
                    <small>{formatTime(event.timestamp)}</small>
                  </div>
                  <pre className="event-payload">{JSON.stringify(event.payload, null, 2)}</pre>
                </div>
              ))
          )}
        </div>
      </section>
    </main>
  );
}

function TasksPage(props: {
  taskRuns: TaskRunItem[];
  sessions: SessionListItem[];
  selectedSession: string | null;
  sessionContent: SessionRecord | null;
  onSelectSession: (value: string) => void;
  documents: DocumentItem[];
  selectedDocument: string | null;
  documentContent: Record<string, unknown> | null;
  onSelectDocument: (value: string) => void;
}) {
  const {
    taskRuns,
    sessions,
    selectedSession,
    sessionContent,
    onSelectSession,
    documents,
    selectedDocument,
    documentContent,
    onSelectDocument,
  } = props;

  return (
    <main className="page-grid">
      <section className="panel panel-wide">
        <PanelHeader title="Task List" meta={taskRuns.length ? `${taskRuns.length} tracked tasks` : '暂无任务事件'} />
        {taskRuns.length === 0 ? (
          <div className="empty-state">当前还没有可展示的任务执行记录。运行一条 coding 或 debug 流水线后，这里会按任务维度展示结果。</div>
        ) : (
          <div className="task-list">
            {taskRuns.map((task) => (
              <article className={`task-row ${task.status}`} key={task.id}>
                <div>
                  <strong>{task.title}</strong>
                  <p>{task.summary}</p>
                </div>
                <div className="task-row-meta">
                  <span className={`task-status ${task.status}`}>{formatTaskStatus(task.status)}</span>
                  <small>{formatTime(task.startedAt)}</small>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <PanelHeader title="Sessions" meta={sessions[0] ? `${sessions.length} records` : 'No sessions'} />
        <div className="split">
          <div className="list">
            {sessions.length === 0 ? <div className="empty-state">当前还没有角色会话记录。执行一次任务后会自动归档。</div> : null}
            {sessions.map((session) => (
              <button
                key={session.id}
                className={`list-item ${selectedSession === session.id ? 'active' : ''}`}
                onClick={() => onSelectSession(session.id)}
              >
                <span>{session.id}</span>
                <small>{session.role} · {formatTime(session.startedAt)}</small>
              </button>
            ))}
          </div>
          {sessionContent ? (
            <div className="session-view">
              <div className="session-meta">
                <strong>{sessionContent.role}</strong>
                <span>{sessionContent.model}</span>
              </div>
              <pre className="json-block">{JSON.stringify(sessionContent, null, 2)}</pre>
            </div>
          ) : (
            <div className="empty-state detail-empty">选择一条会话记录后，这里会显示完整上下文和工具调用。</div>
          )}
        </div>
      </section>

      <section className="panel">
        <PanelHeader title="Documents" meta={documents[0] ? `${documents.length} files` : 'No documents'} />
        <div className="split">
          <div className="list">
            {documents.length === 0 ? <div className="empty-state">还没有生成文档。需求、计划、结果和总结会出现在这里。</div> : null}
            {documents.map((doc) => (
              <button
                key={doc.name}
                className={`list-item ${selectedDocument === doc.name ? 'active' : ''}`}
                onClick={() => onSelectDocument(doc.name)}
              >
                <span>{doc.name}</span>
                <small>{formatTime(doc.updatedAt)}</small>
              </button>
            ))}
          </div>
          {documentContent ? (
            <pre className="json-block">{JSON.stringify(documentContent, null, 2)}</pre>
          ) : (
            <div className="empty-state detail-empty">选择一份文档后，这里会显示结构化内容。</div>
          )}
        </div>
      </section>
    </main>
  );
}

function RolesPage(props: {
  roles: Array<{
    id: string;
    label: string;
    description: string;
    pipelines: string[];
    latestModel: string;
    latestRunAt: string | null;
  }>;
  roleCards: RoleCard[];
  running: boolean;
  pendingInteraction: GuiInteraction | null;
}) {
  const { roles, roleCards, running, pendingInteraction } = props;
  const activeRoleIds = new Set(roleCards.filter((role) => role.status === 'active').map((role) => role.id));
  const completedRoleIds = new Set(roleCards.filter((role) => role.status === 'done').map((role) => role.id));

  return (
    <main className="page-grid">
      <section className="panel panel-wide">
        <PanelHeader title="Role Catalog" meta={`${roles.length} roles`} />
        <div className="catalog-grid">
          {roles.map((role) => {
            const runtimeStatus: RoleCardStatus = activeRoleIds.has(role.id)
              ? 'active'
              : completedRoleIds.has(role.id)
                ? 'done'
                : 'pending';

            return (
              <article className={`catalog-card ${runtimeStatus}`} key={role.id}>
                <div className="catalog-top">
                  <div>
                    <h3>{role.label}</h3>
                    <code className="role-id">{role.id}</code>
                  </div>
                  <span className={`role-badge ${runtimeStatus}`}>{formatRoleStatus(runtimeStatus)}</span>
                </div>
                <p className="role-description">{role.description}</p>
                <div className="meta-pills">
                  {role.pipelines.map((pipeline) => (
                    <span className="meta-pill" key={`${role.id}-${pipeline}`}>{pipeline}</span>
                  ))}
                </div>
                <dl className="kv-grid">
                  <div>
                    <dt>Latest Model</dt>
                    <dd>{role.latestModel}</dd>
                  </div>
                  <div>
                    <dt>Latest Run</dt>
                    <dd>{role.latestRunAt ? formatTime(role.latestRunAt) : '暂无执行记录'}</dd>
                  </div>
                </dl>
              </article>
            );
          })}
        </div>
      </section>

      <section className="panel panel-wide">
        <PanelHeader title="Role Config Roadmap" meta="当前是只读视图，下一步可接后端配置" />
        <div className="roadmap-grid">
          <FeatureNote title="配置项建议" body="模型绑定、system prompt、重试策略、可用工具、审批权限、验证模式都应该进入角色配置。" />
          <FeatureNote title="运行态分离" body="Dashboard 显示当前运行状态；Roles 显示角色定义，不再把配置和监控混在一起。" />
          <FeatureNote title="下一步后端" body="建议把角色定义从硬编码迁到配置模型，再由 GUI 读写角色配置。" />
        </div>
        {running || pendingInteraction ? (
          <div className="inline-note">当前有正在执行或待确认的任务，角色运行态已同步到上方卡片。</div>
        ) : null}
      </section>
    </main>
  );
}

function PipelinesPage(props: {
  pipelines: Array<PipelineDefinition & { roles: RoleCardDefinition[]; active: boolean }>;
  currentPipelineType: PipelineType;
  overview: Overview | null;
}) {
  const { pipelines, currentPipelineType, overview } = props;

  return (
    <main className="page-grid">
      <section className="panel panel-wide">
        <PanelHeader title="Pipeline Catalog" meta={currentPipelineType === 'auto' ? '暂无活动流水线' : `当前活动：${currentPipelineType}`} />
        <div className="pipeline-grid">
          {pipelines.map((pipeline) => (
            <article className={`pipeline-card ${pipeline.active ? 'active' : ''}`} key={pipeline.id}>
              <div className="catalog-top">
                <div>
                  <h3>{pipeline.label}</h3>
                  <code className="role-id">{pipeline.id}</code>
                </div>
                <span className={`role-badge ${pipeline.active ? 'active' : 'pending'}`}>
                  {pipeline.active ? '运行中' : '已定义'}
                </span>
              </div>
              <p className="role-description">{pipeline.summary}</p>
              <dl className="kv-grid">
                <div>
                  <dt>Trigger</dt>
                  <dd>{pipeline.trigger}</dd>
                </div>
                <div>
                  <dt>Verification</dt>
                  <dd>{pipeline.verification}</dd>
                </div>
                <div>
                  <dt>Approval</dt>
                  <dd>{pipeline.approval}</dd>
                </div>
              </dl>
              <div className="meta-pills">
                {pipeline.roles.map((role) => (
                  <span className="meta-pill" key={`${pipeline.id}-${role.id}`}>{role.label}</span>
                ))}
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="panel">
        <PanelHeader title="Pipeline State" meta={overview?.workingDir || 'No workspace'} />
        <pre className="json-block">{JSON.stringify(overview?.pipelineState || { pipelineType: currentPipelineType }, null, 2)}</pre>
      </section>

      <section className="panel">
        <PanelHeader title="Pipeline Design Next" meta="建议尽快把硬编码流程配置化" />
        <div className="roadmap-grid">
          <FeatureNote title="配置结构" body="流水线应抽象成节点、边、审批点、验证点和失败分支，而不是长期停留在 orchestrator 的分支判断里。" />
          <FeatureNote title="GUI 目标" body="这里未来应支持新建流水线、调整角色顺序、配置验证策略和启停某条流水线。" />
          <FeatureNote title="当前阶段" body="这版先把页面结构立住，后面再把后端配置持久化接进来。" />
        </div>
      </section>
    </main>
  );
}

function FeatureNote({ title, body }: { title: string; body: string }) {
  return (
    <article className="note-card">
      <strong>{title}</strong>
      <p>{body}</p>
    </article>
  );
}

function InteractionDialog(props: {
  interaction: GuiInteraction;
  answers: Record<string, string>;
  submitting: boolean;
  onAnswerChange: (question: string, answer: string) => void;
  onApprove: () => void;
  onReject: () => void;
  onContinue: () => void;
  onAbort: () => void;
  onQuestionSubmit: () => void;
}) {
  const { interaction, answers, submitting, onAnswerChange, onApprove, onReject, onContinue, onAbort, onQuestionSubmit } = props;

  let body: ReactNode;
  let footer: ReactNode;

  if (interaction.type === 'questions') {
    const complete = interaction.payload.questions.every((question) => answers[question]?.trim());
    body = (
      <div className="dialog-stack">
        {interaction.payload.questions.map((question) => (
          <label className="dialog-field" key={question}>
            <span>{question}</span>
            <textarea
              value={answers[question] || ''}
              onChange={(event) => onAnswerChange(question, event.target.value)}
              placeholder="请输入你的回答"
              disabled={submitting}
            />
          </label>
        ))}
      </div>
    );
    footer = (
      <div className="dialog-actions">
        <button className="primary-button" onClick={onQuestionSubmit} disabled={submitting || !complete}>
          提交回答
        </button>
      </div>
    );
  } else if (interaction.type === 'requirement-review') {
    body = (
      <div className="dialog-stack">
        <p className="dialog-copy">{interaction.payload.requirement.requirement.summary}</p>
        <JsonCard title="需求详情" data={interaction.payload.requirement} />
      </div>
    );
    footer = (
      <div className="dialog-actions">
        <button className="secondary-button" onClick={onReject} disabled={submitting}>驳回</button>
        <button className="primary-button" onClick={onApprove} disabled={submitting}>确认需求</button>
      </div>
    );
  } else if (interaction.type === 'plan-review') {
    body = (
      <div className="dialog-stack">
        <p className="dialog-copy">{interaction.payload.plan.summary}</p>
        <JsonCard title="计划详情" data={interaction.payload.plan} />
      </div>
    );
    footer = (
      <div className="dialog-actions">
        <button className="secondary-button" onClick={onReject} disabled={submitting}>停止执行</button>
        <button className="primary-button" onClick={onApprove} disabled={submitting}>确认并执行</button>
      </div>
    );
  } else if (interaction.type === 'pause') {
    body = <p className="dialog-copy">{interaction.payload.reason}</p>;
    footer = (
      <div className="dialog-actions">
        <button className="secondary-button" onClick={onAbort} disabled={submitting}>终止流水线</button>
        <button className="primary-button" onClick={onContinue} disabled={submitting}>继续执行</button>
      </div>
    );
  } else {
    body = (
      <div className="dialog-stack">
        <p className="dialog-copy">{interaction.payload.reason}</p>
        <JsonCard title={interaction.payload.toolName} data={interaction.payload.args} />
      </div>
    );
    footer = (
      <div className="dialog-actions">
        <button className="secondary-button" onClick={onReject} disabled={submitting}>拒绝执行</button>
        <button className="primary-button" onClick={onApprove} disabled={submitting}>允许执行</button>
      </div>
    );
  }

  return (
    <div className="dialog-backdrop">
      <div className="dialog-card">
        <div className="dialog-header">
          <p className="eyebrow">Pending Interaction</p>
          <h3>{interaction.title}</h3>
        </div>
        {body}
        {footer}
      </div>
    </div>
  );
}

function JsonCard({ title, data }: { title: string; data: unknown }) {
  return (
    <div className="dialog-json">
      <strong>{title}</strong>
      <pre className="json-block">{JSON.stringify(data, null, 2)}</pre>
    </div>
  );
}

function ResultPanel({ guiState }: { guiState: GuiState | null }) {
  if (guiState?.latestError) {
    return (
      <div className="result-card result-error">
        <p className="result-label">Execution Error</p>
        <p className="result-message">{guiState.latestError}</p>
      </div>
    );
  }

  if (guiState?.latestSimpleResponse) {
    return (
      <div className="result-thread">
        <div className="result-card result-chat">
          <p className="result-label">Assistant Reply</p>
          <div className="markdown-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {guiState.latestSimpleResponse}
            </ReactMarkdown>
          </div>
        </div>
      </div>
    );
  }

  if (guiState?.latestSummary) {
    const summaryMarkdown = buildSummaryMarkdown(guiState.latestSummary);
    return (
      <div className="result-thread">
        <div className="result-stats">
          <Snapshot label="Completed" value={String(guiState.latestSummary.completed_tasks)} detail="tasks passed" />
          <Snapshot label="Failed" value={String(guiState.latestSummary.failed_tasks)} detail="tasks failed" />
          <Snapshot label="Skipped" value={String(guiState.latestSummary.skipped_tasks)} detail="tasks skipped" />
        </div>
        <div className="result-card result-summary">
          <p className="result-label">Execution Summary</p>
          <div className="markdown-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {summaryMarkdown}
            </ReactMarkdown>
          </div>
        </div>
      </div>
    );
  }

  return <div className="empty-state detail-empty">执行完成后，这里会直接显示最终回复或总结结果。</div>;
}

function Snapshot({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="snapshot">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function PanelHeader({ title, meta }: { title: string; meta: string }) {
  return (
    <div className="panel-header">
      <h2>{title}</h2>
      <span>{meta}</span>
    </div>
  );
}

function buildSummaryMarkdown(summary: Summary): string {
  const lines = [
    '## Overall Result',
    '',
    summary.overall_summary,
    '',
    '## Breakdown',
    '',
    `- Total tasks: ${summary.total_tasks}`,
    `- Completed: ${summary.completed_tasks}`,
    `- Failed: ${summary.failed_tasks}`,
    `- Skipped: ${summary.skipped_tasks}`,
  ];

  if (summary.completed_items.length > 0) {
    lines.push('', '## Completed Items', '');
    for (const item of summary.completed_items) lines.push(`- ${item}`);
  }

  if (summary.failed_items.length > 0) {
    lines.push('', '## Failed Items', '');
    for (const item of summary.failed_items) lines.push(`- ${item}`);
  }

  return lines.join('\n');
}

function formatRoleStatus(status: RoleCardStatus): string {
  switch (status) {
    case 'active':
      return '执行中';
    case 'done':
      return '已完成';
    default:
      return '待执行';
  }
}

function formatTaskStatus(status: TaskRunItem['status']): string {
  switch (status) {
    case 'success':
      return '成功';
    case 'failed':
      return '失败';
    default:
      return '运行中';
  }
}

function getPageSubtitle(page: NavPage): string {
  switch (page) {
    case 'dashboard':
      return '运行控制与实时监控';
    case 'tasks':
      return '任务、会话与文档';
    case 'roles':
      return '角色目录与配置视图';
    case 'pipelines':
      return '流水线目录与设计视图';
    default:
      return '';
  }
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}
