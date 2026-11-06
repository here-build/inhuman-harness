import { createContext, useContext, useEffect, type ReactNode } from "react";

import type { Dial } from "./dial.js";
import { bindBlobCache } from "../shell/blob-cache.js";

const DialContext = createContext<Dial | null>(null);

export function DialProvider({ children, dial }: { readonly children: ReactNode; readonly dial: Dial }) {
  // The tape reads blob text through this cache; it asks the daemon on the session that is open now.
  useEffect(
    () =>
      bindBlobCache(async (method, params) => {
        const port = dial.sessionRpc;
        if (port === null) throw new Error("blobs: no session is open");
        return port.request(method, params);
      }),
    [dial],
  );
  return <DialContext.Provider value={dial}>{children}</DialContext.Provider>;
}

export function useDial(): Dial {
  const dial = useContext(DialContext);
  if (dial == null) throw new Error("DialProvider missing");
  return dial;
}
