import { useLayoutEffect, useMemo, useState } from "react";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { observer } from "mobx-react-lite";

import { useDial } from "./dial-context.js";
import { isAccepted, modelParams } from "./directory.js";
import { writeStatus } from "./drafts.js";
import { NativeList, type ListSection } from "./native-list.js";
import type { RootParamList } from "./navigation.js";
import {
  completionWires,
  sessionModel,
  type ModelChoice,
  type ModelWire,
} from "../../harness-web-app/src/shell/model-choice.js";
import { accountWindowLines } from "../../harness-web-app/src/shell/wire-account.js";

type Rpc = { request(method: string, params?: unknown): Promise<unknown> };

export type ModelPick = { readonly ok: true } | { readonly ok: false; readonly message: string };

let picking = false;

export function modelQuota(
  wires: readonly ModelWire[],
  choice: ModelChoice,
): { readonly text: string; readonly failed: boolean } {
  const wire =
    wires.find((item) => item.connection === choice.connection && choice.connection !== "") ??
    wires.find((item) => item.choices.some((row) => row.model === choice.model));
  if (wire == null) return { text: "", failed: false };
  if (wire.account.failed) return { text: wire.account.description, failed: true };
  const lines = accountWindowLines(wire.account, Date.now()).map((line) => line.text);
  const text = [wire.account.balance, ...lines].filter((part) => part !== "").join(" · ");
  return { text, failed: false };
}

export async function selectModel(rpc: Rpc | null, choice: ModelChoice, current: ModelChoice): Promise<ModelPick> {
  if (picking || rpc == null) return { ok: false, message: "" };
  if (choice.connection === current.connection && choice.model === current.model) return { ok: true };
  picking = true;
  try {
    const connectionResult = await rpc.request("kv/set", modelParams("connection", choice.connection));
    if (!isAccepted(connectionResult)) return { ok: false, message: "Model was not changed." };
    const modelResult = await rpc.request("kv/set", modelParams("model", choice.model));
    if (!isAccepted(modelResult)) return { ok: false, message: "Connection changed, but the model was not." };
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Could not change the model." };
  } finally {
    picking = false;
  }
}

export const ModelScreen = observer(function ModelView({ navigation }: NativeStackScreenProps<RootParamList, "Model">) {
  const dial = useDial();
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const session = dial.session;
  const wires = completionWires(dial.kernel?.root.connections);
  const shown = sessionModel(session?.root);
  const needle = query.trim().toLowerCase();
  // The session can be running a model its connection no longer lists (a turn's own alias).
  // Without a row of its own, nothing in the sheet would show what is selected.
  const listed = wires.some((wire) =>
    wire.choices.some((choice) => choice.connection === shown.connection && choice.model === shown.model),
  );
  const unlisted =
    shown.model.trim() !== "" && !listed && (needle === "" || shown.model.toLowerCase().includes(needle));
  const sections: readonly ListSection[] = useMemo(
    () => [
      ...(unlisted
        ? [
            {
              key: "current",
              header: "Current",
              rows: [
                { key: `${shown.connection}\0${shown.model}`, title: shown.model, checked: true, disabled: false },
              ],
            },
          ]
        : []),
      ...wires.flatMap((wire) => {
        const choices = wire.choices.filter((choice) => {
          const haystack = `${wire.name} ${choice.model}`.toLowerCase();
          return needle === "" || haystack.includes(needle);
        });
        if (choices.length === 0) return [];
        const lines = wire.account.failed
          ? [wire.account.description]
          : accountWindowLines(wire.account, Date.now()).map((line) => line.text);
        const quota = [wire.account.balance, ...lines].filter((part) => part !== "").join(" · ");
        return [
          {
            key: wire.connection,
            header: wire.name === "" ? "Model" : wire.name,
            footer: quota === "" ? undefined : quota,
            footerDanger: wire.account.failed,
            rows: choices.map((choice) => ({
              key: `${choice.connection}\0${choice.model}`,
              title: choice.model,
              checked: choice.connection === shown.connection && choice.model === shown.model,
              disabled: pending,
            })),
          },
        ];
      }),
    ],
    [wires, needle, pending, shown.connection, shown.model, unlisted],
  );

  useLayoutEffect(() => {
    navigation.setOptions({
      title: "Model",
      headerSearchBarOptions: {
        placeholder: "Models",
        hideWhenScrolling: false,
        autoCapitalize: "none",
        onChangeText: (event) => setQuery(event.nativeEvent.text),
      },
      unstable_headerLeftItems: () => [
        {
          type: "button",
          label: "",
          icon: { type: "sfSymbol", name: "xmark" },
          accessibilityLabel: "Close",
          onPress: () => navigation.goBack(),
        },
      ],
    });
  }, [navigation]);

  async function choose(choice: ModelChoice): Promise<void> {
    setPending(true);
    setNotice("");
    const result = await selectModel(dial.sessionRpc, choice, shown);
    setPending(false);
    if (result.ok) {
      navigation.goBack();
      return;
    }
    if (result.message !== "") {
      setNotice(result.message);
      writeStatus(result.message);
    }
  }

  return (
    <NativeList
      sections={sections}
      notice={notice === "" ? undefined : notice}
      emptyTitle="No model is connected."
      emptyDetail="Connect a model in Settings."
      onPressRow={(key) => {
        if (key === `${shown.connection}\0${shown.model}`) {
          navigation.goBack();
          return;
        }
        for (const wire of wires) {
          for (const choice of wire.choices) {
            if (`${choice.connection}\0${choice.model}` === key) {
              void choose(choice);
              return;
            }
          }
        }
      }}
    />
  );
});
