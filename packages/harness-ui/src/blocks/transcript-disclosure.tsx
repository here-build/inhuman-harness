import { useContext, useLayoutEffect, useRef, type ComponentProps } from "react";
import { DisclosureStateContext } from "react-aria-components";

import { DisclosurePanel } from "../primitives/navigation.js";

/** Disclosure panel preserving native `hidden="until-found"` browser-find expansion on closed sections. */
export function TranscriptDisclosurePanel(props: ComponentProps<typeof DisclosurePanel>) {
  const state = useContext(DisclosureStateContext);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const panel = ref.current;
    if (panel == null || state == null) return;
    if (!state.isExpanded) panel.setAttribute("hidden", "until-found");
    const reveal = (): void => state.expand();
    panel.addEventListener("beforematch", reveal);
    return () => panel.removeEventListener("beforematch", reveal);
  }, [state, state?.isExpanded]);
  return <DisclosurePanel {...props} ref={ref} />;
}
