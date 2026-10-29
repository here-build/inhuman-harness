import {
  requireNativeComponent,
  type ColorValue,
  type HostComponent,
  type NativeSyntheticEvent,
  type ViewProps,
} from "react-native";

export type MenuAction = { title: string; subtitle?: string; destructive?: boolean };

type MenuProps = ViewProps & {
  actions: readonly MenuAction[];
  highlight?: ColorValue;
  onSelect?: (event: NativeSyntheticEvent<{ index: number }>) => void;
  onPress?: () => void;
};

export const ContextMenu: HostComponent<MenuProps> = requireNativeComponent<MenuProps>("HarnessMenu");
