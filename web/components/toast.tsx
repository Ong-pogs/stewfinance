"use client";
/**
 * Lightweight, in-house toast system — no external deps.
 *
 * A React context exposes `useToast()` with `toast.success/error/info`.
 * Toasts auto-dismiss (~4s), stack bottom-right, are dismissible, and respect
 * `prefers-reduced-motion` (enter/exit animation is skipped via CSS guards).
 * Themed to the Linen Pearl Dark tokens:
 *   - success → accent-warm / primary
 *   - error   → destructive
 *   - info    → muted/border
 *
 * Success toasts may carry an optional `txSig` which renders a "View on
 * explorer" link to the devnet Solana explorer. No on-chain logic lives here —
 * callers pass the signature that their existing action already returned.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type ToastKind = "success" | "error" | "info";

type ToastOptions = {
  /** Optional secondary line under the title. */
  description?: string;
  /** Optional tx signature → renders a devnet explorer link. */
  txSig?: string;
  /** Override the auto-dismiss duration in ms (default 4000). */
  durationMs?: number;
};

type Toast = ToastOptions & {
  id: number;
  kind: ToastKind;
  message: string;
};

type ToastApi = {
  success: (message: string, opts?: ToastOptions) => void;
  error: (message: string, opts?: ToastOptions) => void;
  info: (message: string, opts?: ToastOptions) => void;
  dismiss: (id: number) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

const DEFAULT_DURATION = 4000;

/** Devnet explorer URL for a transaction signature. */
export function explorerTxUrl(sig: string): string {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within a <ToastProvider>");
  }
  return ctx;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const handle = timers.current.get(id);
    if (handle) {
      clearTimeout(handle);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string, opts?: ToastOptions) => {
      const id = ++idRef.current;
      const duration = opts?.durationMs ?? DEFAULT_DURATION;
      setToasts((prev) => [...prev, { id, kind, message, ...opts }]);
      const handle = setTimeout(() => dismiss(id), duration);
      timers.current.set(id, handle);
    },
    [dismiss],
  );

  // Clear any outstanding timers on unmount.
  useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach((h) => clearTimeout(h));
      map.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      success: (m, o) => push("success", m, o),
      error: (m, o) => push("error", m, o),
      info: (m, o) => push("info", m, o),
      dismiss,
    }),
    [push, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

// ── Presentation ────────────────────────────────────────────────────────────

const KIND_STYLE: Record<ToastKind, { border: string; accent: string; icon: string }> = {
  success: {
    border: "border-primary/60",
    accent: "text-accent-warm",
    icon: "✓",
  },
  error: {
    border: "border-destructive/60",
    accent: "text-destructive",
    icon: "✕",
  },
  info: {
    border: "border-border",
    accent: "text-muted-foreground",
    icon: "ℹ",
  },
};

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 px-4 pb-4 sm:inset-x-auto sm:right-4 sm:items-end"
    >
      {toasts.map((t) => (
        <ToastRow key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastRow({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: (id: number) => void;
}) {
  const style = KIND_STYLE[toast.kind];
  return (
    <div
      role="status"
      className={`pointer-events-auto w-full max-w-sm rounded-xl border ${style.border} bg-card/95 p-4 shadow-lg backdrop-blur-sm toast-enter`}
    >
      <div className="flex items-start gap-3">
        <span className={`mt-0.5 text-sm font-bold leading-none ${style.accent}`} aria-hidden="true">
          {style.icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-foreground">{toast.message}</div>
          {toast.description && (
            <div className="mt-0.5 text-xs leading-snug text-muted-foreground break-words">
              {toast.description}
            </div>
          )}
          {toast.txSig && (
            <a
              href={explorerTxUrl(toast.txSig)}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1.5 inline-block rounded text-xs font-medium text-primary underline underline-offset-2 hover:text-accent-warm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
            >
              View on explorer ↗
            </a>
          )}
        </div>
        <button
          type="button"
          onClick={() => onDismiss(toast.id)}
          aria-label="Dismiss notification"
          className="-mr-1 -mt-1 shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        >
          <span aria-hidden="true" className="text-sm leading-none">×</span>
        </button>
      </div>
    </div>
  );
}
