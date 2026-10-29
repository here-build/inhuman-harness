import {
  requireNativeComponent,
  type ColorValue,
  type HostComponent,
  type StyleProp,
  type ViewProps,
  type ViewStyle,
} from "react-native";

type NativeGlassButtonProps = ViewProps & {
  title: string;
  symbol: string;
  prominent: boolean;
  destructive: boolean;
  enabled: boolean;
  size: string;
  label?: string;
  tint?: ColorValue;
  onPress: () => void;
};

const NativeGlassButton: HostComponent<NativeGlassButtonProps> =
  requireNativeComponent<NativeGlassButtonProps>("HarnessGlassButton");

/** A system UIButton: Liquid Glass on iOS 26+, gray/filled before. Give it a height (and width) in `style`. */
export function GlassButton({
  title = "",
  symbol = "",
  prominent = false,
  tint,
  destructive = false,
  disabled = false,
  size = "regular",
  accessibilityLabel,
  style,
  onPress,
}: {
  readonly title?: string;
  /** SF Symbol name. With no title the button is a circle when the style is square. */
  readonly symbol?: string;
  readonly prominent?: boolean;
  readonly tint?: ColorValue;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  readonly size?: "regular" | "large";
  readonly accessibilityLabel?: string;
  readonly style?: StyleProp<ViewStyle>;
  readonly onPress: () => void;
}) {
  return (
    <NativeGlassButton
      style={style}
      title={title}
      symbol={symbol}
      prominent={prominent}
      destructive={destructive}
      enabled={!disabled}
      size={size}
      label={accessibilityLabel}
      tint={tint}
      onPress={onPress}
      accessible
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? (title || undefined)}
      accessibilityState={{ disabled }}
    />
  );
}
