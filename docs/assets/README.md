# Repository media

These assets describe the product and show its real interface. Keep screenshots
current when the interface changes, and label fixture data as a demo.

| Asset | Source and use |
| --- | --- |
| [cover.svg](cover.svg) | Editable vector artwork for the root README. Its diagram shows clients attaching to the persistent daemon. |
| [social-preview.svg](social-preview.svg) | Editable 1280 × 640 version of the cover. |
| [social-preview.png](social-preview.png) | Raster export, ready for GitHub **Settings → General → Social preview**. This file does not change the repository setting automatically. |
| [browser-session.png](browser-session.png) | Browser client rendered in Chromium from the existing `conversation` fixture using `StoryApp` and `sessionStage`. Light theme, 1280 × 800 viewport, conversation scrolled to its beginning. |

The screenshot uses the real router, components, typography, and styles with
frozen demo documents. It is not a recording of a live model run and does not
demonstrate background execution. Its sources are
[`scenes.ts`](../../packages/harness-web-app/src/__stories__/scenes.ts),
[`story-app.tsx`](../../packages/harness-web-app/src/__stories__/story-app.tsx),
and the [app styles](../../packages/harness-web-app/src/styles.css).
Use the app's [Storybook](../../packages/harness-web-app/src/__stories__/README.md)
to inspect the same components and fixtures before refreshing it.

The covers use a warm paper background, dark green type, and a vermilion edge.
Keep the type readable at README width. The diagram is explanatory artwork,
not a screenshot. Both SVGs contain accessible titles and descriptions; the
README also supplies alternative text.
