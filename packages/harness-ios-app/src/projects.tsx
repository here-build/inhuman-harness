import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Clipboard from "@react-native-clipboard/clipboard";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { observer } from "mobx-react-lite";

import { useAttention } from "./attention.js";
import { attentionItem, settingsItem } from "./bar.js";
import { Column } from "./composer.js";
import {
  ATTACHING,
  CONNECT_MODEL,
  linkSentence,
  NO_PROJECT_MATCH,
  NO_PROJECTS,
  NO_PROJECTS_DETAIL,
  ONBOARDING,
} from "./copy.js";
import { botGroups, matchesQuery, SEARCH_AFTER } from "./directory.js";
import { remember } from "./host.js";
import { NativeList, type ListSection } from "./native-list.js";
import { type MainStackParamList, openAttention, openSettings, wasLinked } from "./navigation.js";
import { useWorkspace } from "./roster.js";
import { recallPlace, useScreen, type Place } from "./shell.js";
import { statusRow } from "./status-row.js";
import { useFollow } from "./use-follow.js";
import { needsOnboarding } from "../../harness-web-app/src/shell/provider-list.js";

export const ProjectsScreen = observer(function ProjectsList({
  navigation,
}: NativeStackScreenProps<MainStackParamList, "Projects">) {
  const place = useMemo<Place>(() => ({ kind: "projects" }), []);
  useScreen(place);
  const attention = useAttention(null);
  const target = useMemo(() => ({ kind: "kernel" as const }), []);
  useFollow(target);
  const { dial, kernel, paths, names, held, lightFor, statusFor } = useWorkspace();
  const [query, setQuery] = useState("");
  const searching = paths.length > SEARCH_AFTER;
  const restored = useRef(false);
  const listed = paths.join("\0");
  useEffect(() => {
    if (!searching) setQuery("");
  }, [searching]);
  useEffect(() => {
    if (restored.current || listed === "") return;
    restored.current = true;
    const known = new Set(listed.split("\0"));
    void recallPlace().then((memory) => {
      if (!navigation.isFocused() || wasLinked()) return undefined;
      if (memory != null && known.has(memory.path)) {
        if (memory.sessionId != null)
          navigation.navigate("Session", { path: memory.path, sessionId: memory.sessionId });
        else navigation.navigate("Sessions", { path: memory.path, name: names.get(memory.path) ?? memory.path });
        return undefined;
      }
      remember("");
      return undefined;
    });
  }, [listed, navigation]);
  useLayoutEffect(() => {
    navigation.setOptions({
      title: "Projects",
      headerLargeTitle: true,
      headerSearchBarOptions: searching
        ? {
            placeholder: "Projects",
            hideWhenScrolling: false,
            autoCapitalize: "none",
            onChangeText: (event) => setQuery(event.nativeEvent.text),
          }
        : undefined,
      // The bell lives beside Settings on every screen; a left slot reads as Back on a stack.
      unstable_headerRightItems: () => [
        attentionItem(attention.tone, attention.count, () => openAttention(null)),
        settingsItem(() => openSettings({ kind: "workspace" })),
      ],
    });
  }, [navigation, searching, attention.tone, attention.count]);
  const rows = paths
    .map((path) => ({ path, name: names.get(path) ?? path, ...statusFor(path) }))
    .filter((row) => matchesQuery(query, [row.name, row.path]));
  const groups = botGroups(
    kernel?.root.botsRoster ?? {},
    paths.map((path) => ({
      path,
      name: names.get(path) ?? path,
      roster: held(path)?.root.botsRoster ?? {},
    })),
  ).filter((group) => matchesQuery(query, [group.name, ...group.bots.map((bot) => bot.name)]));
  const bots = groups.flatMap((group) =>
    group.bots.map((bot) => ({
      key: `${group.key}:${bot.sessionId}`,
      name: bot.name,
      sessionId: bot.sessionId,
      path: group.path,
      group: group.name,
    })),
  );
  const onboarding = kernel != null && needsOnboarding(kernel.root.connections);
  const sentence = dial.link == null ? null : linkSentence(dial.link.kind);
  const attached = paths.some((path) => held(path) != null);
  const sections: ListSection[] = [
    {
      key: "projects",
      rows: rows.map((item) => ({
        key: `project:${item.path}`,
        title: item.name,
        detail: item.path,
        detailMiddle: true,
        disclosure: true,
        ...statusRow(item.light, item.waiting),
        menu: [{ id: "copy", title: "Copy Path", symbol: "doc.on.doc" }],
      })),
    },
    ...(bots.length === 0
      ? []
      : [
          {
            key: "bots",
            header: "Bots",
            rows: bots.map((bot) => ({
              key: `bot:${bot.key}`,
              title: bot.name,
              detail: bot.group,
              disclosure: true,
              ...statusRow(lightFor(bot.sessionId), 0),
            })),
          },
        ]),
  ];
  const empty =
    rows.length > 0 || bots.length > 0
      ? null
      : paths.length === 0
        ? { title: NO_PROJECTS, detail: NO_PROJECTS_DETAIL }
        : query.trim() !== ""
          ? { title: NO_PROJECT_MATCH, detail: undefined }
          : attached
            ? null
            : { title: ATTACHING, detail: undefined };
  const notice = [sentence, onboarding ? ONBOARDING : null].filter((part) => part != null).join("\n");
  return (
    <Column place={place} prompt={false}>
      <NativeList
        sections={sections}
        notice={notice === "" ? undefined : notice}
        noticeAction={onboarding ? CONNECT_MODEL : undefined}
        onNoticeAction={() => openSettings({ kind: "workspace" })}
        emptyTitle={empty?.title}
        emptyDetail={empty?.detail}
        onPressRow={(key) => {
          if (key.startsWith("project:")) {
            const item = rows.find((row) => row.path === key.slice(8));
            if (item != null) navigation.navigate("Sessions", { path: item.path, name: item.name });
            return;
          }
          const bot = bots.find((entry) => `bot:${entry.key}` === key);
          if (bot != null) navigation.navigate("Session", { path: bot.path, sessionId: bot.sessionId });
        }}
        onMenuRow={(key, action) => {
          if (action === "copy" && key.startsWith("project:")) Clipboard.setString(key.slice(8));
        }}
      />
    </Column>
  );
});
