import type { MachineDO } from "./machine-do.js";
import type { UserDO } from "./user-do.js";

export function userStub(env: Env, sub: string) {
  const ns = env.USER_DO as DurableObjectNamespace<UserDO>;
  return ns.get(ns.idFromName(sub));
}

export function machineStub(env: Env, sub: string, machineId: string) {
  const ns = env.MACHINE_DO as DurableObjectNamespace<MachineDO>;
  return ns.get(ns.idFromName(`${sub}:${machineId}`));
}
