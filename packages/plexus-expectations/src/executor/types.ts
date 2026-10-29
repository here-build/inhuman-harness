export type Settlement<TResult> =
  | { readonly outcome: "complete"; readonly result: TResult }
  | { readonly outcome: "fail"; readonly reason: unknown };
