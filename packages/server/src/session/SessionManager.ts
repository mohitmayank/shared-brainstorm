import {
  newJoinCode,
  newParticipantId,
  newQuestionId,
  newSessionId,
  type ParticipantId,
  type QuestionId,
  type SessionId,
  type AskGroupInput,
  type AwaitAnswerInput,
  type AwaitAnswerOutput,
  type AnswerSource,
  type ServerEvent,
  type Participant,
  type Question,
  type SessionView,
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
   */
  broadcast?: (event: ServerEvent) => void;
  transcriptDir: string;
  /** REL-07 / D-05: max participants per session. Default 50. */
  maxParticipants?: number;
  /** REL-07 / D-05: max suggestions per participant per question. Default 5. */
  maxSuggestionsPerParticipantPerQuestion?: number;
  /** REL-07 / D-05: max comments per question (total across participants). Default 100. */
  maxCommentsPerQuestion?: number;
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
  join_code: string;
  participants: Map<ParticipantId, Participant>;
  decisions: { question: string; answer: string; question_id: QuestionId }[];
  current_question: Question | null;
  ticket_to_question: Map<string, QuestionId>;
}

export class SessionManager {
  private active: ActiveSession | null = null;
  private tickets: TicketStore;
  private events = new RingBuffer<ServerEvent>(500);
  private nextSeq = 0;
  private broadcaster: (event: ServerEvent) => void;
  private terminalQuestions: Question[] = [];

  constructor(private opts: SessionManagerOpts) {
    this.broadcaster = opts.broadcast ?? ((): void => {});
    this.tickets = new TicketStore(opts.clock);
  }

  setBroadcaster(fn: (event: ServerEvent) => void): void {
    this.broadcaster = fn;
  }

  isActive(): boolean {
    return this.active !== null;
  }

  start({ brief }: { brief: string }): { session_id: SessionId; join_code: string } {
    if (this.active) throw new Error('a session is already active');
    const session_id = newSessionId();
    this.active = {
      id: session_id,
      brief,
      started_at: this.opts.clock.isoNow(),
      join_code: newJoinCode(),
      participants: new Map(),
      decisions: [],
      current_question: null,
      ticket_to_question: new Map(),
    };
    return {
      session_id,
      join_code: this.active.join_code,
    };
  }

  joinCode(): string {
    return this.requireActive().join_code;
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
      resolution: null,
    };
    a.current_question = q;
    a.ticket_to_question.set(ticket.id, q.id);
    this.emit({ type: 'question_broadcast', payload: { question: q } });
    return { ticket_id: ticket.id };
  }

  postSuggestion(args: {
    participant_id: ParticipantId;
    question_id: QuestionId;
    value: string;
    rationale?: string;
  }): void {
    const a = this.requireActive();
    const q = a.current_question;
    if (!q || q.id !== args.question_id || q.status !== 'broadcast') return;
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

  postComment(args: {
    participant_id: ParticipantId;
    question_id: QuestionId;
    text: string;
  }): void {
    const a = this.requireActive();
    const q = a.current_question;
    if (!q || q.id !== args.question_id) return;
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
    const q = a.current_question;
    if (!q || q.id !== args.question_id) {
      throw new Error('record_answer: no matching current question');
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
    a.current_question = null;
  }

  cancelCurrentQuestion(reason: string): void {
    const a = this.requireActive();
    const q = a.current_question;
    if (!q) return;
    q.status = 'cancelled';
    this.tickets.cancel(q.ticket_id);
    this.terminalQuestions.push(q);
    this.emit({ type: 'question_cancelled', payload: { question_id: q.id, reason } });
    a.current_question = null;
  }

  timeoutCurrentQuestion(): void {
    const a = this.requireActive();
    const q = a.current_question;
    if (!q) return;
    q.status = 'timeout';
    this.tickets.timeout(q.ticket_id);
    this.terminalQuestions.push(q);
    this.emit({
      type: 'question_cancelled',
      payload: { question_id: q.id, reason: 'timeout' },
    });
    a.current_question = null;
  }

  /**
   * Block up to `timeout_s` seconds for the question to resolve OR cancel,
   * then return a snapshot of suggestions + comments accumulated so far.
   * The AI host decides what to do with the snapshot — typically presents it
   * to the initiator and then calls `recordAnswer`. The ticket stays pending
   * across timed-out polls, so the caller can poll again.
   */
  async awaitAnswer(input: AwaitAnswerInput): Promise<AwaitAnswerOutput> {
    const a = this.requireActive();
    const qid = a.ticket_to_question.get(input.ticket_id);
    if (!qid) {
      return { suggestions: [], comments: [], resolved: false };
    }
    const signal = await this.tickets.waitFor(input.ticket_id, input.timeout_s * 1000);
    return this.snapshot(qid, signal === 'resolved');
  }

  /** Return the current discussion snapshot without blocking. */
  snapshot(questionId: QuestionId, resolved: boolean): AwaitAnswerOutput {
    const a = this.requireActive();
    const q =
      a.current_question?.id === questionId
        ? a.current_question
        : this.terminalQuestions.find((t) => t.id === questionId);
    if (!q) return { suggestions: [], comments: [], resolved };
    const nameFor = (pid: ParticipantId): string =>
      a.participants.get(pid)?.display_name ?? 'unknown';
    return {
      suggestions: q.suggestions.map((s) => ({
        participant_name: nameFor(s.participant_id),
        value: s.value,
        ...(s.rationale !== undefined ? { rationale: s.rationale } : {}),
        at: s.at,
      })),
      comments: q.comments.map((c) => ({
        participant_name: nameFor(c.participant_id),
        text: c.text,
        at: c.at,
      })),
      resolved,
    };
  }

  currentQuestion(): Question | null {
    return this.active?.current_question ?? null;
  }

  sessionView(): SessionView {
    const a = this.requireActive();
    return {
      session_id: a.id,
      brief: a.brief,
      participants: [...a.participants.values()],
      decisions: a.decisions,
      current_question: a.current_question,
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
    if (a.current_question) this.cancelCurrentQuestion(`session_ended:${reason}`);
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
        resolution: q.resolution,
      })),
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
