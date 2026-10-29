import { setup, type EventFromLogic, type StateValueFrom } from "xstate";

/**
 * Process-local actor phase. Distinct from the durable WorkExpectation lifecycle.
 *
 * minted ──START──► running ──SETTLE|CRASH──► resolved (final)
 *    │                 │
 *    ├──ABORT──► aborted ──SETTLE|CRASH──────────┘
 *    └──RELEASE────────┴──RELEASE──────────► released (final)
 *
 * ENDINGS ARE OBSERVED. RELEASE fires from the actor's done reaction on the
 * durable entity — never from a control-flow wrapper. `resolved` is
 * settlement/crash; `released` is abort without a settlement.
 */
export const expectationActorMachine = setup({
  types: {
    events: {} as { type: "START" | "SETTLE" | "CRASH" | "ABORT" | "RELEASE" },
  },
}).createMachine({
  id: "pew-expectation-actor",
  initial: "minted",
  states: {
    minted: {
      tags: ["live"],
      on: {
        START: "running",
        ABORT: "aborted",
        RELEASE: "released",
      },
    },
    running: {
      tags: ["live"],
      on: {
        SETTLE: "resolved",
        CRASH: "resolved",
        ABORT: "aborted",
        RELEASE: "released",
      },
    },
    resolved: { type: "final" },
    aborted: {
      on: {
        SETTLE: "resolved",
        CRASH: "resolved",
        RELEASE: "released",
      },
    },
    released: { type: "final" },
  },
});

export type ActorPhase = StateValueFrom<typeof expectationActorMachine>;

export type ActorPhaseEvent = EventFromLogic<typeof expectationActorMachine>;
