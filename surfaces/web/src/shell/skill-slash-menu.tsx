import { useEffect } from "react";

import { skillInvoke } from "./skill-slash.js";
import type { useSkillSlash } from "./use-skill-slash.js";
import { NativePopover } from "../components/ui/anchored.js";
import { Text } from "../components/ui/navigation.js";

export function SkillSlashMenu({ menu }: { readonly menu: ReturnType<typeof useSkillSlash>["menu"] }) {
  useEffect(() => {
    if (menu?.activeId != null)
      document.querySelector(`#${CSS.escape(menu.activeId)}`)?.scrollIntoView?.({ block: "nearest" });
  }, [menu?.activeId]);

  if (menu == null) return null;
  return (
    <NativePopover
      isOpen
      triggerRef={menu.fieldRef}
      restoreFocus={false}
      onOpenChange={(open) => {
        if (!open) menu.dismiss();
      }}
      className="skill-slash-popover"
    >
      <div id={menu.id} role="listbox" aria-label="Skills" className="font-sans text-sm text-ink normal-case">
        {menu.rows.map((row, index) => {
          const id = `${menu.id}-${index}`;
          return (
            <div
              key={skillInvoke(row)}
              id={id}
              role="option"
              aria-selected={index === menu.index}
              aria-labelledby={`${id}-label`}
              aria-describedby={row.description ? `${id}-description` : undefined}
              className={`block w-full cursor-default border-l-2 px-3 py-2 text-left hover:bg-hover ${
                index === menu.index ? "border-[var(--selection-marker)] bg-selected" : "border-transparent"
              }`}
              onPointerDown={(event) => event.preventDefault()}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => menu.choose(row)}
            >
              <Text id={`${id}-label`} elementType="code" className="block truncate font-mono normal-case">
                /{skillInvoke(row)}
              </Text>
              {!row.description ? null : (
                <Text id={`${id}-description`} className="line-clamp-2 break-words font-sans text-muted normal-case">
                  {row.description}
                </Text>
              )}
            </div>
          );
        })}
      </div>
    </NativePopover>
  );
}
