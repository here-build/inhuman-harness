/**
 * F1 first-frame gate. `offer` always enqueues (ready or not). `deliver`
 * is empty until `markReady` — never hand keys to a worker that has not
 * published its first frame. After ready is still queue-then-deliver, not
 * pass-through: this type only decides what is deliverable, never sends.
 */

export interface KeyBuffer<T> {
  readonly ready: boolean;
  readonly held: readonly T[];
}

/** Fresh queue per call — shared `held` would leak across boots. */
export function emptyQueue<T>(): KeyBuffer<T> {
  return { ready: false, held: [] };
}

export function offer<T>(queue: KeyBuffer<T>, events: readonly T[]): KeyBuffer<T> {
  if (events.length === 0) return queue;
  return { ...queue, held: [...queue.held, ...events] };
}

export function markReady<T>(queue: KeyBuffer<T>): KeyBuffer<T> {
  return queue.ready ? queue : { ...queue, ready: true };
}

export function deliver<T>(queue: KeyBuffer<T>): { readonly queue: KeyBuffer<T>; readonly events: readonly T[] } {
  if (!queue.ready || queue.held.length === 0) return { queue, events: [] };
  return { queue: { ...queue, held: [] }, events: queue.held };
}
