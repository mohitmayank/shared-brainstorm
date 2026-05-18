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
