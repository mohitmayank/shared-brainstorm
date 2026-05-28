import { useEffect, useRef } from 'react';
import type { WireStreamMode, WireStreamEntry } from '../state.js';

interface PlanningStreamPanelProps {
  /** Recent narration lines (already audience-filtered + capped upstream). */
  stream: WireStreamEntry[];
  /**
   * Coordinator-only audience control. Pass both `mode` and `onModeChange` to
   * render the Off / Just me / Everyone toggle; omit for the read-only
   * participant view (which is only rendered while the mode is `everyone`).
   */
  mode?: WireStreamMode;
  onModeChange?: (mode: WireStreamMode) => void;
}

const MODES: { value: WireStreamMode; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'coordinator', label: 'Just me' },
  { value: 'everyone', label: 'Everyone' },
];

/**
 * Planning-stream view: an append-only, auto-scrolling list of the AI agent's
 * planning narration. The coordinator also gets an audience control; participants
 * get a read-only panel (rendered by App only while the mode is `everyone`).
 */
export function PlanningStreamPanel({ stream, mode, onModeChange }: PlanningStreamPanelProps) {
  const showControl = mode !== undefined && onModeChange !== undefined;
  const linesRef = useRef<HTMLDivElement>(null);

  // Keep the newest line in view as narration arrives.
  useEffect(() => {
    const el = linesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [stream.length]);

  return (
    <section
      className="card planning-stream"
      data-testid="planning-stream-panel"
      aria-label="AI planning stream"
    >
      <header className="planning-stream-header">
        <h2>AI planning</h2>
        {showControl && (
          <div
            className="planning-stream-modes"
            role="group"
            aria-label="Planning stream audience"
          >
            {MODES.map((m) => (
              <button
                key={m.value}
                type="button"
                className="planning-stream-mode"
                aria-pressed={mode === m.value}
                onClick={() => onModeChange(m.value)}
              >
                {m.label}
              </button>
            ))}
          </div>
        )}
      </header>
      <div
        className="planning-stream-lines"
        ref={linesRef}
        aria-live="polite"
        aria-relevant="additions"
      >
        {stream.length === 0 ? (
          <p className="muted">
            {showControl && mode === 'off'
              ? 'Off — the AI is not sharing its planning.'
              : 'Waiting for the AI to share its planning…'}
          </p>
        ) : (
          stream.map((line, i) => (
            <p key={`${line.at}-${i}`} className="planning-stream-line">
              {line.text}
            </p>
          ))
        )}
      </div>
    </section>
  );
}
