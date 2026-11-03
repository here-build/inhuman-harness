import "@inhuman.tools/harness-model/session/register";
import { SessionPlexus } from "@inhuman.tools/harness-model/session";
import {
  SessionRuntime,
  type SessionDurability,
  type SessionEffectPort,
  type TurnIteratorHost,
} from "@inhuman.tools/turn/runtime";
import { bundledCompactProgram } from "@inhuman.tools/turn/resources";

const durability: SessionDurability = { kind: "memory" };
const runtime = new SessionRuntime(SessionPlexus.create("typed-consumer"), durability);
const effects: SessionEffectPort = {
  invoke: async () => ({ kind: "success", payload: "typed result" }),
};
const execute = (turn: Parameters<SessionRuntime["run"]>[0], host: TurnIteratorHost): Promise<void> => runtime.run(turn, host);
const program = bundledCompactProgram();
void effects;
void execute;
void program;
