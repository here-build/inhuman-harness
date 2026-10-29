import { View, requireNativeComponent, type ColorValue, type HostComponent, type ViewProps } from "react-native";

import { useType } from "./type.js";

type SymbolProps = ViewProps & {
  name: string;
  pointSize: number;
  tintColor?: ColorValue;
};

const NativeSymbol: HostComponent<SymbolProps> = requireNativeComponent<SymbolProps>("HarnessSymbol");

/** An SF Symbol that rides the body's Dynamic Type scale, so icons grow with the text beside them. */
export function Symbol({
  name,
  size = 17,
  color,
}: {
  readonly name: string;
  readonly size?: number;
  readonly color?: ColorValue;
}) {
  const scale = useType().body.fontSize / 17;
  const pointSize = size * scale;
  const box = Math.ceil(pointSize);
  return (
    <View collapsable={false} style={{ width: box, height: box, flexShrink: 0 }}>
      <NativeSymbol
        name={name}
        pointSize={pointSize}
        tintColor={color}
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{ width: box, height: box }}
      />
    </View>
  );
}
