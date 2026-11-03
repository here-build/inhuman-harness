/** A tool requests follow-up work; the round runtime arbitrates requests and gates. */
export type ToolContinuation =
  { readonly kind: "observation" } | { readonly kind: "auxiliary"; readonly note?: string } | { readonly kind: "none" };
