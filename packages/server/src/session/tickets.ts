import { newTicketId, type TicketId } from '@shared-brainstorm/shared';
import type { Clock } from './clock.js';

export type TicketSignal = 'resolved' | 'cancelled' | 'timeout' | 'activity';

export interface Ticket {
  id: TicketId;
  status: 'pending' | 'resolved' | 'cancelled' | 'timeout';
  value?: string;
  created_at: string;
  resolved_at?: string;
}

type Waiter = (signal: TicketSignal) => void;

/**
 * TicketStore is a thin coordination primitive: a ticket exists per in-flight
 * `askGroup` call, and `waitFor` blocks until the ticket reaches a terminal
 * state (resolved / cancelled / timeout) or its timeout fires. It is
 * deliberately unaware of wire-level snapshot shapes — the SessionManager
 * builds those by reading `current_question` after `waitFor` returns.
 */
export class TicketStore {
  private tickets = new Map<TicketId, Ticket>();
  private waiters = new Map<TicketId, Set<Waiter>>();

  constructor(private clock: Clock) {}

  hasOpen(): boolean {
    for (const t of this.tickets.values()) if (t.status === 'pending') return true;
    return false;
  }

  create(): Ticket {
    if (this.hasOpen()) {
      const e = new Error('BUSY: a question is already in flight');
      (e as Error & { code: string }).code = 'BUSY';
      throw e;
    }
    const t: Ticket = {
      id: newTicketId(),
      status: 'pending',
      created_at: this.clock.isoNow(),
    };
    this.tickets.set(t.id, t);
    return t;
  }

  get(id: TicketId | string): Ticket | undefined {
    return this.tickets.get(id as TicketId);
  }

  resolve(id: TicketId | string, value: string): boolean {
    const t = this.tickets.get(id as TicketId);
    if (!t || t.status !== 'pending') return false;
    t.status = 'resolved';
    t.value = value;
    t.resolved_at = this.clock.isoNow();
    this.notify(t.id, 'resolved');
    return true;
  }

  cancel(id: TicketId | string): boolean {
    const t = this.tickets.get(id as TicketId);
    if (!t || t.status !== 'pending') return false;
    t.status = 'cancelled';
    t.resolved_at = this.clock.isoNow();
    this.notify(t.id, 'cancelled');
    return true;
  }

  timeout(id: TicketId | string): boolean {
    const t = this.tickets.get(id as TicketId);
    if (!t || t.status !== 'pending') return false;
    t.status = 'timeout';
    t.resolved_at = this.clock.isoNow();
    this.notify(t.id, 'timeout');
    return true;
  }

  /**
   * Wake long-pollers without changing the ticket's status. Used when the
   * question gets a new suggestion/comment so the AI host can long-poll and
   * react fast instead of waiting out the full timeout window.
   */
  bump(id: TicketId | string): boolean {
    const t = this.tickets.get(id as TicketId);
    if (!t || t.status !== 'pending') return false;
    this.notify(t.id, 'activity');
    return true;
  }

  /**
   * Resolves when the ticket reaches a terminal state OR when `timeoutMs`
   * elapses. The caller decides what wire-level data to surface — this only
   * reports which condition fired.
   *
   * Note: `awaitAnswer` no longer auto-times-out the ticket on a slow round —
   * timing out means "the AI host's poll window expired", not "the question
   * is dead". The ticket stays pending across multiple polls.
   */
  waitFor(id: TicketId | string, timeoutMs: number): Promise<TicketSignal> {
    const tid = id as TicketId;
    const t = this.tickets.get(tid);
    if (!t) return Promise.resolve('cancelled');
    if (t.status === 'resolved') return Promise.resolve('resolved');
    if (t.status === 'cancelled') return Promise.resolve('cancelled');
    if (t.status === 'timeout') return Promise.resolve('timeout');

    return new Promise<TicketSignal>((resolve) => {
      const set = this.waiters.get(tid) ?? new Set<Waiter>();
      let settled = false;
      const settle = (signal: TicketSignal): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        set.delete(waiter);
        if (set.size === 0) this.waiters.delete(tid);
        resolve(signal);
      };
      const waiter: Waiter = (signal) => settle(signal);
      const timer = setTimeout(() => settle('timeout'), timeoutMs);
      set.add(waiter);
      this.waiters.set(tid, set);
    });
  }

  private notify(id: TicketId, signal: TicketSignal): void {
    const set = this.waiters.get(id);
    if (!set) return;
    for (const w of set) w(signal);
    set.clear();
    this.waiters.delete(id);
  }
}
