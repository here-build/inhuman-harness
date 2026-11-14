import { modelPkg } from "./deps.mjs";
import { flatTextOfBytes } from "./harness.mjs";

const { DocumentContainer, Model, model, state, getModelByTag } = modelPkg;

/**
 * Attaches real Stage-3 `@inhuman.tools/model` `state` accessors to an ES class
 * without requiring TypeScript compilation in pure Node `--expose-gc` benchmarks.
 */
function buildDecoratedStateModel(tag, fieldDefs, customClassFactory) {
  const existing = getModelByTag(tag);
  if (existing) return existing;

  const storageSymbols = new Map();
  const initializers = new Map();
  const extraInitializers = [];
  const metadata = Object.create(null);

  const Cls = customClassFactory((instance) => {
    for (const [key, init] of initializers) {
      const sym = storageSymbols.get(key);
      instance[sym] = init.call(instance, fieldDefs[key].defaultValue());
    }
    for (const fn of extraInitializers) {
      fn.call(instance);
    }
  });

  for (const [key, def] of Object.entries(fieldDefs)) {
    const sym = Symbol(key);
    storageSymbols.set(key, sym);
    const context = {
      kind: "accessor",
      name: key,
      static: false,
      private: false,
      access: {
        has: (obj) => key in obj,
        get: (obj) => obj[key],
        set: (obj, value) => {
          obj[key] = value;
        },
      },
      addInitializer(fn) {
        extraInitializers.push(fn);
      },
      metadata,
    };
    const res = def.decorator(
      {
        get() {
          return this[sym];
        },
        set(value) {
          this[sym] = value;
        },
      },
      context,
    );
    Object.defineProperty(Cls.prototype, key, {
      get: res.get,
      set: res.set,
      enumerable: true,
      configurable: true,
    });
    if (res.init) {
      initializers.set(key, res.init);
    }
  }

  Object.defineProperty(Cls, Symbol.metadata, {
    value: metadata,
    enumerable: true,
    configurable: true,
    writable: true,
  });

  model(tag)(Cls, { kind: "class", name: Cls.name, metadata });
  return Cls;
}

export const BenchToolCallNode = buildDecoratedStateModel(
  "bench:session:tool-call",
  {
    toolName: { decorator: state, defaultValue: () => "read_file" },
    status: { decorator: state, defaultValue: () => "completed" },
    argsJson: { decorator: state, defaultValue: () => "{}" },
    outcomeText: { decorator: state, defaultValue: () => "" },
    revision: { decorator: state, defaultValue: () => 0 },
  },
  (initFields) =>
    class BenchToolCallNode extends Model {
      constructor(props) {
        super(props);
        initFields(this);
      }
    },
);

export const BenchTurnNode = buildDecoratedStateModel(
  "bench:session:turn",
  {
    ordinal: { decorator: state, defaultValue: () => 0 },
    prompt: { decorator: state, defaultValue: () => "" },
    status: { decorator: state, defaultValue: () => "completed" },
    responseText: { decorator: state, defaultValue: () => "" },
    responseThought: { decorator: state, defaultValue: () => "" },
    calls: { decorator: state.childList, defaultValue: () => [] },
  },
  (initFields) =>
    class BenchTurnNode extends Model {
      constructor(props) {
        super(props);
        initFields(this);
      }
    },
);

export const BenchSessionRoot = buildDecoratedStateModel(
  "bench:session:root",
  {
    sessionId: { decorator: state, defaultValue: () => "" },
    title: { decorator: state, defaultValue: () => "" },
    mode: { decorator: state, defaultValue: () => "assistant" },
    permissionMode: { decorator: state, defaultValue: () => "manual" },
    kvs: { decorator: state.record, defaultValue: () => ({}) },
    turns: { decorator: state.childList, defaultValue: () => [] },
  },
  (initFields) =>
    class BenchSessionRoot extends Model {
      constructor(props) {
        super(props);
        initFields(this);
      }
    },
);

export function createBenchSessionContainer({
  sessionId = "bench-session",
  turnCount = 100,
  callsPerTurn = 3,
  promptBytes = 180,
  thoughtBytes = 400,
  responseBytes = 1400,
  toolOutcomeBytes = 1800,
} = {}) {
  const root = new BenchSessionRoot({
    sessionId,
    title: `Benchmark Session (${turnCount}t)`,
    mode: "assistant",
    permissionMode: "manual",
    kvs: { model: "bench-model", tier: "standard" },
    turns: [],
  });
  const container = new DocumentContainer(root, { guid: sessionId, revision: 1 });

  const turns = [];
  for (let t = 0; t < turnCount; t++) {
    const calls = [];
    for (let c = 0; c < callsPerTurn; c++) {
      calls.push(
        new BenchToolCallNode({
          toolName: c % 3 === 0 ? "read_file" : c % 3 === 1 ? "shell" : "edit_file",
          status: "completed",
          argsJson: `{"path":"src/mod-${t}-${c}.ts","offset":${c * 10 + 1}}`,
          outcomeText: flatTextOfBytes(toolOutcomeBytes, `tool-${t}-${c}`),
          revision: t * callsPerTurn + c + 1,
        }),
      );
    }
    turns.push(
      new BenchTurnNode({
        ordinal: t + 1,
        prompt: flatTextOfBytes(promptBytes, `prompt-${t}`),
        status: "completed",
        responseText: flatTextOfBytes(responseBytes, `resp-${t}`),
        responseThought: flatTextOfBytes(thoughtBytes, `thought-${t}`),
        calls,
      }),
    );
  }

  container.transact(() => {
    root.turns.push(...turns);
    container.revision += 1;
  });

  return container;
}

export function tapeStats(root) {
  let turns = 0;
  let calls = 0;
  let chars = 0;
  const list = root.turns;
  for (let i = 0; i < list.length; i++) {
    const turn = list[i];
    turns++;
    chars += turn.prompt.length + turn.responseText.length + turn.responseThought.length;
    const toolList = turn.calls;
    for (let j = 0; j < toolList.length; j++) {
      calls++;
      chars += toolList[j].outcomeText.length;
    }
  }
  return { turns, calls, chars };
}
