import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SessionTurn } from "@inhuman.tools/harness-model";
import { observer } from "mobx-react-lite";
import {
  ActivityIndicator,
  FlatList,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  StyleSheet,
  View,
} from "react-native";

import { AgentRow, Cell, SIDE, ThoughtsRow } from "./native/cells.js";
import { DialProvider, HostProvider, ink, T, useDial, type TranscriptHost } from "./native/host.js";
import { FIRST_WINDOW, growWindow } from "./tail-window.js";
import type { Dial } from "../../harness-web-app/src/client/dial.js";
import { canEditMessages, editMessage, type EditSink } from "../../harness-web-app/src/shell/edit-message.js";
import type { TapeBeat } from "../../harness-web-app/src/shell/tape-beats.js";
import { turnBeats, turnOutline } from "../../harness-web-app/src/shell/tape-live.js";
import { turnsOldestFirst } from "../../harness-web-app/src/shell/tape-read.js";

export type { EditSink } from "../../harness-web-app/src/shell/edit-message.js";
export type { Face, MessageAction, MessageMenuProps, Role, TranscriptHost } from "./native/host.js";

/**
 * What a row needs to find its turn. It rides in context and the list's data is only ids: React's
 * development build describes a component's props by walking them, and a prop that reaches the
 * session document makes that walk touch all of it.
 */
type Rows = {
  readonly projectPath: string;
  readonly turnOf: (id: string) => SessionTurn | undefined;
  readonly edit: (turn: SessionTurn) => void;
};

const RowsContext = createContext<Rows | null>(null);

function Beat({ beat, turn, rows }: { readonly beat: TapeBeat; readonly turn: SessionTurn; readonly rows: Rows }) {
  const dial = useDial();
  const editable = canEditMessages(dial);
  const startsAsk = beat.cells.some((cell) => cell.kind === "user");
  return (
    <View style={{ paddingTop: startsAsk ? 22 : 14, gap: 10 }}>
      {beat.mark == null || beat.mark.title === "" ? null : (
        <View style={{ paddingHorizontal: SIDE, gap: 2 }}>
          <T role="headline">{beat.mark.title}</T>
          {beat.mark.description === "" ? null : (
            <T role="subhead" color={ink.secondary}>
              {beat.mark.description}
            </T>
          )}
        </View>
      )}
      {beat.thoughts.length === 0 ? null : <ThoughtsRow thoughts={beat.thoughts} />}
      {beat.cells.map((cell) => (
        <Cell
          key={cell.id}
          cell={cell}
          {...(editable && cell.kind === "user" && cell.id === `${turn.uuid}:user`
            ? { onEdit: () => rows.edit(turn) }
            : {})}
        />
      ))}
      {beat.agents.map((agent) => (
        <AgentRow key={agent.id} cell={agent} />
      ))}
    </View>
  );
}

/**
 * One round, found by id in its turn's projection. A turn is projected only when one of its rounds
 * is drawn; projecting a whole session would also parse every program in it before the first row.
 */
const BeatRow = observer(function BeatRowView({ id }: { readonly id: string }) {
  const rows = useContext(RowsContext);
  const turn = rows?.turnOf(id);
  if (turn == null || rows == null) return null;
  const beat = turnBeats(turn, rows.projectPath).find((item) => item.id === id);
  return beat == null ? null : <Beat beat={beat} turn={turn} rows={rows} />;
});

const Working = observer(function WorkingView() {
  const dial = useDial();
  const running = dial.session?.root.findRunningTurn() != null;
  if (!running) return null;
  return (
    <View
      accessible
      accessibilityLabel="Working"
      accessibilityLiveRegion="polite"
      style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: SIDE, paddingTop: 14 }}
    >
      <ActivityIndicator size="small" />
      <T role="subhead" color={ink.secondary}>
        Working…
      </T>
    </View>
  );
});

export type TapeProps = {
  readonly dial: Dial;
  /** The session to show. Until the dial has it attached, `loading` stands in. */
  readonly sessionId: string;
  readonly host: TranscriptHost;
  /** Room the host's chrome takes: the transparent header above, the composer below. */
  readonly inset: { readonly top: number; readonly bottom: number };
  /** An edited message's prompt and pictures, for the host's composer. */
  readonly onEditDraft: EditSink;
  /**
   * True when the reader drags the list more than a few points away from the end, false when they
   * come back within reach of it. Told only on transitions, and again if a new drag moves away.
   */
  readonly onReading?: (reading: boolean) => void;
  readonly loading: ReactNode;
  readonly empty: ReactNode;
};

/** The list is filled to this many screens before it is shown. */
const FILL = 1.5;
/** Within this many points of the end counts as reading the end. */
const PIN_SLOP = 120;
/** A drag has to move this far from where it began before it counts as reading. */
const READ_SLOP = 24;

const keyOf = (id: string): string => id;
const renderRow = ({ item }: { readonly item: string }) => <BeatRow id={item} />;

/**
 * The transcript, drawn by React Native. The tape's structure (beats, cells, helpers) is the
 * web's; here the cells are native views in a virtualized list that opens at the latest message.
 * The list is inverted: the bottom is offset zero, so a streaming reply stays pinned there until
 * the reader scrolls up, and nothing scrolls on open.
 */
export const Tape = observer(function TapeView({
  dial,
  sessionId,
  host,
  inset,
  onEditDraft,
  onReading,
  loading,
  empty,
}: TapeProps) {
  const root = dial.session?.root.sessionId === sessionId ? dial.session.root : null;
  // Deriving 18 MB of turns blocks the thread; the spinner paints first.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (root == null) {
      setReady(false);
      return;
    }
    // eslint-disable-next-line compat/compat -- React Native provides requestAnimationFrame
    const frame = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(frame);
  }, [root]);
  const chain = ready && root != null ? turnsOldestFirst(root) : null;
  // The list holds the latest rounds and grows upward as the reader scrolls: the first layout is
  // exact, so opening at the bottom lands on the last message.
  const [span, setSpan] = useState(FIRST_WINDOW);
  const path = root?.path ?? "";
  const unfolded = (chain ?? []).slice(-span.turns).map((turn) => ({
    turn,
    ids: turnOutline(turn, path).map((beat) => beat.id),
  }));
  const flat = unfolded.flatMap((item) => item.ids);
  const shown = flat.slice(-span.rounds);
  const owners = useMemo(() => {
    const map = new Map<string, SessionTurn>();
    for (const item of unfolded) for (const id of item.ids) map.set(id, item.turn);
    return map;
    // The outline ids are structurally stable; the turns alone say when this changes.
  }, [unfolded.map((item) => item.turn.uuid).join(","), flat.length]);
  const chainLength = chain?.length ?? 0;
  const more = useCallback(() => {
    setSpan((now) => growWindow(now, flat.length, chainLength) ?? now);
  }, [flat.length, chainLength]);
  const list = useRef<FlatList<string>>(null);
  const pinned = useRef(true);
  const [revealed, setRevealed] = useState(false);
  // Only the reader's own scrolling moves the pin. A list that grows under a programmatic scroll
  // also ends in a scroll event, and that one must not unpin it.
  const dragged = useRef(false);
  // Where this drag began, and what the host was last told during it. Null until it has moved.
  const origin = useRef(0);
  const told = useRef<boolean | null>(null);
  const tell = useCallback(
    (reading: boolean) => {
      if (told.current === reading) return;
      told.current = reading;
      onReading?.(reading);
    },
    [onReading],
  );
  const onBeginDrag = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    dragged.current = true;
    origin.current = event.nativeEvent.contentOffset.y;
    told.current = null;
  }, []);
  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!dragged.current) return;
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      const away = contentSize.height - (contentOffset.y + layoutMeasurement.height) >= PIN_SLOP;
      if (!away) tell(false);
      else if (Math.abs(contentOffset.y - origin.current) > READ_SLOP) tell(true);
    },
    [tell],
  );
  const onScrollEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!dragged.current) return;
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      pinned.current = contentSize.height - (contentOffset.y + layoutMeasurement.height) < PIN_SLOP;
      if (pinned.current) tell(false);
    },
    [tell],
  );
  const onMomentumEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      onScrollEnd(event);
      dragged.current = false;
    },
    [onScrollEnd],
  );
  const viewport = useRef(0);
  const canGrow = growWindow(span, flat.length, chainLength) != null;
  const grew = useCallback(
    (_width: number, height: number) => {
      // Too little to fill the screen: list more above before the first reveal, and keep short
      // content at the bottom.
      if (canGrow && height < viewport.current * FILL) {
        more();
        return;
      }
      if (!pinned.current) return;
      // The scroll view's own end; the list's estimate of unmeasured rows is not.
      list.current?.getScrollResponder()?.scrollToEnd({ animated: false });
      // eslint-disable-next-line compat/compat -- React Native provides requestAnimationFrame
      requestAnimationFrame(() => setRevealed(true));
    },
    [canGrow, more],
  );
  const rows = useMemo<Rows>(
    () => ({
      projectPath: path,
      turnOf: (id) => owners.get(id),
      edit: (turn) => void editMessage(dial, turn, onEditDraft),
    }),
    [path, owners, dial, onEditDraft],
  );
  const footer = useMemo(
    () => (
      <View style={{ height: inset.bottom + 12 }}>
        <Working />
      </View>
    ),
    [inset.bottom],
  );
  const content = useMemo(
    () => ({ flexGrow: 1, justifyContent: "flex-end" as const, paddingTop: inset.top + 12 }),
    [inset.top],
  );
  if (chain == null) return <View style={{ flex: 1, backgroundColor: ink.background }}>{loading}</View>;
  if ((chain?.length ?? 0) === 0) return <View style={{ flex: 1, backgroundColor: ink.background }}>{empty}</View>;
  return (
    <HostProvider value={host}>
      <DialProvider value={dial}>
        <View style={{ flex: 1 }}>
          <RowsContext.Provider value={rows}>
            <FlatList
              ref={list}
              data={shown}
              extraData={rows}
              keyExtractor={keyOf}
              renderItem={renderRow}
              ListFooterComponent={footer}
              contentContainerStyle={content}
              initialNumToRender={FIRST_WINDOW.rounds}
              maxToRenderPerBatch={4}
              windowSize={7}
              onStartReached={more}
              onStartReachedThreshold={2}
              onScrollBeginDrag={onBeginDrag}
              onScroll={onScroll}
              scrollEventThrottle={16}
              onScrollEndDrag={onScrollEnd}
              onMomentumScrollEnd={onMomentumEnd}
              onContentSizeChange={grew}
              onLayout={(event) => {
                viewport.current = event.nativeEvent.layout.height;
              }}
              maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
              contentInsetAdjustmentBehavior="never"
              automaticallyAdjustContentInsets={false}
              scrollIndicatorInsets={{ top: inset.top, bottom: inset.bottom }}
              keyboardDismissMode="interactive"
              style={{ flex: 1, backgroundColor: ink.background, opacity: revealed ? 1 : 0 }}
            />
          </RowsContext.Provider>
          {revealed ? null : <View style={StyleSheet.absoluteFill}>{loading}</View>}
        </View>
      </DialProvider>
    </HostProvider>
  );
});
