import { describe, expect, it } from 'vitest';
import { TicketStore } from './tickets.js';
import { fixedClock } from './clock.js';

describe('TicketStore', () => {
  it('creates a pending ticket', () => {
    const ts = new TicketStore(fixedClock('2026-01-01T00:00:00Z'));
    const t = ts.create();
    expect(t.status).toBe('pending');
    expect(ts.get(t.id)?.status).toBe('pending');
  });

  it('resolve() transitions a pending ticket and notifies waiters', async () => {
    const ts = new TicketStore(fixedClock('2026-01-01T00:00:00Z'));
    const t = ts.create();
    const waitP = ts.waitFor(t.id, 5000);
    ts.resolve(t.id, 'Postgres');
    expect(await waitP).toBe('resolved');
    expect(ts.get(t.id)?.value).toBe('Postgres');
  });

  it('resolve() on already-resolved is a no-op', () => {
    const ts = new TicketStore(fixedClock('2026-01-01T00:00:00Z'));
    const t = ts.create();
    ts.resolve(t.id, 'a');
    expect(ts.resolve(t.id, 'b')).toBe(false);
    expect(ts.get(t.id)?.value).toBe('a');
  });

  it('cancel() resolves with cancelled signal', async () => {
    const ts = new TicketStore(fixedClock('2026-01-01T00:00:00Z'));
    const t = ts.create();
    const waitP = ts.waitFor(t.id, 5000);
    ts.cancel(t.id);
    expect(await waitP).toBe('cancelled');
  });

  it('waitFor() returns timeout signal if not resolved within window', async () => {
    const ts = new TicketStore(fixedClock('2026-01-01T00:00:00Z'));
    const t = ts.create();
    const r = await ts.waitFor(t.id, 10);
    expect(r).toBe('timeout');
    // ticket itself stays pending — the timeout was just for this caller
    expect(ts.get(t.id)?.status).toBe('pending');
    expect(ts.hasOpen()).toBe(true);
  });

  it('waitFor() returns immediately if already resolved', async () => {
    const ts = new TicketStore(fixedClock('2026-01-01T00:00:00Z'));
    const t = ts.create();
    ts.resolve(t.id, 'x');
    expect(await ts.waitFor(t.id, 5000)).toBe('resolved');
  });

  it('hasOpen() returns true while a ticket is pending', () => {
    const ts = new TicketStore(fixedClock('2026-01-01T00:00:00Z'));
    expect(ts.hasOpen()).toBe(false);
    const t = ts.create();
    expect(ts.hasOpen()).toBe(true);
    ts.resolve(t.id, 'x');
    expect(ts.hasOpen()).toBe(false);
  });

  it('create() throws if a ticket is already open (BUSY) [LEGACY — superseded by Phase 6]', () => {
    // NOTE: Phase 6 (BATCH-02) removes this gate. Test updated below.
    // Keeping as a comment marker so git history is traceable.
  });

  // Phase 6 (BATCH-02): N concurrent pending tickets allowed
  describe('Phase 6: N concurrent pending tickets', () => {
    it('create() called twice in same session does NOT throw; both tickets have status pending', () => {
      const ts = new TicketStore(fixedClock('2026-01-01T00:00:00Z'));
      const t1 = ts.create();
      const t2 = ts.create(); // should NOT throw after gate removal
      expect(t1.status).toBe('pending');
      expect(t2.status).toBe('pending');
      expect(t1.id).not.toBe(t2.id);
    });

    it('hasOpen() returns true with 2 pending tickets', () => {
      const ts = new TicketStore(fixedClock('2026-01-01T00:00:00Z'));
      ts.create();
      ts.create();
      expect(ts.hasOpen()).toBe(true);
    });

    it('hasOpen() returns false after all tickets are resolved', () => {
      const ts = new TicketStore(fixedClock('2026-01-01T00:00:00Z'));
      const t1 = ts.create();
      const t2 = ts.create();
      ts.resolve(t1.id, 'a');
      expect(ts.hasOpen()).toBe(true); // t2 still pending
      ts.resolve(t2.id, 'b');
      expect(ts.hasOpen()).toBe(false);
    });
  });

  it('waitFor on unknown ticket id resolves to cancelled', async () => {
    const ts = new TicketStore(fixedClock('2026-01-01T00:00:00Z'));
    expect(await ts.waitFor('sb_t_nonexistent', 5000)).toBe('cancelled');
  });

  it('cancel() on already-resolved is a no-op (returns false)', () => {
    const ts = new TicketStore(fixedClock('2026-01-01T00:00:00Z'));
    const t = ts.create();
    ts.resolve(t.id, 'x');
    expect(ts.cancel(t.id)).toBe(false);
  });

  it('timeout() marks ticket as timed out and clears hasOpen', () => {
    const ts = new TicketStore(fixedClock('2026-01-01T00:00:00Z'));
    const t = ts.create();
    expect(ts.hasOpen()).toBe(true);
    expect(ts.timeout(t.id)).toBe(true);
    expect(ts.get(t.id)?.status).toBe('timeout');
    expect(ts.hasOpen()).toBe(false);
  });

  it('timeout() on already-resolved ticket returns false', () => {
    const ts = new TicketStore(fixedClock('2026-01-01T00:00:00Z'));
    const t = ts.create();
    ts.resolve(t.id, 'x');
    expect(ts.timeout(t.id)).toBe(false);
  });

  it('timeout() notifies waiters with timeout signal', async () => {
    const ts = new TicketStore(fixedClock('2026-01-01T00:00:00Z'));
    const t = ts.create();
    const waitP = ts.waitFor(t.id, 60_000);
    ts.timeout(t.id);
    expect(await waitP).toBe('timeout');
  });

  it('multiple concurrent waiters all settle on resolve()', async () => {
    const ts = new TicketStore(fixedClock('2026-01-01T00:00:00Z'));
    const t = ts.create();
    const w1 = ts.waitFor(t.id, 60_000);
    const w2 = ts.waitFor(t.id, 60_000);
    ts.resolve(t.id, 'x');
    expect(await w1).toBe('resolved');
    expect(await w2).toBe('resolved');
  });

  it('bump() wakes waiters with activity signal but keeps ticket pending', async () => {
    const ts = new TicketStore(fixedClock('2026-01-01T00:00:00Z'));
    const t = ts.create();
    const waitP = ts.waitFor(t.id, 60_000);
    ts.bump(t.id);
    expect(await waitP).toBe('activity');
    // Ticket is still pending after a bump — it's a wakeup, not a state change.
    expect(ts.get(t.id)?.status).toBe('pending');
    expect(ts.hasOpen()).toBe(true);
  });

  it('bump() with no waiters is a no-op (returns true while ticket is pending)', () => {
    const ts = new TicketStore(fixedClock('2026-01-01T00:00:00Z'));
    const t = ts.create();
    expect(ts.bump(t.id)).toBe(true);
    expect(ts.get(t.id)?.status).toBe('pending');
  });

  it('bump() on resolved ticket returns false', () => {
    const ts = new TicketStore(fixedClock('2026-01-01T00:00:00Z'));
    const t = ts.create();
    ts.resolve(t.id, 'x');
    expect(ts.bump(t.id)).toBe(false);
  });
});
