import { choiceByKey, type AckFlagFace, type StoreChoice } from "./ack-prompt.js";
import { DropdownSelect } from "../components/ui/anchored.js";

/**
 * The acknowledgement part of a prompt: the flags that hold the call, and what to remember. Flag text is
 * config-written, but rendered as text, never markup.
 */
export function AckBlock({
  flags,
  choices,
  remember,
  disabled,
  onRemember,
}: {
  readonly flags: readonly AckFlagFace[];
  readonly choices: readonly StoreChoice[];
  readonly remember: string;
  readonly disabled: boolean;
  readonly onRemember: (key: string) => void;
}) {
  const picked = choiceByKey(choices, remember);
  return (
    <div className="ack-block mb-3" aria-label="Acknowledgement">
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
            label="Remember"
            className="ack-remember-select"
            isDisabled={disabled}
            value={picked?.key ?? "just-once"}
            onChange={(value) => onRemember(value === "just-once" ? "" : String(value ?? ""))}
            options={[
              { id: "just-once", label: "Just this once" },
              ...choices.map((choice) => ({ id: choice.key, label: choice.text })),
            ]}
          />
        </div>
      )}
    </div>
  );
}
