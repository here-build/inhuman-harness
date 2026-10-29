import { useMemo, type ReactNode } from "react";
import type { MessageMenuProps, TranscriptHost } from "@inhuman.tools/harness-transcript";
import Clipboard from "@react-native-clipboard/clipboard";
import { Linking } from "react-native";

import { ContextMenu } from "./menu.js";
import { useType } from "./type.js";

/** The transcript's long-press menu is the system one: lifted message, blurred page, vertical list. */
function MessageMenu({ actions, onAction, children, ...view }: MessageMenuProps) {
  return (
    <ContextMenu
      {...view}
      actions={actions.map((action) => ({
        title: action.title,
        ...(action.subtitle == null ? {} : { subtitle: action.subtitle }),
        ...(action.destructive === true ? { destructive: true } : {}),
      }))}
      onSelect={(event) => {
        const action = actions[event.nativeEvent.index];
        if (action != null) onAction(action.id);
      }}
    >
      {children as ReactNode}
    </ContextMenu>
  );
}

/** What the transcript borrows from this app: its Dynamic Type faces, the menu, the clipboard, the browser. */
export function useTranscriptHost(): TranscriptHost {
  const faces = useType();
  return useMemo(
    () => ({
      faces,
      Menu: MessageMenu,
      copy: (text: string) => Clipboard.setString(text),
      openUrl: (url: string) => {
        void Linking.openURL(url).catch(() => undefined);
      },
    }),
    [faces],
  );
}
