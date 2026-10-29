import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { observer } from "mobx-react-lite";

import { useAttention } from "./attention.js";
import { attentionItem, settingsItem } from "./bar.js";
import { Column } from "./composer.js";
import { ATTACHING, CONNECT_MODEL, linkSentence, NO_MATCH, NO_SESSIONS, ONBOARDING } from "./copy.js";
import { ageLabel, matchesQuery, mintId, orderedIds, SEARCH_AFTER, sessionLabel } from "./directory.js";
import { NativeList } from "./native-list.js";
import { type MainStackParamList, openAttention, openSettings } from "./navigation.js";
import { useWorkspace } from "./roster.js";
import { useScreen, type Place } from "./shell.js";
import { statusRow } from "./status-row.js";
import { useFollow } from "./use-follow.js";
import { needsOnboarding } from "../../harness-web-app/src/shell/provider-list.js";

export const SessionsScreen = observer(function SessionsList({
  navigation,
  route,
}: NativeStackScreenProps<MainStackParamList, "Sessions">) {
  const { path, name } = route.params;
  const heading = name.trim() !== "" ? name : (path.split("/").findLast(Boolean) ?? "Sessions");
  const place = useMemo<Place>(() => ({ kind: "project", path }), [path]);
  useScreen(place);
  const attention = useAttention(null);
  const target = useMemo(() => ({ kind: "project" as const, path }), [path]);
  useFollow(target);
  const { dial, kernel, held, glance, lightFor, conversationIds } = useWorkspace();
  const [query, setQuery] = useState("");
  const room = held(path);
  const ids = conversationIds(path);
  const searching = ids.length > SEARCH_AFTER;
  useEffect(() => {
    if (!searching) setQuery("");
  }, [searching]);
  const onboarding = kernel != null && needsOnboarding(kernel.root.connections);
  const canMint = room != null && !onboarding && dial.link == null && !dial.attaching;
  useLayoutEffect(() => {
    navigation.setOptions({
      title: heading,
      headerLargeTitle: true,
      headerSearchBarOptions: searching
        ? {
            placeholder: "Sessions",
            hideWhenScrolling: false,
            autoCapitalize: "none",
            onChangeText: (event) => setQuery(event.nativeEvent.text),
          }
        : undefined,
      unstable_headerRightItems: () => [
        {
          type: "button",
          label: "New session",
          accessibilityLabel: "New session",
          icon: { type: "sfSymbol", name: "square.and.pencil" },
          disabled: !canMint,
          onPress: () => {
            const sessionId = mintId();
            dial.prepareMint(sessionId);
            navigation.navigate("Session", { path, sessionId, fresh: true });
          },
        },
        settingsItem(() => openSettings({ kind: "project", path })),
        attentionItem(attention.tone, attention.count, () => openAttention(null)),
      ],
    });
  }, [navigation, heading, searching, canMint, dial, path, attention.tone, attention.count]);
  const now = Date.now();
  const ordered = orderedIds(ids, lightFor, (id) => glance(id)?.lastMessageAt ?? Number.POSITIVE_INFINITY);
  const shown = ordered.filter((id) => matchesQuery(query, [sessionLabel(glance(id)), path]));
  const sentence = dial.link == null ? null : linkSentence(dial.link.kind);
  const notice = [sentence, onboarding ? ONBOARDING : null].filter((part) => part != null).join("\n");
  const emptyTitle =
    shown.length > 0
      ? undefined
      : room == null
        ? dial.attaching
          ? ATTACHING
          : NO_SESSIONS
        : ids.length === 0
          ? NO_SESSIONS
          : NO_MATCH;
  return (
    <Column place={place} prompt={false}>
      <NativeList
        sections={[
          {
            key: "sessions",
            rows: shown.map((id) => ({
              key: id,
              title: sessionLabel(glance(id), dial.session?.root.sessionId === id ? dial.session.root.title : ""),
              value: ageLabel(glance(id), now),
              disclosure: true,
              ...statusRow(lightFor(id), 0),
            })),
          },
        ]}
        notice={notice === "" ? undefined : notice}
        noticeAction={onboarding ? CONNECT_MODEL : undefined}
        onNoticeAction={() => openSettings({ kind: "workspace" })}
        emptyTitle={emptyTitle}
        onPressRow={(sessionId) => navigation.navigate("Session", { path, sessionId })}
      />
    </Column>
  );
});
