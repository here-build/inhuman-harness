/**
 * Machine notify at a model-input boundary. Refs the origin atoms; render
 * is `notificationText`. Not a recall and not a steer.
 */
import { WorkContainer } from "@inhuman.tools/expectations";
import { model, state } from "@inhuman.tools/model";

import { AgentCallNotification } from "../jobs/AgentCallNotification.js";

@model("harness:session:turn-notification")
export class TurnNotificationChunk extends WorkContainer {
  get work(): WorkContainer[] {
    return [];
  }
  @state.refList accessor notifications: AgentCallNotification[] = [];
  @state.childList accessor ownedNotifications: AgentCallNotification[] = [];

  constructor(
    props?:
      | {
          readonly notifications?: AgentCallNotification[];
          readonly ownedNotifications?: AgentCallNotification[];
        }
      | symbol,
  ) {
    super(props);
    if (props && typeof props !== "symbol" && props.notifications) {
      for (const note of props.notifications) {
        if (!note.parent && !note.container) {
          this.ownedNotifications.push(note);
        }
      }
    }
  }

  notificationText(): string {
    return this.notifications
      .map((note) => note.message)
      .filter((line) => line.trim() !== "")
      .join("\n");
  }
}
