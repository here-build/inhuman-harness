/**
 * Machine notify at a model-input boundary. Refs the origin atoms; render
 * is `notificationText`. Not a recall and not a steer.
 */
import { model, state } from "@inhuman.tools/model";
import { WorkContainer } from "@inhuman.tools/plexus-expectations";

import { AgentCallNotification } from "../jobs/AgentCallNotification.js";

@model("harness:session:turn-notification")
export class TurnNotificationChunk extends WorkContainer {
  get work(): WorkContainer[] {
    return [];
  }
  @state.refList accessor notifications: AgentCallNotification[] = [];

  constructor(
    props?:
      | {
          readonly notifications?: AgentCallNotification[];
        }
      | symbol,
  ) {
    super(props);
  }

  notificationText(): string {
    return this.notifications
      .map((note) => note.message)
      .filter((line) => line.trim() !== "")
      .join("\n");
  }
}
