import { useEffect, useRef, useState, type ComponentRef, type ReactNode } from "react";
import Clipboard from "@react-native-clipboard/clipboard";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { observer } from "mobx-react-lite";
import {
  AccessibilityInfo,
  Image,
  Keyboard,
  LayoutAnimation,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { background, card, chrome, fill, grouped, label, placeholder, red, secondary } from "./chrome.js";
import { TURN_RUNNING } from "./copy.js";
import { useDial } from "./dial-context.js";
import { isAccepted, mintId, turnParams } from "./directory.js";
import {
  isSending,
  markSending,
  markStopping,
  peekPrompt,
  pictureFromClipboard,
  queuePrompt,
  readDraft,
  readStatus,
  readVisuals,
  stoppingTurn,
  takePrompt,
  useDrafts,
  writeDraft,
  writeStatus,
  writeVisuals,
  type DraftVisual,
} from "./drafts.js";
import { GlassButton } from "./glass-button.js";
import { Glass } from "./glass.js";
import { impact } from "./host.js";
import { KeyboardFollower } from "./keyboard-follower.js";
import { modelQuota } from "./model-menu.js";
import { openModel, type MainStackParamList } from "./navigation.js";
import { useWorkspace } from "./roster.js";
import type { Place } from "./shell.js";
import { Symbol } from "./symbol.js";
import { Label, useType } from "./type.js";
import { turnIsLive } from "../../harness-web-app/src/shell/light.js";
import { completionWires, sessionModel } from "../../harness-web-app/src/shell/model-choice.js";
import { needsOnboarding } from "../../harness-web-app/src/shell/provider-list.js";

function draftKey(place: Place): string {
  if (place.kind === "session") return place.sessionId;
  if (place.kind === "project") return `project:${place.path}`;
  return "projects";
}

let flushing = false;

async function deliver(
  request: (prompt: string, visuals: readonly DraftVisual[]) => Promise<unknown>,
  sessionId: string,
  prompt: string,
  visuals: readonly DraftVisual[],
): Promise<void> {
  markSending(true);
  writeStatus("");
  const restore = (): void => {
    writeDraft(sessionId, prompt);
    writeVisuals(sessionId, visuals);
  };
  try {
    const result = await request(prompt, visuals);
    if (!isAccepted(result)) {
      restore();
      writeStatus("Message was not accepted. Your draft is saved.");
    }
  } catch (error) {
    restore();
    writeStatus(error instanceof Error ? error.message : "Could not send. Your draft is saved.");
  } finally {
    markSending(false);
  }
}

export function Column({
  place,
  prompt,
  plain = false,
  onInset,
  reading = false,
  onCompact,
  onRestore,
  children,
}: {
  readonly place: Place;
  readonly prompt: boolean;
  readonly plain?: boolean;
  /** Called with the distance from the screen bottom to the composer's top edge, so content can inset itself. */
  readonly onInset?: (bottom: number) => void;
  /** The reader is away from the end, so the composer may shrink to a pill. */
  readonly reading?: boolean;
  /** Told when the composer is a pill, so the host can shrink its own chrome with it. */
  readonly onCompact?: (compact: boolean) => void;
  /** The reader asked for the full chrome back: a tap on the pill, or the field took focus. */
  readonly onRestore?: () => void;
  readonly children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  const [keyboard, setKeyboard] = useState(0);
  const [height, setHeight] = useState(0);
  // Only the web padding follows these JS events; the composer itself is lifted natively by KeyboardFollower.
  useEffect(() => {
    if (!prompt) return;
    const show = Keyboard.addListener("keyboardWillShow", (event) => setKeyboard(event.endCoordinates.height));
    const hide = Keyboard.addListener("keyboardWillHide", () => setKeyboard(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, [prompt]);
  const rest = Math.max(insets.bottom, COMPOSER_GAP);
  const live = prompt && focused;
  const inset = !live || height === 0 ? 0 : height + (keyboard > 0 ? keyboard + COMPOSER_GAP : rest);
  useEffect(() => {
    onInset?.(inset);
  }, [onInset, inset]);
  const tone = plain ? background : grouped;
  if (!prompt) return <View style={[chrome.screen, { backgroundColor: tone }]}>{children}</View>;
  // The content runs full-bleed; the composer floats over it. UIKit's keyboard animation lifts it natively.
  return (
    <View style={[chrome.screen, { backgroundColor: tone }]}>
      <View style={{ flex: 1 }}>{children}</View>
      {focused ? (
        <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
          <View pointerEvents="box-none" style={{ flex: 1, justifyContent: "flex-end" }}>
            <Prompt
              place={place}
              bottom={rest}
              onHeight={setHeight}
              reading={reading}
              onCompact={onCompact}
              onRestore={onRestore}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

const COMPOSER_GAP = 8;

export function easeLayout(): void {
  LayoutAnimation.configureNext({
    duration: 250,
    create: { type: "easeInEaseOut", property: "opacity" },
    update: { type: "easeInEaseOut" },
    delete: { type: "easeInEaseOut", property: "opacity" },
  });
}

export const Prompt = observer(function PromptView({
  place,
  bottom,
  onHeight,
  reading = false,
  onCompact,
  onRestore,
}: {
  readonly place: Place;
  readonly bottom: number;
  readonly onHeight: (height: number) => void;
  readonly reading?: boolean;
  readonly onCompact?: (compact: boolean) => void;
  readonly onRestore?: (() => void) | undefined;
}) {
  useDrafts();
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const dial = useDial();
  const { kernel, held, glance } = useWorkspace();
  const type = useType();
  const wires = completionWires(dial.kernel?.root.connections);
  const choice = sessionModel(dial.session?.root);
  const quota = modelQuota(wires, choice);
  const key = draftKey(place);
  const draft = readDraft(key);
  const visuals = readVisuals(key);
  const field = useRef<ComponentRef<typeof TextInput>>(null);
  const [typing, setTyping] = useState(false);
  const [still, setStill] = useState(false);
  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setStill);
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setStill);
    return () => sub.remove();
  }, []);
  const ease = (): void => {
    if (!still) easeLayout();
  };
  const session = place.kind === "session" && dial.session?.root.sessionId === place.sessionId ? dial.session : null;
  const turn = session?.root.findRunningTurn() ?? null;
  const live = turn != null && turnIsLive(turn) && turn.uuid !== stoppingTurn() ? turn : null;
  const asking =
    place.kind === "session" && (live?.approvalHead != null || glance(place.sessionId)?.unfinished === "ask");
  const onboarding = kernel != null && needsOnboarding(kernel.root.connections);
  const roomReady = place.kind === "project" && held(place.path) != null;
  const linkDown = dial.link != null || dial.attaching;
  const sessionReady = session != null && dial.sessionRpc != null && !linkDown;
  const hasContent = draft.trim() !== "" || visuals.length > 0;
  const canSend =
    !isSending() &&
    hasContent &&
    !asking &&
    (place.kind === "project"
      ? roomReady && !onboarding && !linkDown
      : place.kind === "session" && sessionReady && live == null);
  const stoppable = place.kind === "session" && sessionReady && !asking && live != null && !isSending();
  // A draft being written while a turn runs used to hide both buttons. Send stays visible, held, and named.
  const sendHeld = place.kind === "session" && hasContent && live != null && !asking;
  const placeholderText =
    session?.root.head == null && place.kind === "session" ? "Ask or describe a change" : "Message";

  useEffect(() => {
    writeStatus("");
  }, [key]);

  useEffect(() => {
    if (place.kind !== "session" || dial.session?.root.sessionId !== place.sessionId || dial.sessionRpc == null) return;
    const queued = peekPrompt(place.sessionId);
    if (queued == null || flushing) return;
    const taken = takePrompt(place.sessionId);
    if (taken == null) return;
    flushing = true;
    const rpc = dial.sessionRpc;
    void deliver(
      (text, pictures) => rpc.request("turn", turnParams(text, pictures)),
      place.sessionId,
      taken.prompt,
      taken.visuals,
    ).finally(() => {
      flushing = false;
    });
  }, [place, dial.session, dial.sessionRpc]);

  // The push animation is what used to be an interaction. React Native 0.87 removed InteractionManager.
  useEffect(() => {
    if (place.kind !== "session" || !place.fresh) return;
    return navigation.addListener("transitionEnd", (event) => {
      if (event.data.closing) return;
      field.current?.focus();
    });
  }, [navigation, place]);

  function send(): void {
    if (!canSend) return;
    impact();
    const prompt = readDraft(key);
    const pictures = readVisuals(key);
    if (place.kind === "project") {
      const sessionId = mintId();
      writeDraft(key, "");
      writeVisuals(key, []);
      dial.prepareMint(sessionId);
      queuePrompt(sessionId, prompt, pictures);
      navigation.navigate("Session", { path: place.path, sessionId });
      return;
    }
    if (place.kind !== "session" || dial.sessionRpc == null) return;
    const rpc = dial.sessionRpc;
    writeDraft(key, "");
    writeVisuals(key, []);
    void deliver(
      (text, attached) => rpc.request("turn", turnParams(text, attached)),
      place.sessionId,
      prompt,
      pictures,
    );
  }

  function pasteImage(): void {
    const blocked = (): boolean => {
      const running = session?.root.findRunningTurn() ?? null;
      return running != null && turnIsLive(running) && running.uuid !== stoppingTurn();
    };
    if (blocked()) {
      writeStatus("A turn is still running, so the picture was not added.");
      return;
    }
    void Clipboard.getImage()
      .then((raw) => {
        if (blocked()) {
          writeStatus("A turn is still running, so the picture was not added.");
          return undefined;
        }
        const picture = typeof raw === "string" ? pictureFromClipboard(raw) : null;
        if (picture == null) {
          writeStatus("The clipboard has no image.");
          return undefined;
        }
        writeStatus("");
        writeVisuals(key, [...readVisuals(key), picture]);
        return undefined;
      })
      .catch((error: unknown) => {
        writeStatus(error instanceof Error ? error.message : "The clipboard has no image.");
      });
  }

  function removeVisual(index: number): void {
    writeVisuals(
      key,
      readVisuals(key).filter((_, at) => at !== index),
    );
  }

  function stop(): void {
    const rpc = dial.sessionRpc;
    const running = session?.root.findRunningTurn() ?? null;
    if (place.kind !== "session" || rpc == null || running == null || !turnIsLive(running)) return;
    writeStatus("");
    markStopping(running.uuid);
    void rpc
      .request("turn/cancel", { turnId: running.uuid })
      .then((result) => {
        if (!isAccepted(result)) {
          markStopping("");
          writeStatus("Stop was not accepted.");
        }
        return undefined;
      })
      .catch((error: unknown) => {
        markStopping("");
        writeStatus(error instanceof Error ? error.message : "Could not stop the turn.");
      });
  }

  const status = readStatus();
  const body = type.body;
  const showModel = place.kind === "session";
  const modelName = choice.model.trim() === "" ? "Model" : choice.model;
  const notes = [status, quota.failed && quota.text !== "" ? quota.text : "", sendHeld ? TURN_RUNNING : ""].filter(
    (line) => line !== "",
  );
  // At rest the composer is one Messages-style line; focus, a draft, pictures, or a note open it up.
  const expanded = typing || hasContent || notes.length > 0;
  const collapsedStop = !expanded && stoppable;
  // Reading shrinks the composer further, to a pill, but never one that holds a draft or a note.
  const compact = reading && !expanded;
  useEffect(() => {
    onCompact?.(compact);
  }, [onCompact, compact]);
  // A tap on the pill brings the field back and then focuses it.
  const focusNext = useRef(false);
  useEffect(() => {
    if (compact || !focusNext.current) return;
    focusNext.current = false;
    field.current?.focus();
  }, [compact]);
  return (
    <View
      collapsable={false}
      pointerEvents="box-none"
      style={{ marginHorizontal: 12, marginBottom: bottom, alignItems: compact ? "center" : "stretch" }}
      onLayout={(event) => {
        // The inset stays at the full composer's height, so the text does not shift under the pill.
        if (!compact) onHeight(Math.round(event.nativeEvent.layout.height));
      }}
    >
      <KeyboardFollower gap={COMPOSER_GAP} />
      {compact ? (
        <Glass radius="capsule" interactive style={{ flexDirection: "row", alignItems: "center", minHeight: 36 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={placeholderText}
            accessibilityHint="Opens the message field"
            hitSlop={4}
            onPress={() => {
              focusNext.current = true;
              onRestore?.();
            }}
            style={({ pressed }) => [
              {
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                minHeight: 36,
                paddingLeft: 14,
                paddingRight: stoppable ? 8 : 14,
              },
              pressed ? { opacity: 0.55 } : null,
            ]}
          >
            <Symbol name="square.and.pencil" size={13} color={secondary} />
            <Label role="footnote">Message</Label>
          </Pressable>
          {stoppable ? (
            <View hitSlop={4} style={{ paddingRight: 2 }}>
              <GlassButton
                symbol="stop.fill"
                accessibilityLabel="Stop"
                tint={red}
                prominent
                style={{ width: 32, height: 32 }}
                onPress={stop}
              />
            </View>
          ) : null}
        </Glass>
      ) : null}
      <Glass
        radius={expanded ? 24 : "capsule"}
        style={
          compact
            ? { display: "none" }
            : expanded
              ? { paddingHorizontal: 14, paddingTop: 10, paddingBottom: 6, gap: 4 }
              : { paddingLeft: 16, paddingRight: collapsedStop ? 6 : 16, paddingVertical: 4, minHeight: 48 }
        }
      >
        {notes.map((line) => (
          <Label key={line} accessibilityLiveRegion="polite" role="footnote" numberOfLines={2}>
            {line}
          </Label>
        ))}
        {visuals.length === 0 ? null : (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, paddingVertical: 2 }}>
            {visuals.map((picture, index) => (
              <View
                key={`${index}:${picture.mime}:${picture.sourcePath ?? ""}:${picture.bytesBase64.length}`}
                style={{ width: 56, height: 56 }}
              >
                <Image
                  accessibilityLabel="Attached picture"
                  source={{ uri: `data:${picture.mime};base64,${picture.bytesBase64}` }}
                  style={{ width: 56, height: 56, borderRadius: 8, backgroundColor: fill }}
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Remove picture"
                  hitSlop={8}
                  onPress={() => removeVisual(index)}
                  style={({ pressed }) => [
                    { position: "absolute", top: 2, right: 2, borderRadius: 9, backgroundColor: card },
                    pressed ? { opacity: 0.55 } : null,
                  ]}
                >
                  <Symbol name="xmark.circle.fill" size={18} color={label} />
                </Pressable>
              </View>
            ))}
          </View>
        )}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <TextInput
            ref={field}
            accessibilityLabel={placeholderText}
            allowFontScaling={false}
            editable={place.kind !== "projects" && !asking}
            multiline
            placeholder={placeholderText}
            placeholderTextColor={placeholder}
            textAlignVertical={expanded ? "top" : "center"}
            value={draft}
            onFocus={() => {
              ease();
              setTyping(true);
              onRestore?.();
            }}
            onBlur={() => {
              ease();
              setTyping(false);
            }}
            onChangeText={(value) => {
              if ((value.trim() === "") !== (draft.trim() === "")) ease();
              writeDraft(key, value);
            }}
            style={{
              fontSize: body.fontSize,
              lineHeight: body.lineHeight,
              fontWeight: body.fontWeight,
              flex: 1,
              minHeight: expanded ? body.lineHeight + 4 : 40,
              maxHeight: expanded ? Math.round(body.lineHeight * 5) : 40,
              margin: 0,
              paddingTop: expanded ? 2 : 9,
              paddingBottom: expanded ? 2 : 9,
              paddingHorizontal: 0,
              color: label,
              backgroundColor: "transparent",
            }}
          />
          {collapsedStop ? (
            <View hitSlop={4}>
              <GlassButton
                symbol="stop.fill"
                accessibilityLabel="Stop"
                tint={red}
                prominent
                style={{ width: 36, height: 36 }}
                onPress={stop}
              />
            </View>
          ) : null}
        </View>
        {expanded ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4, minHeight: 44 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Paste an image from the clipboard. This app has no photo library or document picker."
              onPress={pasteImage}
              style={({ pressed }) => [
                { width: 44, height: 44, alignItems: "center", justifyContent: "center", marginLeft: -10 },
                pressed ? { opacity: 0.55 } : null,
              ]}
            >
              <Symbol name="photo" size={20} color={secondary} />
            </Pressable>
            {showModel ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Model, ${modelName}`}
                accessibilityHint="Opens the model list"
                onPress={openModel}
                style={({ pressed }) => [
                  { flexShrink: 1, flexDirection: "row", alignItems: "center", gap: 4, minHeight: 44 },
                  pressed ? { opacity: 0.55 } : null,
                ]}
              >
                <View style={{ flexShrink: 1 }}>
                  <Label role="subhead" numberOfLines={1} ellipsizeMode="middle">
                    {modelName}
                  </Label>
                </View>
                <Symbol name="chevron.up.chevron.down" size={11} color={secondary} />
              </Pressable>
            ) : null}
            <View style={{ flex: 1 }} />
            {stoppable ? (
              <View hitSlop={4}>
                <GlassButton
                  symbol="stop.fill"
                  accessibilityLabel="Stop"
                  tint={red}
                  prominent
                  style={{ width: 36, height: 36 }}
                  onPress={stop}
                />
              </View>
            ) : hasContent ? (
              <View hitSlop={4}>
                <GlassButton
                  symbol="arrow.up"
                  accessibilityLabel="Send"
                  prominent
                  disabled={!canSend}
                  style={{ width: 36, height: 36 }}
                  onPress={send}
                />
              </View>
            ) : null}
          </View>
        ) : null}
      </Glass>
    </View>
  );
});
