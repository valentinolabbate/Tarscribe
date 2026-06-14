import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

type ToastKind = "info" | "success" | "error";

export interface ToastOptions {
  /** How long the toast stays before auto-dismissing (ms). */
  durationMs?: number;
  /** Optional action button (e.g. "Rückgängig"). Clicking it dismisses the toast. */
  action?: { label: string; onClick: () => void };
}

interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  action?: { label: string; onClick: () => void };
}

const DEFAULT_DURATION = 4200;

type Push = (message: string, kind?: ToastKind, options?: ToastOptions) => void;

const ToastContext = createContext<Push>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

// Module-level emitter so non-React code (e.g. React Query caches) can toast.
let emitter: Push | null = null;
export function toast(message: string, kind: ToastKind = "info", options?: ToastOptions) {
  emitter?.(message, kind, options);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const push = useCallback<Push>((message, kind = "info", options) => {
    const id = nextId.current++;
    setToasts((t) => [...t, { id, kind, message, action: options?.action }]);
    setTimeout(() => dismiss(id), options?.durationMs ?? DEFAULT_DURATION);
  }, [dismiss]);

  emitter = push;

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toast-stack">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <span className="toast-dot" />
            <span className="toast-msg" onClick={() => dismiss(t.id)}>{t.message}</span>
            {t.action && (
              <button
                className="toast-action"
                onClick={() => {
                  t.action?.onClick();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
