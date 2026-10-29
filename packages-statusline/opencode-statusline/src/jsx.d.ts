// OpenCode compiles src/tui.tsx itself (OpenTUI's Solid transform under Bun); this only lets tsc check it.
declare namespace JSX {
  type Element = unknown;
  interface IntrinsicElements {
    text: { fg?: unknown; children?: unknown };
  }
}
