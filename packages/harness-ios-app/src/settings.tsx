import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useFocusEffect } from "@react-navigation/native";
import {
  type NativeStackNavigationOptions,
  type NativeStackScreenProps,
  createNativeStackNavigator,
} from "@react-navigation/native-stack";
import { observer } from "mobx-react-lite";
import {
  ActivityIndicator,
  InputAccessoryView,
  Keyboard,
  Linking,
  Platform,
  PlatformColor,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  TextInput,
  View,
  type ColorValue,
} from "react-native";

import {
  blue,
  cardChrome,
  green,
  orange,
  chrome,
  Empty,
  fill,
  grouped,
  Hairline,
  label as ink,
  Notice,
  placeholder as placeholderColor,
  red,
  secondary,
  separator,
} from "./chrome.js";
import { choose, confirmRemove, useDiscard } from "./confirm.js";
import { useDial } from "./dial-context.js";
import { GlassButton } from "./glass-button.js";
import { NativeList, type ListSection } from "./native-list.js";
import type { RootParamList, SettingsParams } from "./navigation.js";
import { GroupedRow } from "./rows.js";
import { useShell } from "./shell.js";
import { Symbol } from "./symbol.js";
import { Label, useType } from "./type.js";
import {
  mcpDrafts,
  mcpHint,
  mcpOption,
  mcpPayload,
  mcpPoolCaption,
  mcpServerOptions,
  serverChoices,
  type McpGrantDraft,
  type McpServerOption,
} from "../../harness-web-app/src/shell/bot-mcp.js";
import { openUrlFieldType, parsePark, type ParkForm } from "../../harness-web-app/src/shell/connect-park.js";
import {
  mcpCopies,
  mcpLoginLine,
  registryAddWord,
  registryDetail,
  registryHits,
  registryStatus,
  type RegistryHit,
} from "../../harness-web-app/src/shell/mcp-registry.js";
import {
  GROUP_LABELS,
  GROUPS,
  providerRows,
  type ConnectStart,
} from "../../harness-web-app/src/shell/provider-list.js";
import { wireAccount } from "../../harness-web-app/src/shell/wire-account.js";

type Scope = "home" | "project";
type Mode = "manual" | "auto" | "yolo";
type Request = (method: string, params: unknown) => Promise<unknown>;

type SettingsStackParamList = {
  Menu: SettingsParams;
  Connections: undefined;
  Mcp: undefined;
  AddModel: undefined;
  AddMcp: undefined;
  Plugins: undefined;
  Plugin: { readonly name: string };
  Skills: { readonly project: string | null };
  Skill: {
    readonly project: string | null;
    readonly name: string;
    readonly description: string;
    readonly location: string;
    readonly invoke: string;
    readonly scope: Scope;
  };
  SkillNew: { readonly project: string | null };
  Bots: { readonly project: string | null };
  BotEdit: { readonly project: string | null; readonly name?: string };
  Security: undefined;
  Advanced: undefined;
};

type Screen<Name extends keyof SettingsStackParamList> = NativeStackScreenProps<SettingsStackParamList, Name>;

const SettingsStack = createNativeStackNavigator<SettingsStackParamList>();
const indigo = PlatformColor("systemIndigo");
const teal = PlatformColor("systemTeal");
const iconGray = "#636366";

const MODE_LABEL: Record<Mode, string> = {
  manual: "Manual",
  auto: "Auto",
  yolo: "Always approve",
};

const headStyle = { paddingHorizontal: 32, paddingTop: 18, paddingBottom: 6 };
const footStyle = { paddingHorizontal: 32, paddingTop: 6 };

type Conn = {
  readonly name?: string;
  readonly readyState?: string | null;
  readonly error?: string;
  readonly configuration?: { readonly [key: string]: unknown };
  readonly live?: {
    readonly identity?: unknown;
    readonly keyMask?: unknown;
    readonly account?: unknown;
    readonly tools?: unknown;
    readonly models?: unknown;
    readonly catalogName?: unknown;
  } | null;
  readonly driver?: { readonly name?: string; readonly abilityClaim?: readonly string[] } | null;
};

type PluginFace = {
  readonly pluginName?: string;
  readonly sourceNpm?: string;
  readonly sourceVersion?: string;
  readonly enabled?: boolean;
  readonly foreground?: boolean;
  readonly problem?: string | null;
};

type BotFace = {
  readonly name?: string;
  readonly description?: string;
  readonly instructions?: unknown;
  readonly recipeScope?: string;
  readonly tools?: readonly string[];
  readonly skills?: readonly string[];
  readonly keepAlive?: boolean;
  readonly mcpJson?: string;
};

type SkillRow = {
  readonly name: string;
  readonly description: string;
  readonly location: string;
  readonly invoke: string;
  readonly scope: Scope;
};

type Park = { readonly pending: string; readonly body: string };

type BotDraft = {
  readonly scope: Scope;
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly recipeScope: "session" | "project" | "global";
  readonly tools: string;
  readonly skills: string;
  readonly keepAlive: boolean;
  readonly mcp: readonly McpGrantDraft[];
};

type RuntimeDraft = {
  compact: string;
  hard: string;
  soft: string;
  keep: string;
  glow: string;
  classifier: string;
  throttle: string;
  speculative: string;
  tail: string;
  statusline: string;
  refresh: string;
  superKey: "ctrl" | "cmd";
  hideFloor: boolean;
  textOnly: boolean;
};

type RuntimeText = Exclude<keyof RuntimeDraft, "superKey" | "hideFloor" | "textOnly">;

const RUNTIME_GROUPS: readonly {
  readonly footer: string;
  readonly fields: readonly { readonly key: RuntimeText; readonly label: string; readonly keyboard?: "number-pad" }[];
}[] = [
  {
    footer: "When a conversation gets long.",
    fields: [
      { key: "compact", label: "Compact strategy" },
      { key: "hard", label: "Hard trigger" },
      { key: "soft", label: "Soft trigger" },
      { key: "keep", label: "Turns to keep", keyboard: "number-pad" },
      { key: "glow", label: "Context glow" },
    ],
  },
  {
    footer: "How Auto decides, and how long it waits.",
    fields: [
      { key: "classifier", label: "Auto classifier" },
      { key: "throttle", label: "Approval pause (ms)", keyboard: "number-pad" },
      { key: "speculative", label: "Speculative tools", keyboard: "number-pad" },
    ],
  },
  {
    footer: "How much of a command’s output is kept.",
    fields: [{ key: "tail", label: "Shell peek (bytes)", keyboard: "number-pad" }],
  },
  {
    footer: "The line under the composer.",
    fields: [
      { key: "statusline", label: "Status line" },
      { key: "refresh", label: "Status refresh" },
    ],
  },
];

function useRequest(): Request | null {
  const dial = useDial();
  const port = dial.kernelRpc;
  return port == null ? null : (method, params) => port.request(method, params);
}

/** The switch moves immediately. The kernel value replaces it when the write lands. */
function useToggle(live: boolean, apply: (next: boolean) => Promise<string>, setNotice: (notice: string) => void) {
  const [override, setOverride] = useState<boolean | null>(null);
  useEffect(() => {
    if (override !== null && override === live) setOverride(null);
  }, [override, live]);
  return {
    value: override ?? live,
    onChange: (next: boolean) => {
      setNotice("");
      setOverride(next);
      void apply(next).then((error) => {
        if (error !== "") {
          setOverride(null);
          setNotice(error);
        }
        return undefined;
      });
    },
  };
}

function useBarButton(
  navigation: { setOptions(options: NativeStackNavigationOptions): void },
  label: string,
  enabled: boolean,
  onPress: () => void,
  shown = true,
): void {
  const press = useRef(onPress);
  press.current = onPress;
  useLayoutEffect(() => {
    navigation.setOptions({
      unstable_headerRightItems: () =>
        shown
          ? [
              {
                type: "button" as const,
                label,
                variant: "prominent" as const,
                disabled: !enabled,
                onPress: () => press.current(),
              },
            ]
          : [],
    });
  }, [navigation, label, enabled, shown]);
}

function menuTitle(scope: SettingsParams): string {
  if (scope.kind === "workspace") return "Settings";
  const parts = scope.path.split(/[\\/]/).filter((part) => part !== "");
  return parts[parts.length - 1] ?? "Project";
}

export function SettingsScreen({ route }: NativeStackScreenProps<RootParamList, "Settings">) {
  const scopeKey = route.params.kind === "project" ? route.params.path : "workspace";
  return (
    <>
      <NumberBar />
      <SettingsStack.Navigator
        key={scopeKey}
        screenOptions={{
          headerBackButtonMenuEnabled: false,
          headerLargeStyle: { backgroundColor: "transparent" },
          contentStyle: { backgroundColor: grouped },
          scrollEdgeEffects: { top: "soft" },
        }}
      >
        <SettingsStack.Screen
          name="Menu"
          component={SettingsMenu}
          initialParams={route.params}
          options={({ route: menu, navigation }) => ({
            title: menuTitle(menu.params),
            headerLargeTitle: true,
            unstable_headerRightItems: () => [
              {
                type: "button",
                label: "Done",
                icon: { type: "sfSymbol", name: "checkmark" },
                variant: "prominent",
                accessibilityLabel: "Done",
                onPress: () => navigation.getParent()?.goBack(),
              },
            ],
          })}
        />
        <SettingsStack.Screen
          name="Connections"
          component={ConnectionsScreen}
          options={({ navigation }) => ({
            title: "Connections",
            unstable_headerRightItems: () => [
              {
                type: "button",
                label: "Add",
                icon: { type: "sfSymbol", name: "plus" },
                accessibilityLabel: "Add a model",
                onPress: () => navigation.navigate("AddModel"),
              },
            ],
          })}
        />
        <SettingsStack.Screen
          name="Mcp"
          component={McpScreen}
          options={({ navigation }) => ({
            title: "MCP",
            unstable_headerRightItems: () => [
              {
                type: "button",
                label: "Add",
                icon: { type: "sfSymbol", name: "plus" },
                accessibilityLabel: "Add an MCP server",
                onPress: () => navigation.navigate("AddMcp"),
              },
            ],
          })}
        />
        <SettingsStack.Screen name="AddModel" component={AddModelScreen} options={{ title: "Add a model" }} />
        <SettingsStack.Screen name="AddMcp" component={AddMcpScreen} options={{ title: "Add MCP server" }} />
        <SettingsStack.Screen name="Plugins" component={PluginsScreen} options={{ title: "Plugins" }} />
        <SettingsStack.Screen
          name="Plugin"
          component={PluginScreen}
          options={({ route: item }) => ({ title: item.params.name })}
        />
        <SettingsStack.Screen
          name="Skills"
          component={SkillsScreen}
          options={({ navigation, route: item }) => ({
            title: "Skills",
            unstable_headerRightItems: () => [
              {
                type: "button",
                label: "Add",
                icon: { type: "sfSymbol", name: "plus" },
                accessibilityLabel: "New skill",
                onPress: () => navigation.navigate("SkillNew", { project: item.params.project }),
              },
            ],
          })}
        />
        <SettingsStack.Screen
          name="Skill"
          component={SkillScreen}
          options={({ route: item }) => ({ title: item.params.name })}
        />
        <SettingsStack.Screen name="SkillNew" component={SkillNewScreen} options={{ title: "New skill" }} />
        <SettingsStack.Screen
          name="Bots"
          component={BotsScreen}
          options={({ navigation, route: item }) => ({
            title: "Bots",
            unstable_headerRightItems: () => [
              {
                type: "button",
                label: "Add",
                icon: { type: "sfSymbol", name: "plus" },
                accessibilityLabel: "New bot",
                onPress: () => navigation.navigate("BotEdit", { project: item.params.project }),
              },
            ],
          })}
        />
        <SettingsStack.Screen
          name="BotEdit"
          component={BotEditScreen}
          options={({ route: item }) => ({ title: item.params.name ?? "New bot" })}
        />
        <SettingsStack.Screen name="Security" component={SecurityScreen} options={{ title: "Security" }} />
        <SettingsStack.Screen name="Advanced" component={AdvancedScreen} options={{ title: "Advanced" }} />
      </SettingsStack.Navigator>
    </>
  );
}

function SettingsMenu({ navigation, route }: Screen<"Menu">) {
  const scope = route.params;
  const project = scope.kind === "project" ? scope.path : null;
  const workspace = scope.kind === "workspace";
  const total = workspace ? 5 : 2;
  return (
    <Page>
      <Group
        footer={
          workspace
            ? "Connections, MCP servers, and plugins belong to this Mac. Home skills and bots are available in every project."
            : "Skills and bots for this project. Home ones are in Settings on the Projects screen."
        }
      >
        {workspace ? (
          <GroupedRow
            leading={<Tile name="link" color={blue} />}
            title="Connections"
            index={0}
            total={total}
            trailing="disclosure"
            onPress={() => navigation.navigate("Connections")}
          />
        ) : null}
        {workspace ? (
          <GroupedRow
            leading={<Tile name="server.rack" color={teal} />}
            title="MCP"
            index={1}
            total={total}
            trailing="disclosure"
            onPress={() => navigation.navigate("Mcp")}
          />
        ) : null}
        {workspace ? (
          <GroupedRow
            leading={<Tile name="puzzlepiece.fill" color={indigo} />}
            title="Plugins"
            index={2}
            total={total}
            trailing="disclosure"
            onPress={() => navigation.navigate("Plugins")}
          />
        ) : null}
        <GroupedRow
          leading={<Tile name="book.fill" color={orange} />}
          title="Skills"
          index={workspace ? 3 : 0}
          total={total}
          trailing="disclosure"
          onPress={() => navigation.navigate("Skills", { project })}
        />
        <GroupedRow
          leading={<Tile name="cpu" color={green} />}
          title="Bots"
          index={workspace ? 4 : 1}
          total={total}
          trailing="disclosure"
          onPress={() => navigation.navigate("Bots", { project })}
        />
      </Group>
      {workspace ? (
        <Group footer="New sessions start here. A session can change this later.">
          <SecurityRow onPress={() => navigation.navigate("Security")} />
        </Group>
      ) : null}
      {workspace ? (
        <Group footer="Most sessions never need these.">
          <GroupedRow
            leading={<Tile name="slider.horizontal.3" color={iconGray} />}
            title="Advanced"
            index={0}
            total={1}
            trailing="disclosure"
            onPress={() => navigation.navigate("Advanced")}
          />
        </Group>
      ) : null}
    </Page>
  );
}

const SecurityRow = observer(function SecurityMode({ onPress }: { readonly onPress: () => void }) {
  const dial = useDial();
  const mode = modeOf(dial.kernel?.root.defaultPermissionMode);
  return (
    <GroupedRow
      leading={<Tile name="lock.fill" color={red} />}
      title="Security"
      value={MODE_LABEL[mode]}
      index={0}
      total={1}
      trailing="disclosure"
      onPress={onPress}
    />
  );
});

const ConnectionsScreen = observer(function ConnectionsView() {
  const rows = listedConnections(useDial()).filter(([, spec]) => !isMcp(spec));
  return <ConnectionList rows={rows} empty="No model is connected." footer="Off keeps a model out of new sessions." />;
});

const McpScreen = observer(function McpView() {
  const rows = listedConnections(useDial()).filter(([, spec]) => isMcp(spec));
  return (
    <ConnectionList rows={rows} empty="No MCP server is connected." footer="Off keeps a server out of new sessions." />
  );
});

const ConnectionList = observer(function ConnectionListView({
  rows,
  empty,
  footer,
}: {
  readonly rows: readonly (readonly [string, Conn])[];
  readonly empty: string;
  readonly footer: string;
}) {
  const request = useRequest();
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<readonly string[]>([]);

  const specOf = (id: string): Conn | undefined => rows.find(([key]) => key === id)?.[1];

  const toggle = (id: string, spec: Conn): void => {
    void ask(request, "connect/set-enabled", { id, enabled: spec.configuration?.enabled === false });
  };

  const run = (id: string, method: string): void => {
    if (request == null || busy.includes(id)) return;
    setNotice("");
    setBusy((current) => [...current, id]);
    void ask(request, method, method === "connect/drop" ? { id, confirm: true } : { id }).then((error) => {
      setBusy((current) => current.filter((key) => key !== id));
      if (error !== "") setNotice(error);
      return undefined;
    });
  };

  const sections: readonly ListSection[] = [
    {
      key: "connections",
      footer: rows.length === 0 ? undefined : footer,
      rows: rows.map(([id, spec]) => {
        const account = wireAccount(spec, spec.driver?.name ?? "");
        const line = paintedAccount(account);
        const title = shownName(spec.name, id);
        const mcp = isMcp(spec);
        const detail = mcp ? mcpLoginLine(spec, title) : line !== "" ? line : statusLabel(spec.readyState);
        return {
          key: id,
          title,
          detail,
          detailDanger: account.failed,
          switchOn: spec.configuration?.enabled !== false,
          disabled: busy.includes(id) || request == null,
          leadingSwipe: mcp
            ? [
                {
                  id: account.failed ? "login" : "logout",
                  label: account.failed ? "Log in" : "Log out",
                  tone: account.failed ? ("action" as const) : ("quiet" as const),
                },
              ]
            : undefined,
          trailingSwipe: [{ id: "drop", label: "Delete", tone: "destructive" as const }],
        };
      }),
    },
  ];

  return (
    <NativeList
      sections={sections}
      notice={notice === "" ? undefined : notice}
      emptyTitle={rows.length === 0 ? empty : undefined}
      onPressRow={(id) => {
        const spec = specOf(id);
        if (spec != null) toggle(id, spec);
      }}
      onSwitchRow={(id) => {
        const spec = specOf(id);
        if (spec != null) toggle(id, spec);
      }}
      onAction={(id, action) => {
        if (action === "drop") {
          const spec = specOf(id);
          const title = spec == null ? id : shownName(spec.name, id);
          confirmRemove(title, () => run(id, "connect/drop"));
          return;
        }
        run(id, action === "login" ? "connect/login" : "connect/logout");
      }}
    />
  );
});

const AddModelScreen = observer(function AddModelView({ navigation }: Screen<"AddModel">) {
  const dial = useDial();
  const request = useRequest();
  const [start, setStart] = useState<ConnectStart | null>(null);
  const rows = providerRows(dial.kernel?.root.drivers, dial.kernel?.root.connections);
  const drivers = rows.map((row) => row.driver).join("\0");
  useEffect(() => {
    dial.look([], drivers === "" ? [] : [...new Set(drivers.split("\0"))]);
    return () => dial.look([], []);
  }, [dial, drivers]);
  useLayoutEffect(() => {
    navigation.setOptions({ title: start?.name ?? "Add a model" });
  }, [navigation, start]);
  if (start != null && request != null) {
    return <ConnectFlow start={start} onCancel={() => setStart(null)} onDone={() => navigation.goBack()} />;
  }
  const waiting = rows.length === 0 && Object.keys(dial.kernel?.root.drivers ?? {}).length === 0;
  return (
    <Page>
      {waiting ? <Loading title="Checking this Mac for models." /> : null}
      {!waiting && rows.length === 0 ? <Empty title="Every offered model is already connected." /> : null}
      {GROUPS.map((group) => {
        const mine = rows.filter((row) => row.group === group);
        if (mine.length === 0) return null;
        return (
          <Group key={group} header={GROUP_LABELS[group]}>
            {mine.map((row, index) => (
              <GroupedRow
                key={row.key}
                title={row.name}
                detail={shownName(row.hint, row.description)}
                detailLines={2}
                index={index}
                total={mine.length}
                disabled={row.start == null || request == null}
                onPress={() => {
                  if (row.start != null) setStart(row.start);
                }}
              />
            ))}
          </Group>
        );
      })}
    </Page>
  );
});

function ConnectFlow({
  start,
  onDone,
  onCancel,
}: {
  readonly start: ConnectStart;
  readonly onDone: () => void;
  readonly onCancel: () => void;
}) {
  const dial = useDial();
  const request = useRequest();
  const done = useRef(onDone);
  done.current = onDone;
  const finished = useRef(false);
  const pending = useRef<string | null>(null);
  const [park, setPark] = useState<Park | null>(null);
  const [notice, setNotice] = useState("");
  const [typed, setTyped] = useState(false);
  const [close, setClose] = useState(false);
  const key = JSON.stringify(start);
  useDiscard(!close && typed);
  useEffect(() => {
    if (close) done.current();
  }, [close]);
  useEffect(() => {
    const port = dial.kernelRpc;
    if (port == null) return;
    let live = true;
    void port.request("connect/adopt", start).then(
      async (result) => {
        if (!live) {
          const late = parkOf(result);
          if (late != null) await port.request("ui/resolve", { pending: late.pending, kind: "cancel" });
          return undefined;
        }
        const next = parkOf(result);
        if (next != null) {
          pending.current = next.pending;
          setPark(next);
          return undefined;
        }
        if (idOf(result) != null) {
          finished.current = true;
          setClose(true);
        } else setNotice(failureOf(result) || "The daemon gave an answer this page does not know.");
        return undefined;
      },
      (error: unknown) => {
        if (live) setNotice(messageOf(error));
        return undefined;
      },
    );
    return () => {
      live = false;
      const id = pending.current;
      if (!finished.current && id != null) {
        void port.request("ui/resolve", { pending: id, kind: "cancel" }).catch(() => undefined);
      }
    };
  }, [dial, key, start]);
  if (park == null) {
    return (
      <Page>
        {notice === "" ? <Loading title="Connecting…" /> : <Notice>{notice}</Notice>}
        <QuietButton title="Cancel" onPress={onCancel} />
      </Page>
    );
  }
  if (request == null) {
    return (
      <Page>
        <Notice>The daemon is not connected.</Notice>
      </Page>
    );
  }
  return (
    <ParkFollow
      park={park}
      request={request}
      onDirty={setTyped}
      onCancel={onCancel}
      onDone={() => {
        finished.current = true;
        setClose(true);
      }}
      onPark={(next) => {
        pending.current = next.pending;
        setPark(next);
      }}
    />
  );
}

const AddMcpScreen = observer(function AddMcpView({ navigation }: Screen<"AddMcp">) {
  const request = useRequest();
  const servers = listedConnections(useDial()).filter(([, spec]) => isMcp(spec));
  const [endpoint, setEndpoint] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<RegistryHit[]>([]);
  const [pending, setPending] = useState(false);
  const [park, setPark] = useState<Park | null>(null);
  const [notice, setNotice] = useState("");
  const [typed, setTyped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [close, setClose] = useState(false);
  const requestRef = useRef(request);
  requestRef.current = request;
  const dirty = !close && (endpoint.trim() !== "" || typed);
  useDiscard(dirty);
  useEffect(() => {
    if (close && !dirty) navigation.goBack();
  }, [close, dirty, navigation]);
  useEffect(() => {
    const q = query.trim();
    if (q === "") {
      setHits([]);
      setPending(false);
      return;
    }
    let live = true;
    setHits([]);
    setPending(true);
    const timer = setTimeout(() => {
      const current = requestRef.current;
      if (!live) return;
      if (current == null) {
        setPending(false);
        setNotice("The daemon is not connected.");
        return;
      }
      void current("mcp-server/search", { query: q }).then(
        (result) => {
          if (!live) return undefined;
          setPending(false);
          setHits(registryHits(result));
          setNotice("");
          return undefined;
        },
        (error: unknown) => {
          if (!live) return undefined;
          setPending(false);
          setHits([]);
          setNotice(messageOf(error));
          return undefined;
        },
      );
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query]);
  const adopt = (input: string, name = "") => {
    if (request == null) {
      setNotice("The daemon is not connected.");
      return;
    }
    if (busy || input.trim() === "") return;
    setNotice("");
    setBusy(true);
    const body = name.trim() === "" ? { input: input.trim() } : { name: name.trim(), input: input.trim() };
    void request("mcp-server/adopt", body).then(
      (result) => {
        setBusy(false);
        const next = parkOf(result);
        if (next != null) {
          setPark(next);
          return undefined;
        }
        const failure = failureOf(result);
        if (failure !== "") setNotice(failure);
        else if (name.trim() === "") setClose(true);
        return undefined;
      },
      (error: unknown) => {
        setBusy(false);
        setNotice(messageOf(error));
        return undefined;
      },
    );
  };
  useBarButton(
    navigation,
    busy ? "Connecting…" : "Connect",
    !busy && endpoint.trim() !== "",
    () => adopt(endpoint),
    park == null,
  );
  if (park != null && request != null) {
    return (
      <ParkFollow
        park={park}
        request={request}
        onDirty={setTyped}
        onCancel={() => {
          setPark(null);
          setTyped(false);
        }}
        onDone={() => setClose(true)}
        onPark={setPark}
      />
    );
  }
  const status = registryStatus(query, pending, hits.length);
  return (
    <Page>
      {notice === "" ? null : <Notice>{notice}</Notice>}
      <Group header="Registry" footer={status === "" ? "Searches server names in the official registry." : status}>
        <FieldRow label="Search" value={query} index={0} total={1} placeholder="Name" onChange={setQuery} />
      </Group>
      {hits.length === 0 ? null : (
        <Group footer="Each server you add signs in on its own.">
          {hits.map((hit, index) => {
            const copies = mcpCopies(servers, hit.install);
            return (
              <GroupedRow
                key={hit.name}
                title={hit.title}
                detail={registryDetail(hit.description, copies)}
                detailLines={4}
                value={registryAddWord(hit.install, copies.length)}
                index={index}
                total={hits.length}
                disabled={busy || hit.install.trim() === ""}
                onPress={() => adopt(hit.install, hit.title)}
              />
            );
          })}
        </Group>
      )}
      <Group footer="A URL, or a command such as npx @scope/server.">
        <FieldRow
          label="URL or command"
          value={endpoint}
          index={0}
          total={1}
          keyboard="url"
          placeholder="https://…"
          onChange={setEndpoint}
        />
      </Group>
    </Page>
  );
});

function ParkFollow({
  park,
  request,
  onPark,
  onDone,
  onCancel,
  onDirty,
}: {
  readonly park: Park;
  readonly request: Request;
  readonly onPark: (park: Park) => void;
  readonly onDone: () => void;
  readonly onCancel: () => void;
  readonly onDirty?: (dirty: boolean) => void;
}) {
  const [form, setForm] = useState<ParkForm | null>(null);
  const [pasted, setPasted] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    onDirty?.(pasted.trim() !== "");
  }, [onDirty, pasted]);
  useEffect(() => {
    let live = true;
    void parsePark(park.body).then((next) => {
      if (live) setForm(next);
      return undefined;
    });
    return () => {
      live = false;
    };
  }, [park.body]);
  const answer = (params: Record<string, unknown>): void => {
    setNotice("");
    void request("ui/resolve", { pending: park.pending, ...params }).then(
      (result) => {
        const next = parkOf(result);
        if (next != null) {
          setPasted("");
          onPark(next);
          return undefined;
        }
        const failure = failureOf(result);
        if (failure !== "") setNotice(failure);
        else onDone();
        return undefined;
      },
      (error: unknown) => setNotice(messageOf(error)),
    );
  };
  const fieldType =
    form?.kind === "open-url"
      ? openUrlFieldType(form.paste, form.input)
      : form?.kind === "input" && form.secret
        ? "password"
        : "text";
  const showField = form?.kind === "input" || (form?.kind === "open-url" && form.paste !== "");
  return (
    <Page>
      {notice === "" ? null : <Notice>{notice}</Notice>}
      {form == null ? <Loading title="Reading the next step…" /> : null}
      {form?.kind === "unknown" ? <Empty title="Finish this step in the terminal, then close Settings." /> : null}
      {form?.kind === "open-url" ? (
        <Group>
          <GroupedRow
            title={shownName(form.description, "Open the page")}
            index={0}
            total={1}
            trailing="disclosure"
            onPress={() => void Linking.openURL(form.url)}
          />
        </Group>
      ) : null}
      {form?.kind === "confirm" ? (
        <Group footer={form.description}>
          <View style={[cardChrome(0, 1), { paddingHorizontal: 20, paddingVertical: 14 }]}>
            <Label>{form.name}</Label>
          </View>
        </Group>
      ) : null}
      {showField ? (
        <Group footer={form.kind === "input" ? form.description : undefined}>
          <FieldRow
            label={form.kind === "input" ? form.name : form.paste}
            value={pasted}
            index={0}
            total={1}
            keyboard={fieldType === "url" ? "url" : "default"}
            secure={fieldType === "password"}
            onChange={setPasted}
          />
        </Group>
      ) : null}
      {form?.kind === "open-url" && form.paste === "" ? (
        <PrimaryButton title="I opened it" onPress={() => answer({ kind: "opened", url: form.url })} />
      ) : null}
      {showField ? <PrimaryButton title="Continue" onPress={() => answer({ kind: "text", input: pasted })} /> : null}
      {form?.kind === "confirm" ? <PrimaryButton title="Confirm" onPress={() => answer({ kind: "accept" })} /> : null}
      <QuietButton
        title="Cancel"
        onPress={() => {
          void request("ui/resolve", { pending: park.pending, kind: "cancel" }).then(onCancel, onCancel);
        }}
      />
    </Page>
  );
}

const PluginsScreen = observer(function PluginsView({ navigation }: Screen<"Plugins">) {
  const plugins = Object.values(pluginsOf(useDial())).filter((plugin) => (plugin.pluginName ?? "") !== "");
  return (
    <Page>
      <Group footer={plugins.length === 0 ? "No plugin is installed." : "A plugin adds tools and, sometimes, a bot."}>
        {plugins.map((plugin, index) => {
          const name = plugin.pluginName ?? "";
          const source = [plugin.sourceNpm, plugin.sourceVersion]
            .filter((part) => part != null && part !== "")
            .join(" ");
          return (
            <GroupedRow
              key={name}
              title={name}
              detail={plugin.problem ?? (source === "" ? undefined : source)}
              detailLines={2}
              detailColor={plugin.problem ? red : undefined}
              value={plugin.enabled === false ? "Off" : undefined}
              index={index}
              total={plugins.length}
              trailing="disclosure"
              onPress={() => navigation.navigate("Plugin", { name })}
            />
          );
        })}
      </Group>
    </Page>
  );
});

const PluginScreen = observer(function PluginView({ route }: Screen<"Plugin">) {
  const name = route.params.name;
  const request = useRequest();
  const plugin = Object.values(pluginsOf(useDial())).find((item) => item.pluginName === name);
  const [notice, setNotice] = useState("");
  const enabled = useToggle(
    plugin?.enabled !== false,
    (next) => ask(request, "plugin/set", { name, enabled: next }),
    setNotice,
  );
  const foreground = useToggle(
    plugin?.foreground !== false,
    (next) => ask(request, "plugin/set", { name, foreground: next }),
    setNotice,
  );
  if (plugin == null) {
    return (
      <Page>
        <Empty title="That plugin is no longer installed." />
      </Page>
    );
  }
  const source = [plugin.sourceNpm, plugin.sourceVersion].filter((part) => part != null && part !== "").join(" ");
  return (
    <Page>
      {notice === "" ? null : <Notice>{notice}</Notice>}
      <Group footer={plugin.problem ?? undefined} footerTone="danger">
        <SwitchRow
          title="Enabled"
          value={enabled.value}
          disabled={request == null}
          index={0}
          total={2}
          onChange={enabled.onChange}
        />
        <SwitchRow
          title="Foreground"
          value={foreground.value}
          disabled={request == null}
          index={1}
          total={2}
          onChange={foreground.onChange}
        />
      </Group>
      <Group footer="When off, the plugin stays installed and does not run. When Foreground is on, its bot can run in the foreground." />
      {source === "" ? null : <Group footer={source} />}
    </Page>
  );
});

function SkillsScreen({ navigation, route }: Screen<"Skills">) {
  const project = route.params.project;
  const dial = useDial();
  const [rows, setRows] = useState<readonly SkillRow[]>([]);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const load = useCallback(() => {
    const port = dial.kernelRpc;
    if (port == null) {
      setLoading(false);
      setNotice("The daemon is not connected.");
      return;
    }
    let live = true;
    // A file read. Opening a session here would sync that session's transcript first.
    void port.request("skill/list", project == null ? {} : { project }).then(
      (result) => {
        if (!live) return undefined;
        const failure = failureOf(result);
        if (failure !== "") setNotice(skillFailure(failure));
        else {
          setNotice("");
          setRows(skillRowsFrom(result, project));
        }
        setLoading(false);
        return undefined;
      },
      (error: unknown) => {
        if (!live) return undefined;
        setNotice(skillFailure(messageOf(error)));
        setLoading(false);
        return undefined;
      },
    );
    return () => {
      live = false;
    };
  }, [dial, project]);
  useFocusEffect(load);
  return (
    <Page>
      {notice === "" ? null : <Notice>{notice}</Notice>}
      {loading && rows.length === 0 ? (
        <Loading title="Loading skills…" />
      ) : notice !== "" && rows.length === 0 ? null : (
        <Group
          footer={
            rows.length === 0
              ? "No skills."
              : project == null
                ? "Home skills are available in every session."
                : "These are offered on the next session in this project."
          }
        >
          {rows.map((skill, index) => (
            <GroupedRow
              key={skill.location || skill.name}
              title={skill.name}
              detail={skill.description === "" ? undefined : skill.description}
              detailLines={2}
              value={skill.invoke === skill.name ? undefined : `/${skill.invoke}`}
              index={index}
              total={rows.length}
              trailing="disclosure"
              onPress={() => navigation.navigate("Skill", { project, ...skill })}
            />
          ))}
        </Group>
      )}
    </Page>
  );
}

function SkillScreen({ navigation, route }: Screen<"Skill">) {
  const { project, name, description, location, invoke, scope } = route.params;
  const request = useRequest();
  const [notice, setNotice] = useState("");
  const where = [invoke === name ? "" : `Invoke as /${invoke}.`, location].filter((part) => part !== "").join(" ");
  return (
    <Page>
      {notice === "" ? null : <Notice>{notice}</Notice>}
      {description === "" ? null : (
        <Group>
          <View style={[cardChrome(0, 1), { paddingHorizontal: 20, paddingVertical: 14 }]}>
            <Label>{description}</Label>
          </View>
        </Group>
      )}
      {where === "" ? null : <Group footer={where} />}
      <Group spaced>
        <DestructiveRow
          title="Remove"
          disabled={request == null}
          onPress={() =>
            confirmRemove(name, () => {
              void ask(request, "skill/remove", {
                scope,
                ...(scope === "project" && project != null ? { project } : {}),
                name,
              }).then((error) => {
                if (error === "") navigation.goBack();
                else setNotice(error);
                return undefined;
              });
            })
          }
        />
      </Group>
    </Page>
  );
}

function SkillNewScreen({ navigation, route }: Screen<"SkillNew">) {
  const project = route.params.project;
  const request = useRequest();
  const [draft, setDraft] = useState({ name: "", description: "", body: "" });
  const [notice, setNotice] = useState("");
  const [close, setClose] = useState(false);
  const scope: Scope = project == null ? "home" : "project";
  const dirty = !close && (draft.name.trim() !== "" || draft.description.trim() !== "" || draft.body.trim() !== "");
  useDiscard(dirty);
  useLeave(navigation, close, dirty);
  const save = () => {
    setNotice("");
    void ask(request, "skill/write", {
      scope,
      ...(scope === "project" && project != null ? { project } : {}),
      name: draft.name.trim(),
      description: draft.description,
      body: draft.body,
    }).then((error) => {
      setNotice(error);
      if (error === "") setClose(true);
      return undefined;
    });
  };
  useBarButton(navigation, "Save", draft.name.trim() !== "", save);
  return (
    <Page>
      {notice === "" ? null : <Notice>{notice}</Notice>}
      <Group footer={project == null ? "Available in every session." : "Offered on the next session in this project."}>
        <FieldRow
          label="Name"
          value={draft.name}
          index={0}
          total={2}
          onChange={(name) => setDraft({ ...draft, name })}
        />
        <FieldRow
          label="Description"
          plain
          value={draft.description}
          index={1}
          total={2}
          onChange={(description) => setDraft({ ...draft, description })}
        />
      </Group>
      <Group header="Body">
        <TextBlock
          plain
          placeholder="Write the skill"
          value={draft.body}
          onChange={(body) => setDraft({ ...draft, body })}
        />
      </Group>
    </Page>
  );
}

const BotsScreen = observer(function BotsView({ navigation, route }: Screen<"Bots">) {
  const project = route.params.project;
  const dial = useDial();
  const root = project == null ? dial.kernel?.root : dial.projects.get(project)?.root;
  const rows = botSummaries(root);
  return (
    <Page>
      <Group
        header={project == null ? "Home" : "This project"}
        footer={
          rows.length === 0
            ? "No bots."
            : project == null
              ? "Home bots are available in every project."
              : "Bots authored in this project."
        }
      >
        {rows.map((bot, index) => (
          <GroupedRow
            key={bot.id}
            title={bot.title}
            detail={bot.detail === "" ? undefined : bot.detail}
            detailLines={2}
            index={index}
            total={rows.length}
            trailing="disclosure"
            onPress={() => navigation.navigate("BotEdit", { project, name: bot.id })}
          />
        ))}
      </Group>
    </Page>
  );
});

const BotEditScreen = observer(function BotEditView({ navigation, route }: Screen<"BotEdit">) {
  const project = route.params.project;
  const opened = route.params.name;
  const scope: Scope = project == null ? "home" : "project";
  const dial = useDial();
  const shell = useShell();
  const request = useRequest();
  const root = project == null ? dial.kernel?.root : dial.projects.get(project)?.root;
  const existing = opened == null ? undefined : botsOf(root)[opened];
  const poolProject = project ?? (shell.place.kind === "projects" ? "" : shell.place.path);
  const [baseline, setBaseline] = useState<BotDraft>(() =>
    opened != null && existing != null ? draftFrom(opened, existing, scope) : emptyBot(scope),
  );
  const [draft, setDraft] = useState(baseline);
  const [notice, setNotice] = useState("");
  const [close, setClose] = useState(false);
  const seeded = useRef(opened == null || existing != null);
  useEffect(() => {
    if (seeded.current || opened == null || existing == null) return;
    seeded.current = true;
    const next = draftFrom(opened, existing, scope);
    setBaseline(next);
    setDraft(next);
  }, [existing, opened, scope]);
  const dirty = !close && JSON.stringify(draft) !== JSON.stringify(baseline);
  useDiscard(dirty);
  useLeave(navigation, close, dirty);
  const missing = opened != null && existing == null && !seeded.current;
  const save = () => {
    const name = draft.name.trim();
    setNotice("");
    void ask(request, "bot/write", {
      scope: draft.scope,
      ...(draft.scope === "project" && project != null ? { project } : {}),
      name,
      description: draft.description,
      instructions: draft.instructions,
      recipeScope: draft.recipeScope,
      tools: splitList(draft.tools),
      skills: splitList(draft.skills),
      keepAlive: draft.keepAlive,
      mcp: mcpPayload(draft.mcp),
    }).then(async (error) => {
      if (error !== "") {
        setNotice(error);
        return undefined;
      }
      const previous =
        name === baseline.name
          ? []
          : [
              ...new Set(
                [opened, baseline.name].filter((item): item is string => item != null && item !== "" && item !== name),
              ),
            ];
      for (const prior of previous) {
        const removed = await ask(request, "bot/remove", {
          scope,
          ...(scope === "project" && project != null ? { project } : {}),
          name: prior,
        });
        if (removed !== "") {
          setNotice(removed);
          return undefined;
        }
      }
      setBaseline(draft);
      setClose(true);
      return undefined;
    });
  };
  useBarButton(navigation, "Save", draft.name.trim() !== "" && !missing, save, !missing);
  if (missing) {
    return (
      <Page>
        <Empty title="That bot is no longer here." />
      </Page>
    );
  }
  const servers = mcpServerOptions(connectionsOf(dial), draft.recipeScope, poolProject);
  return (
    <Page>
      {notice === "" ? null : <Notice>{notice}</Notice>}
      <Group>
        <FieldRow
          label="Name"
          value={draft.name}
          index={0}
          total={2}
          onChange={(name) => setDraft({ ...draft, name })}
        />
        <FieldRow
          label="Description"
          plain
          value={draft.description}
          index={1}
          total={2}
          onChange={(description) => setDraft({ ...draft, description })}
        />
      </Group>
      <Group header="Instructions">
        <TextBlock
          label="Instructions"
          plain
          value={draft.instructions}
          onChange={(instructions) => setDraft({ ...draft, instructions })}
        />
      </Group>
      <Group header="Recipe" footer="Where this bot is allowed to run.">
        {(
          [
            ["session", "Session"],
            ["project", "Project"],
            ["global", "Global"],
          ] as const
        ).map(([recipe, title], index, recipes) => (
          <GroupedRow
            key={recipe}
            title={title}
            index={index}
            total={recipes.length}
            selected={draft.recipeScope === recipe}
            trailing="check"
            onPress={() => setDraft({ ...draft, recipeScope: recipe })}
          />
        ))}
      </Group>
      <Group footer="Comma-separated names.">
        <FieldRow
          label="Tools"
          value={draft.tools}
          index={0}
          total={2}
          onChange={(tools) => setDraft({ ...draft, tools })}
        />
        <FieldRow
          label="Skills"
          value={draft.skills}
          index={1}
          total={2}
          onChange={(skills) => setDraft({ ...draft, skills })}
        />
      </Group>
      <McpGrants draft={draft} project={poolProject} servers={servers} onChange={setDraft} />
      <Group footer="When on, the bot keeps going after a step that would otherwise stop it.">
        <SwitchRow
          title="Keep alive"
          value={draft.keepAlive}
          index={0}
          total={1}
          onChange={(keepAlive) => setDraft({ ...draft, keepAlive })}
        />
      </Group>
      {opened == null ? null : (
        <Group spaced>
          <DestructiveRow
            title="Remove"
            disabled={request == null}
            onPress={() =>
              confirmRemove(opened, () => {
                void ask(request, "bot/remove", {
                  scope,
                  ...(scope === "project" && project != null ? { project } : {}),
                  name: opened,
                }).then((error) => {
                  if (error === "") setClose(true);
                  else setNotice(error);
                  return undefined;
                });
              })
            }
          />
        </Group>
      )}
    </Page>
  );
});

function McpGrants({
  draft,
  project,
  servers,
  onChange,
}: {
  readonly draft: BotDraft;
  readonly project: string;
  readonly servers: readonly McpServerOption[];
  readonly onChange: (draft: BotDraft) => void;
}) {
  const replace = (index: number, grant: McpGrantDraft) => {
    onChange({ ...draft, mcp: draft.mcp.map((row, at) => (at === index ? grant : row)) });
  };
  return (
    <Group header="MCP" footer={mcpPoolCaption(draft.recipeScope, project)}>
      {draft.mcp.map((grant, index) => {
        const option = mcpOption(servers, grant.server);
        const choices = serverChoices(servers, grant.server);
        return (
          <View key={`${grant.server}:${index}`} style={index === 0 ? undefined : { marginTop: 16 }}>
            <GroupedRow
              title="Server"
              value={grant.server === "" ? "Choose" : grant.server}
              index={0}
              total={1}
              trailing="disclosure"
              disabled={choices.length === 0}
              onPress={() =>
                choose(
                  "Server",
                  choices.map((choice) => ({
                    label: choice.server,
                    onPress: () => replace(index, { ...grant, server: choice.server }),
                  })),
                )
              }
            />
            <View style={{ height: 16 }} />
            <FieldRow
              label="Tools"
              placeholder={mcpHint(option, "tools")}
              value={grant.tools}
              index={0}
              total={3}
              onChange={(tools) => replace(index, { ...grant, tools })}
            />
            <FieldRow
              label="Account"
              placeholder={mcpHint(option, "account")}
              value={grant.account}
              index={1}
              total={3}
              onChange={(account) => replace(index, { ...grant, account })}
            />
            <FieldRow
              label="Session"
              placeholder={mcpHint(option, "session")}
              value={grant.session}
              index={2}
              total={3}
              onChange={(session) => replace(index, { ...grant, session })}
            />
            <View style={{ height: 16 }} />
            <ActionRow
              title="Remove server"
              tone="destructive"
              index={0}
              total={1}
              onPress={() => onChange({ ...draft, mcp: draft.mcp.filter((_, at) => at !== index) })}
            />
          </View>
        );
      })}
      <View style={draft.mcp.length === 0 ? undefined : { marginTop: 16 }}>
        <ActionRow
          title="Add a server"
          disabled={servers.length === 0}
          index={0}
          total={1}
          onPress={() => {
            if (servers.length === 0) return;
            const server = servers[0];
            onChange({
              ...draft,
              mcp: [...draft.mcp, { server: server.server, tools: "", account: "", session: "" }],
            });
          }}
        />
      </View>
    </Group>
  );
}

const SecurityScreen = observer(function SecurityView() {
  const dial = useDial();
  const request = useRequest();
  const [notice, setNotice] = useState("");
  const mode = modeOf(dial.kernel?.root.defaultPermissionMode);
  const setMode = (policy: Mode) => {
    setNotice("");
    void ask(request, "config/set", { defaultPermissionMode: policy }).then(setNotice);
  };
  const modes = [
    ["manual", "Manual", "Ask before a file write, a shell command, or an MCP tool."],
    ["auto", "Auto", "A judge decides each action and asks you when it is unsure."],
    ["yolo", "Always approve", "Allow every action except those blocked outright. Acknowledgements still ask."],
  ] as const;
  return (
    <Page>
      {notice === "" ? null : <Notice>{notice}</Notice>}
      <Group header="Permission mode" footer="New sessions start here. A session can change its own mode.">
        {modes.map(([id, title, detail], index) => (
          <GroupedRow
            key={id}
            title={title}
            detail={detail}
            detailLines={2}
            index={index}
            total={modes.length}
            selected={mode === id}
            trailing="check"
            onPress={() => setMode(id)}
          />
        ))}
      </Group>
    </Page>
  );
});

function AdvancedScreen({ navigation }: Screen<"Advanced">) {
  const dial = useDial();
  const [baseline, setBaseline] = useState(() => runtimeDraft(dial.kernel?.root));
  const [draft, setDraft] = useState(baseline);
  const [notice, setNotice] = useState("");
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  useDiscard(dirty);
  const save = () => {
    const keep = Number(draft.keep);
    const throttle = Number(draft.throttle);
    const speculative = Number(draft.speculative);
    const tail = Number(draft.tail);
    if (![keep, throttle, speculative, tail].every((value) => Number.isFinite(value))) {
      setNotice("Turns, pause, speculative tools, and shell peek need numbers.");
      return;
    }
    const port = dial.kernelRpc;
    setNotice("");
    void ask(port == null ? null : (method, params) => port.request(method, params), "config/set", {
      compact: draft.compact,
      compactTriggers: { hard: draft.hard, soft: draft.soft },
      compactKeepTurns: keep,
      contextGlowRemaining: draft.glow,
      autoModeClassifier: draft.classifier,
      approvalAskThrottleMs: throttle,
      speculativePolicyProcessingTools: speculative,
      shellTailBytes: tail,
      statusline: draft.statusline,
      statuslineRefresh: draft.refresh,
      superKey: draft.superKey,
      hideFloorTools: draft.hideFloor,
      textOnlyContinue: draft.textOnly,
    }).then((error) => {
      setNotice(error);
      if (error === "") setBaseline(draft);
      return undefined;
    });
  };
  useBarButton(navigation, "Save", dirty, save);
  return (
    <Page>
      {notice === "" ? null : <Notice>{notice}</Notice>}
      {RUNTIME_GROUPS.map((group) => (
        <Group key={group.footer} footer={group.footer}>
          {group.fields.map((field, index) => (
            <FieldRow
              key={field.key}
              label={field.label}
              value={draft[field.key]}
              index={index}
              total={group.fields.length}
              keyboard={field.keyboard}
              onChange={(value) => setDraft({ ...draft, [field.key]: value })}
            />
          ))}
        </Group>
      ))}
      <Group header="Super key" footer="The modifier for approval shortcuts.">
        {(
          [
            ["ctrl", "Ctrl"],
            ["cmd", "Command"],
          ] as const
        ).map(([key, title], index, keys) => (
          <GroupedRow
            key={key}
            title={title}
            index={index}
            total={keys.length}
            selected={draft.superKey === key}
            trailing="check"
            onPress={() => setDraft({ ...draft, superKey: key })}
          />
        ))}
      </Group>
      <Group footer="Known-safe calls drop off the compact transcript.">
        <SwitchRow
          title="Hide floor-allow calls on the compact tape"
          value={draft.hideFloor}
          index={0}
          total={1}
          onChange={(hideFloor) => setDraft({ ...draft, hideFloor })}
        />
      </Group>
      <Group footer="A text-only reply can continue the turn.">
        <SwitchRow
          title="Text-only continuation"
          value={draft.textOnly}
          index={0}
          total={1}
          onChange={(textOnly) => setDraft({ ...draft, textOnly })}
        />
      </Group>
    </Page>
  );
}

function Page({ children }: { readonly children: ReactNode }) {
  return (
    <ScrollView
      automaticallyAdjustKeyboardInsets
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      style={{ flex: 1, backgroundColor: grouped }}
      contentContainerStyle={{ paddingBottom: 40 }}
    >
      {children}
    </ScrollView>
  );
}

function Group({
  header,
  footer,
  footerTone = "secondary",
  spaced = false,
  children,
}: {
  readonly header?: string;
  readonly footer?: string;
  readonly footerTone?: "secondary" | "danger";
  readonly spaced?: boolean;
  readonly children?: ReactNode;
}) {
  return (
    <View style={spaced ? { marginTop: 28 } : header == null ? { marginTop: 16 } : undefined}>
      {header == null ? null : (
        <Label role="footnote" style={headStyle}>
          {header}
        </Label>
      )}
      {children}
      {footer == null || footer === "" ? null : (
        <Label role="footnote" color={footerTone === "danger" ? red : undefined} style={footStyle}>
          {footer}
        </Label>
      )}
    </View>
  );
}

function Tile({ name, color }: { readonly name: string; readonly color: ColorValue }) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: 30,
        height: 30,
        borderRadius: 7,
        borderCurve: "continuous",
        flexShrink: 0,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: color,
      }}
    >
      <Symbol name={name} size={16} color="#FFFFFF" />
    </View>
  );
}

function Loading({ title }: { readonly title: string }) {
  return (
    <View style={{ paddingTop: 24, alignItems: "center", gap: 8 }}>
      <ActivityIndicator />
      <Label role="subhead">{title}</Label>
    </View>
  );
}

function SwitchRow({
  title,
  value,
  disabled = false,
  index,
  total,
  onChange,
}: {
  readonly title: string;
  readonly value: boolean;
  readonly disabled?: boolean;
  readonly index: number;
  readonly total: number;
  readonly onChange: (value: boolean) => void;
}) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={title}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={() => onChange(!value)}
      style={({ pressed }) => [
        chrome.row,
        cardChrome(index, total),
        pressed && !disabled ? { backgroundColor: fill } : null,
      ]}
    >
      <Label style={{ flex: 1 }}>{title}</Label>
      <Switch
        accessibilityElementsHidden
        importantForAccessibility="no"
        disabled={disabled}
        pointerEvents="none"
        value={value}
        onValueChange={onChange}
      />
      {index < total - 1 ? <Hairline /> : null}
    </Pressable>
  );
}

function FieldRow({
  label: title,
  value,
  index,
  total,
  placeholder,
  keyboard = "default",
  secure = false,
  plain = false,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly index: number;
  readonly total: number;
  readonly placeholder?: string;
  readonly keyboard?: "default" | "number-pad" | "url";
  readonly secure?: boolean;
  readonly plain?: boolean;
  readonly onChange: (value: string) => void;
}) {
  const body = useType().body;
  return (
    <View style={[cardChrome(index, total), { paddingHorizontal: 20, paddingTop: 10, paddingBottom: 10 }]}>
      <Label role="footnote">{title}</Label>
      <TextInput
        accessibilityLabel={title}
        allowFontScaling={false}
        autoCapitalize={plain ? "sentences" : "none"}
        autoComplete="off"
        autoCorrect={plain}
        clearButtonMode="while-editing"
        inputAccessoryViewID={keyboard === "number-pad" ? NUMBER_BAR : undefined}
        keyboardType={keyboard}
        placeholder={placeholder}
        placeholderTextColor={placeholderColor}
        secureTextEntry={secure}
        textContentType={secure ? "password" : "none"}
        value={value}
        onChangeText={onChange}
        style={{
          minHeight: Math.max(22, body.lineHeight),
          paddingVertical: 2,
          color: ink,
          fontSize: body.fontSize,
          lineHeight: body.lineHeight,
          fontWeight: body.fontWeight,
        }}
      />
      {index < total - 1 ? <Hairline /> : null}
    </View>
  );
}

function TextBlock({
  label: title = "Body",
  value,
  placeholder,
  plain = false,
  onChange,
}: {
  readonly label?: string;
  readonly value: string;
  readonly placeholder?: string;
  readonly plain?: boolean;
  readonly onChange: (value: string) => void;
}) {
  const body = useType().body;
  return (
    <View style={[cardChrome(0, 1), { paddingHorizontal: 20, paddingTop: 10, paddingBottom: 12 }]}>
      <TextInput
        accessibilityLabel={title}
        allowFontScaling={false}
        autoCapitalize={plain ? "sentences" : "none"}
        autoCorrect={plain}
        multiline
        placeholder={placeholder}
        placeholderTextColor={placeholderColor}
        scrollEnabled={false}
        textAlignVertical="top"
        value={value}
        onChangeText={onChange}
        style={{
          minHeight: Math.round(body.lineHeight * 6),
          paddingTop: 4,
          color: ink,
          fontSize: body.fontSize,
          lineHeight: body.lineHeight,
          fontWeight: body.fontWeight,
        }}
      />
    </View>
  );
}

function ActionRow({
  title,
  tone = "action",
  disabled = false,
  index,
  total,
  onPress,
}: {
  readonly title: string;
  readonly tone?: "action" | "destructive";
  readonly disabled?: boolean;
  readonly index: number;
  readonly total: number;
  readonly onPress: () => void;
}) {
  const color = disabled ? secondary : tone === "destructive" ? red : blue;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        chrome.row,
        cardChrome(index, total),
        pressed && !disabled ? { backgroundColor: fill } : null,
      ]}
    >
      <Label color={color}>{title}</Label>
      {index < total - 1 ? <Hairline /> : null}
    </Pressable>
  );
}

function DestructiveRow({
  title,
  disabled = false,
  onPress,
}: {
  readonly title: string;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        chrome.row,
        cardChrome(0, 1),
        { justifyContent: "center" },
        pressed && !disabled ? { backgroundColor: fill } : null,
      ]}
    >
      <Label color={disabled ? secondary : red} style={{ flex: 1, textAlign: "center" }}>
        {title}
      </Label>
    </Pressable>
  );
}

function PrimaryButton({
  title,
  disabled = false,
  onPress,
}: {
  readonly title: string;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <GlassButton
      title={title}
      prominent
      size="large"
      disabled={disabled}
      style={{ height: 50, marginHorizontal: 20, marginTop: 16 }}
      onPress={onPress}
    />
  );
}

function QuietButton({ title, onPress }: { readonly title: string; readonly onPress: () => void }) {
  return (
    <GlassButton
      title={title}
      size="large"
      style={{ height: 50, marginHorizontal: 20, marginTop: 12 }}
      onPress={onPress}
    />
  );
}

function useLeave(navigation: { goBack(): void }, close: boolean, dirty: boolean): void {
  const left = useRef(false);
  useEffect(() => {
    if (!close || dirty || left.current) return;
    left.current = true;
    navigation.goBack();
  }, [close, dirty, navigation]);
}

function connectionsOf(dial: ReturnType<typeof useDial>): Record<string, Conn> {
  return (dial.kernel?.root.connections ?? {}) as Record<string, Conn>;
}

function listedConnections(dial: ReturnType<typeof useDial>): (readonly [string, Conn])[] {
  return Object.entries(connectionsOf(dial)).filter(([id]) => !id.startsWith("__"));
}

function pluginsOf(dial: ReturnType<typeof useDial>): Record<string, PluginFace> {
  return (dial.kernel?.root.plugins ?? {}) as Record<string, PluginFace>;
}

function botsOf(root: { readonly bots?: Record<string, BotFace> } | null | undefined): Record<string, BotFace> {
  return root?.bots ?? {};
}

function botSummaries(root: { readonly bots?: Record<string, BotFace> } | null | undefined): {
  id: string;
  title: string;
  detail: string;
}[] {
  return Object.entries(root?.bots ?? {}).map(([id, bot]) => ({
    id,
    title: shownName(bot.name, id),
    detail: asText(bot.description),
  }));
}

function isMcp(spec: Conn): boolean {
  return spec.driver?.abilityClaim?.includes("mcp") === true;
}

function modeOf(value: unknown): Mode {
  return value === "auto" || value === "yolo" ? value : "manual";
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function shownName(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? fallback : trimmed;
}

/** A key mask is painted as an ellipsis. The row already has a status, so the mark adds nothing. */
function paintedAccount(account: { readonly description: string; readonly balance: string }): string {
  const who = account.description === "…" ? "" : account.description;
  return [who, account.balance].filter((part) => part !== "").join(" · ");
}

function statusLabel(state: string | null | undefined): string {
  const value = shownName(state, "idle");
  if (value === "ready") return "Ready";
  if (value === "bootstrapping" || value === "connecting") return "Connecting";
  if (value === "failed") return "Failed";
  if (value === "idle") return "Idle";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

const NUMBER_BAR = "settings-number-bar";

function NumberBar() {
  if (Platform.OS !== "ios") return null;
  return (
    <InputAccessoryView nativeID={NUMBER_BAR}>
      <View style={numberBar}>
        <Pressable accessibilityRole="button" onPress={() => Keyboard.dismiss()} style={chrome.textButton}>
          <Label color={blue}>Done</Label>
        </Pressable>
      </View>
    </InputAccessoryView>
  );
}

const numberBar = {
  flexDirection: "row" as const,
  justifyContent: "flex-end" as const,
  alignItems: "center" as const,
  backgroundColor: grouped,
  borderTopWidth: StyleSheet.hairlineWidth,
  borderTopColor: separator,
};

function emptyBot(scope: Scope): BotDraft {
  return {
    scope,
    name: "",
    description: "",
    instructions: "",
    recipeScope: "session",
    tools: "",
    skills: "",
    keepAlive: false,
    mcp: [],
  };
}

function draftFrom(name: string, bot: BotFace, scope: Scope): BotDraft {
  const recipe = bot.recipeScope === "project" || bot.recipeScope === "global" ? bot.recipeScope : "session";
  return {
    scope,
    name: shownName(bot.name, name),
    description: asText(bot.description),
    instructions: asText(bot.instructions),
    recipeScope: recipe,
    tools: (bot.tools ?? []).join(", "),
    skills: (bot.skills ?? []).join(", "),
    keepAlive: bot.keepAlive === true,
    mcp: mcpDrafts(bot.mcpJson),
  };
}

function skillFailure(error: string): string {
  if (error.startsWith("Method not found")) {
    return "Couldn’t list skills. The harness on this Mac doesn’t know that request yet.";
  }
  return error;
}

function skillRowsFrom(result: unknown, project: string | null): SkillRow[] {
  if (result == null || typeof result !== "object" || !("skills" in result) || !Array.isArray(result.skills)) return [];
  const want: Scope = project == null ? "home" : "project";
  const rows: SkillRow[] = [];
  for (const item of result.skills) {
    if (item == null || typeof item !== "object") continue;
    const name = textField(item, "name");
    if (name === "") continue;
    const scope: Scope = textField(item, "scope") === "home" ? "home" : "project";
    if (scope !== want) continue;
    const invoke = textField(item, "invoke");
    rows.push({
      name,
      description: textField(item, "description"),
      location: textField(item, "location"),
      invoke: invoke === "" ? name : invoke,
      scope,
    });
  }
  return rows;
}

function textField(value: object, key: string): string {
  const read = (value as Record<string, unknown>)[key];
  return typeof read === "string" ? read : "";
}

function runtimeDraft(root: unknown): RuntimeDraft {
  const record = root as
    | {
        compactStrategy?: string;
        compactTriggers?: { hard?: string; soft?: string };
        compactKeepTurns?: number;
        contextGlowRemaining?: string;
        autoModeClassifier?: string;
        approvalAskThrottleMs?: number;
        speculativePolicyProcessingTools?: number;
        shellTailBytes?: number;
        statusline?: string;
        statuslineRefresh?: string;
        superKey?: string;
        hideFloorTools?: boolean;
        reActLoopIntentDetectedTrigger?: { enabled?: boolean };
      }
    | undefined;
  return {
    compact: asText(record?.compactStrategy),
    hard: asText(record?.compactTriggers?.hard),
    soft: asText(record?.compactTriggers?.soft),
    keep: String(record?.compactKeepTurns ?? 1),
    glow: asText(record?.contextGlowRemaining),
    classifier: asText(record?.autoModeClassifier),
    throttle: String(record?.approvalAskThrottleMs ?? 0),
    speculative: String(record?.speculativePolicyProcessingTools ?? 0),
    tail: String(record?.shellTailBytes ?? 0),
    statusline: asText(record?.statusline),
    refresh: asText(record?.statuslineRefresh),
    superKey: record?.superKey === "cmd" ? "cmd" : "ctrl",
    hideFloor: record?.hideFloorTools === true,
    textOnly: record?.reActLoopIntentDetectedTrigger?.enabled !== false,
  };
}

function parkOf(result: unknown): Park | null {
  if (result == null || typeof result !== "object") return null;
  if (!("form" in result) || result.form !== "ui") return null;
  if (!("pending" in result) || typeof result.pending !== "string") return null;
  if (!("body" in result) || typeof result.body !== "string") return null;
  return { pending: result.pending, body: result.body };
}

function idOf(result: unknown): string | null {
  if (result == null || typeof result !== "object" || !("id" in result) || typeof result.id !== "string") return null;
  return result.id === "" ? null : result.id;
}

function failureOf(result: unknown): string {
  if (result == null || typeof result !== "object") return "";
  if ("ok" in result && result.ok === false) {
    return "error" in result && typeof result.error === "string" ? result.error : "Not accepted.";
  }
  return "";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Not accepted.";
}

async function ask(request: Request | null, method: string, params: unknown): Promise<string> {
  if (request == null) return "The daemon is not connected.";
  try {
    return failureOf(await request(method, params));
  } catch (error) {
    return messageOf(error);
  }
}
