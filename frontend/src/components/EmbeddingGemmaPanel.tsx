import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Commands, invoke } from "../oriel";

type Status = Commands["embedding_status"]["result"];
type Result = Commands["embedding_match"]["result"];
type Action = "download" | "cancel" | "prepare" | "release" | "delete";
const INITIAL_LABELS =
  "apple\nbanana\ntomato\npotato\nbroccoli\ncarrot\nbread\npasta\nrice\noats\ncereal\nmilk\ncheese\nyogurt\neggs\ncanned beans\ncoffee\nchocolate";
const seconds = (ms: number) => `${(ms / 1000).toFixed(2)} s`;

export function EmbeddingGemmaPanel({
  image,
  disabled = false,
  onBusyChange,
}: {
  image?: string | null;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [backend, setBackend] = useState<"cpu" | "gpu">("cpu");
  const [labels, setLabels] = useState(INITIAL_LABELS);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const pending = useRef(false);
  const labelId = useId();
  const downloading =
    status?.state === "downloading" || status?.state === "verifying";
  const downloaded =
    status?.state === "downloaded" || status?.state === "ready";
  const blocked = disabled || busy !== null;
  const candidates = [
    ...new Set(
      labels
        .split(/\n|,/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  const validLabels =
    candidates.length >= 2 &&
    candidates.length <= 48 &&
    candidates.every((s) => s.length <= 120);

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

  const run = async (action: Action | "match") => {
    if (pending.current || blocked) return;
    pending.current = true;
    setBusy(action);
    setError(null);
    setResult(null);
    try {
      if (action === "match") {
        if (!image || !validLabels) return;
        setResult(
          await invoke("embedding_match", {
            image,
            backend,
            labels: candidates,
          }),
        );
        setStatus(await invoke("embedding_status"));
      } else {
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
      }
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
      aria-label="EmbeddingGemma experiment"
    >
      <span className="eyebrow">ON-DEVICE EXPERIMENT</span>
      <h3>EmbeddingGemma 2</h3>
      <p className="text-muted">
        Compare a photo with food labels, entirely on your phone. Try one item
        or package at a time. This ranks labels; it does not count items or add
        them to your pantry.
      </p>
      <div className="embedding-status" role="status" aria-live="polite">
        <strong>
          {busy === "prepare"
            ? `Testing ${backend.toUpperCase()}…`
            : busy === "match"
              ? "Matching photo…"
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
                    setBackend(option);
                    setResult(null);
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
              Delete experiment model
            </button>
          </div>
          {image ? (
            <>
              <div className="form-group">
                <label htmlFor={labelId}>Food labels to compare</label>
                <textarea
                  id={labelId}
                  rows={6}
                  value={labels}
                  disabled={blocked}
                  onChange={(e) => {
                    setLabels(e.target.value);
                    setResult(null);
                  }}
                />
                <small className="text-muted">
                  2–48 labels, one per line or separated by commas. Up to 120
                  characters each.
                </small>
              </div>
              <button
                type="button"
                className="btn primary w-full"
                disabled={blocked || !validLabels}
                onClick={() => void run("match")}
              >
                {busy === "match"
                  ? "Matching photo…"
                  : `Match photo on ${backend.toUpperCase()}`}
              </button>
            </>
          ) : (
            <p className="text-muted">
              Select a photo in Scan a shelf, then open “Try image matching”.
            </p>
          )}
        </>
      )}
      {result && (
        <div className="embedding-results" role="status">
          <h4>Closest food labels</h4>
          <ol>
            {result.matches.map((match) => (
              <li key={match.label}>
                <span>{match.label}</span>
                <strong>{match.score.toFixed(3)}</strong>
              </li>
            ))}
          </ol>
          <small className="text-muted">
            Cosine similarity, not a probability. Only the labels above were
            compared.
          </small>
          <dl className="embedding-timings">
            <div>
              <dt>Total · {result.backend.toUpperCase()}</dt>
              <dd>{seconds(result.total_ms)}</dd>
            </div>
            <div>
              <dt>Model load</dt>
              <dd>{seconds(result.load_ms)}</dd>
            </div>
            <div>
              <dt>Food labels{result.labels_cached ? " · cached" : ""}</dt>
              <dd>{seconds(result.labels_ms)}</dd>
            </div>
            <div>
              <dt>Photo</dt>
              <dd>{seconds(result.image_ms)}</dd>
            </div>
            <div>
              <dt>App memory · PSS</dt>
              <dd>{result.pss_mb.toFixed(0)} MiB</dd>
            </div>
          </dl>
          <p className="text-muted small">
            {result.device} · {result.vision_tokens} image tokens ·{" "}
            {result.dimensions} dimensions. Repeat with the same photo and
            labels to compare a warm run. Release memory to test loading again.
          </p>
        </div>
      )}
    </section>
  );
}
