/**
 * Session-status pill component (PRES-01).
 * Renders at the top of both the participant Session view and the Coordinator view,
 * driven by server-authoritative session_status from UiState.
 */

export interface SessionStatusPillProps {
  status: 'waiting' | 'question_open' | 'choosing' | 'done';
}

const STATUS_COPY: Record<SessionStatusPillProps['status'], string> = {
  waiting: 'Waiting for the AI host',
  question_open: 'Question in progress',
  choosing: 'Answer being chosen',
  done: 'Session ended',
};

export function SessionStatusPill({ status }: SessionStatusPillProps) {
  return (
    <div
      className="session-status-pill"
      data-testid="session-status"
      data-status={status}
      role="status"
      aria-live="polite"
    >
      <span className="session-status-dot" data-status={status} aria-hidden="true" />
      <span>{STATUS_COPY[status]}</span>
    </div>
  );
}
