import type { ReactNode } from "react";

import { Button } from "../primitives/button.js";
import { TextField } from "../primitives/text-field.js";

/** Cell rendering for one ask / soft-deny permission matrix column. */
export interface PermissionCellView {
  readonly text: string;
  readonly title: string;
  readonly layer: string;
}

/** One policy class row in the permissions matrix table. */
export interface PermissionClassRowView {
  readonly id: string;
  readonly ask: PermissionCellView;
  readonly softDeny: PermissionCellView;
}

/** Active acknowledgement flag row displayed in the permissions inspector. */
export interface PermissionFlagRowView {
  readonly label: string;
  readonly why: string;
  readonly layer: string;
}

/** Stored grant or acknowledgement row displayed in the permissions inspector. */
export interface StoredPermissionRowView {
  readonly id: string;
  readonly scope: string;
  readonly label: string;
  readonly created: string;
  readonly expires: string;
  readonly source: string;
  readonly revocable: boolean;
}

/** Pure presentation data for the permissions inspector body. */
export interface PermissionsBodyView {
  readonly mode: string;
  readonly warnings: readonly string[];
  readonly classes: readonly PermissionClassRowView[];
  readonly grants: readonly StoredPermissionRowView[];
  readonly flags: readonly PermissionFlagRowView[];
  readonly acks: readonly StoredPermissionRowView[];
}

/** Structured explanation returned from probing a command, path, or MCP tool. */
export interface ExplainResultView {
  readonly outcome: string;
  readonly reason: string;
  readonly classes: string;
  readonly resolver: string;
  readonly grant: string;
  readonly ack: string;
}

export function LayerBadge({ layer }: { readonly layer: string }) {
  return (
    <span className="layer-badge" data-layer={layer}>
      {layer}
    </span>
  );
}

export function StoredPermissionList<Row extends StoredPermissionRowView>({
  title,
  rows,
  empty,
  busy,
  onRevoke,
}: {
  readonly title: string;
  readonly rows: readonly Row[];
  readonly empty: string;
  readonly busy: boolean;
  readonly onRevoke: (row: Row) => void;
}) {
  return (
    <section className="flex flex-col gap-2" aria-label={title}>
      <h3 className="text-xl leading-[26px]">{title}</h3>
      {rows.length === 0 ? <p className="text-sm text-subtle">{empty}</p> : null}
      {rows.map((row) => (
        <article key={row.id} className="settings-row">
          <div className="settings-row-main">
            <div className="settings-grow">
              <p className="text-sm font-strong break-words">{row.label}</p>
              <p className="text-sm text-muted">
                {row.scope} · created {row.created} · {row.expires} · {row.source}
              </p>
            </div>
            {row.revocable ? (
              <Button
                variant="secondary"
                disabled={busy}
                aria-label={`Revoke ${row.label}`}
                onClick={() => onRevoke(row)}
              >
                Revoke
              </Button>
            ) : (
              <span className="text-sm text-subtle">in settings</span>
            )}
          </div>
        </article>
      ))}
    </section>
  );
}

export interface PermissionsBodyBlockProps<Row extends StoredPermissionRowView> {
  readonly view: PermissionsBodyView & {
    readonly grants: readonly Row[];
    readonly acks: readonly Row[];
  };
  readonly busy: boolean;
  readonly onRevoke: (row: Row) => void;
  readonly children?: ReactNode;
}

/** Renders the resolved policy matrix, stored grants, active flags, and stored acknowledgements. */
export function PermissionsBodyBlock<Row extends StoredPermissionRowView>({
  view,
  busy,
  onRevoke,
  children,
}: PermissionsBodyBlockProps<Row>) {
  return (
    <>
      {view.warnings.map((warning) => (
        <p key={warning} className="text-sm text-warning" role="status">
          {warning}
        </p>
      ))}
      <section aria-label="Mode and classes">
        <h3 className="text-xl leading-[26px]">
          Mode: <span className="permissions-mode">{view.mode}</span>
        </h3>
        <table className="permissions-table">
          <thead>
            <tr>
              <th scope="col">Class</th>
              <th scope="col">Ask</th>
              <th scope="col">Soft-deny</th>
            </tr>
          </thead>
          <tbody>
            {view.classes.map((row) => (
              <tr key={row.id}>
                <th scope="row" className="mono">
                  {row.id}
                </th>
                <td title={row.ask.title}>
                  {row.ask.text} <LayerBadge layer={row.ask.layer} />
                </td>
                <td title={row.softDeny.title}>
                  {row.softDeny.text} <LayerBadge layer={row.softDeny.layer} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <StoredPermissionList
        title="Stored grants"
        rows={view.grants}
        empty="No stored grants."
        busy={busy}
        onRevoke={onRevoke}
      />
      <section className="flex flex-col gap-2" aria-label="Flags in force">
        <h3 className="text-xl leading-[26px]">Needs acknowledgement</h3>
        {view.flags.length === 0 ? <p className="text-sm text-subtle">No flags in force.</p> : null}
        {view.flags.map((flag) => (
          <p key={`${flag.layer}\0${flag.label}`} className="text-sm break-words">
            {flag.label} <LayerBadge layer={flag.layer} />
            {flag.why === "" ? null : <span className="text-muted"> — {flag.why}</span>}
          </p>
        ))}
      </section>
      <StoredPermissionList
        title="Stored acknowledgements"
        rows={view.acks}
        empty="No stored acknowledgements."
        busy={busy}
        onRevoke={onRevoke}
      />
      {children}
    </>
  );
}

/** Renders the `<dl>` output of a permission explain probe. */
export function ExplainResultBlock({ lines }: { readonly lines: ExplainResultView }) {
  return (
    <dl className="permissions-explain text-sm" aria-label="Explain result">
      <dt>Outcome</dt>
      <dd>{lines.outcome}</dd>
      <dt>Why</dt>
      <dd>{lines.reason}</dd>
      {lines.classes === "" ? null : (
        <>
          <dt>Classes</dt>
          <dd>{lines.classes}</dd>
        </>
      )}
      {lines.resolver === "" ? null : (
        <>
          <dt>Resolver</dt>
          <dd>{lines.resolver}</dd>
        </>
      )}
      {lines.grant === "" ? null : (
        <>
          <dt>Grant</dt>
          <dd>{lines.grant}</dd>
        </>
      )}
      {lines.ack === "" ? null : (
        <>
          <dt>Acknowledgement</dt>
          <dd>{lines.ack}</dd>
        </>
      )}
    </dl>
  );
}

export interface PermissionsExplainBlockProps {
  readonly probeId: string;
  readonly probeHelpId: string;
  readonly noticeId: string;
  readonly hasNotice: boolean;
  readonly canExplain: boolean;
  readonly probe: string;
  readonly lines: ExplainResultView | null;
  readonly onProbeChange: (value: string) => void;
  readonly onSubmit: () => void;
}

/** Pure probe section for testing what policy decision a command, path, or MCP tool receives. */
export function PermissionsExplainBlock({
  probeId,
  probeHelpId,
  noticeId,
  hasNotice,
  canExplain,
  probe,
  lines,
  onProbeChange,
  onSubmit,
}: PermissionsExplainBlockProps) {
  const describedBy =
    [canExplain ? null : probeHelpId, hasNotice ? noticeId : null].filter(Boolean).join(" ") || undefined;

  return (
    <section aria-label="Explain">
      <h3 className="text-xl leading-[26px]">What would happen?</h3>
      <form
        className="mt-2 flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <TextField
          id={probeId}
          label="Command, path or mcp:server/tool"
          className="min-w-0 flex-1"
          inputClassName="mono"
          aria-describedby={describedBy}
          placeholder="git push, ~/.ssh/config, mcp:gmail/send_email"
          value={probe}
          onChange={onProbeChange}
        />
        <Button type="submit" variant="secondary" disabled={!canExplain || probe.trim() === ""}>
          Explain
        </Button>
      </form>
      {canExplain ? null : (
        <p id={probeHelpId} className="text-sm text-subtle">
          Open a session to explain a call.
        </p>
      )}
      {lines == null ? null : <ExplainResultBlock lines={lines} />}
    </section>
  );
}
