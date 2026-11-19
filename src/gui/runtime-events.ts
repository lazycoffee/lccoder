export interface GuiRuntimeEvent {
  type:
    | 'stage-start'
    | 'stage-complete'
    | 'task-start'
    | 'task-complete'
    | 'verification'
    | 'pause'
    | 'summary'
    | 'error';
  timestamp: string;
  payload: Record<string, unknown>;
}
