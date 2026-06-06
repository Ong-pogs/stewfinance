"use client";
/**
 * InfoTooltip — a small accessible "?" info trigger + popover.
 *
 * Use it inline next to a term that needs a one-line explanation:
 *
 *   Your odds <InfoTooltip label="How your odds work">…copy…</InfoTooltip>
 *
 * Accessibility model (no logic / contract / odds changes — pure presentation):
 *   - Trigger is a real <button> (keyboard-focusable, in tab order). It is
 *     icon-only, so it carries an `aria-label` ("More info: <label>") and an
 *     `aria-describedby` pointing at the popover whenever the popover is open.
 *   - The popover has `role="tooltip"` and a stable id (via React.useId), so
 *     `aria-describedby` resolves and screen readers announce the description.
 *   - Opens on hover AND on keyboard focus (focus-visible included). On touch,
 *     a tap toggles it (no hover on touch, so the click handler covers it).
 *   - Dismisses on Escape and on blur (focus leaving the trigger). Hover-out
 *     also closes it when it wasn't opened by focus/tap.
 *   - Does NOT trap focus — the popover is non-interactive text; focus stays on
 *     the trigger, and Tab moves on naturally.
 *   - Reduced-motion safe: the fade/translate is gated behind `motion-safe:`,
 *     so `prefers-reduced-motion: reduce` shows it instantly with no transform.
 *   - On-theme: `bg-card border-border text-foreground`, --radius, soft shadow.
 *   - focus-visible ring uses the `--ring` token.
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";

export function InfoTooltip({
  children,
  label,
  className = "",
}: {
  /** The explanatory copy shown inside the popover. */
  children: ReactNode;
  /**
   * A short accessible name for the term being explained, e.g. "Your odds".
   * Used to build the trigger's aria-label ("More info: Your odds").
   */
  label: string;
  /** Optional extra classes on the wrapper span. */
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  // Track the two "open" inputs independently: pointer hover and keyboard focus
  // (or a sticky tap). The popover is visible when EITHER is active, so a
  // hover-out never closes a focus-held popover and vice versa. A tap latches
  // `focused` so the popover stays open until Escape, blur, or a second tap.
  const hovering = useRef(false);
  const focused = useRef(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const tipId = useId();

  const sync = useCallback(() => {
    setOpen(hovering.current || focused.current);
  }, []);

  const close = useCallback(() => {
    hovering.current = false;
    focused.current = false;
    setOpen(false);
  }, []);

  // Escape closes the popover (only bound while open).
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  return (
    <span
      ref={rootRef}
      className={`relative inline-flex align-middle ${className}`}
      // Blur dismiss: when focus leaves the trigger, clear the focus latch.
      // The popover stays up only if the pointer is still hovering it.
      onBlur={(e) => {
        if (!rootRef.current?.contains(e.relatedTarget as Node | null)) {
          focused.current = false;
          sync();
        }
      }}
    >
      <button
        type="button"
        aria-label={`More info: ${label}`}
        aria-expanded={open}
        aria-describedby={open ? tipId : undefined}
        // Touch / click latches the popover open (toggles the sticky flag).
        // On touch there's no hover, so this is the only way to open it.
        onClick={() => {
          focused.current = !focused.current;
          sync();
        }}
        // Hover opens; hover-out closes (unless focus is holding it open).
        onMouseEnter={() => {
          hovering.current = true;
          sync();
        }}
        onMouseLeave={() => {
          hovering.current = false;
          sync();
        }}
        // Keyboard focus opens; blur (handled on the wrapper) closes.
        onFocus={() => {
          focused.current = true;
          sync();
        }}
        className="grid h-4 w-4 place-items-center rounded-full border border-border bg-secondary text-[10px] font-bold leading-none text-muted-foreground transition-colors hover:border-primary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
      >
        <span aria-hidden="true">?</span>
      </button>

      {open && (
        <span
          id={tipId}
          role="tooltip"
          className="absolute bottom-full left-1/2 z-50 mb-1.5 w-56 -translate-x-1/2 rounded-[--radius] border border-border bg-card p-2.5 text-left text-xs font-normal normal-case leading-snug text-foreground shadow-lg motion-safe:animate-[tooltip-in_0.12s_ease-out]"
        >
          {children}
        </span>
      )}
    </span>
  );
}
