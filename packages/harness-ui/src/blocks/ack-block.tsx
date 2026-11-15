import { DropdownSelect } from "../primitives/index.js";
import { useVoice } from "../voice/index.js";

/** One acknowledgement flag shown before approval. */
export interface AckFlagItem {
  readonly label: string;
  readonly why?: string | undefined;
}

/** One persisted remember-choice item offered for an acknowledgement prompt. */
export interface AckRememberChoice {
  readonly key: string;
  readonly text: string;
}

export interface AckBlockProps {
  readonly flags: readonly AckFlagItem[];
  readonly choices: readonly AckRememberChoice[];
  readonly remember: string;
  readonly disabled: boolean;
  readonly onRemember: (key: string) => void;
  readonly rememberLabel?: string;
  readonly justOnceLabel?: string;
}

/**
 * The acknowledgement part of an approval card: flags that hold the call and a selector for remembering approval.
 */
export function AckBlock({
  flags,
  choices,
  remember,
  disabled,
  onRemember,
  rememberLabel = "Remember",
  justOnceLabel = "Just this once",
}: AckBlockProps) {
  const voice = useVoice();
  const picked = choices.find((choice) => choice.key === remember) ?? null;

  return (
    <div className="ack-block mb-3" aria-label={voice.composer.acknowledgementHeading}>
      <ul className="ack-flags">
        {flags.map((flag) => (
          <li key={`${flag.label}\0${flag.why ?? ""}`}>
            <span className="ack-flag-label">{flag.label}</span>
            {flag.why == null || flag.why === "" ? null : (
              <span className="ack-flag-why text-muted"> — {flag.why}</span>
            )}
          </li>
        ))}
      </ul>
      {choices.length === 0 ? null : (
        <div className="ack-remember mt-2 flex flex-wrap items-center gap-2">
          <DropdownSelect
            label={rememberLabel}
            className="ack-remember-select"
            isDisabled={disabled}
            value={picked?.key ?? "just-once"}
            onChange={(value) => onRemember(value === "just-once" ? "" : String(value ?? ""))}
            options={[
              { id: "just-once", label: justOnceLabel },
              ...choices.map((choice) => ({ id: choice.key, label: choice.text })),
            ]}
          />
        </div>
      )}
    </div>
  );
}
