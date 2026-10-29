import { useState } from "react";
import { Tape } from "@inhuman.tools/harness-transcript";
import { createRootRouteWithContext, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";

import { DialProvider } from "./client/context.js";
import { Dial, dialOrigin } from "./client/dial.js";
import { Frame } from "./shell/frame.js";

const rootRoute = createRootRouteWithContext<{ dial: Dial }>()({
  component: function Root() {
    const { dial } = rootRoute.useRouteContext();
    return (
      <DialProvider dial={dial}>
        <Frame />
      </DialProvider>
    );
  },
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  loader: ({ context, abortController }) => context.dial.follow({ kind: "kernel" }, abortController.signal),
  component: Tape,
  pendingComponent: Tape,
  shouldReload: true,
});

// The project match survives sibling session navigation. Only its leaf loader
// changes the active session; no parent effect tears down the shared directory.
const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/p/$path",
  component: Outlet,
});

const projectIndexRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/",
  loader: ({ context, params, abortController }) =>
    context.dial.follow({ kind: "project", path: params.path }, abortController.signal),
  component: Tape,
  pendingComponent: Tape,
  shouldReload: true,
});

const sessionRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "s/$sessionId",
  loader: ({ context, params, abortController }) =>
    context.dial.follow(
      { kind: "project-session", path: params.path, sessionId: params.sessionId },
      abortController.signal,
    ),
  component: Tape,
  pendingComponent: Tape,
  shouldReload: true,
});

const looseRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/s/$sessionId",
  loader: ({ context, params, abortController }) =>
    context.dial.follow({ kind: "session", sessionId: params.sessionId }, abortController.signal),
  component: Tape,
  pendingComponent: Tape,
  shouldReload: true,
});

export const routeTree = rootRoute.addChildren([
  indexRoute,
  projectRoute.addChildren([projectIndexRoute, sessionRoute]),
  looseRoute,
]);

export function createAppRouter(dial: Dial) {
  return createRouter({
    routeTree,
    context: { dial },
    // Attachments are live resources, not cached query results. Returning via
    // Back must activate the room again even if the route match is cached.
    defaultStaleTime: 0,
    defaultPreload: false,
    defaultPendingMs: 150,
    defaultPendingMinMs: 0,
  });
}

export function App() {
  const [router] = useState(() => createAppRouter(new Dial(dialOrigin(globalThis.location))));
  return <RouterProvider router={router} />;
}
