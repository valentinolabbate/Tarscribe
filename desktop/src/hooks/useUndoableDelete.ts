import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "../components/Toast";

const UNDO_WINDOW_MS = 5000;

/**
 * Deferred-delete with an undo toast. The actual `commit` (the real delete) only
 * runs after the undo window lapses; until then callers should hide the item via
 * `isPending(id)`. Clicking "Rückgängig" cancels the commit. Pending deletes are
 * honored on unmount so navigating away doesn't silently drop the intent.
 */
export function useUndoableDelete(windowMs = UNDO_WINDOW_MS) {
  const toast = useToast();
  const [pending, setPending] = useState<Set<number>>(() => new Set());
  const timers = useRef(
    new Map<number, { timer: ReturnType<typeof setTimeout>; commit: () => void }>(),
  );

  const finish = useCallback((id: number, run: boolean) => {
    const entry = timers.current.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    timers.current.delete(id);
    setPending((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    if (run) entry.commit();
  }, []);

  const schedule = useCallback(
    (id: number, commit: () => void, message: string) => {
      if (timers.current.has(id)) return;
      const timer = setTimeout(() => finish(id, true), windowMs);
      timers.current.set(id, { timer, commit });
      setPending((prev) => new Set(prev).add(id));
      toast(message, "info", {
        durationMs: windowMs,
        action: { label: "Rückgängig", onClick: () => finish(id, false) },
      });
    },
    [finish, toast, windowMs],
  );

  useEffect(
    () => () => {
      timers.current.forEach((entry) => {
        clearTimeout(entry.timer);
        entry.commit();
      });
      timers.current.clear();
    },
    [],
  );

  const isPending = useCallback((id: number) => pending.has(id), [pending]);
  return { isPending, schedule };
}
