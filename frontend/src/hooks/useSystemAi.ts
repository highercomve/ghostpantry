import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "../oriel";

export interface SystemAiStatus {
  state: string;
  message: string;
}

export function useSystemAi(enabled: boolean) {
  const [status, setStatus] = useState<SystemAiStatus | null>(null);
  const [busy, setBusy] = useState<"checking" | "downloading" | null>(null);
  const pending = useRef<Promise<SystemAiStatus> | null>(null);

  const check = useCallback((download = false): Promise<SystemAiStatus> => {
    if (pending.current) return pending.current;
    setBusy(download ? "downloading" : "checking");
    const request = (async () => {
      try {
        const next = await invoke(
          download ? "system_ai_download" : "system_ai_status",
        );
        setStatus(next);
        return next;
      } catch (error: unknown) {
        const next = {
          state: "error",
          message: error instanceof Error ? error.message : String(error),
        };
        setStatus(next);
        return next;
      }
    })();
    pending.current = request;
    void request.finally(() => {
      pending.current = null;
      setBusy(null);
    });
    return request;
  }, []);

  useEffect(() => {
    if (enabled && window.oriel) void check();
  }, [enabled, check]);

  // AICore can keep downloading after an app download request returns.
  // Refresh until Android reports a terminal state; never overlap requests.
  useEffect(() => {
    if (!enabled || busy || status?.state !== "downloading") return;
    const timer = window.setInterval(() => void check(), 10000);
    return () => window.clearInterval(timer);
  }, [enabled, busy, status?.state, check]);

  return { status, busy, check };
}
