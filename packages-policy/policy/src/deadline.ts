/** Judge budget shared by the adapters. Crush's hook self-bounds at the same 20 s. */
export const JUDGE_DEADLINE_MS = 20_000;

/** Reject when `work` has not settled in `ms`; the caller maps a rejection to deny. */
export async function withDeadline<T>(work: Promise<T>, ms: number = JUDGE_DEADLINE_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("authorization timed out")), ms);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
