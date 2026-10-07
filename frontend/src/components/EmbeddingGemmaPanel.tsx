import { useCallback, useEffect, useRef, useState } from "react";
import { Commands, invoke } from "../oriel";

type Status = Commands["embedding_status"]["result"];
type Action = "download" | "cancel" | "prepare" | "release" | "delete";

export function EmbeddingGemmaPanel({
  disabled = false,
  onBusyChange,
  selectedBackend,
  onBackendChange,
}: {
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
  selectedBackend?: "cpu" | "gpu";
  onBackendChange?: (backend: "cpu" | "gpu") => void;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [backendChoice, setBackendChoice] = useState<"cpu" | "gpu">("cpu");
  const backend = selectedBackend || backendChoice;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const downloading =
    status?.state === "downloading" || status?.state === "verifying";
  const downloaded =
    status?.state === "downloaded" || status?.state === "ready";
  const blocked = disabled || busy !== null;
  const check = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    try {
      setStatus(await invoke("embedding_status"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      pending.current = false;
    }
  }, []);

  useEffect(() => {
    if (window.oriel) void check();
  }, [check]);
  useEffect(() => {
    if (!downloading || busy) return;
    const timer = window.setInterval(() => void check(), 1500);
    return () => window.clearInterval(timer);
  }, [downloading, busy, check]);
  useEffect(() => {
    onBusyChange?.(busy !== null);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);

  const run = async (action: Action) => {
    if (pending.current || blocked) return;
    pending.current = true;
    setBusy(action);
    setError(null);
    try {
        const next =
          action === "prepare"
            ? await invoke("embedding_prepare", { backend })
            : action === "download"
              ? await invoke("embedding_download")
              : action === "cancel"
                ? await invoke("embedding_cancel")
                : action === "release"
                  ? await invoke("embedding_release")
                  : await invoke("embedding_delete");
        setStatus(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      try {
        setStatus(await invoke("embedding_status"));
      } catch {
        /* retain last status */
      }
    } finally {
      pending.current = false;
      setBusy(null);
    }
  };

  return (
    <section
      className="settings-section embedding-panel"
      aria-label="Fast local model setup"
    >
      <span className="eyebrow">
        FAST & OFFLINE
      </span>
      <h3>Fast local scan</h3>
      <p className="text-muted">
        YOLOE finds packages and loose produce; EmbeddingGemma 2 matches them
        to your food list. Download the matching model once to scan offline.
      </p>
      <div className="embedding-status" role="status" aria-live="polite">
        <strong>
          {busy === "prepare"
            ? `Testing ${backend.toUpperCase()}…`
              : status?.state === "ready"
                ? "Ready to match"
                : "Model status"}
        </strong>
        <p>{status?.message || "Open the Android app to check this device."}</p>
        {status?.device && (
          <small className="text-muted">{status.device}</small>
        )}
      </div>
      {downloading && (
        <div className="embedding-progress">
          <progress
            max={status?.total_bytes || 1}
            value={status?.bytes_downloaded || 0}
            aria-label="Model download progress"
          />
          <small>
            {((status?.bytes_downloaded || 0) / 1000000).toFixed(1)} / 388 MB ·
            Keep the app open
          </small>
        </div>
      )}
      {error && (
        <div className="alert alert-danger" role="alert">
          {error}
        </div>
      )}
      <div className="embedding-actions">
        {!downloaded && !downloading && (
          <button
            type="button"
            className="btn primary"
            disabled={blocked || !status?.supported}
            onClick={() => void run("download")}
          >
            {status?.bytes_downloaded
              ? "Resume model download"
              : "Download model · 388 MB"}
          </button>
        )}
        {downloading && (
          <button
            type="button"
            className="btn"
            disabled={blocked}
            onClick={() => void run("cancel")}
          >
            Pause download
          </button>
        )}
        <button
          type="button"
          className="btn"
          disabled={blocked}
          onClick={() => void check()}
        >
          Check model status
        </button>
      </div>
      {downloaded && (
        <>
          <div className="form-group">
            <span>Processor</span>
            <div
              className="seg embedding-backends"
              role="radiogroup"
              aria-label="Image matching processor"
            >
              {(["cpu", "gpu"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={backend === option}
                  className={`seg-btn ${backend === option ? "active" : ""}`}
                  disabled={blocked}
                  onClick={() => {
                    setBackendChoice(option);
                    onBackendChange?.(option);
                                  }}
                >
                  {option.toUpperCase()}
                </button>
              ))}
            </div>
            <small className="text-muted">
              Start with CPU on Pixel 8 or Pixel 10. GPU support is checked when
              you test it.
            </small>
          </div>
          <div className="embedding-actions">
            <button
              type="button"
              className="btn"
              disabled={blocked}
              onClick={() => void run("prepare")}
            >
              Test {backend.toUpperCase()} support
            </button>
            {status?.loaded && (
              <button
                type="button"
                className="btn"
                disabled={blocked}
                onClick={() => void run("release")}
              >
                Release model memory
              </button>
            )}
            <button
              type="button"
              className="btn"
              disabled={blocked}
              onClick={() => void run("delete")}
            >
              Delete downloaded model
            </button>
          </div>
        </>
      )}
    </section>
  );
}
