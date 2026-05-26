/**
 * Advisory status card shown when the server emits `room_empty_changed`
 * with `is_empty: true` and a question is broadcast (Phase 11 ROOM-03).
 * Auto-clears when any approved participant reconnects — no dismiss affordance.
 *
 * Uses the existing `.card` shell (inherits background/shadow/padding).
 * `.empty-room-notice` is a zero-rule passthrough added for targeting in
 * tests and future styling.
 */
// IN-01: propless component — no parameter, no eslint-disable. The previous
// `_props: Record<string, never> = {}` existed only to satisfy a direct-call
// test; the test now calls EmptyRoomNotice() with no args.
export function EmptyRoomNotice() {
  return (
    <div className="card empty-room-notice" role="status" aria-live="polite">
      <p className="muted">Room is empty — all participants left. You can still answer and resolve.</p>
    </div>
  );
}
