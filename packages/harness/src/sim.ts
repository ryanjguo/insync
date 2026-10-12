/** A pending callback on the simulated timeline. */
export interface Timer {
  at: number;
  seq: number;
  fn: () => void;
  cancelled: boolean;
}

/**
 * Discrete-event clock. Nothing waits in real time: callbacks run in time
 * order (ties in the order they were scheduled), so ten simulated minutes take
 * well under a second and every run with the same seed is identical.
 */
export class Sim {
  /** Simulated milliseconds since the start of the run. */
  now = 0;
  private seq = 0;
  private readonly heap: Timer[] = [];

  /** Run `fn` at simulated time `at` (never earlier than now). */
  at(at: number, fn: () => void): Timer {
    const t: Timer = {
      at: Math.max(at, this.now),
      seq: this.seq++,
      fn,
      cancelled: false,
    };
    this.push(t);
    return t;
  }

  /** Run `fn` after `ms` simulated milliseconds. */
  after(ms: number, fn: () => void): Timer {
    return this.at(this.now + ms, fn);
  }

  /** Run `fn` every `ms`, starting `ms` from now. */
  every(ms: number, fn: () => void): Timer {
    const handle: Timer = { at: 0, seq: -1, fn, cancelled: false };
    const tick = () => {
      if (handle.cancelled) return;
      fn();
      this.after(ms, tick);
    };
    this.after(ms, tick);
    return handle;
  }

  cancel(t: Timer): void {
    t.cancelled = true;
  }

  /** Run every callback due up to and including `end`, then set the clock to `end`. */
  runUntil(end: number): void {
    while (this.heap.length > 0 && this.heap[0]!.at <= end) {
      const t = this.pop();
      this.now = t.at;
      if (!t.cancelled) t.fn();
    }
    this.now = end;
  }

  private less(a: Timer, b: Timer): boolean {
    return a.at < b.at || (a.at === b.at && a.seq < b.seq);
  }

  private push(t: Timer): void {
    const h = this.heap;
    h.push(t);
    let i = h.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(h[i]!, h[parent]!)) break;
      [h[i], h[parent]] = [h[parent]!, h[i]!];
      i = parent;
    }
  }

  private pop(): Timer {
    const h = this.heap;
    const top = h[0]!;
    const last = h.pop()!;
    if (h.length > 0) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && this.less(h[l]!, h[m]!)) m = l;
        if (r < h.length && this.less(h[r]!, h[m]!)) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m]!, h[i]!];
        i = m;
      }
    }
    return top;
  }
}

/** Seeded random numbers in [0, 1) (mulberry32), so runs are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
