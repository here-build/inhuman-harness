export type AgentRelationSnap = {
  readonly id: string;
  readonly workerSessionId: string;
  readonly spec: string;
  readonly oneShot: boolean;
  readonly completed: boolean;
};
