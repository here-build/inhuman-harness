import {
  requireNativeComponent,
  type HostComponent,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";

export type ListSwipeAction = {
  readonly id: string;
  readonly label: string;
  readonly tone: "action" | "quiet" | "destructive";
};

export type ListMenuItem = {
  readonly id: string;
  readonly title: string;
  readonly symbol?: string;
  readonly destructive?: boolean;
};

export type ListRow = {
  readonly key: string;
  readonly title: string;
  readonly detail?: string;
  readonly detailDanger?: boolean;
  readonly checked?: boolean;
  readonly disclosure?: boolean;
  readonly switchOn?: boolean;
  readonly disabled?: boolean;
  /** SF Symbol shown leading, tinted by `symbolTint`. */
  readonly symbol?: string;
  readonly symbolTint?: "green" | "orange" | "red" | "blue" | "secondary" | "tertiary";
  readonly symbolScale?: "small" | "medium" | "large";
  /** Trailing secondary text. */
  readonly value?: string;
  /** Trailing orange count, shown when > 0. */
  readonly badge?: number;
  readonly detailLines?: number;
  readonly detailMiddle?: boolean;
  readonly menu?: readonly ListMenuItem[];
  readonly leadingSwipe?: readonly ListSwipeAction[];
  readonly trailingSwipe?: readonly ListSwipeAction[];
};

export type ListSection = {
  readonly key: string;
  readonly header?: string;
  readonly footer?: string;
  readonly footerDanger?: boolean;
  readonly rows: readonly ListRow[];
};

type ListEvent = { readonly key: string; readonly value?: boolean; readonly action?: string };

type HarnessListProps = {
  readonly style?: StyleProp<ViewStyle>;
  readonly sections: readonly ListSection[];
  readonly notice?: string;
  readonly emptyTitle?: string;
  readonly emptyDetail?: string;
  readonly noticeAction?: string;
  readonly onPress: (event: NativeSyntheticEvent<ListEvent>) => void;
  readonly onSwitch?: (event: NativeSyntheticEvent<ListEvent>) => void;
  readonly onSwipeAction?: (event: NativeSyntheticEvent<ListEvent>) => void;
  readonly onMenuAction?: (event: NativeSyntheticEvent<ListEvent>) => void;
  readonly onNoticeAction?: () => void;
};

const HarnessList: HostComponent<HarnessListProps> = requireNativeComponent<HarnessListProps>("HarnessList");

/** An inset-grouped list drawn by UIKit: cells, swipe actions, and Dynamic Type are the system's. */
export function NativeList({
  style,
  sections,
  notice,
  emptyTitle,
  emptyDetail,
  noticeAction,
  onPressRow,
  onSwitchRow,
  onAction,
  onMenuRow,
  onNoticeAction,
}: {
  readonly style?: StyleProp<ViewStyle>;
  readonly sections: readonly ListSection[];
  readonly notice?: string;
  readonly emptyTitle?: string;
  readonly emptyDetail?: string;
  readonly onPressRow: (key: string) => void;
  readonly onSwitchRow?: (key: string, value: boolean) => void;
  readonly onAction?: (key: string, action: string) => void;
  readonly noticeAction?: string;
  readonly onMenuRow?: (key: string, action: string) => void;
  readonly onNoticeAction?: () => void;
}) {
  return (
    <HarnessList
      style={[{ flex: 1 }, style]}
      sections={sections as ListSection[]}
      notice={notice}
      emptyTitle={emptyTitle}
      emptyDetail={emptyDetail}
      noticeAction={noticeAction}
      onPress={(event) => onPressRow(event.nativeEvent.key)}
      onSwitch={
        onSwitchRow == null
          ? undefined
          : (event) => onSwitchRow(event.nativeEvent.key, event.nativeEvent.value === true)
      }
      onSwipeAction={
        onAction == null ? undefined : (event) => onAction(event.nativeEvent.key, event.nativeEvent.action ?? "")
      }
      onMenuAction={
        onMenuRow == null ? undefined : (event) => onMenuRow(event.nativeEvent.key, event.nativeEvent.action ?? "")
      }
      onNoticeAction={onNoticeAction}
    />
  );
}
