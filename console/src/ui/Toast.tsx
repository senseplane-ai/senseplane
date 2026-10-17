// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { type ReactNode, createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

type Tone = "info" | "error";
interface ToastItem { id: number; text: ReactNode; tone: Tone }
type Show = (text: ReactNode, tone?: Tone) => void;

const ToastContext = createContext<Show>(() => undefined);

/** Short confirmations in a polite live region, bottom right; each lasts 5 s. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setItems((all) => all.filter((t) => t.id !== id)), []);
  const show = useCallback<Show>((text, tone = "info") => {
    const id = next.current++;
    setItems((all) => [...all.slice(-2), { id, text, tone }]);
    setTimeout(() => dismiss(id), 5000);
  }, [dismiss]);
  const value = useMemo(() => show, [show]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            <span>{t.text}</span>
            <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => dismiss(t.id)}>×</button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** `const toast = useToast(); toast("Clip saved")`. */
export function useToast(): Show {
  return useContext(ToastContext);
}
