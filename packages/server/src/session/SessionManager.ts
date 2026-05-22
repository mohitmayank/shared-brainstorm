import {
  newCoordinatorToken,
  newParticipantId,
  newQuestionId,
  newSessionId,
  newClarificationId,
  newChatEntryId,
  type ParticipantId,
  type QuestionId,
  type SessionId,
  type AskGroupInput,
  type AwaitAnswerInput,
  type AwaitAnswerOutput,
  type AnswerSource,
  type ServerEvent,
  type EphemeralFrame,
  type Participant,
  type Question,
  type Clarification,
  type ChatEntry,
  type SessionView,
  type SessionStatus,
  type Transcript,
} from '@shared-brainstorm/shared';
import { TicketStore } from './tickets.js';
import { RingBuffer } from './ringBuffer.js';
import { writeTranscript } from './transcript.js';
import type { Clock } from './clock.js';

export interface SessionManagerOpts {
  clock: Clock;
  /**
   * Broadcast sink. Optional so SessionManager can be instantiated standalone
   * (tests, MCP-only contexts). Use {@link SessionManager.setBroadcaster} to
   * (re)bind a broadcaster at runtime — typically wired by `startHttpServer`.
   * Widened to accept EphemeralFrame for the broadcastEphemeral() path.
   */
  broadcast?: (event: ServerEvent | EphemeralFrame) => void;
  transcriptDir: string;
  /** REL-07 / D-05: max participants per session. Default 50. */
  maxParticipants?: number;
  /** REL-07 / D-05: max suggestions per participant per question. Default 5. */
  maxSuggestionsPerParticipantPerQuestion?: number;
  /** REL-07 / D-05: max comments per question (total across participants). Default 100. */
  maxCommentsPerQuestion?: number;
  /** CHATAI-01: max clarifications per question (total across participants). Default 50. */
  maxClarificationsPerQuestion?: number;
  /** CHAT-01: max chat messages per session (total). Default 1000. */
  maxChatMessages?: number;
}

/**
 * Build a typed cap-exceeded error. Mirrors the `.code` attachment pattern in
 * `tickets.ts:35-40` and adds a numeric `.limit` so the HTTP layer can include
 * the configured cap value in the 409 response body (D-06).
 *
 * Cap errors are thrown BEFORE any `emit()` call (D-07) — they are HTTP-layer
 * rejections and must never enter the RingBuffer / transcript.
 */
function capError(code: string, limit: number, message: string): Error {
  const e = new Error(message);
  (e as Error & { code: string; limit: number }).code = code;
  (e as Error & { code: string; limit: number }).limit = limit;
  return e;
}

interface ActiveSession {
  id: SessionId;
  brief: string;
  started_at: string;
  /**
   * High-entropy coordinator token. Minted once in start(), dies on stop().
   * MUST NOT appear in sessionView(), any ServerEvent payload, the transcript,
   * or logs — it is the only credential gating the coordinator browser view.
   */
  coordinator_token: string;
  /** Phase 4: whether the room is locked to new participants. */
  locked: boolean;
  /** Phase 5: server-driven session lifecycle status. */
  session_status: SessionStatus;
  participants: Map<ParticipantId, Participant>;
  decisions: { question: string; answer: string; question_id: QuestionId }[];
  /**
   * Phase 6 (BATCH-02): replaces current_question scalar. Holds N concurrently
   * open questions in insertion order (Map preserves insertion order in V8).
   */
  open_questions: Map<QuestionId, Question>;
  ticket_to_question: Map<string, QuestionId>;
  /**
   * WR-01 / WR-03: the ticket_id currently being picked by the coordinator
   * (set by the ws.ts `picking start` handler, cleared on `picking stop` or
   * coordinator WS disconnect). `deriveSessionStatus` returns 'choosing' only
   * while this is non-null AND the ticket's question is still open — so
   * resolving Q2 while Q1 is mid-pick does NOT drop the 'choosing' caption,
   * and coordinator disconnect clears it so the caption can never stick.
   */
  pickingTicketId: string | null;
  /** CHATAI-01 / CHAT-01: durable session-level chat. */
  chat: ChatEntry[];
}

/**
 * CR-01 (errata E19): aggregate cap on concurrently-open questions. The per-call
 * `MAX_BATCH_QUESTIONS` Zod guard only limits a single `askGroupBatch` invocation;
 * this constant caps the total across ALL open questions (single or batch) so a
 * rogue AI host cannot grow the Map/tickets/waiters/ring-buffer without bound by
 * repeatedly calling `askGroup` or `askGroupBatch`.
 */
const MAX_OPEN_QUESTIONS = 20;

export class SessionManager {
  private active: ActiveSession | null = null;
  private tickets: TicketStore;
  private events = new RingBuffer<ServerEvent>(500);
  private nextSeq = 0;
  private broadcaster: (event: ServerEvent | EphemeralFrame) => void;
  private terminalQuestions: Question[] = [];

  constructor(private opts: SessionManagerOpts) {
    this.broadcaster = opts.broadcast ?? ((): void => {});
    this.tickets = new TicketStore(opts.clock);
  }

  setBroadcaster(fn: (event: ServerEvent | EphemeralFrame) => void): void {
    this.broadcaster = fn;
  }

  isActive(): boolean {
    return this.active !== null;
  }

  start({ brief }: { brief: string }): { session_id: SessionId } {
    if (this.active) throw new Error('a session is already active');
    const session_id = newSessionId();
    this.active = {
      id: session_id,
      brief,
      started_at: this.opts.clock.isoNow(),
      coordinator_token: newCoordinatorToken(),
      locked: false,
      session_status: 'waiting',
      participants: new Map(),
      decisions: [],
      open_questions: new Map<QuestionId, Question>(),
      ticket_to_question: new Map(),
      pickingTicketId: null,
      chat: [],
    };
    return { session_id };
  }

  /**
   * The session's coordinator token. Mirrors joinCode() semantics: throws
   * 'no active session' before start() / after stop(). Never broadcast or
   * serialized — exposed only to the MCP/HTTP layer for URL composition and
   * cookie verification.
   */
  coordinatorToken(): string {
    return this.requireActive().coordinator_token;
  }

  addParticipant(args: { display_name: string }): Participant {
    const a = this.requireActive();
    // REL-07 / D-07: cap check throws BEFORE any mutation or emit() so cap
    // rejections never enter the RingBuffer / transcript.
    const limit = this.opts.maxParticipants ?? 50;
    if (a.participants.size >= limit) {
      throw capError(
        'cap_exceeded:participants',
        limit,
        `participant cap reached (${limit})`,
      );
    }
    const p: Participant = {
      id: newParticipantId(),
      display_name: args.display_name,
      joined_at: this.opts.clock.isoNow(),
      status: 'pending',
    };
    a.participants.set(p.id, p);
    this.emit({ type: 'participant_joined', payload: { participant: p } });
    return p;
  }

  removeParticipant(id: ParticipantId): void {
    const a = this.requireActive();
    if (a.participants.delete(id)) {
      this.emit({ type: 'participant_left', payload: { participant_id: id } });
    }
  }

  askGroup(input: AskGroupInput): { ticket_id: string } {
    const a = this.requireActive();
    // CR-01 (errata E19): aggregate cap — must be checked BEFORE tickets.create()
    // so a cap rejection never creates a dangling ticket or enters the RingBuffer.
    if (a.open_questions.size >= MAX_OPEN_QUESTIONS) {
      throw capError(
        'cap_exceeded:open_questions',
        MAX_OPEN_QUESTIONS,
        `open question cap reached (${MAX_OPEN_QUESTIONS})`,
      );
    }
    const ticket = this.tickets.create();
    const normalisedOptions = input.options?.map((o) =>
      o.description !== undefined
        ? { label: o.label, description: o.description }
        : { label: o.label },
    );
    const q: Question = {
      id: newQuestionId(),
      ticket_id: ticket.id,
      asked_at: this.opts.clock.isoNow(),
      text: input.question,
      ...(normalisedOptions !== undefined ? { options: normalisedOptions } : {}),
      ...(input.recommendation !== undefined ? { recommendation: input.recommendation } : {}),
      status: 'broadcast',
      suggestions: [],
      comments: [],
      clarifications: [],
      resolution: null,
    };
    a.open_questions.set(q.id, q); // Phase 6: replaced a.current_question = q
    a.ticket_to_question.set(ticket.id, q.id);
    this.emit({ type: 'question_broadcast', payload: { question: q } });
    this.setSessionStatus(this.deriveSessionStatus()); // Phase 6: replaced hardcoded 'question_open'
    return { ticket_id: ticket.id };
  }

  /**
   * Phase 6 (BATCH-01): post multiple questions concurrently. Reuses the
   * single-question askGroup() path per item so all invariants are preserved.
   * The setSessionStatus idempotency guard in askGroup() suppresses redundant
   * session_status_changed events after the first question_open transition.
   */
  askGroupBatch(inputs: AskGroupInput[]): { tickets: { question_id: string; ticket_id: string }[] } {
    // CR-01 (errata E19): validate the WHOLE batch against the aggregate cap
    // BEFORE creating/broadcasting any question. Without this pre-check a batch
    // that crosses the cap mid-loop would broadcast the earlier questions, then
    // throw — orphaning live, un-awaitable questions that hold cap slots until
    // session end. Reject atomically so a partial batch is never created.
    const a = this.requireActive();
    if (a.open_questions.size + inputs.length > MAX_OPEN_QUESTIONS) {
      throw capError(
        'cap_exceeded:open_questions',
        MAX_OPEN_QUESTIONS,
        `open question cap reached (max ${MAX_OPEN_QUESTIONS}; ${a.open_questions.size} open, ${inputs.length} requested)`,
      );
    }
    const tickets = inputs.map((input) => {
      const { ticket_id } = this.askGroup(input);
      const a = this.requireActive();
      // ticket_to_question was set synchronously inside askGroup() above;
      // non-null assertion is safe (single-threaded event loop).
      const question_id = a.ticket_to_question.get(ticket_id)!;
      return { question_id, ticket_id };
    });
    return { tickets };
  }

  postSuggestion(args: {
    participant_id: ParticipantId;
    question_id: QuestionId;
    value: string;
    rationale?: string;
  }): void {
    const a = this.requireActive();
    const q = a.open_questions.get(args.question_id); // Phase 6: replaced current_question scalar guard
    if (!q || q.status !== 'broadcast') return;
    if (!a.participants.has(args.participant_id)) return;
    const existing = q.suggestions.find((s) => s.participant_id === args.participant_id);
    if (existing) {
      existing.value = args.value;
      if (args.rationale !== undefined) existing.rationale = args.rationale;
      else delete existing.rationale;
      existing.at = this.opts.clock.isoNow();
      this.emit({
        type: 'suggestion_updated',
        payload: { question_id: q.id, suggestion: existing },
      });
      this.tickets.bump(q.ticket_id);
      return;
    }
    // REL-07 / D-05 / D-07: cap throw on the insert branch only — updates above
    // are not counted. Throw BEFORE the push() + emit() so a rejected insert
    // never enters the RingBuffer.
    //
    // Forward-compat seatbelt: under current dedupe-by-participant logic this
    // cap is unreachable (a same-participant re-submit goes through the
    // `existing` branch above, so any one participant can only ever have 1
    // suggestion per question). Intentionally untested. See 02-03-PLAN.md
    // §Concerns / user resolution (Interpretation A, 2026-05-19) — the field
    // ships so when batch-question semantics arrive in a later phase the cap
    // is already wired.
    const sugLimit = this.opts.maxSuggestionsPerParticipantPerQuestion ?? 5;
    const mine = q.suggestions.filter((s) => s.participant_id === args.participant_id).length;
    if (mine >= sugLimit) {
      throw capError(
        'cap_exceeded:suggestions',
        sugLimit,
        `suggestion cap reached for participant (${sugLimit} per question)`,
      );
    }
    const sug = {
      id: `s_${q.suggestions.length + 1}`,
      participant_id: args.participant_id,
      value: args.value,
      ...(args.rationale !== undefined ? { rationale: args.rationale } : {}),
      at: this.opts.clock.isoNow(),
    };
    q.suggestions.push(sug);
    this.emit({ type: 'suggestion_added', payload: { question_id: q.id, suggestion: sug } });
    this.tickets.bump(q.ticket_id);
  }

  /**
   * Coordinator-as-planner: the coordinator contributes their own answer as an
   * attributed suggestion in the pool, mirroring {@link postSuggestion} but with
   * server-derived identity (the same anti-spoof posture as {@link postChat}):
   *   - NO `participants.has(...)` guard (the coordinator is not a roster member),
   *   - reserved synthetic `participant_id: 'coordinator'`,
   *   - stamps `author_kind:'coordinator'` + `display_name:'Coordinator'`,
   *   - dedups by the `'coordinator'` id (resubmit updates the single coordinator
   *     suggestion, never a second entry),
   *   - emits the EXISTING `suggestion_added` / `suggestion_updated` events and
   *     bumps the ticket (no new WS event type),
   *   - is exempt from the per-participant suggestion cap.
   *
   * Silently returns (no throw, no emit) when the question is missing or not in
   * 'broadcast' status, matching {@link postSuggestion}.
   */
  postCoordinatorSuggestion(args: {
    question_id: QuestionId;
    value: string;
    rationale?: string;
  }): void {
    const a = this.requireActive();
    const q = a.open_questions.get(args.question_id);
    if (!q || q.status !== 'broadcast') return;
    // Reserved synthetic id for coordinator-authored suggestions. Cast to the
    // ParticipantId brand the same way other synthetic ids are handled here.
    const coordinatorId = 'coordinator' as ParticipantId;
    const existing = q.suggestions.find((s) => s.participant_id === coordinatorId);
    if (existing) {
      existing.value = args.value;
      if (args.rationale !== undefined) existing.rationale = args.rationale;
      else delete existing.rationale;
      existing.at = this.opts.clock.isoNow();
      this.emit({
        type: 'suggestion_updated',
        payload: { question_id: q.id, suggestion: existing },
      });
      this.tickets.bump(q.ticket_id);
      return;
    }
    const sug = {
      id: `s_${q.suggestions.length + 1}`,
      participant_id: coordinatorId,
      value: args.value,
      ...(args.rationale !== undefined ? { rationale: args.rationale } : {}),
      at: this.opts.clock.isoNow(),
      author_kind: 'coordinator' as const,
      display_name: 'Coordinator',
    };
    q.suggestions.push(sug);
    this.emit({ type: 'suggestion_added', payload: { question_id: q.id, suggestion: sug } });
    this.tickets.bump(q.ticket_id);
  }

  postComment(args: {
    participant_id: ParticipantId;
    question_id: QuestionId;
    text: string;
  }): void {
    const a = this.requireActive();
    const q = a.open_questions.get(args.question_id); // Phase 6: replaced current_question scalar guard
    if (!q) return;
    if (!a.participants.has(args.participant_id)) return;
    // REL-07 / D-07: total comments per question cap. Throw BEFORE push() +
    // emit() so cap rejections never enter the RingBuffer / transcript.
    const limit = this.opts.maxCommentsPerQuestion ?? 100;
    if (q.comments.length >= limit) {
      throw capError(
        'cap_exceeded:comments',
        limit,
        `comment cap reached for question (${limit} total)`,
      );
    }
    const c = {
      id: `c_${q.comments.length + 1}`,
      participant_id: args.participant_id,
      text: args.text,
      at: this.opts.clock.isoNow(),
    };
    q.comments.push(c);
    this.emit({ type: 'comment_added', payload: { question_id: q.id, comment: c } });
    this.tickets.bump(q.ticket_id);
  }

  /**
   * CHATAI-01: Approved participant asks a clarifying question on a specific open
   * question. Emits `clarification_added` and bumps the ticket so `awaitAnswer`
   * surfaces it in the `clarifications[]` array on the next poll.
   *
   * Silently returns (no-op) if the question is not in 'broadcast' status so
   * that late messages after resolve/cancel are safely discarded.
   *
   * D-07: cap throw is BEFORE push+emit so cap rejections never enter RingBuffer.
   */
  postClarification(args: {
    participant_id: ParticipantId;
    question_id: QuestionId;
    text: string;
  }): void {
    const a = this.requireActive();
    const q = a.open_questions.get(args.question_id);
    if (!q || q.status !== 'broadcast') return;
    if (!a.participants.has(args.participant_id)) return;
    // CHATAI-01 / D-07: cap BEFORE push+emit
    const limit = this.opts.maxClarificationsPerQuestion ?? 50;
    if (q.clarifications.length >= limit) {
      throw capError(
        'cap_exceeded:clarifications',
        limit,
        `clarification cap reached for question (${limit} total)`,
      );
    }
    const cl: Clarification = {
      id: newClarificationId() as string,
      participant_id: args.participant_id,
      text: args.text,
      asked_at: this.opts.clock.isoNow(),
    };
    q.clarifications.push(cl);
    this.emit({ type: 'clarification_added', payload: { question_id: q.id, clarification: cl } });
    this.tickets.bump(q.ticket_id);
  }

  /**
   * CHATAI-01: AI host records an answer to a clarification. Finds the question
   * by `ticket_id` in `open_questions` first, then falls back to `terminalQuestions`
   * (dual-lookup so the AI can answer even after recordAnswer is called on the
   * same question). Sets `answer` + `answered_at` on the clarification and re-emits
   * `clarification_added` so the browser upserts the entry by id.
   *
   * Does NOT call `tickets.bump` — answering a clarification should not prematurely
   * wake a pending `awaitAnswer` poll.
   *
   * Throws if the clarification_id is not found on the question.
   */
  answerClarification(args: {
    ticket_id: string;
    clarification_id: string;
    answer_text: string;
  }): void {
    const a = this.requireActive();
    const qid = a.ticket_to_question.get(args.ticket_id);
    const q =
      (qid !== undefined ? a.open_questions.get(qid) : undefined) ??
      this.terminalQuestions.find((t) => t.ticket_id === args.ticket_id);
    if (!q) throw new Error(`answerClarification: no question for ticket ${args.ticket_id}`);
    const cl = q.clarifications.find((c) => c.id === args.clarification_id);
    if (!cl) {
      throw new Error(
        `answerClarification: clarification ${args.clarification_id} not found on question ${q.id}`,
      );
    }
    cl.answer = args.answer_text;
    cl.answered_at = this.opts.clock.isoNow();
    this.emit({ type: 'clarification_added', payload: { question_id: q.id, clarification: cl } });
    // NOTE: no tickets.bump — answering a clarification must not prematurely wake awaitAnswer
  }

  /**
   * CHAT-01: Post a chat message to the session-level chat. Both the coordinator
   * and approved participants may call this path; actor fields are always
   * server-derived (anti-spoof — the ClientCommand carries only `text`).
   *
   * D-07: cap throw is BEFORE push+emit so cap rejections never enter the
   * RingBuffer or appear in the transcript.
   *
   * Coordinator messages use display_name:'Coordinator' and no actor_id
   * (exactOptionalPropertyTypes: conditional spread omits the key entirely).
   */
  postChat(args: {
    actor_kind: 'participant' | 'coordinator';
    actor_id?: string;
    display_name: string;
    text: string;
  }): void {
    const a = this.requireActive();
    const limit = this.opts.maxChatMessages ?? 1000;
    if (a.chat.length >= limit) {
      throw capError('cap_exceeded:chat', limit, `chat cap reached (${limit} total)`);
    }
    const entry: ChatEntry = {
      id: newChatEntryId() as string,
      actor_kind: args.actor_kind,
      ...(args.actor_id !== undefined ? { actor_id: args.actor_id } : {}),
      display_name: args.display_name,
      text: args.text,
      at: this.opts.clock.isoNow(),
    };
    a.chat.push(entry);
    this.emit({ type: 'chat_added', payload: { entry } });
  }

  /**
   * Record the final answer to the current question and resolve its ticket.
   * Called by the AI host via the MCP `recordAnswer` tool after presenting
   * the team's suggestions/comments to the initiator and getting their pick.
   */
  recordAnswer(args: {
    question_id: QuestionId;
    value: string;
    source: AnswerSource;
  }): void {
    const a = this.requireActive();
    const q = a.open_questions.get(args.question_id); // Phase 6: replaced current_question scalar guard
    if (!q) {
      throw new Error(`record_answer: no open question with id ${args.question_id}`);
    }
    if (q.status !== 'broadcast') {
      throw new Error(`record_answer: question is not broadcast (status=${q.status})`);
    }
    const recorded_at = this.opts.clock.isoNow();
    q.status = 'resolved';
    q.resolution = { value: args.value, source: args.source, recorded_at };
    a.decisions.push({ question: q.text, answer: args.value, question_id: q.id });
    this.tickets.resolve(q.ticket_id, args.value);
    this.terminalQuestions.push(q);
    this.emit({
      type: 'question_resolved',
      payload: { question_id: q.id, resolution: q.resolution },
    });
    a.open_questions.delete(args.question_id); // Phase 6: replaced a.current_question = null
    // WR-01: prune ticket_to_question so stale entries cannot accumulate for the
    // session lifetime. answerClarification falls back to terminalQuestions (by
    // ticket_id scan) when this entry is absent — the dual-lookup does NOT rely
    // on ticket_to_question for terminal questions, so pruning is safe here.
    a.ticket_to_question.delete(q.ticket_id);
    // WR-01: only clear pickingTicketId when the resolved ticket IS the one being
    // picked — a sibling resolve must NOT drop the 'choosing' caption for a concurrent pick.
    if (a.pickingTicketId === q.ticket_id) {
      a.pickingTicketId = null;
    }
    this.setSessionStatus(this.deriveSessionStatus()); // derives fresh status from pickingTicketId
  }

  /**
   * Phase 6 (BATCH-02): renamed from cancelCurrentQuestion; iterates all
   * concurrently open questions and cancels each one. Emits question_cancelled
   * per question, then derives the new session status from the (now empty) map.
   */
  cancelAllOpenQuestions(reason: string): void {
    const a = this.requireActive();
    for (const q of a.open_questions.values()) {
      q.status = 'cancelled';
      this.tickets.cancel(q.ticket_id);
      this.terminalQuestions.push(q);
      this.emit({ type: 'question_cancelled', payload: { question_id: q.id, reason } });
    }
    a.open_questions.clear();
    // WR-01: prune all ticket_to_question entries for now-terminal questions.
    // cancelAllOpenQuestions clears ALL open questions — clear the map entirely
    // so no stale entries can accumulate across the session lifetime.
    a.ticket_to_question.clear();
    a.pickingTicketId = null; // WR-01/WR-03: all questions gone → no pick can be active
    this.setSessionStatus(this.deriveSessionStatus()); // pickingTicketId nulled above → choosing cleared
  }

  /**
   * @deprecated Phase 6: use cancelAllOpenQuestions(). Retained for back-compat
   * with existing call sites until they are migrated.
   */
  cancelCurrentQuestion(reason: string): void {
    this.cancelAllOpenQuestions(reason);
  }

  timeoutCurrentQuestion(): void {
    const a = this.requireActive();
    for (const q of a.open_questions.values()) {
      q.status = 'timeout';
      this.tickets.timeout(q.ticket_id);
      this.terminalQuestions.push(q);
      this.emit({
        type: 'question_cancelled',
        payload: { question_id: q.id, reason: 'timeout' },
      });
    }
    a.open_questions.clear();
    // WR-01: prune all ticket_to_question entries — mirrors cancelAllOpenQuestions.
    a.ticket_to_question.clear();
    a.pickingTicketId = null; // WR-01/WR-03: all questions gone → no pick can be active
    this.setSessionStatus(this.deriveSessionStatus()); // pickingTicketId nulled above → choosing cleared
  }

  /**
   * Block up to `timeout_s` seconds for the question to resolve OR cancel,
   * then return a snapshot of suggestions + comments accumulated so far.
   * The AI host decides what to do with the snapshot — typically presents it
   * to the initiator and then calls `recordAnswer`. The ticket stays pending
   * across timed-out polls, so the caller can poll again.
   *
   * WR-01: ticket_to_question is pruned when a question resolves/cancels/times
   * out, so the fast-path Map lookup will miss a ticket that was already resolved
   * (e.g. the coordinator browser answers faster than the MCP tool polls). The
   * terminalQuestions fallback handles this case — if the ticket is found there,
   * return its snapshot immediately with resolved=true (for 'resolved' status)
   * or resolved=false (for 'cancelled'/'timeout').
   */
  async awaitAnswer(input: AwaitAnswerInput): Promise<AwaitAnswerOutput> {
    const a = this.requireActive();
    const qid = a.ticket_to_question.get(input.ticket_id);
    if (!qid) {
      // WR-01: ticket not in the live map — check terminalQuestions.
      const terminal = this.terminalQuestions.find((q) => q.ticket_id === input.ticket_id);
      if (terminal) {
        return this.snapshot(terminal.id as QuestionId, terminal.status === 'resolved');
      }
      return { suggestions: [], comments: [], clarifications: [], resolved: false };
    }
    const signal = await this.tickets.waitFor(input.ticket_id, input.timeout_s * 1000);
    return this.snapshot(qid, signal === 'resolved');
  }

  /** Return the current discussion snapshot without blocking. */
  snapshot(questionId: QuestionId, resolved: boolean): AwaitAnswerOutput {
    const a = this.requireActive();
    const q =
      a.open_questions.get(questionId) ?? // Phase 6: check open_questions map first
      this.terminalQuestions.find((t) => t.id === questionId);
    if (!q) return { suggestions: [], comments: [], clarifications: [], resolved };
    const nameFor = (pid: ParticipantId): string =>
      a.participants.get(pid)?.display_name ?? 'unknown';
    return {
      suggestions: q.suggestions.map((s) => ({
        // Coordinator-as-planner: a coordinator-authored suggestion has no roster
        // entry — resolve its name from the embedded display_name (so MCP
        // awaitAnswer attributes it as 'Coordinator', not 'unknown').
        participant_name:
          s.author_kind === 'coordinator'
            ? (s.display_name ?? 'Coordinator')
            : nameFor(s.participant_id),
        value: s.value,
        ...(s.rationale !== undefined ? { rationale: s.rationale } : {}),
        at: s.at,
      })),
      comments: q.comments.map((c) => ({
        participant_name: nameFor(c.participant_id),
        text: c.text,
        at: c.at,
      })),
      // CHATAI-01: map Clarification[] → ClarificationEntry[] for the MCP wire shape
      clarifications: q.clarifications.map((cl) => ({
        participant_name: nameFor(cl.participant_id),
        clarification_id: cl.id,
        text: cl.text,
        ...(cl.answer !== undefined ? { answer: cl.answer } : {}),
        asked_at: cl.asked_at,
        ...(cl.answered_at !== undefined ? { answered_at: cl.answered_at } : {}),
      })),
      resolved,
    };
  }

  /** Phase 6 back-compat: returns first open question or null. */
  currentQuestion(): Question | null {
    return [...(this.active?.open_questions.values() ?? [])][0] ?? null;
  }

  /**
   * WR-02: returns true when the given ticket_id maps to a question that has
   * already been resolved/cancelled/timeout — i.e. it is a known ticket in a
   * terminal state. Used by the HTTP coordinator/answer handler to distinguish
   * "double-resolve on a known ticket" (→ 409 already_resolved) from "ticket
   * never existed" (→ 404 ticket_not_found). Throws if no session is active.
   */
  isTerminalTicket(ticketId: string): boolean {
    this.requireActive();
    return this.terminalQuestions.some((q) => q.ticket_id === ticketId);
  }

  approveParticipant(id: ParticipantId): void {
    const a = this.requireActive();
    const p = a.participants.get(id);
    if (!p) throw new Error(`approveParticipant: unknown id ${id}`);
    if (p.status !== 'pending') return; // idempotent
    p.status = 'approved';
    this.emit({
      type: 'participant_status_changed',
      payload: { participant_id: id, status: 'approved' },
    });
  }

  kickParticipant(id: ParticipantId): void {
    const a = this.requireActive();
    const p = a.participants.get(id);
    if (!p) throw new Error(`kickParticipant: unknown id ${id}`);
    if (p.status === 'kicked') return; // idempotent
    p.status = 'kicked';
    this.emit({
      type: 'participant_status_changed',
      payload: { participant_id: id, status: 'kicked' },
    });
  }

  setLocked(locked: boolean): void {
    const a = this.requireActive();
    if (a.locked === locked) return; // idempotent
    a.locked = locked;
    this.emit({ type: 'room_locked', payload: { locked } });
  }

  /**
   * WR-01 / WR-03: set or clear the ticket currently being picked by the
   * coordinator. Called by ws.ts on `picking start/stop` and on coordinator
   * WS disconnect. Derives and applies the new session status immediately.
   *
   * `ticketId` non-null: transition to 'choosing' only if the ticket's question
   * is still open (stale ticket_ids from resolved/cancelled questions are silently
   * ignored). `ticketId` null: clear the picking state, derive new status.
   */
  setPickingTicket(ticketId: string | null): void {
    const a = this.requireActive();
    if (ticketId !== null) {
      // Only enter 'choosing' when the ticket maps to an open question.
      const qid = a.ticket_to_question.get(ticketId);
      if (!qid || !a.open_questions.has(qid)) return; // stale ticket — silent no-op
      a.pickingTicketId = ticketId;
    } else {
      a.pickingTicketId = null;
    }
    this.setSessionStatus(this.deriveSessionStatus());
  }

  /**
   * Phase 6 (BATCH-02): derive the aggregate session status from the current
   * open_questions map.
   *
   * WR-01 / WR-03: `choosing` is now derived from `pickingTicketId` rather than
   * a sticky boolean. The status is 'choosing' only when:
   *  - `pickingTicketId` is non-null AND
   *  - the corresponding question is still open.
   * This means:
   *  - resolving Q2 while Q1 is mid-pick keeps 'choosing' (Q1 still open).
   *  - resolving the picked question drops 'choosing' (open_questions.has fails).
   *  - coordinator disconnect (setPickingTicket(null)) clears the status immediately.
   * Callers that terminate ALL open questions (cancelAllOpenQuestions /
   * timeoutCurrentQuestion) simply null `pickingTicketId` first, so no separate
   * force-clear parameter is needed — the single source of truth is the pair
   * (pickingTicketId, open_questions).
   */
  private deriveSessionStatus(): SessionStatus {
    const a = this.requireActive();
    if (a.session_status === 'done') return 'done'; // terminal — cannot regress
    if (a.pickingTicketId !== null) {
      // 'choosing' only while the picked question is still open.
      const qid = a.ticket_to_question.get(a.pickingTicketId);
      if (qid !== undefined && a.open_questions.has(qid)) return 'choosing';
      // Picked question was resolved/cancelled by another path — fall through.
    }
    if (a.open_questions.size > 0) return 'question_open';
    return 'waiting';
  }

  /**
   * Idempotent session status transition. Emits session_status_changed only
   * when the status actually changes. Called by internal lifecycle methods and
   * by ws.ts (coordinator picking handler) for the 'choosing' transition.
   */
  setSessionStatus(status: SessionStatus): void {
    const a = this.requireActive();
    if (a.session_status === status) return; // idempotent
    a.session_status = status;
    this.emit({ type: 'session_status_changed', payload: { status } });
  }

  /**
   * Fans out frame to all connected WS clients. Does NOT enter the RingBuffer
   * and has no seq — ephemeral only.
   */
  broadcastEphemeral(frame: EphemeralFrame): void {
    this.broadcaster(frame);
  }

  sessionView(): SessionView {
    const a = this.requireActive();
    const questions = [...a.open_questions.values()]; // Phase 6: spread Map to array in insertion order
    return {
      session_id: a.id,
      brief: a.brief,
      participants: [...a.participants.values()],
      decisions: a.decisions,
      questions, // Phase 6 (BATCH-02): all currently-open questions
      current_question: questions[0] ?? null, // Phase 6: derived back-compat field
      locked: a.locked,
      session_status: a.session_status,
      chat: a.chat, // CHATAI-01 / CHAT-01: durable session-level chat (seeded in welcome)
    };
  }

  replay(lastSeq: number): ServerEvent[] {
    return this.events.since(lastSeq, (e) => e.seq);
  }

  oldestReplaySeq(): number | null {
    return this.events.oldestSeq((e) => e.seq);
  }

  emitExternal(e: Omit<ServerEvent, 'seq' | 'ts'>): void {
    this.emit(e);
  }

  stop(
    reason: 'stop_session' | 'signal' | 'crash' | 'ai_host_disconnected',
  ): { ok: true; transcript_path: string } {
    const a = this.requireActive();
    const ended_at = this.opts.clock.isoNow();
    if (a.open_questions.size > 0) this.cancelAllOpenQuestions(`session_ended:${reason}`);
    this.setSessionStatus('done');
    this.emit({ type: 'session_ended', payload: { reason } });

    const transcript: Transcript = {
      schema_version: 2,
      session_id: a.id,
      brief: a.brief,
      started_at: a.started_at,
      ended_at,
      ended_reason: reason,
      participants: [...a.participants.values()].map((p) => ({
        id: p.id,
        display_name: p.display_name,
        joined_at: p.joined_at,
      })),
      events: this.events.toArray().map((e) => ({
        seq: e.seq,
        ts: e.ts,
        type: e.type,
        payload: e.payload,
      })),
      questions: this.terminalQuestions.map((q) => ({
        id: q.id,
        ticket_id: q.ticket_id,
        asked_at: q.asked_at,
        text: q.text,
        ...(q.options !== undefined ? { options: q.options } : {}),
        ...(q.recommendation !== undefined ? { recommendation: q.recommendation } : {}),
        status: q.status as 'resolved' | 'cancelled' | 'timeout',
        suggestions: q.suggestions,
        comments: q.comments,
        clarifications: q.clarifications, // CHATAI-01: include in transcript
        resolution: q.resolution,
      })),
      chat: a.chat, // CHAT-01: durable session-level chat list
    };
    const path = writeTranscript(transcript, this.opts.transcriptDir);
    this.active = null;
    this.events = new RingBuffer<ServerEvent>(500);
    this.nextSeq = 0;
    this.terminalQuestions = [];
    this.tickets = new TicketStore(this.opts.clock);
    return { ok: true, transcript_path: path };
  }

  private emit(e: Omit<ServerEvent, 'seq' | 'ts'>): void {
    const evt = {
      seq: this.nextSeq++,
      ts: this.opts.clock.isoNow(),
      ...e,
    } as ServerEvent;
    this.events.push(evt);
    this.broadcaster(evt);
  }

  private requireActive(): ActiveSession {
    if (!this.active) throw new Error('no active session');
    return this.active;
  }
}
