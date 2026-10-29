import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FileMutateToolJob, ToolCallJob } from "@inhuman.tools/harness-model";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { observer } from "mobx-react-lite";
import { AccessibilityInfo, Pressable, SectionList, View } from "react-native";

import { decide, retrySession } from "./act.js";
import { useAttention } from "./attention.js";
import { cardChrome, chrome, EDGE, Empty, grouped, Hairline, Notice } from "./chrome.js";
import { ANSWER_SHORTLY, NOTHING_WAITING } from "./copy.js";
import { useDial } from "./dial-context.js";
import { actLine, sessionLabel, sessionProblem, waitingTitle, type ConnectionFace } from "./directory.js";
import { readDraft, useDrafts } from "./drafts.js";
import { GlassButton } from "./glass-button.js";
import { impact, listenForCommands } from "./host.js";
import { type RootParamList, showSession } from "./navigation.js";
import { useWorkspace } from "./roster.js";
import { Label } from "./type.js";
import { askHeading, askRisk, type AskAct } from "../../harness-web-app/src/shell/ask-risk.js";
import {
  armCover,
  confirmCover,
  seatForAsk,
  throttleMs,
  type CoverSeat,
} from "../../harness-web-app/src/shell/cover.js";
import { toolLabel } from "../../harness-web-app/src/shell/tool-label.js";

function toAct(ask: ToolCallJob, projectPath: string): AskAct {
  return {
    name: ask.name,
    args: ask.args,
    projectPath,
    existed: ask instanceof FileMutateToolJob ? ask.existed : null,
  };
}

const AskRow = observer(function AskRowView({
  path,
  sessionId,
  listen,
  onOpen,
}: {
  readonly path: string;
  readonly sessionId: string;
  readonly listen: boolean;
  readonly onOpen: () => void;
}) {
  useDrafts();
  const dial = useDial();
  const { glance, kernel } = useWorkspace();
  const seated = dial.session?.root.sessionId === sessionId ? dial.session : null;
  const head = seated?.root.findRunningTurn()?.approvalHead ?? null;
  const act = head instanceof ToolCallJob ? toAct(head, path) : null;
  const risk = act == null ? { destructive: false, phrase: "" } : askRisk(act);
  const heading = act == null ? waitingTitle(glance(sessionId)) : askHeading(act, toolLabel);
  const line = act == null ? "" : actLine(act.args);
  const name = sessionLabel(glance(sessionId), seated?.root.title ?? "");
  const leafId = head?.uuid ?? sessionId;
  const waitMs = throttleMs(kernel?.root.approvalAskThrottleMs);
  const [seat, setSeat] = useState<CoverSeat>({ phase: "inert", leafId: null });
  const [note, setNote] = useState("");
  const deciding = useRef(false);
  const draftEmpty = readDraft(sessionId).trim() === "";

  useEffect(() => {
    setSeat((previous) => seatForAsk(previous, leafId, draftEmpty, waitMs));
  }, [leafId, draftEmpty, waitMs]);

  useEffect(() => {
    if (seat.phase !== "cover_throttled") return;
    const current = seat.leafId;
    const timer = setTimeout(() => {
      setSeat((value) => (value.leafId === current ? armCover(value) : value));
    }, waitMs);
    return () => clearTimeout(timer);
  }, [seat.phase, seat.leafId, waitMs]);

  const armed = confirmCover(seat, leafId);
  const answerRef = useRef<(allow: boolean) => void>(() => undefined);

  async function answer(allow: boolean): Promise<void> {
    if (!armed || deciding.current) return;
    deciding.current = true;
    setNote("");
    const error = await decide(dial, sessionId, path, allow);
    deciding.current = false;
    if (error !== "") setNote(error);
  }

  answerRef.current = (allow) => {
    void answer(allow);
  };

  useEffect(() => {
    if (!armed || !listen) return;
    impact();
    AccessibilityInfo.announceForAccessibility(heading);
    return listenForCommands((command) => answerRef.current(command === "allow"));
  }, [armed, listen, heading, leafId]);

  return (
    <View style={{ paddingHorizontal: EDGE, paddingVertical: 14, gap: 10 }}>
      <Pressable accessibilityRole="button" onPress={onOpen}>
        <Label>{heading}</Label>
        {line !== "" && line !== heading ? <Label role="subhead">{line}</Label> : null}
        {name !== heading ? <Label role="subhead">{name}</Label> : null}
        {risk.phrase === "" ? null : <Label role="subhead">{risk.phrase}</Label>}
      </Pressable>
      {note === "" ? null : <Notice>{note}</Notice>}
      {seat.phase === "cover_throttled" ? (
        <Label accessibilityLiveRegion="polite" role="footnote">
          {ANSWER_SHORTLY}
        </Label>
      ) : null}
      <View style={chrome.actions}>
        <GlassButton
          title="Deny"
          size="large"
          disabled={!armed}
          style={{ flex: 1, height: 50 }}
          onPress={() => void answer(false)}
        />
        <GlassButton
          title="Allow"
          prominent
          destructive={risk.destructive}
          size="large"
          disabled={!armed}
          style={{ flex: 1, height: 50 }}
          onPress={() => void answer(true)}
        />
      </View>
    </View>
  );
});

const ProblemRow = observer(function ProblemRowView({
  path,
  sessionId,
  onOpen,
}: {
  readonly path: string;
  readonly sessionId: string;
  readonly onOpen: () => void;
}) {
  const dial = useDial();
  const { glance, kernel } = useWorkspace();
  const connections = kernel?.root.connections as Readonly<Record<string, ConnectionFace | undefined>> | undefined;
  const problem =
    sessionProblem(glance(sessionId), connections) ?? glance(sessionId)?.status ?? "Something went wrong.";
  const name = sessionLabel(glance(sessionId));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function retry(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setNote("");
    const error = await retrySession(dial, sessionId, path);
    setBusy(false);
    if (error !== "") setNote(error);
  }

  return (
    <View style={chrome.row}>
      <Pressable accessibilityRole="button" onPress={onOpen} style={chrome.rowBody}>
        <Label>{problem}</Label>
        {name === problem ? null : <Label role="subhead">{name}</Label>}
        {note === "" ? null : <Label role="subhead">{note}</Label>}
      </Pressable>
      <GlassButton
        symbol="arrow.clockwise"
        accessibilityLabel="Retry"
        disabled={busy}
        style={{ width: 44, height: 44 }}
        onPress={() => void retry()}
      />
    </View>
  );
});

export const AttentionScreen = observer(function AttentionView({
  navigation,
  route,
}: NativeStackScreenProps<RootParamList, "Attention">) {
  const { glance } = useWorkspace();
  const report = useAttention(route.params.path);
  const firstAsk =
    report.sections.flatMap((section) => section.sessionIds).find((id) => report.kindFor(id) === "ask") ?? null;
  const sections = report.sections.map((section) => ({
    key: section.path === "" ? "global" : section.path,
    path: section.path,
    name: section.name,
    data: [...section.sessionIds],
  }));

  useLayoutEffect(() => {
    navigation.setOptions({
      title: "Attention",
      unstable_headerLeftItems: () => [
        {
          type: "button",
          label: "Close",
          icon: { type: "sfSymbol", name: "xmark" },
          accessibilityLabel: "Close",
          onPress: () => navigation.goBack(),
        },
      ],
    });
  }, [navigation]);

  function open(path: string, sessionId: string): void {
    showSession(path, sessionId);
  }

  return (
    <SectionList
      sections={sections}
      keyExtractor={(id) => id}
      contentInsetAdjustmentBehavior="automatic"
      style={{ flex: 1, backgroundColor: grouped }}
      contentContainerStyle={sections.length === 0 ? { flexGrow: 1, justifyContent: "center" } : { paddingBottom: 24 }}
      ListEmptyComponent={<Empty symbol="checkmark.circle" title={NOTHING_WAITING} />}
      renderSectionHeader={({ section }) => (
        <Label role="footnote" style={[chrome.section, { backgroundColor: grouped }]}>
          {section.name}
        </Label>
      )}
      renderItem={({ item, index, section }) => {
        const kind = report.kindFor(item);
        const body =
          kind === "ask" ? (
            <AskRow
              listen={item === firstAsk}
              path={section.path}
              sessionId={item}
              onOpen={() => open(section.path, item)}
            />
          ) : kind === "bad" ? (
            <ProblemRow path={section.path} sessionId={item} onOpen={() => open(section.path, item)} />
          ) : (
            <Pressable accessibilityRole="button" onPress={() => open(section.path, item)} style={chrome.row}>
              <View style={chrome.rowBody}>
                <Label>{waitingTitle(glance(item))}</Label>
                {sessionLabel(glance(item)) === waitingTitle(glance(item)) ? null : (
                  <Label role="subhead">{sessionLabel(glance(item))}</Label>
                )}
              </View>
            </Pressable>
          );
        return (
          <View style={cardChrome(index, section.data.length)}>
            {body}
            {index < section.data.length - 1 ? <Hairline /> : null}
          </View>
        );
      }}
    />
  );
});
