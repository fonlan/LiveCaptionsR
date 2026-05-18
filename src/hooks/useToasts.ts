import { useCallback, useState } from "react";
import type { Toast } from "../types";
import { generateId } from "../utils/textUtils";

const TOAST_AUTO_DISMISS_MS = 3000;

export type ToastKind = Toast["type"];

export type AddToast = (type: ToastKind, message: string) => void;

export type UseToastsResult = {
  toasts: Toast[];
  addToast: AddToast;
};

/**
 * Toast notification state machine.
 *
 * Owns the queue of currently visible toasts and exposes a single
 * `addToast(type, message)` action. Each toast auto-dismisses after
 * {@link TOAST_AUTO_DISMISS_MS} ms.
 */
export function useToasts(): UseToastsResult {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback<AddToast>((type, message) => {
    const id = generateId();
    setToasts(prev => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(toast => toast.id !== id));
    }, TOAST_AUTO_DISMISS_MS);
  }, []);

  return { toasts, addToast };
}
