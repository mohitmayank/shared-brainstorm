import type { ParticipantId, QuestionId, TicketId, SessionId } from './ids.js';

export interface Participant {
  id: ParticipantId;
  display_name: string;
  joined_at: string; // ISO
  status: 'pending' | 'approved' | 'kicked';
}

export interface Suggestion {
  id: string;
  participant_id: ParticipantId;
  value: string;
  rationale?: string;
  at: string;
}

export interface Comment {
  id: string;
  participant_id: ParticipantId;
  text: string;
  at: string;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export type AnswerSource = 'suggestion' | 'synthesis' | 'override';

export interface Question {
  id: QuestionId;
  ticket_id: TicketId;
  asked_at: string;
  text: string;
  options?: QuestionOption[];
  recommendation?: string;
  status: 'broadcast' | 'resolved' | 'cancelled' | 'timeout';
  suggestions: Suggestion[];
  comments: Comment[];
  resolution: { value: string; source: AnswerSource; recorded_at: string } | null;
}

export type SessionStatus = 'waiting' | 'question_open' | 'choosing' | 'done';

export interface SessionView {
  session_id: SessionId;
  brief: string;
  participants: Participant[];
  decisions: { question: string; answer: string; question_id: QuestionId }[];
  // Phase 6 (BATCH-02): all currently-open questions in askGroup submission order.
  questions: Question[];
  current_question: Question | null; // derived back-compat = questions[0] ?? null
  locked: boolean;
  session_status: SessionStatus;
}
