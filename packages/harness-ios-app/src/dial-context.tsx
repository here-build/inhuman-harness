import { createContext, useContext, useState, type ReactNode } from "react";

import { SOCKET_ORIGIN } from "./directory.js";
import { deviceDocCache } from "./doc-cache.js";
import { Dial } from "../../harness-web-app/src/client/dial.js";

const DialContext = createContext<Dial | null>(null);

export function DialProvider({ children }: { readonly children: ReactNode }) {
  const [dial] = useState(() => new Dial(SOCKET_ORIGIN, { cache: deviceDocCache() ?? undefined }));
  return <DialContext.Provider value={dial}>{children}</DialContext.Provider>;
}

export function useDial(): Dial {
  const dial = useContext(DialContext);
  if (dial == null) throw new Error("DialProvider is missing.");
  return dial;
}
