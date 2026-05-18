/**
 * Fixed-capacity ring buffer. Caller is responsible for gap detection
 * (compare returned events' first seq against caller's last_seq + 1).
 */
export class RingBuffer<T> {
  private buf: T[] = [];

  constructor(public readonly capacity: number) {
    if (capacity <= 0) throw new Error('capacity must be positive');
  }

  push(item: T): void {
    this.buf.push(item);
    if (this.buf.length > this.capacity) this.buf.shift();
  }

  toArray(): T[] {
    return [...this.buf];
  }

  since(lastSeq: number, getSeq: (item: T) => number): T[] {
    return this.buf.filter((item) => getSeq(item) > lastSeq);
  }

  oldestSeq(getSeq: (item: T) => number): number | null {
    return this.buf.length === 0 ? null : getSeq(this.buf[0]!);
  }
}
