import type { AgentNature } from "../recipe-scope.js";
import type { SessionUnfinished } from "./session-unfinished.js";

/** Fields the daemon projects from a session. `lastMessageAt` is not one of them. */
export type SessionOverviewFace = {
  readonly title: string;
  readonly recipeScope: AgentNature;
  readonly specName: string;
  readonly resident: boolean;
  readonly keepAlive: boolean;
  readonly oneShot: boolean;
  readonly model: string;
  readonly status: string;
  readonly midMotion: boolean;
  readonly openTurn: boolean;
  readonly openToolCount: number;
  readonly periodArmed: boolean;
  readonly openCallbackCount: number;
  readonly asking: boolean;
  readonly unfinished: SessionUnfinished;
  readonly lastPrompt: string;
  readonly askLine: string;
  readonly questionLine: string;
};
