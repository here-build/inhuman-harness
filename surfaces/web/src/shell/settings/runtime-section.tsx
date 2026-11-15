import { useEffect, useState } from "react";
import { parseCompactTrigger } from "@inhuman.tools/harness-model/shared";
import { PercentSlider, Setting, SettingsGroup, TriggerRange } from "@inhuman.tools/harness-ui";
import { DropdownSelect } from "@inhuman.tools/harness-ui/primitives/anchored";
import { Button } from "@inhuman.tools/harness-ui/primitives/button";
import { observer } from "mobx-react-lite";

import { asText, ask, Check, Field, kernelRequest, Notice } from "./shared.js";
import { useDial } from "../../client/context.js";

/** `90%`, `0.9` and `90` name the same share; anything the harness would ignore is null. */
function percentOf(text: string): number | null {
  const ratio = parseCompactTrigger(text);
  return ratio == null ? null : Math.round(ratio * 100);
}

type RuntimeDraft = {
  compact: string;
  hard: string;
  soft: string;
  keep: string;
  glow: string;
  classifier: string;
  throttle: string;
  speculative: string;
  tail: string;
  statusline: string;
  refresh: string;
  superKey: "ctrl" | "cmd";
  hideFloor: boolean;
  textOnly: boolean;
  retryForeground: string;
  retryBackground: string;
};

function runtimeDraft(root: unknown): RuntimeDraft {
  const record = root as
    | {
        compactStrategy?: string;
        compactTriggers?: { hard?: string; soft?: string };
        compactKeepTurns?: number;
        contextGlowRemaining?: string;
        autoModeClassifier?: string;
        approvalAskThrottleMs?: number;
        speculativePolicyProcessingTools?: number;
        shellTailBytes?: number;
        statusline?: string;
        statuslineRefresh?: string;
        superKey?: string;
        hideFloorTools?: boolean;
        reActLoopIntentDetectedTrigger?: { enabled?: boolean };
        retryMaxAttempts?: number;
        retryBackgroundMaxAttempts?: number;
      }
    | undefined;
  return {
    compact: asText(record?.compactStrategy),
    hard: asText(record?.compactTriggers?.hard),
    soft: asText(record?.compactTriggers?.soft),
    keep: String(record?.compactKeepTurns ?? 1),
    glow: asText(record?.contextGlowRemaining),
    classifier: asText(record?.autoModeClassifier),
    throttle: String(record?.approvalAskThrottleMs ?? 0),
    speculative: String(record?.speculativePolicyProcessingTools ?? 0),
    tail: String(record?.shellTailBytes ?? 0),
    statusline: asText(record?.statusline),
    refresh: asText(record?.statuslineRefresh),
    superKey: record?.superKey === "cmd" ? "cmd" : "ctrl",
    hideFloor: record?.hideFloorTools === true,
    textOnly: record?.reActLoopIntentDetectedTrigger?.enabled !== false,
    retryForeground: String(record?.retryMaxAttempts ?? 15),
    retryBackground: String(record?.retryBackgroundMaxAttempts ?? 0),
  };
}

/** Kernel runtime configuration view (compaction, approvals, output, loop limits). */
export const Runtime = observer(function RuntimeView() {
  const dial = useDial();
  const request = kernelRequest(dial);
  const root = dial.kernel?.root;
  const [notice, setNotice] = useState("");
  const [saved, setSaved] = useState(false);
  const [draft, setDraft] = useState(() => runtimeDraft(root));
  useEffect(() => setDraft(runtimeDraft(root)), [root]);
  const soft = percentOf(draft.soft);
  const hard = percentOf(draft.hard);
  const glow = percentOf(draft.glow);
  const off = [soft == null ? "Soft" : "", hard == null ? "Hard" : ""].filter((name) => name !== "");
  return (
    <>
      <Notice message={notice} />
      <div className="flex flex-col gap-4" onChangeCapture={() => setSaved(false)}>
        <SettingsGroup
          title="Compaction"
          intro="Long conversations are summarized so they keep fitting the model's context window."
        >
          <Setting
            label="Compact strategy"
            hint={
              <>
                <span className="block">The program that writes the summary when a conversation is compacted.</span>
                <span className="block mt-1">
                  The default ships with the harness and updates with it. To change how summaries are written, point
                  this at your own file rather than editing a copy.
                </span>
              </>
            }
          >
            <Field
              label="Compact strategy"
              value={draft.compact}
              onChange={(compact) => setDraft({ ...draft, compact })}
            />
          </Setting>
          <TriggerRange
            soft={soft ?? 80}
            hard={hard ?? 90}
            note={
              off.length === 0
                ? undefined
                : `${off.join(" and ")} trigger ${off.length === 1 ? "is" : "are"} off in config.json. Moving the handles turns ${off.length === 1 ? "it" : "them"} on.`
            }
            hint={
              <>
                <span className="block">Both handles are shares of the model's context window that are in use.</span>
                <span className="block mt-1">
                  <b>Soft</b> is where the context rail runs out and starts warning you. Nothing is forced there.
                </span>
                <span className="block mt-1">
                  <b>Hard</b> is where the harness compacts the conversation by itself. Hard never sits below soft.
                </span>
              </>
            }
            onChange={(nextSoft, nextHard) => {
              setSaved(false);
              setDraft({ ...draft, soft: `${nextSoft}%`, hard: `${nextHard}%` });
            }}
          />
          <Setting
            label="Turns to keep"
            hint="How many of the most recent turns stay word for word when older ones are summarized. At least 1."
          >
            <Field numeric label="Turns to keep" value={draft.keep} onChange={(keep) => setDraft({ ...draft, keep })} />
          </Setting>
          <PercentSlider
            label="Context glow"
            min={5}
            value={glow ?? 75}
            caption={`The rail starts to warm when ${glow ?? 75}% of the runway to the soft trigger is left.`}
            hint={
              <>
                <span className="block">
                  The composer rail blends toward its warning color once the runway left before the soft trigger drops
                  to this share.
                </span>
                <span className="block mt-1">
                  Higher values warn earlier. Lower values stay calm until compaction is close.
                </span>
              </>
            }
            onChange={(next) => {
              setSaved(false);
              setDraft({ ...draft, glow: `${next}%` });
            }}
          />
        </SettingsGroup>
        <SettingsGroup title="Approvals" intro="How tool calls that need a decision are judged and presented.">
          <Setting
            label="Auto classifier"
            hint={
              <>
                <span className="block">
                  The program that decides an ask in auto mode when no rule covers the call.
                </span>
                <span className="block mt-1">
                  Point it at your own file to change the judgment. The default updates with the harness.
                </span>
              </>
            }
          >
            <Field
              label="Auto classifier"
              value={draft.classifier}
              onChange={(classifier) => setDraft({ ...draft, classifier })}
            />
          </Setting>
          <Setting
            label="Approval pause (ms)"
            hint="When an approval prompt appears while you are typing, its confirm keys stay covered for this long so a stray keystroke cannot approve a call. 0 turns the pause off."
          >
            <Field
              numeric
              label="Approval pause (ms)"
              value={draft.throttle}
              onChange={(throttle) => setDraft({ ...draft, throttle })}
            />
          </Setting>
          <Setting
            label="Speculative tools"
            hint="How many pending tool calls the policy check may judge ahead of time, at once. Higher values make approvals feel faster and spend more on the classifier. 0 judges nothing early."
          >
            <Field
              numeric
              label="Speculative tools"
              value={draft.speculative}
              onChange={(speculative) => setDraft({ ...draft, speculative })}
            />
          </Setting>
        </SettingsGroup>
        <SettingsGroup title="Output and display" intro="What you see of shell output and around the composer.">
          <Setting
            label="Shell peek (bytes)"
            hint="How much of the end of a running or finished shell command is shown live and sent to the model. The rest is kept on disk. 0 shows no output; the highest allowed is 65536."
          >
            <Field
              numeric
              label="Shell peek (bytes)"
              value={draft.tail}
              onChange={(tail) => setDraft({ ...draft, tail })}
            />
          </Setting>
          <Setting
            label="Status line"
            hint="What the line under the composer shows: git for branch and changes, any shell command to show its output, or empty for just the working directory."
          >
            <Field
              label="Status line"
              value={draft.statusline}
              onChange={(statusline) => setDraft({ ...draft, statusline })}
            />
          </Setting>
          <Setting
            label="Status refresh"
            hint="When the status line is recomputed: round (after each model round), turn (after each turn), or a duration such as 30s."
          >
            <Field
              label="Status refresh"
              value={draft.refresh}
              onChange={(refresh) => setDraft({ ...draft, refresh })}
            />
          </Setting>
          <Setting
            label="Super key"
            hint="The modifier for persist and more actions. Ctrl is the default everywhere because terminals often do not pass Command through."
          >
            <DropdownSelect
              label="Super key"
              value={draft.superKey}
              onChange={(value) => setDraft({ ...draft, superKey: value === "cmd" ? "cmd" : "ctrl" })}
              options={[
                { id: "ctrl", label: "Ctrl" },
                { id: "cmd", label: "Command" },
              ]}
            />
          </Setting>
          <Setting
            inline
            label="Hide floor-allow calls on the compact tape"
            hint="Calls the safety floor always allows are left off the compact tape. They stay visible while open and in the full view."
          >
            <Check
              label="Hide floor-allow calls on the compact tape"
              checked={draft.hideFloor}
              onChange={(hideFloor) => {
                setSaved(false);
                setDraft({ ...draft, hideFloor });
              }}
            />
          </Setting>
        </SettingsGroup>
        <SettingsGroup title="Agent loop" intro="How a turn decides to keep going.">
          <Setting
            label="Foreground attempts"
            hint="Stop a model request after this many unsuccessful attempts while a client has the session open. Workers inherit their caller's foreground state. Default: 15. 0 means no limit."
          >
            <Field
              numeric
              label="Foreground attempts"
              value={draft.retryForeground}
              onChange={(retryForeground) => setDraft({ ...draft, retryForeground })}
            />
          </Setting>
          <Setting
            label="Background attempts"
            hint="How many unsuccessful attempts to allow when no client has the session open. Background work continues after you leave the page. Default: 0, no limit. Counts are separate from foreground attempts."
          >
            <Field
              numeric
              label="Background attempts"
              value={draft.retryBackground}
              onChange={(retryBackground) => setDraft({ ...draft, retryBackground })}
            />
          </Setting>
          <Setting
            inline
            label="Text-only continuation"
            hint="When a round ends with text and no tool call, a judge checks whether the model said it was about to keep working. If so, the turn continues instead of stopping."
          >
            <Check
              label="Text-only continuation"
              checked={draft.textOnly}
              onChange={(textOnly) => {
                setSaved(false);
                setDraft({ ...draft, textOnly });
              }}
            />
          </Setting>
        </SettingsGroup>
      </div>
      <Button
        variant="secondary"
        disabled={request == null}
        onClick={() => {
          setSaved(false);
          const keep = Number(draft.keep);
          const throttle = Number(draft.throttle);
          const speculative = Number(draft.speculative);
          const tail = Number(draft.tail);
          const retryForeground = Number(draft.retryForeground);
          const retryBackground = Number(draft.retryBackground);
          if (
            draft.retryForeground.trim() === "" ||
            draft.retryBackground.trim() === "" ||
            ![retryForeground, retryBackground].every((value) => Number.isSafeInteger(value) && value >= 0)
          ) {
            setNotice("Attempt limits need whole numbers of 0 or more. Use 0 for no limit.");
            return;
          }
          if (![keep, throttle, speculative, tail].every((value) => Number.isFinite(value))) {
            setNotice("Turns, pause, speculative tools, and shell peek need numbers.");
            return;
          }
          setNotice("");
          void ask(request, "config/set", {
            compact: draft.compact,
            compactTriggers: { hard: draft.hard, soft: draft.soft },
            compactKeepTurns: keep,
            contextGlowRemaining: draft.glow,
            autoModeClassifier: draft.classifier,
            approvalAskThrottleMs: throttle,
            speculativePolicyProcessingTools: speculative,
            shellTailBytes: tail,
            statusline: draft.statusline,
            statuslineRefresh: draft.refresh,
            superKey: draft.superKey,
            hideFloorTools: draft.hideFloor,
            textOnlyContinue: draft.textOnly,
            retryMaxAttempts: retryForeground,
            retryBackgroundMaxAttempts: retryBackground,
          }).then((error) => {
            setNotice(error);
            setSaved(error === "");
            return undefined;
          });
        }}
      >
        Save
      </Button>
      {saved ? (
        <p className="text-sm text-ink" role="status">
          Runtime settings saved.
        </p>
      ) : null}
    </>
  );
});
