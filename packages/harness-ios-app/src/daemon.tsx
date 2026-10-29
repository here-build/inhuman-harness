import { useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, View } from "react-native";

import { chrome, Empty } from "./chrome.js";
import { DAEMON_UNANSWERED, DAEMON_WHERE, OPENING } from "./copy.js";
import { useDial } from "./dial-context.js";
import { GlassButton } from "./glass-button.js";
import { Label } from "./type.js";

function Gate({ children }: { readonly children: ReactNode }) {
  return <View style={[chrome.screen, { alignItems: "center", justifyContent: "center" }]}>{children}</View>;
}

export function Opening() {
  return (
    <Gate>
      <View accessible accessibilityLabel={OPENING} style={{ alignItems: "center", gap: 14 }}>
        <ActivityIndicator size="large" />
        <Label role="subhead">{OPENING}</Label>
      </View>
    </Gate>
  );
}

export function Daemon({ timedOut }: { readonly timedOut: boolean }) {
  const dial = useDial();
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!dial.attaching) setPending(false);
  }, [dial.attaching]);
  return (
    <Gate>
      <Empty
        symbol="desktopcomputer.trianglebadge.exclamationmark"
        title={timedOut ? DAEMON_UNANSWERED : "Can’t reach the daemon"}
        detail={DAEMON_WHERE}
      />
      <GlassButton
        title={pending ? "Retrying…" : "Retry"}
        prominent
        size="large"
        disabled={pending}
        accessibilityLabel="Retry"
        style={{ height: 50, width: 160, marginTop: 8 }}
        onPress={() => {
          setPending(true);
          void dial.follow({ kind: "kernel" });
        }}
      />
    </Gate>
  );
}
