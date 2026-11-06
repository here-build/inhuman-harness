import { forwardRef } from "react";
import * as Aria from "react-aria-components";

import { buttonVariants } from "./button.js";
import { fieldControlClassName } from "./input.js";
import { cn } from "../../lib/cn.js";

const field = "flex flex-col gap-1 text-sm text-ink data-[disabled]:opacity-50";
const focus =
  "data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-[var(--focus)]";
const thumb = cn(
  "h-5 w-5 rounded-none border-2 border-ink bg-field data-[disabled]:cursor-not-allowed group-data-[orientation=horizontal]/slider-track:top-1/2 group-data-[orientation=vertical]/slider-track:left-1/2",
  focus,
);

// Preserve RAC's render props, slots, validation wiring, and controlled/uncontrolled APIs.
// Field labels are content, not commands: only buttons use the petite-cap label class.
export const Form = forwardRef<HTMLFormElement, Aria.FormProps>(function FormControl({ className, ...props }, ref) {
  return <Aria.Form {...props} ref={ref} className={cn("flex flex-col gap-5 text-sm text-ink", className)} />;
});

export const Label = forwardRef<HTMLLabelElement, Aria.LabelProps>(function LabelControl({ className, ...props }, ref) {
  return <Aria.Label {...props} ref={ref} className={cn("text-sm text-ink", className)} />;
});

export const Description = forwardRef<HTMLElement, Aria.TextProps>(function DescriptionControl(
  { className, ...props },
  ref,
) {
  return <Aria.Text slot="description" {...props} ref={ref} className={cn("text-xs text-muted", className)} />;
});

export const FieldError = forwardRef<HTMLDivElement, Aria.FieldErrorProps>(function FieldErrorControl(
  { className, ...props },
  ref,
) {
  return (
    <Aria.FieldError
      {...props}
      ref={ref}
      className={Aria.composeRenderProps(className, (value) => cn("text-xs text-danger", value))}
    />
  );
});

export const Group = forwardRef<HTMLDivElement, Aria.GroupProps>(function GroupControl({ className, ...props }, ref) {
  return (
    <Aria.Group
      {...props}
      ref={ref}
      className={Aria.composeRenderProps(className, (value) =>
        cn(
          "flex items-center gap-2 rounded-none data-[disabled]:opacity-50 data-[invalid]:border-danger",
          focus,
          value,
        ),
      )}
    />
  );
});

export const FieldInput = forwardRef<HTMLInputElement, Aria.InputProps>(function FieldInputControl(
  { className, ...props },
  ref,
) {
  return (
    <Aria.Input
      {...props}
      ref={ref}
      className={Aria.composeRenderProps(className, (value) => cn(fieldControlClassName, "h-9 min-w-0", value))}
    />
  );
});

// Use slot="increment" / "decrement" in NumberField. In SearchField the button clears it.
export const FieldButton = forwardRef<HTMLButtonElement, Aria.ButtonProps>(function FieldButtonControl(
  { className, ...props },
  ref,
) {
  return (
    <Aria.Button
      {...props}
      ref={ref}
      className={Aria.composeRenderProps(className, (value) =>
        cn(
          buttonVariants({ variant: "secondary" }),
          "shrink-0 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 motion-reduce:transition-none",
          value,
        ),
      )}
    />
  );
});

export const SearchField = forwardRef<HTMLDivElement, Aria.SearchFieldProps>(function SearchFieldControl(
  { className, ...props },
  ref,
) {
  return (
    <Aria.SearchField
      {...props}
      ref={ref}
      className={Aria.composeRenderProps(className, (value) => cn(field, value))}
    />
  );
});

export const NumberField = forwardRef<HTMLDivElement, Aria.NumberFieldProps>(function NumberFieldControl(
  { className, ...props },
  ref,
) {
  return (
    <Aria.NumberField
      {...props}
      ref={ref}
      className={Aria.composeRenderProps(className, (value) => cn(field, "tabular-nums", value))}
    />
  );
});

export const Slider = forwardRef<HTMLDivElement, Aria.SliderProps>(function SliderControl(
  { className, ...props },
  ref,
) {
  return (
    <Aria.Slider
      {...props}
      ref={ref}
      className={Aria.composeRenderProps(className, (value) =>
        cn(field, "data-[orientation=vertical]:items-center", value),
      )}
    />
  );
});

export const SliderTrack = forwardRef<HTMLDivElement, Aria.SliderTrackProps>(function SliderTrackControl(
  { className, ...props },
  ref,
) {
  return (
    <Aria.SliderTrack
      {...props}
      ref={ref}
      className={Aria.composeRenderProps(className, (value) =>
        cn(
          "group/slider-track relative h-6 w-full before:absolute before:inset-x-0 before:top-1/2 before:h-1 before:-translate-y-1/2 before:bg-edge data-[orientation=vertical]:h-40 data-[orientation=vertical]:w-6 data-[orientation=vertical]:before:inset-y-0 data-[orientation=vertical]:before:left-1/2 data-[orientation=vertical]:before:top-0 data-[orientation=vertical]:before:h-full data-[orientation=vertical]:before:w-1 data-[orientation=vertical]:before:-translate-x-1/2 data-[orientation=vertical]:before:translate-y-0",
          value,
        ),
      )}
    />
  );
});

export const SliderThumb = forwardRef<HTMLDivElement, Aria.SliderThumbProps>(function SliderThumbControl(
  { className, ...props },
  ref,
) {
  return (
    <Aria.SliderThumb
      {...props}
      ref={ref}
      className={Aria.composeRenderProps(className, (value) => cn(thumb, value))}
    />
  );
});

export const SliderOutput = forwardRef<HTMLOutputElement, Aria.SliderOutputProps>(function SliderOutputControl(
  { className, ...props },
  ref,
) {
  return (
    <Aria.SliderOutput
      {...props}
      ref={ref}
      className={Aria.composeRenderProps(className, (value) => cn("text-sm tabular-nums text-muted", value))}
    />
  );
});

export const Meter = forwardRef<HTMLDivElement, Aria.MeterProps>(function MeterControl(
  { className, children, ...props },
  ref,
) {
  return (
    <Aria.Meter {...props} ref={ref} className={Aria.composeRenderProps(className, (value) => cn(field, value))}>
      {Aria.composeRenderProps(children, (content, { percentage }) => (
        <>
          {content}
          <div aria-hidden="true" className="h-2 overflow-hidden rounded-none bg-edge">
            <div className="h-full bg-ink" style={{ width: `${percentage}%` }} />
          </div>
        </>
      ))}
    </Aria.Meter>
  );
});

export const ProgressBar = forwardRef<HTMLDivElement, Aria.ProgressBarProps>(function ProgressBarControl(
  { className, children, ...props },
  ref,
) {
  return (
    <Aria.ProgressBar {...props} ref={ref} className={Aria.composeRenderProps(className, (value) => cn(field, value))}>
      {Aria.composeRenderProps(children, (content, { percentage, isIndeterminate }) => (
        <>
          {content}
          <div aria-hidden="true" className="h-2 overflow-hidden rounded-none bg-edge">
            <div
              className={cn("h-full bg-ink", isIndeterminate && "mx-auto w-1/3")}
              style={isIndeterminate ? undefined : { width: `${percentage}%` }}
            />
          </div>
        </>
      ))}
    </Aria.ProgressBar>
  );
});

export const CheckboxGroup = forwardRef<HTMLDivElement, Aria.CheckboxGroupProps>(function CheckboxGroupControl(
  { className, ...props },
  ref,
) {
  return (
    <Aria.CheckboxGroup
      {...props}
      ref={ref}
      className={Aria.composeRenderProps(className, (value) => cn(field, "gap-2", value))}
    />
  );
});

export const ToggleButton = forwardRef<HTMLButtonElement, Aria.ToggleButtonProps>(function ToggleButtonControl(
  { className, ...props },
  ref,
) {
  return (
    <Aria.ToggleButton
      {...props}
      ref={ref}
      className={Aria.composeRenderProps(className, (value) =>
        cn(
          buttonVariants({ variant: "secondary" }),
          "data-[selected]:bg-hover data-[selected]:shadow-[inset_0_-2px_0_var(--ink)] data-[disabled]:pointer-events-none data-[disabled]:opacity-50 motion-reduce:transition-none",
          value,
        ),
      )}
    />
  );
});

export const ToggleButtonGroup = forwardRef<HTMLDivElement, Aria.ToggleButtonGroupProps>(
  function ToggleButtonGroupControl({ className, ...props }, ref) {
    return (
      <Aria.ToggleButtonGroup
        {...props}
        ref={ref}
        className={Aria.composeRenderProps(className, (value) =>
          cn("flex flex-wrap gap-1 data-[orientation=vertical]:flex-col data-[disabled]:opacity-50", value),
        )}
      />
    );
  },
);

// Color surfaces intentionally display the edited color. All surrounding chrome stays neutral.
// RAC supplies the gradient, thumb positioning, native range inputs, and channel names.
export const ColorArea = forwardRef<HTMLDivElement, Aria.ColorAreaProps>(function ColorAreaControl(
  { className, ...props },
  ref,
) {
  return (
    <Aria.ColorArea
      {...props}
      ref={ref}
      className={Aria.composeRenderProps(className, (value) =>
        cn("relative h-40 w-56 rounded-none data-[disabled]:opacity-50", value),
      )}
    />
  );
});

export const ColorField = forwardRef<HTMLDivElement, Aria.ColorFieldProps>(function ColorFieldControl(
  { className, ...props },
  ref,
) {
  return (
    <Aria.ColorField {...props} ref={ref} className={Aria.composeRenderProps(className, (value) => cn(field, value))} />
  );
});

export const ColorSlider = forwardRef<HTMLDivElement, Aria.ColorSliderProps>(function ColorSliderControl(
  { className, ...props },
  ref,
) {
  return (
    <Aria.ColorSlider
      {...props}
      ref={ref}
      className={Aria.composeRenderProps(className, (value) =>
        cn(field, "data-[orientation=vertical]:items-center", value),
      )}
    />
  );
});

export const ColorSliderTrack = forwardRef<HTMLDivElement, Aria.SliderTrackProps>(function ColorSliderTrackControl(
  { className, ...props },
  ref,
) {
  return (
    <Aria.SliderTrack
      {...props}
      ref={ref}
      className={Aria.composeRenderProps(className, (value) =>
        cn(
          "group/slider-track relative h-6 w-full rounded-none data-[orientation=vertical]:h-40 data-[orientation=vertical]:w-6",
          value,
        ),
      )}
    />
  );
});

export const ColorThumb = forwardRef<HTMLDivElement, Aria.ColorThumbProps>(function ColorThumbControl(
  { className, ...props },
  ref,
) {
  return (
    <Aria.ColorThumb
      {...props}
      ref={ref}
      className={Aria.composeRenderProps(className, (value) => cn(thumb, "shadow-[0_0_0_1px_var(--canvas)]", value))}
    />
  );
});

export const ColorSwatch = forwardRef<HTMLDivElement, Aria.ColorSwatchProps>(function ColorSwatchControl(
  { className, ...props },
  ref,
) {
  return (
    <Aria.ColorSwatch
      {...props}
      ref={ref}
      className={Aria.composeRenderProps(className, (value) =>
        cn("h-8 w-8 shrink-0 rounded-none border border-edge", value),
      )}
    />
  );
});

export const ColorSwatchPicker = forwardRef<HTMLDivElement, Aria.ColorSwatchPickerProps>(
  function ColorSwatchPickerControl({ className, ...props }, ref) {
    return (
      <Aria.ColorSwatchPicker
        {...props}
        ref={ref}
        className={Aria.composeRenderProps(className, (value) => cn("flex flex-wrap gap-2", value))}
      />
    );
  },
);

export const ColorSwatchPickerItem = forwardRef<HTMLDivElement, Aria.ColorSwatchPickerItemProps>(
  function ColorSwatchPickerItemControl({ className, children, ...props }, ref) {
    return (
      <Aria.ColorSwatchPickerItem
        {...props}
        ref={ref}
        className={Aria.composeRenderProps(className, (value) =>
          cn(
            "relative cursor-pointer rounded-none border-2 border-transparent p-1 data-[selected]:border-ink data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
            focus,
            value,
          ),
        )}
      >
        {children ?? <ColorSwatch />}
      </Aria.ColorSwatchPickerItem>
    );
  },
);

export const ColorWheel = forwardRef<HTMLDivElement, Aria.ColorWheelProps>(function ColorWheelControl(
  { className, ...props },
  ref,
) {
  return (
    <Aria.ColorWheel
      {...props}
      ref={ref}
      className={Aria.composeRenderProps(className, (value) =>
        cn("relative h-48 w-48 data-[disabled]:opacity-50", value),
      )}
    />
  );
});

// The wheel is circular because hue wraps; ordinary controls remain rectangular.
export const ColorWheelTrack = forwardRef<HTMLDivElement, Aria.ColorWheelTrackProps>(function ColorWheelTrackControl(
  { className, ...props },
  ref,
) {
  return (
    <Aria.ColorWheelTrack
      {...props}
      ref={ref}
      className={Aria.composeRenderProps(className, (value) => cn("absolute inset-0 rounded-full", value))}
    />
  );
});
