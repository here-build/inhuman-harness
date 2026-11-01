import { forwardRef, type DialogHTMLAttributes } from "react";
import { mergeProps, useDialog, useObjectRef } from "react-aria";

// Preserve the caller's native showModal/close lifecycle and browser top layer.
// React Aria supplies dialog semantics and focus initialization on that same node.
export const NativeDialog = forwardRef<HTMLDialogElement, DialogHTMLAttributes<HTMLDialogElement>>(
  function NativeDialogControl(props, forwardedRef) {
    const ref = useObjectRef(forwardedRef);
    const { dialogProps } = useDialog(
      {
        "aria-label": props["aria-label"],
        "aria-labelledby": props["aria-labelledby"],
        "aria-describedby": props["aria-describedby"],
      },
      ref,
    );
    return <dialog {...mergeProps(dialogProps, props)} ref={ref} />;
  },
);
