async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'unknown' }));
    throw Object.assign(new Error(String((err as { error?: string }).error ?? res.status)), {
      status: res.status,
    });
  }
  return res.json() as Promise<T>;
}

export interface JoinArgs {
  display_name: string;
  join_code: string;
}

export interface JoinResult {
  id: string;
  display_name: string;
}

export function join(args: JoinArgs): Promise<JoinResult> {
  return post<JoinResult>('/api/join', args);
}

export interface SuggestionArgs {
  question_id: string;
  value: string;
  rationale?: string;
}

export function postSuggestion(args: SuggestionArgs): Promise<{ ok: boolean }> {
  const body: { question_id: string; value: string; rationale?: string } = {
    question_id: args.question_id,
    value: args.value,
  };
  if (args.rationale !== undefined) body.rationale = args.rationale;
  return post<{ ok: boolean }>('/api/suggestion', body);
}

export interface CommentArgs {
  question_id: string;
  text: string;
}

export function postComment(args: CommentArgs): Promise<{ ok: boolean }> {
  return post<{ ok: boolean }>('/api/comment', args);
}

/**
 * Coordinator link validation (COORD-01). POSTs the coordinator token from the
 * `?token=` query param to `/api/coordinator/join`; the server sets the `sb_c`
 * cookie on success. Reuses the shared `post<T>` so it sends `credentials:
 * 'include'`; rejects with an Error carrying `.status` on 4xx (caller branches
 * `session_ended` vs `not_coordinator`/`invalid` for copy).
 */
export function postCoordinatorJoin(token: string): Promise<{ ok: boolean }> {
  return post<{ ok: boolean }>('/api/coordinator/join', { token });
}

export interface CoordinatorAnswerArgs {
  ticket_id: string;
  value: string;
  source: 'suggestion' | 'synthesis' | 'override';
}

/**
 * Coordinator final-answer pick (COORD-03). POSTs to `/api/coordinator/answer`,
 * gated server-side by the `sb_c` cookie. Resolves `{ ok: true }` on 200; rejects
 * with an Error carrying `.status` on 4xx/409 so the card can map 409 →
 * "already resolved" and other statuses → the generic retry copy.
 */
export function postCoordinatorAnswer(args: CoordinatorAnswerArgs): Promise<{ ok: boolean }> {
  return post<{ ok: boolean }>('/api/coordinator/answer', args);
}
