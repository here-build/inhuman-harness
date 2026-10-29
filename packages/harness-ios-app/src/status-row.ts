import type { ListRow } from "./native-list.js";
import type { RowLight } from "../../harness-web-app/src/shell/light.js";

/** The row's status: a count of asks beats the light; a running session is a small green dot; idle shows nothing. */
export function statusRow(light: RowLight, waiting: number | undefined): Partial<ListRow> {
  if (waiting != null && waiting > 0) return { badge: waiting };
  if (light === "running") return { symbol: "circle.fill", symbolTint: "green", symbolScale: "small" };
  if (light === "idle") return {};
  return { symbol: "circle", symbolTint: "orange", symbolScale: "small" };
}
