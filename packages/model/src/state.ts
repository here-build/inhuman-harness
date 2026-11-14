import { action, observable, observe, runInAction } from "mobx";

import { getModelMetadata, registerStateMetadata } from "./metadata.js";
import { Model } from "./model.js";
import { CONTAINER_LINK, HYDRATION_DATA } from "./symbols.js";
import type { ModelPatch, SerializedModelGraph } from "./types.js";

interface Linkable {
  readonly uuid: string;
  [HYDRATION_DATA]?: Record<string, unknown>;
  [CONTAINER_LINK]?: {
    readonly isApplyingPatches?: boolean;
    recordPatch(patch: ModelPatch): void;
    registerNode(node: Model): void;
    notifyDetached?(node: Model): void;
    serializeNode(node: Model): SerializedModelGraph;
    transact<T>(fn: () => T): T;
  };
}

export function state<This, TValue>(
  target: ClassAccessorDecoratorTarget<This, TValue>,
  context: ClassAccessorDecoratorContext<This, TValue>,
): ClassAccessorDecoratorResult<This, TValue> {
  const propertyKey = String(context.name);
  registerStateMetadata(context, { propertyKey, kind: "scalar" });

  const mobxResult = observable.ref(target, context);
  const getter = mobxResult?.get ?? target.get;
  const setter = mobxResult?.set ?? target.set;
  const initter = mobxResult?.init;

  return {
    get(this: This): TValue {
      return getter.call(this);
    },
    set(this: This, value: TValue): void {
      const oldVal = getter.call(this);
      setter.call(this, value);
      if (!Object.is(oldVal, value)) {
        const self = this as unknown as Linkable;
        const link = self[CONTAINER_LINK];
        if (link && !link.isApplyingPatches) {
          link.recordPatch({
            op: "set",
            nodeId: self.uuid,
            field: propertyKey,
            value,
          });
        }
      }
    },
    init(this: This, initialValue: TValue): TValue {
      const self = this as unknown as Linkable;
      const props = self[HYDRATION_DATA];
      const val = props?.[propertyKey] !== undefined ? (props[propertyKey] as TValue) : initialValue;
      return initter ? initter.call(this, val) : val;
    },
  };
}

state.ref = function stateRef<This, TValue extends Model | null>(
  target: ClassAccessorDecoratorTarget<This, TValue>,
  context: ClassAccessorDecoratorContext<This, TValue>,
): ClassAccessorDecoratorResult<This, TValue> {
  const propertyKey = String(context.name);
  registerStateMetadata(context, { propertyKey, kind: "ref" });

  const mobxResult = observable.ref(target, context);
  const getter = mobxResult?.get ?? target.get;
  const setter = mobxResult?.set ?? target.set;
  const initter = mobxResult?.init;

  return {
    get(this: This): TValue {
      return getter.call(this);
    },
    set(this: This, value: TValue): void {
      const oldVal = getter.call(this);
      setter.call(this, value);
      if (oldVal !== value) {
        const self = this as unknown as Linkable;
        const link = self[CONTAINER_LINK];
        if (oldVal instanceof Model) {
          link?.notifyDetached?.(oldVal);
        }
        if (value instanceof Model) {
          link?.registerNode(value);
        }
        if (link && !link.isApplyingPatches) {
          link.recordPatch({
            op: "set",
            nodeId: self.uuid,
            field: propertyKey,
            value: value ? link.serializeNode(value as Model) : null,
          });
        }
      }
    },
    init(this: This, initialValue: TValue): TValue {
      const self = this as unknown as Linkable;
      const props = self[HYDRATION_DATA];
      const val = props?.[propertyKey] !== undefined ? (props[propertyKey] as TValue) : initialValue;
      return initter ? initter.call(this, val) : val;
    },
  };
};

function attachParent(child: unknown, parent: unknown, key: string | number | null): void {
  if (child && typeof child === "object" && "parent" in child) {
    const ctor = (child as object).constructor;
    const meta = ctor ? getModelMetadata(ctor) : undefined;
    if (meta?.stateFields?.has("parent")) {
      return;
    }
    runInAction(() => {
      (child as Model).parent = parent;
      (child as Model).parentFieldKey = key;
    });
  }
}

function detachParent(child: unknown): void {
  if (child && typeof child === "object" && "parent" in child) {
    const ctor = (child as object).constructor;
    const meta = ctor ? getModelMetadata(ctor) : undefined;
    if (meta?.stateFields?.has("parent")) {
      return;
    }
    runInAction(() => {
      (child as Model).parent = null;
      (child as Model).parentFieldKey = null;
    });
  }
}

function stateChildImpl<This, TValue extends Model | null>(
  target: ClassAccessorDecoratorTarget<This, TValue>,
  context: ClassAccessorDecoratorContext<This, TValue>,
): ClassAccessorDecoratorResult<This, TValue> {
  const propertyKey = String(context.name);
  registerStateMetadata(context, { propertyKey, kind: "child" });

  const mobxResult = observable.ref(target, context);
  const getter = mobxResult?.get ?? target.get;
  const setter = mobxResult?.set ?? target.set;
  const initter = mobxResult?.init;

  return {
    get(this: This): TValue {
      return getter.call(this);
    },
    set(this: This, value: TValue): void {
      const oldVal = getter.call(this);
      if (oldVal !== value && oldVal) {
        detachParent(oldVal);
      }
      attachParent(value, this, propertyKey);
      setter.call(this, value);
      if (oldVal !== value) {
        const self = this as unknown as Linkable;
        const link = self[CONTAINER_LINK];
        if (oldVal instanceof Model) {
          link?.notifyDetached?.(oldVal);
        }
        if (value instanceof Model) {
          link?.registerNode(value);
        }
        if (link && !link.isApplyingPatches) {
          link.recordPatch({
            op: "set",
            nodeId: self.uuid,
            field: propertyKey,
            value: value ? link.serializeNode(value as Model) : null,
          });
        }
      }
    },
    init(this: This, initialValue: TValue): TValue {
      const self = this as unknown as Linkable;
      const props = self[HYDRATION_DATA];
      const val = props?.[propertyKey] !== undefined ? (props[propertyKey] as TValue) : initialValue;
      attachParent(val, this, propertyKey);
      return initter ? initter.call(this, val) : val;
    },
  };
}

function bindArrayObserver<T>(
  self: Linkable,
  propertyKey: string,
  arr: T[],
  kind: "list" | "refList" | "childList",
): () => void {
  return observe(arr, (change) => {
    if (change.type !== "splice") {
      return;
    }
    const link = self[CONTAINER_LINK];
    switch (kind) {
      case "childList": {
        const remaining = new Set(arr);
        for (const removed of change.removed) {
          if (!remaining.has(removed)) {
            detachParent(removed);
            if (removed instanceof Model) {
              link?.notifyDetached?.(removed);
            }
          }
        }
        for (let idx = change.index; idx < arr.length; idx++) {
          attachParent(arr[idx], self, idx);
        }
        for (const child of change.added) {
          if (child) {
            link?.registerNode(child as unknown as Model);
          }
        }
        break;
      }
      case "refList": {
        for (const removed of change.removed) {
          if (removed instanceof Model) {
            link?.notifyDetached?.(removed);
          }
        }
        for (const added of change.added) {
          if (added instanceof Model) {
            link?.registerNode(added);
          }
        }
        break;
      }
      case "list": {
        for (const removed of change.removed) {
          if (removed instanceof Model) {
            link?.notifyDetached?.(removed);
          }
        }
        for (const item of change.added) {
          if (item && item instanceof Model) {
            link?.registerNode(item);
          }
        }
        break;
      }
    }
    if (!link || link.isApplyingPatches) {
      return;
    }

    let items: unknown[];
    if (kind === "childList") {
      items = change.added.map((child) => link.serializeNode(child as unknown as Model));
    } else if (kind === "refList") {
      items = change.added.map((m) => link.serializeNode(m as unknown as Model));
    } else {
      items = change.added.map((item) => {
        if (item && item instanceof Model) {
          return { $model: link.serializeNode(item) };
        }
        return { $value: item };
      });
    }

    link.recordPatch({
      op: "splice",
      ...(kind === "list" ? { encoding: "rows-v1" as const } : {}),
      nodeId: self.uuid,
      field: propertyKey,
      index: change.index,
      deleteCount: change.removedCount,
      items,
    });
  });
}

function bindRecordObserver(self: Linkable, propertyKey: string, obj: Record<string, unknown>): () => void {
  return observe(obj, (change) => {
    const link = self[CONTAINER_LINK];
    if (!link || link.isApplyingPatches) {
      return;
    }

    if (change.type === "remove") {
      link.recordPatch({
        op: "del",
        nodeId: self.uuid,
        field: propertyKey,
        key: String(change.name),
      });
    } else {
      link.recordPatch({
        op: "set",
        nodeId: self.uuid,
        field: propertyKey,
        key: String(change.name),
        value: change.newValue,
      });
    }
  });
}

export function stateList<This, TItem>(
  target: ClassAccessorDecoratorTarget<This, TItem[]>,
  context: ClassAccessorDecoratorContext<This, TItem[]>,
): ClassAccessorDecoratorResult<This, TItem[]> {
  const propertyKey = String(context.name);
  registerStateMetadata(context, { propertyKey, kind: "list" });

  const mobxResult = observable.shallow(target, context);
  const getter = mobxResult?.get ?? target.get;
  const setter = mobxResult?.set ?? target.set;
  const initter = mobxResult?.init;

  const disposers = new WeakMap<object, () => void>();

  return {
    get(this: This): TItem[] {
      return getter.call(this);
    },
    set(this: This, value: TItem[]): void {
      const self = this as unknown as Linkable;
      const oldArr = getter.call(this);
      const link = self[CONTAINER_LINK];
      if (Array.isArray(oldArr)) {
        const nextSet = new Set<unknown>(value);
        for (const oldItem of oldArr) {
          if (oldItem instanceof Model && !nextSet.has(oldItem)) {
            link?.notifyDetached?.(oldItem);
          }
        }
      }
      const obsArr = observable.array(value, {
        deep: false,
        name: `${String((self as any)?.constructor?.name ?? "")}.${propertyKey}`,
      });
      const prevDisposer = disposers.get(self as object);
      if (prevDisposer) {
        prevDisposer();
      }
      const disposer = bindArrayObserver(self, propertyKey, obsArr, "list");
      disposers.set(self as object, disposer);

      setter.call(this, obsArr as unknown as TItem[]);

      for (const item of obsArr) {
        if (item instanceof Model) {
          link?.registerNode(item);
        }
      }
      if (link && !link.isApplyingPatches) {
        link.recordPatch({
          op: "set",
          nodeId: self.uuid,
          field: propertyKey,
          value: obsArr.map((item) =>
            item instanceof Model ? { $model: link.serializeNode(item) } : { $value: item },
          ),
          encoding: "rows-v1",
        });
      }
    },
    init(this: This, initialValue: TItem[]): TItem[] {
      const self = this as unknown as Linkable;
      const props = self[HYDRATION_DATA];
      const raw = props && Array.isArray(props[propertyKey]) ? (props[propertyKey] as TItem[]) : initialValue;
      const obsArr = observable.array(raw, {
        deep: false,
        name: `${String((self as any)?.constructor?.name ?? "")}.${propertyKey}`,
      });
      const disposer = bindArrayObserver(self, propertyKey, obsArr, "list");
      disposers.set(self as object, disposer);
      return initter ? initter.call(this, obsArr as unknown as TItem[]) : (obsArr as unknown as TItem[]);
    },
  };
}
state.list = stateList;

export function stateRefList<This, TItem extends Model>(
  target: ClassAccessorDecoratorTarget<This, TItem[]>,
  context: ClassAccessorDecoratorContext<This, TItem[]>,
): ClassAccessorDecoratorResult<This, TItem[]> {
  const propertyKey = String(context.name);
  registerStateMetadata(context, { propertyKey, kind: "refList" });

  const mobxResult = observable.shallow(target, context);
  const getter = mobxResult?.get ?? target.get;
  const setter = mobxResult?.set ?? target.set;
  const initter = mobxResult?.init;

  const disposers = new WeakMap<object, () => void>();

  return {
    get(this: This): TItem[] {
      return getter.call(this);
    },
    set(this: This, value: TItem[]): void {
      const self = this as unknown as Linkable;
      const oldArr = getter.call(this);
      const link = self[CONTAINER_LINK];
      if (Array.isArray(oldArr)) {
        const nextSet = new Set<unknown>(value);
        for (const oldItem of oldArr) {
          if (oldItem instanceof Model && !nextSet.has(oldItem)) {
            link?.notifyDetached?.(oldItem);
          }
        }
      }
      const obsArr = observable.array(value, {
        deep: false,
        name: `${String((self as any)?.constructor?.name ?? "")}.${propertyKey}`,
      });
      const prevDisposer = disposers.get(self as object);
      if (prevDisposer) {
        prevDisposer();
      }
      const disposer = bindArrayObserver(self, propertyKey, obsArr, "refList");
      disposers.set(self as object, disposer);

      setter.call(this, obsArr as unknown as TItem[]);

      for (const item of obsArr) {
        if (item instanceof Model) {
          link?.registerNode(item);
        }
      }
      if (link && !link.isApplyingPatches) {
        link.recordPatch({
          op: "set",
          nodeId: self.uuid,
          field: propertyKey,
          value: obsArr.map((m) => link.serializeNode(m as unknown as Model)),
        });
      }
    },
    init(this: This, initialValue: TItem[]): TItem[] {
      const self = this as unknown as Linkable;
      const props = self[HYDRATION_DATA];
      const raw = props && Array.isArray(props[propertyKey]) ? (props[propertyKey] as TItem[]) : initialValue;
      const obsArr = observable.array(raw, {
        deep: false,
        name: `${String((self as any)?.constructor?.name ?? "")}.${propertyKey}`,
      });
      const disposer = bindArrayObserver(self, propertyKey, obsArr, "refList");
      disposers.set(self as object, disposer);
      return initter ? initter.call(this, obsArr as unknown as TItem[]) : (obsArr as unknown as TItem[]);
    },
  };
}
state.refList = stateRefList;

export function stateChildList<This, TItem extends Model>(
  target: ClassAccessorDecoratorTarget<This, TItem[]>,
  context: ClassAccessorDecoratorContext<This, TItem[]>,
): ClassAccessorDecoratorResult<This, TItem[]> {
  const propertyKey = String(context.name);
  registerStateMetadata(context, { propertyKey, kind: "childList" });

  const mobxResult = observable.shallow(target, context);
  const getter = mobxResult?.get ?? target.get;
  const setter = mobxResult?.set ?? target.set;
  const initter = mobxResult?.init;

  const disposers = new WeakMap<object, () => void>();

  return {
    get(this: This): TItem[] {
      return getter.call(this);
    },
    set(this: This, value: TItem[]): void {
      const self = this as unknown as Linkable;
      const oldArr = getter.call(this);
      const link = self[CONTAINER_LINK];
      const nextSet = new Set(value);
      if (Array.isArray(oldArr)) {
        for (const oldChild of oldArr) {
          if (!nextSet.has(oldChild)) {
            detachParent(oldChild);
            if (oldChild instanceof Model) {
              link?.notifyDetached?.(oldChild);
            }
          }
        }
      }
      for (const [idx, child] of value.entries()) attachParent(child, this, idx);
      const obsArr = observable.array(value, {
        deep: false,
        name: `${String((self as any)?.constructor?.name ?? "")}.${propertyKey}`,
      });
      const prevDisposer = disposers.get(self as object);
      if (prevDisposer) {
        prevDisposer();
      }
      const disposer = bindArrayObserver(self, propertyKey, obsArr, "childList");
      disposers.set(self as object, disposer);

      setter.call(this, obsArr as unknown as TItem[]);

      for (const child of obsArr) {
        if (child instanceof Model) {
          link?.registerNode(child);
        }
      }
      if (link && !link.isApplyingPatches) {
        link.recordPatch({
          op: "set",
          nodeId: self.uuid,
          field: propertyKey,
          value: obsArr.map((child) => link.serializeNode(child as unknown as Model)),
        });
      }
    },
    init(this: This, initialValue: TItem[]): TItem[] {
      const self = this as unknown as Linkable;
      const props = self[HYDRATION_DATA];
      const raw = props && Array.isArray(props[propertyKey]) ? (props[propertyKey] as TItem[]) : initialValue;
      for (const [idx, child] of raw.entries()) attachParent(child, this, idx);
      const obsArr = observable.array(raw, {
        deep: false,
        name: `${String((self as any)?.constructor?.name ?? "")}.${propertyKey}`,
      });
      const disposer = bindArrayObserver(self, propertyKey, obsArr, "childList");
      disposers.set(self as object, disposer);
      return initter ? initter.call(this, obsArr as unknown as TItem[]) : (obsArr as unknown as TItem[]);
    },
  };
}
state.childList = stateChildList;

function bindChildRecordObserver(self: Linkable, propertyKey: string, obj: Record<string, unknown>): () => void {
  return observe(obj, (change) => {
    const link = self[CONTAINER_LINK];
    if (change.type === "remove") {
      detachParent(change.oldValue);
      if (change.oldValue instanceof Model) {
        link?.notifyDetached?.(change.oldValue);
      }
    } else {
      if (change.type === "update" && change.oldValue !== change.newValue) {
        detachParent(change.oldValue);
        if (change.oldValue instanceof Model) {
          link?.notifyDetached?.(change.oldValue);
        }
      }
      attachParent(change.newValue, self, String(change.name));
      if (change.newValue instanceof Model) {
        link?.registerNode(change.newValue);
      }
    }
    if (!link || link.isApplyingPatches) {
      return;
    }

    if (change.type === "remove") {
      link.recordPatch({
        op: "del",
        nodeId: self.uuid,
        field: propertyKey,
        key: String(change.name),
      });
    } else {
      link.recordPatch({
        op: "set",
        nodeId: self.uuid,
        field: propertyKey,
        key: String(change.name),
        value: change.newValue ? link.serializeNode(change.newValue as Model) : null,
      });
    }
  });
}

export function stateChildRecord<This, TValue extends Model>(
  target: ClassAccessorDecoratorTarget<This, Record<string, TValue>>,
  context: ClassAccessorDecoratorContext<This, Record<string, TValue>>,
): ClassAccessorDecoratorResult<This, Record<string, TValue>> {
  const propertyKey = String(context.name);
  registerStateMetadata(context, { propertyKey, kind: "childRecord" });

  const mobxResult = observable.shallow(target, context);
  const getter = mobxResult?.get ?? target.get;
  const setter = mobxResult?.set ?? target.set;
  const initter = mobxResult?.init;

  const disposers = new WeakMap<object, () => void>();

  return {
    get(this: This): Record<string, TValue> {
      return getter.call(this);
    },
    set(this: This, value: Record<string, TValue>): void {
      const self = this as unknown as Linkable;
      const oldObj = getter.call(this);
      const link = self[CONTAINER_LINK];
      const nextValues = new Set<unknown>(Object.values(value));
      if (oldObj && typeof oldObj === "object") {
        for (const oldChild of Object.values(oldObj)) {
          if (!nextValues.has(oldChild)) {
            detachParent(oldChild);
            if (oldChild instanceof Model) {
              link?.notifyDetached?.(oldChild);
            }
          }
        }
      }
      for (const [k, v] of Object.entries(value)) {
        attachParent(v, this, k);
      }
      const obsObj = observable.object(value, undefined, { deep: false });
      const prevDisposer = disposers.get(self as object);
      if (prevDisposer) {
        prevDisposer();
      }
      const disposer = bindChildRecordObserver(self, propertyKey, obsObj as Record<string, unknown>);
      disposers.set(self as object, disposer);

      setter.call(this, obsObj as unknown as Record<string, TValue>);

      for (const v of Object.values(obsObj)) {
        if (v instanceof Model) {
          link?.registerNode(v);
        }
      }
      if (link && !link.isApplyingPatches) {
        const serialized: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obsObj)) {
          if (v) {
            serialized[k] = link.serializeNode(v as unknown as Model);
          }
        }
        link.recordPatch({
          op: "set",
          nodeId: self.uuid,
          field: propertyKey,
          value: serialized,
        });
      }
    },
    init(this: This, initialValue: Record<string, TValue>): Record<string, TValue> {
      const self = this as unknown as Linkable;
      const props = self[HYDRATION_DATA];
      const raw =
        props && typeof props[propertyKey] === "object" && props[propertyKey] !== null
          ? (props[propertyKey] as Record<string, TValue>)
          : initialValue;
      for (const [k, v] of Object.entries(raw)) {
        attachParent(v, this, k);
      }
      const obsObj = observable.object(raw, undefined, { deep: false });
      const disposer = bindChildRecordObserver(self, propertyKey, obsObj as Record<string, unknown>);
      disposers.set(self as object, disposer);
      return initter
        ? initter.call(this, obsObj as unknown as Record<string, TValue>)
        : (obsObj as unknown as Record<string, TValue>);
    },
  };
}
state.childRecord = stateChildRecord;
state.child = Object.assign(stateChildImpl, {
  list: stateChildList,
  record: stateChildRecord,
});

export function stateRecord<This, TValue>(
  target: ClassAccessorDecoratorTarget<This, Record<string, TValue>>,
  context: ClassAccessorDecoratorContext<This, Record<string, TValue>>,
): ClassAccessorDecoratorResult<This, Record<string, TValue>> {
  const propertyKey = String(context.name);
  registerStateMetadata(context, { propertyKey, kind: "record" });

  const mobxResult = observable.shallow(target, context);
  const getter = mobxResult?.get ?? target.get;
  const setter = mobxResult?.set ?? target.set;
  const initter = mobxResult?.init;

  const disposers = new WeakMap<object, () => void>();

  return {
    get(this: This): Record<string, TValue> {
      return getter.call(this);
    },
    set(this: This, value: Record<string, TValue>): void {
      const self = this as unknown as Linkable;
      const obsObj = observable.object(value, undefined, { deep: false });
      const prevDisposer = disposers.get(self as object);
      if (prevDisposer) {
        prevDisposer();
      }
      const disposer = bindRecordObserver(self, propertyKey, obsObj as Record<string, unknown>);
      disposers.set(self as object, disposer);

      setter.call(this, obsObj as unknown as Record<string, TValue>);

      const link = self[CONTAINER_LINK];
      if (link && !link.isApplyingPatches) {
        link.recordPatch({
          op: "set",
          nodeId: self.uuid,
          field: propertyKey,
          value: { ...obsObj },
        });
      }
    },
    init(this: This, initialValue: Record<string, TValue>): Record<string, TValue> {
      const self = this as unknown as Linkable;
      const props = self[HYDRATION_DATA];
      const raw =
        props && typeof props[propertyKey] === "object" && props[propertyKey] !== null
          ? (props[propertyKey] as Record<string, TValue>)
          : initialValue;
      const obsObj = observable.object(raw, undefined, { deep: false });
      const disposer = bindRecordObserver(self, propertyKey, obsObj as Record<string, unknown>);
      disposers.set(self as object, disposer);
      return initter
        ? initter.call(this, obsObj as unknown as Record<string, TValue>)
        : (obsObj as unknown as Record<string, TValue>);
    },
  };
}
state.record = stateRecord;

export function stateAction<This, Args extends unknown[], Return>(
  target: (this: This, ...args: Args) => Return,
  context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Return>,
): (this: This, ...args: Args) => Return {
  const mobxAction = action(String(context.name), target);

  return function (this: This, ...args: Args): Return {
    const link = (this as unknown as Linkable)[CONTAINER_LINK];
    if (link) {
      return link.transact(() => mobxAction.apply(this, args));
    }
    return mobxAction.apply(this, args);
  };
}
state.action = stateAction;
