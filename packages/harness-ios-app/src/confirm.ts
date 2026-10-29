import { useEffect, useRef, useState } from "react";
import { useNavigation, usePreventRemove } from "@react-navigation/native";
import { ActionSheetIOS, Alert, Platform } from "react-native";

let open = false;

function present(title: string, destructive: string, cancel: string, onDestructive: () => void): void {
  if (Platform.OS !== "ios") {
    Alert.alert(title, undefined, [
      { text: destructive, style: "destructive", onPress: onDestructive },
      { text: cancel, style: "cancel" },
    ]);
    return;
  }
  if (open) return;
  open = true;
  ActionSheetIOS.showActionSheetWithOptions(
    { title, options: [destructive, cancel], destructiveButtonIndex: 0, cancelButtonIndex: 1 },
    (index) => {
      open = false;
      if (index === 0) onDestructive();
    },
  );
}

export function confirmDiscard(onDiscard: () => void): void {
  present("Discard your changes?", "Discard Changes", "Cancel", onDiscard);
}

export function confirmRemove(name: string, onRemove: () => void): void {
  present(name, "Remove", "Cancel", onRemove);
}

/** A short list of actions. Cancel is added. Nothing happens while another sheet is up. */
export function choose(
  title: string,
  choices: readonly { readonly label: string; readonly destructive?: boolean; readonly onPress: () => void }[],
): void {
  if (Platform.OS !== "ios") {
    Alert.alert(title, undefined, [
      ...choices.map((choice) => ({
        text: choice.label,
        style: choice.destructive === true ? ("destructive" as const) : ("default" as const),
        onPress: choice.onPress,
      })),
      { text: "Cancel", style: "cancel" as const },
    ]);
    return;
  }
  if (open) return;
  open = true;
  const destructive = choices.findIndex((choice) => choice.destructive === true);
  ActionSheetIOS.showActionSheetWithOptions(
    {
      title,
      options: [...choices.map((choice) => choice.label), "Cancel"],
      ...(destructive === -1 ? {} : { destructiveButtonIndex: destructive }),
      cancelButtonIndex: choices.length,
    },
    (index) => {
      open = false;
      choices[index]?.onPress();
    },
  );
}

/**
 * Hold the swipe and the Back button while `dirty` is set.
 * The nested settings stack reports the section, which also blocks the page-sheet swipe.
 * The hold follows `dirty` in the same render, so clearing a draft and then leaving is not raced
 * by a leftover block. A confirmed discard stays released until this screen unmounts.
 */
export function useDiscard(dirty: boolean): void {
  const navigation = useNavigation();
  const pending = useRef<Parameters<typeof navigation.dispatch>[0] | null>(null);
  const released = useRef(false);
  const [block, setBlock] = useState(dirty);
  if (!released.current && pending.current == null && dirty !== block) setBlock(dirty);
  usePreventRemove(block, ({ data }) => {
    confirmDiscard(() => {
      pending.current = data.action;
      released.current = true;
      setBlock(false);
    });
  });
  useEffect(() => {
    if (block || pending.current == null) return;
    const action = pending.current;
    pending.current = null;
    navigation.dispatch(action);
  }, [block, navigation]);
}
