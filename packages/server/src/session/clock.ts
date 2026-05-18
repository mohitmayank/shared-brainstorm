export interface Clock {
  now(): Date;
  isoNow(): string;
}

export const realClock: Clock = {
  now: () => new Date(),
  isoNow: () => new Date().toISOString(),
};

export function fixedClock(start: string): Clock & { advance(ms: number): void } {
  let t = new Date(start).getTime();
  return {
    now: () => new Date(t),
    isoNow: () => new Date(t).toISOString(),
    advance: (ms) => {
      t += ms;
    },
  };
}
