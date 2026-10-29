import { StyleSheet, requireNativeComponent, type HostComponent, type ViewProps } from "react-native";

type NativeFollowerProps = ViewProps & { gap?: number };

const NativeFollower: HostComponent<NativeFollowerProps> =
  requireNativeComponent<NativeFollowerProps>("HarnessKeyboardFollower");

const style = StyleSheet.create({ none: { position: "absolute", width: 0, height: 0 } });

/**
 * Renders nothing. As the first child of a view, it lifts that view with the keyboard inside UIKit's own
 * keyboard animation, so the view's bottom edge rests `gap` points above the keyboard. No JS runs per frame.
 */
export function KeyboardFollower({ gap = 8 }: { readonly gap?: number }) {
  return (
    <NativeFollower
      gap={gap}
      style={style.none}
      pointerEvents="none"
      accessible={false}
      importantForAccessibility="no-hide-descendants"
    />
  );
}
