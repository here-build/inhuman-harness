export type Reading = {
  readonly tokens: readonly string[];
  readonly flags: Readonly<Record<string, readonly string[]>>;
};

export type Question = {
  readonly argv0: string;
  readonly readings: readonly Reading[];
  readonly overflow?: true;
};
