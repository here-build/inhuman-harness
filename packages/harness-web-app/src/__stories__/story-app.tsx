import { useState } from "react";
import type { SessionPlexus } from "@inhuman.tools/harness-peer";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";

import { type StoryDial, worldOf } from "./world.js";
import { createAppRouter } from "../app.js";
import { sessionHref } from "../shell/path.js";

export type Staged = { readonly dial: StoryDial; readonly at: string };

/**
 * The whole app at one route: the real router, frame, tape, and composer.
 * Only the dial is the story's: it serves frozen documents instead of rooms.
 * The world is built once per mount, so a story's later mutations land on it.
 */
export function StoryApp({ stage }: { readonly stage: () => Staged }) {
  const [router] = useState(() => {
    const { dial, at } = stage();
    const made = createAppRouter(dial.asDial);
    made.update({ history: createMemoryHistory({ initialEntries: [at] }), context: { dial: dial.asDial } });
    return made;
  });
  return <RouterProvider router={router} />;
}

/** A session's page, in a world that lists it and the `others` beside it. */
export function sessionStage(
  build: () => SessionPlexus,
  options: Parameters<typeof worldOf>[1] & { readonly others?: () => readonly SessionPlexus[] } = {},
): () => Staged {
  return () => {
    const open = build();
    return {
      dial: worldOf([open, ...(options.others?.() ?? [])], options),
      at: sessionHref(open.root.path, open.root.sessionId),
    };
  };
}
