import { PlexusModel, syncing } from "@here.build/plexus";

import { BotSpec, writeAuthoredBots } from "./BotSpec.js";
import type { CommandSpec } from "./CommandSpec.js";
import type { PermissionMode } from "../session/eval-context.js";
import type { ActionSpec } from "../shared/ActionSpec.js";
import { applyKv } from "../shared/KeyValueStorage.js";
import type { KvProposal } from "../shared/residual.js";

@syncing("harness:project:root")
export class ProjectRoot extends PlexusModel<null> {
  @syncing.record accessor kvs: Record<string, string> = {};

  @syncing.action
  applyKvs(proposals: readonly KvProposal[]): void {
    applyKv(this.kvs, proposals);
  }

  /**
   * `"connection"` → model this project last settled on for that wire. Session
   * model selection writes through; a project-scope kv/set can pin it. Session
   * mint prefers this over the kernel record.
   */
  @syncing.record accessor lastUsedConnectionModel: Record<string, string> = {};

  @syncing.action
  stampLastUsedConnectionModel(connection: string, model: string): void {
    const conn = connection.trim();
    const mid = model.trim();
    if (conn === "" || mid === "") return;
    this.lastUsedConnectionModel[conn] = mid;
  }

  @syncing.action
  replaceAuthoredBots(specs: readonly BotSpec[]): void {
    writeAuthoredBots(this, specs);
  }

  @syncing accessor path: string = "";
  /**
   * Last-choice permission mode for a new session in this project.
   * Empty inherits kernel `defaultPermissionMode` at mint. A set id wins, including
   * `manual`. Not a kv key. Attach does not re-seed.
   */
  @syncing accessor defaultPermissionMode: PermissionMode | "" = "";
  @syncing accessor trusted: boolean = false;
  @syncing accessor contentHash: string = "";
  /** Project-authored bots (`<repo>/.inhuman/bots`). Overrides home / stdlib. */
  @syncing.child.record accessor bots: Record<string, BotSpec> = {};
  @syncing.child.record accessor commands: Record<string, CommandSpec> = {};
  @syncing.child.record accessor actions: Record<string, ActionSpec> = {};
  /** Project-scope roster: recipe name → bot `sessionId`. */
  @syncing.record accessor botsRoster: Record<string, string> = {};
  /** Conversations. Key = `sessionId`. Value is membership (`""`). Not the bot roster. */
  @syncing.record accessor sessions: Record<string, ""> = {};

  constructor(
    opts:
      | symbol
      | {
          path?: string;
          defaultPermissionMode?: PermissionMode | "";
          trusted?: boolean;
          contentHash?: string;
          kvs?: Record<string, string>;
          lastUsedConnectionModel?: Record<string, string>;
          bots?: Record<string, BotSpec>;
          commands?: Record<string, CommandSpec>;
          actions?: Record<string, ActionSpec>;
          botsRoster?: Record<string, string>;
          sessions?: Record<string, "">;
        },
  ) {
    super(opts);
  }
}
