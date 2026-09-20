'use client';

// Inline toast notification system — no external dependencies.
//
// A single fixed region announces messages politely; error toasts use their
// own assertive wrapper so screen readers interrupt on failures. Toasts expire
// automatically and can be dismissed by keyboard like anything else.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export type ToastKind = 'success' | 'error' | 'info';

interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastApi {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const LIFESPAN_MS: Record<ToastKind, number> = {
  success: 5000,
  error: 9000,
  info: 6500,
};

const KIND_STYLES: Record<ToastKind, string> = {
  success: 'border-status-success bg-surface-raised text-ink',
  error: 'border-status-failure bg-surface-raised text-ink',
  info: 'border-border-strong bg-surface-raised text-ink',
};

const KIND_ICON: Record<ToastKind, string> = {
  success: '✓',
  error: '✕',
  info: 'i',
};

const ICON_STYLES: Record<ToastKind, string> = {
  success: 'bg-status-success text-canvas',
  error: 'bg-status-failure text-canvas',
  info: 'bg-accent text-canvas',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string) => {
      const id = nextId.current;
      nextId.current += 1;
      setToasts((current) => [...current.slice(-4), { id, kind, message }]);
      timers.current.set(
        id,
        setTimeout(() => {
          dismiss(id);
        }, LIFESPAN_MS[kind]),
      );
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) {
        clearTimeout(timer);
      }
      pending.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      success: (message: string) => push('success', message),
      error: (message: string) => push('error', message),
      info: (message: string) => push('info', message),
      dismiss,
    }),
    [push, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-label="Notifications"
        className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex flex-col items-end gap-2 sm:inset-x-auto sm:right-6 sm:bottom-6"
      >
        <div aria-live="polite" aria-atomic="false" className="contents">
          {toasts
            .filter((toast) => toast.kind !== 'error')
            .map((toast) => (
              <ToastCard key={toast.id} toast={toast} onDismiss={dismiss} />
            ))}
        </div>
        <div aria-live="assertive" aria-atomic="false" className="contents">
          {toasts
            .filter((toast) => toast.kind === 'error')
            .map((toast) => (
              <ToastCard key={toast.id} toast={toast} onDismiss={dismiss} />
            ))}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  return (
    <div
      className={`pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-lg border px-4 py-3 shadow-lg ${KIND_STYLES[toast.kind]}`}
      role={toast.kind === 'error' ? 'alert' : 'status'}
    >
      <span
        aria-hidden="true"
        className={`mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${ICON_STYLES[toast.kind]}`}
      >
        {KIND_ICON[toast.kind]}
      </span>
      <p className="min-w-0 flex-1 text-sm leading-relaxed break-words">{toast.message}</p>
      <button
        type="button"
        onClick={() => {
          onDismiss(toast.id);
        }}
        aria-label="Dismiss notification"
        className="shrink-0 rounded p-1 text-ink-faint hover:text-ink focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
      >
        <span aria-hidden="true" className="text-sm leading-none">
          ✕
        </span>
      </button>
    </div>
  );
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (context === null) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}
