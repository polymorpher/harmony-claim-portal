import { useEffect, useId, useRef, type ReactNode } from "react";

/** A modal on the native <dialog>; Escape cancels. */
export function Dialog({ open, title, onCancel, children }: { open: boolean; title: string; onCancel: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
    >
      {open && (
        <>
          <h2 id={titleId}>{title}</h2>
          {children}
        </>
      )}
    </dialog>
  );
}
