/**
 * `inhuman blobs vacuum`: move a stored session's large text into the kernel's blob bucket.
 *
 * A session written before large bodies left the document keeps a file's prior text and an isolated
 * completion's prompt in its stored image, and the daemon never rewrites an image to convert it. This attaches
 * to the stored session the way a restore does and asks the daemon to do it, then prints what moved and how much
 * the stored image shrank.
 */
import { ensure } from "@inhuman.tools/harness";
import { Client, RestoreNotFound } from "@inhuman.tools/harness-sdk";
import { Command, Option } from "clipanion";

import { KernelCommand, type ShellContext } from "./context.js";

export class BlobsCommand extends KernelCommand {
  static paths = [["blobs"]];
  static usage = Command.Usage({
    category: "Blobs",
    description: "manage the large text stored beside session documents",
  });

  async execute(): Promise<number> {
    const blocked = this.rejectUnsupportedAgentFlags("inhuman blobs");
    if (blocked !== undefined) return blocked;
    this.context.stderr.write("Specify a blobs command: vacuum\n");
    return 2;
  }
}

export class BlobsVacuumCommand extends KernelCommand {
  static paths = [["blobs", "vacuum"]];
  static usage = Command.Usage({
    category: "Blobs",
    description: "move a stored session's large text into the blob bucket",
    details: `
      A session written before large bodies left the document carries them in its stored image: a file's prior
      text, and the prompt of every summarizer it ran. This moves every such body over the inline limit into the
      blob bucket under the kernel folder, leaves a short head and a reference in its place, and rewrites the
      stored image as one snapshot. Nothing is lost: the wire and the shells read the references.

      A completion that is still running is skipped. Run it with --dry-run first to see what would move.
    `,
    examples: [
      ["Count what would move", "$0 blobs vacuum --session <id> --dry-run"],
      ["Vacuum one session", "$0 blobs vacuum --session <id>"],
    ],
  });

  session = Option.String("--session", { description: "session id", required: true });
  dryRun = Option.Boolean("--dry-run", false, { description: "count what would move; write nothing" });

  async execute(): Promise<number> {
    const blocked = this.rejectUnsupportedAgentFlags("inhuman blobs vacuum");
    if (blocked !== undefined) return blocked;
    const { code } = await runBlobsVacuum(
      { kernel: this.kernelPath(), session: this.session, dryRun: this.dryRun },
      this.context,
    );
    return code;
  }
}

export type BlobsVacuumArgv = {
  readonly kernel: string;
  readonly session: string;
  readonly dryRun: boolean;
};

/** The one thing the vacuum asks of a restored session. */
export type SessionRpc = {
  request(method: string, params?: unknown): Promise<unknown>;
  [Symbol.asyncDispose](): Promise<void>;
};

export type BlobsDeps = {
  /** Attach to a stored session. Defaults to ensuring the daemon, then `Client.restore`. */
  readonly open?: (kernel: string, session: string, phase: (label: string) => void) => Promise<SessionRpc>;
};

/** What `blob/vacuum` answers, as far as the printout reads it. */
type VacuumReply = {
  readonly dryRun: boolean;
  readonly fileMutates: number;
  readonly promptMessages: number;
  readonly promptTexts: number;
  readonly bytesMoved: number;
  readonly imageBytesBefore: number;
  readonly imageBytesAfter: number;
};

export async function runBlobsVacuum(
  args: BlobsVacuumArgv,
  streams: ShellContext,
  deps: BlobsDeps = {},
): Promise<{ code: number }> {
  const session = args.session.trim();
  if (session === "") {
    streams.writeErr("--session is required");
    return { code: 2 };
  }
  const open = deps.open ?? openRestored;
  try {
    await using rpc = await open(args.kernel, session, (label) => streams.stderr.write(`${label}\n`));
    const reply = vacuumReply(await rpc.request("blob/vacuum", { dryRun: args.dryRun }));
    streams.stdout.write(`${render(session, reply)}\n`);
    return { code: 0 };
  } catch (error) {
    streams.writeErr(error instanceof RestoreNotFound ? `session not found: ${session}` : error);
    return { code: 1 };
  }
}

async function openRestored(kernel: string, session: string, phase: (label: string) => void): Promise<SessionRpc> {
  await ensure(kernel);
  return await Client.restore(kernel, session, phase);
}

function vacuumReply(value: unknown): VacuumReply {
  if (typeof value !== "object" || value === null) throw new Error("blob/vacuum answered nothing");
  const record = value as Record<string, unknown>;
  const count = (key: keyof VacuumReply): number => {
    const found = record[key];
    if (typeof found !== "number" || !Number.isFinite(found)) throw new Error(`blob/vacuum: ${key} is missing`);
    return found;
  };
  return {
    dryRun: record.dryRun === true,
    fileMutates: count("fileMutates"),
    promptMessages: count("promptMessages"),
    promptTexts: count("promptTexts"),
    bytesMoved: count("bytesMoved"),
    imageBytesBefore: count("imageBytesBefore"),
    imageBytesAfter: count("imageBytesAfter"),
  };
}

const grouped = (value: number): string => value.toLocaleString("en-US");

function megabytes(value: number): string {
  return `${(value / 1_000_000).toFixed(1)} MB`;
}

function render(session: string, reply: VacuumReply): string {
  const rows: Array<[label: string, value: string]> = [
    ["file prior texts", grouped(reply.fileMutates)],
    ["prompt messages", grouped(reply.promptMessages)],
    ["prompt lines", grouped(reply.promptTexts)],
    [reply.dryRun ? "would move" : "moved", `${megabytes(reply.bytesMoved)} (${grouped(reply.bytesMoved)} bytes)`],
    reply.dryRun
      ? ["stored image", `${megabytes(reply.imageBytesBefore)} (${grouped(reply.imageBytesBefore)} bytes), unchanged`]
      : [
          "stored image",
          `${megabytes(reply.imageBytesBefore)} -> ${megabytes(reply.imageBytesAfter)} (${grouped(reply.imageBytesBefore)} -> ${grouped(reply.imageBytesAfter)} bytes)`,
        ],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  return [
    `${reply.dryRun ? "dry run: " : ""}vacuum ${session}`,
    ...rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`),
  ].join("\n");
}
