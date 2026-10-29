/**
 * What a shell takes from its host: the process streams, plus the working
 * directory when the caller is not the process (tests, embedders).
 */
export type Streams = {
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: NodeJS.WriteStream;
  readonly stderr: NodeJS.WriteStream;
  readonly cwd?: string;
};

/** `Streams` plus the one-line error sink a shell reports through. Carries no command-parser types. */
export type ShellStreams = Streams & { readonly writeErr: (error: unknown) => void };
