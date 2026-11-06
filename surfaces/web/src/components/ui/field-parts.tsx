import { forwardRef } from "react";
import * as Aria from "react-aria-components";

import { cn } from "../../lib/cn.js";

// These are semantic providers/render-prop hooks. Their visible children use
// the styled controls; they do not install an overlay or positioning engine.
export {
  ColorPicker,
  CalendarMonthPicker,
  CalendarYearPicker,
  Autocomplete as AutocompleteRoot,
  ComboBoxValue,
} from "react-aria-components";

export const CalendarHeading = forwardRef<HTMLHeadingElement, Aria.CalendarHeadingProps>(
  function CalendarHeadingControl({ className, ...props }, ref) {
    return (
      <Aria.CalendarHeading
        {...props}
        ref={ref}
        className={cn("font-heading text-lg leading-[26px] font-normal text-ink", className)}
      />
    );
  },
);
export const SliderFill = forwardRef<HTMLDivElement, Aria.SliderFillProps>(function SliderFillControl(
  { className, ...props },
  ref,
) {
  return (
    <Aria.SliderFill
      {...props}
      ref={ref}
      className={Aria.composeRenderProps(className, (value) =>
        cn(
          "absolute top-1/2 h-1 -translate-y-1/2 bg-[var(--selection-marker)] data-[orientation=vertical]:left-1/2 data-[orientation=vertical]:top-auto data-[orientation=vertical]:w-1 data-[orientation=vertical]:-translate-x-1/2 data-[orientation=vertical]:translate-y-0",
          value,
        ),
      )}
    />
  );
});
export const FieldTextArea = forwardRef<HTMLTextAreaElement, Aria.TextAreaProps>(function FieldTextAreaControl(
  { className, ...props },
  ref,
) {
  return (
    <Aria.TextArea
      {...props}
      ref={ref}
      className={Aria.composeRenderProps(className, (value) =>
        cn(
          "min-h-24 w-full resize-y rounded-none border border-edge bg-field px-3 py-2 text-sm text-ink placeholder:text-subtle data-[invalid]:border-danger data-[disabled]:opacity-50 data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-[var(--focus)]",
          value,
        ),
      )}
    />
  );
});
