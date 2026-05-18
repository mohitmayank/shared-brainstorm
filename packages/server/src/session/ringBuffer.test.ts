import { describe, expect, it } from 'vitest';
import { RingBuffer } from './ringBuffer.js';

describe('RingBuffer', () => {
  it('stores up to capacity then drops oldest', () => {
    const rb = new RingBuffer<number>(3);
    rb.push(1);
    rb.push(2);
    rb.push(3);
    rb.push(4);
    expect(rb.toArray()).toEqual([2, 3, 4]);
  });

  it('replays since seq returns events with seq > given', () => {
    const rb = new RingBuffer<{ seq: number; v: string }>(10);
    rb.push({ seq: 0, v: 'a' });
    rb.push({ seq: 1, v: 'b' });
    rb.push({ seq: 2, v: 'c' });
    expect(rb.since(0, (e) => e.seq)).toEqual([
      { seq: 1, v: 'b' },
      { seq: 2, v: 'c' },
    ]);
    expect(rb.since(2, (e) => e.seq)).toEqual([]);
  });

  it('returns full buffer when last_seq is below all stored seqs (gap detection)', () => {
    const rb = new RingBuffer<{ seq: number }>(2);
    rb.push({ seq: 0 });
    rb.push({ seq: 1 });
    rb.push({ seq: 2 }); // evicts seq 0
    rb.push({ seq: 3 }); // evicts seq 1
    // client claims last_seq=0 but oldest in buffer is seq 2 -> gap
    const result = rb.since(0, (e) => e.seq);
    expect(result).toEqual([{ seq: 2 }, { seq: 3 }]);
    // gap detection is the caller's job; document this contract in implementation
  });

  it('throws on non-positive capacity', () => {
    expect(() => new RingBuffer<number>(0)).toThrow(/capacity/);
    expect(() => new RingBuffer<number>(-1)).toThrow(/capacity/);
  });

  it('oldestSeq returns null on empty, first seq otherwise', () => {
    const rb = new RingBuffer<{ seq: number }>(3);
    expect(rb.oldestSeq((e) => e.seq)).toBeNull();
    rb.push({ seq: 5 });
    rb.push({ seq: 6 });
    expect(rb.oldestSeq((e) => e.seq)).toBe(5);
    rb.push({ seq: 7 });
    rb.push({ seq: 8 });
    expect(rb.oldestSeq((e) => e.seq)).toBe(6);
  });
});
