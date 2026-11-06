import { useEffect, useState } from "react";

import { pageScheme, type ColorScheme } from "./highlight.js";

/** Follows the OS preference and a pinned `data-scheme` on the root, whichever decides. */
export function useScheme(): ColorScheme {
  const [scheme, setScheme] = useState<ColorScheme>(pageScheme);
  useEffect(() => {
    const apply = (): void => setScheme(pageScheme());
    apply();
    const query =
      typeof globalThis.matchMedia === "function" ? globalThis.matchMedia("(prefers-color-scheme: dark)") : null;
    query?.addEventListener("change", apply);
    const pin = new MutationObserver(apply);
    pin.observe(document.documentElement, { attributes: true, attributeFilter: ["data-scheme"] });
    return () => {
      query?.removeEventListener("change", apply);
      pin.disconnect();
    };
  }, []);
  return scheme;
}
