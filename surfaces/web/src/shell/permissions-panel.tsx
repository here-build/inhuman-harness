import { useCallback, useEffect, useId, useState } from "react";
import { PermissionsBodyBlock, PermissionsExplainBlock } from "@inhuman.tools/harness-ui";
import { observer } from "mobx-react-lite";

import {
  explain,
  loadPermissions,
  permissionsView,
  revokeRow,
  type ExplainLines,
  type PermissionsData,
} from "./permissions-view.js";
import { useDial } from "../client/context.js";

/** Live settings panel wiring kernel/session permission RPCs into harness-ui permission blocks. */
export const PermissionsPanel = observer(function PermissionsPanelView() {
  const dial = useDial();
  const root = dial.session?.root;
  const session = dial.sessionRpc;
  const kernel = dial.kernelRpc;
  const sessionId = root?.sessionId ?? null;
  const [data, setData] = useState<PermissionsData | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [probe, setProbe] = useState("");
  const probeId = useId();
  const probeHelpId = useId();
  const noticeId = useId();
  const [lines, setLines] = useState<ExplainLines | null>(null);
  const mode = root?.permissionMode ?? root?.standingPermissionMode ?? dial.kernel?.root.defaultPermissionMode;
  const sessionGrants = root?.grantsJson ?? "";
  const kernelGrants = dial.kernel?.root.grantsJson ?? "";
  const policyProgram = root?.policyProgram ?? "";

  const load = useCallback(async () => {
    setData(
      await loadPermissions({
        session: session == null ? null : (method, params) => session.request(method, params),
        kernel: kernel == null ? null : (method, params) => kernel.request(method, params),
        sessionId,
        projectPath: root?.path ?? null,
        mode,
        nowMs: Date.now(),
      }),
    );
  }, [session, kernel, sessionId, root?.path, mode, sessionGrants, kernelGrants, policyProgram]);
  useEffect(() => {
    void load();
  }, [load]);

  if (kernel == null) return <p className="text-sm text-subtle">The daemon is not connected.</p>;
  if (data == null) return <p className="text-sm text-subtle">Loading.</p>;
  const view = permissionsView(data);
  return (
    <>
      {notice === "" ? null : (
        <p id={noticeId} className="text-sm text-danger" role="status">
          {notice}
        </p>
      )}
      <PermissionsBodyBlock
        view={view}
        busy={busy}
        onRevoke={(row) => {
          setBusy(true);
          setNotice("");
          void revokeRow((method, params) => kernel.request(method, params), row, sessionId)
            .then((ok) => (ok ? load() : setNotice("Not revoked.")))
            .catch((error: unknown) => setNotice(error instanceof Error ? error.message : "Not revoked."))
            .finally(() => setBusy(false));
        }}
      >
        <PermissionsExplainBlock
          probeId={probeId}
          probeHelpId={probeHelpId}
          noticeId={noticeId}
          hasNotice={notice !== ""}
          canExplain={session != null}
          probe={probe}
          lines={lines}
          onProbeChange={setProbe}
          onSubmit={() => {
            if (session == null) return;
            setNotice("");
            void explain((method, params) => session.request(method, params), probe, view.mode)
              .then(setLines)
              .catch((error: unknown) => setNotice(error instanceof Error ? error.message : "Could not explain."));
          }}
        />
      </PermissionsBodyBlock>
    </>
  );
});

export {
  PermissionsBodyBlock as PermissionsBody,
  ExplainResultBlock as ExplainResult,
} from "@inhuman.tools/harness-ui";
