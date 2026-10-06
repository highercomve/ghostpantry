import { SystemAiStatus } from "../hooks/useSystemAi";

export function SystemAiStatusPanel({
  status,
  busy,
  onCheck,
  onDownload,
  disabled = false,
}: {
  status: SystemAiStatus | null;
  busy: "checking" | "downloading" | null;
  disabled?: boolean;
  onCheck: () => void;
  onDownload: () => void;
}) {
  const downloading = busy === "downloading" || status?.state === "downloading";
  const title = downloading
    ? "Downloading system model…"
    : busy === "checking"
      ? "Checking system AI…"
      : status?.state === "available"
        ? "Ready to scan"
        : status?.state === "downloadable"
          ? "Model download needed"
          : status?.state === "error"
            ? "Could not check support"
            : "System AI unavailable";
  const message =
    busy === "downloading"
      ? "Downloading Gemini Nano to enable scans on this phone."
      : busy === "checking"
        ? "Checking system AI support on this phone."
        : status?.message || "Open the Android app to check system AI support.";

  return (
    <>
      <div
        role="status"
        className={`alert system-ai-status ${status?.state === "available" ? "alert-success" : "alert-info"}`}
      >
        <strong>{title}</strong>
        <p>{message}</p>
      </div>
      <div className="system-ai-actions">
        <button
          type="button"
          className="btn btn-secondary"
          disabled={disabled || busy !== null}
          onClick={onCheck}
        >
          Check support again
        </button>
        {(status?.state === "downloadable" || downloading) && (
          <button
            type="button"
            className="btn btn-primary"
            disabled={disabled || busy !== null || downloading}
            onClick={onDownload}
          >
            {downloading ? "Downloading…" : "Download system model"}
          </button>
        )}
      </div>
    </>
  );
}
