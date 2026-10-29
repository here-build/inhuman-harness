import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Tape } from "@inhuman.tools/harness-transcript";
import { useHeaderHeight } from "@react-navigation/elements";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { observer } from "mobx-react-lite";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Keyboard,
  Pressable,
  useColorScheme,
  View,
  type ColorValue,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAttention } from "./attention.js";
import { attentionItem } from "./bar.js";
import { background, Empty, label, Notice, orange, red } from "./chrome.js";
import { Column, easeLayout } from "./composer.js";
import { linkSentence, NO_MESSAGES, NO_MESSAGES_DETAIL, OPENING_SESSION } from "./copy.js";
import { sessionLabel } from "./directory.js";
import { applyEditedDraft } from "./drafts.js";
import { Glass } from "./glass.js";
import { type MainStackParamList, openAttention } from "./navigation.js";
import { useWorkspace } from "./roster.js";
import { useScreen, type Place } from "./shell.js";
import { useTranscriptHost } from "./transcript.js";
import { Label } from "./type.js";
import { useFollow } from "./use-follow.js";

/** The system accessibility settings that change how the chrome may move or hide. */
function useAccessibility(): { readonly screenReader: boolean; readonly still: boolean } {
  const [screenReader, setScreenReader] = useState(false);
  const [still, setStill] = useState(false);
  useEffect(() => {
    void AccessibilityInfo.isScreenReaderEnabled().then(setScreenReader);
    void AccessibilityInfo.isReduceMotionEnabled().then(setStill);
    const reader = AccessibilityInfo.addEventListener("screenReaderChanged", setScreenReader);
    const motion = AccessibilityInfo.addEventListener("reduceMotionChanged", setStill);
    return () => {
      reader.remove();
      motion.remove();
    };
  }, []);
  return { screenReader, still };
}

/** How far below the status bar the top fade reaches, past the title capsule. */
const FADE = 48;

/** The title, small and centered under the status bar, in place of the navigation bar while reading. */
function TitlePill({
  title,
  shown,
  still,
  badge,
  onPress,
}: {
  readonly title: string;
  readonly shown: boolean;
  readonly still: boolean;
  readonly badge: ColorValue | null;
  readonly onPress: () => void;
}) {
  const insets = useSafeAreaInsets();
  // Gradients take plain colors, not the system's dynamic ones: the transcript canvas is white or black.
  const dark = useColorScheme() === "dark";
  const canvas = dark ? "#000000" : "#ffffff";
  const clear = dark ? "rgba(0,0,0,0)" : "rgba(255,255,255,0)";
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const motion = still
      ? Animated.timing(progress, { toValue: shown ? 1 : 0, duration: 150, useNativeDriver: true })
      : Animated.spring(progress, { toValue: shown ? 1 : 0, speed: 20, bounciness: 0, useNativeDriver: true });
    motion.start();
    return () => motion.stop();
  }, [progress, shown, still]);
  const scale = still ? 1 : progress.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1] });
  return (
    <>
      {/* The bar's soft edge goes with it. This fade keeps text from running under the clock and the title. */}
      <Animated.View
        pointerEvents="none"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: insets.top + FADE,
          backgroundImage: `linear-gradient(to bottom, ${canvas} 0px, ${canvas} ${insets.top}px, ${clear} 100%)`,
          opacity: progress,
        }}
      />
      <Animated.View
        pointerEvents={shown ? "box-none" : "none"}
        accessibilityElementsHidden={!shown}
        importantForAccessibility={shown ? "auto" : "no-hide-descendants"}
        style={{
          position: "absolute",
          top: insets.top + 4,
          left: 0,
          right: 0,
          alignItems: "center",
          opacity: progress,
          transform: [{ scale }],
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={title}
          accessibilityHint="Shows the navigation bar"
          hitSlop={8}
          onPress={onPress}
          style={({ pressed }) => [{ maxWidth: "60%" }, pressed ? { opacity: 0.55 } : null]}
        >
          <Glass
            radius="capsule"
            interactive
            style={{ minHeight: 28, paddingHorizontal: 12, justifyContent: "center" }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <View style={{ flexShrink: 1 }}>
                <Label role="footnote" color={label} style={{ fontWeight: "600" }} numberOfLines={1}>
                  {title}
                </Label>
              </View>
              {badge == null ? null : <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: badge }} />}
            </View>
          </Glass>
        </Pressable>
      </Animated.View>
    </>
  );
}

export const SessionScreen = observer(function SessionView({
  navigation,
  route,
}: NativeStackScreenProps<MainStackParamList, "Session">) {
  const { path, sessionId } = route.params;
  const fresh = route.params.fresh === true;
  const place = useMemo<Place>(() => ({ kind: "session", path, sessionId, fresh }), [path, sessionId, fresh]);
  useScreen(place);
  const attention = useAttention(null);
  const { dial, glance } = useWorkspace();
  const target = useMemo(
    () =>
      path === "" ? { kind: "session" as const, sessionId } : { kind: "project-session" as const, path, sessionId },
    [path, sessionId],
  );
  useFollow(target);
  const session = dial.session?.root.sessionId === sessionId ? dial.session : null;
  const peek = glance(sessionId);
  const title = sessionLabel(peek, session?.root.title ?? "");
  const headerHeight = useHeaderHeight();
  const host = useTranscriptHost();
  const [bottom, setBottom] = useState(0);
  const onInset = useCallback((value: number) => setBottom(value), []);
  const { screenReader, still } = useAccessibility();
  // Reading shrinks the header and the composer. A screen reader keeps both whole.
  const [away, setAway] = useState(false);
  const [compact, setCompact] = useState(false);
  const reading = true; // TEMPHACK
  const onReading = useCallback(
    (value: boolean) => {
      if (!still) easeLayout();
      setAway(value);
    },
    [still],
  );
  const onRestore = useCallback(() => onReading(false), [onReading]);
  useEffect(() => {
    setAway(false);
  }, [sessionId]);
  useEffect(() => {
    const show = Keyboard.addListener("keyboardWillShow", () => setAway(false));
    return () => show.remove();
  }, []);
  // The header height is zero while the bar is hidden. The text keeps the room it had, so nothing jumps.
  const [roomy, setRoomy] = useState(headerHeight);
  useEffect(() => {
    if (!compact && headerHeight > 0) setRoomy(headerHeight);
  }, [compact, headerHeight]);
  const top = compact ? Math.max(roomy, headerHeight) : headerHeight;
  const inset = useMemo(() => ({ top, bottom }), [top, bottom]);
  const onEditDraft = useCallback(
    (
      prompt: string,
      visuals: readonly { readonly mime: string; readonly bytesBase64: string; readonly sourcePath: string | null }[],
    ) => applyEditedDraft(sessionId, prompt, visuals),
    [sessionId],
  );

  useLayoutEffect(() => {
    navigation.setOptions({
      title,
      unstable_headerRightItems: () => [attentionItem(attention.tone, attention.count, () => openAttention(null))],
    });
  }, [navigation, title, attention.tone, attention.count]);

  useLayoutEffect(() => {
    navigation.setOptions({ headerShown: !compact });
  }, [navigation, compact]);

  const sentence = dial.link == null ? null : linkSentence(dial.link.kind);

  return (
    <Column place={place} prompt plain onInset={onInset} reading={reading} onCompact={setCompact} onRestore={onRestore}>
      <View collapsable={false} style={{ flex: 1 }}>
        <Tape
          dial={dial}
          sessionId={sessionId}
          host={host}
          inset={inset}
          onEditDraft={onEditDraft}
          onReading={onReading}
          loading={
            <View
              accessible
              accessibilityLabel={OPENING_SESSION}
              accessibilityLiveRegion="polite"
              style={{
                flex: 1,
                alignItems: "center",
                justifyContent: "center",
                gap: 12,
                paddingTop: top,
                paddingBottom: bottom,
              }}
            >
              <ActivityIndicator size="large" />
              <Label role="subhead">{OPENING_SESSION}</Label>
            </View>
          }
          empty={
            <View
              pointerEvents="none"
              style={{
                flex: 1,
                justifyContent: "center",
                paddingHorizontal: 32,
                paddingTop: top,
                paddingBottom: bottom,
              }}
            >
              <Empty title={NO_MESSAGES} detail={NO_MESSAGES_DETAIL} />
            </View>
          }
        />
        <TitlePill
          title={title}
          shown={compact}
          still={still}
          badge={attention.count === 0 ? null : attention.tone === "red" ? red : orange}
          onPress={onRestore}
        />
        {sentence == null ? null : (
          <View style={{ position: "absolute", left: 0, right: 0, bottom, backgroundColor: background }}>
            <Notice>{sentence}</Notice>
          </View>
        )}
      </View>
    </Column>
  );
});
