import React, { useState, useEffect } from "react";
import { AppSettings } from "../types";
import { invoke, listen, openExternal } from "../oriel";
import { useSystemAi } from "../hooks/useSystemAi";
import { EmbeddingGemmaPanel } from "./EmbeddingGemmaPanel";
import { SystemAiStatusPanel } from "./SystemAiStatusPanel";

interface SettingsViewProps {
  onSettingsSaved: () => void;
  onResetData: () => void;
}

export interface ModelInfo {
  id: string;
  name: string;
  vision: boolean;
}

interface LocalModelInfo {
  id: string;
  label: string;
  mb: number;
  projector_mb: number;
  speed: number;
  quality: number;
  note: string;
  present: boolean;
  partial: boolean;
  partial_mb: number;
}

interface LocalStatus {
  backend: string;
  gpu: string | null;
  models_dir: string;
  supported: boolean;
  models: LocalModelInfo[];
  loaded: string | null;
  loaded_gpu?: boolean;
  load_ms?: number;
  downloading: string | null;
  generating: boolean;
}

const PROVIDER_HINTS = [
  "https://api.openai.com/v1 — OpenAI (GPT-4o, …)",
  "https://openrouter.ai/api/v1 — OpenRouter",
  "http://192.168.1.100:11434/v1 — Ollama on your network",
  "http://localhost:1234/v1 — LM Studio",
];

export const SettingsView: React.FC<SettingsViewProps> = ({
  onSettingsSaved,
  onResetData,
}) => {
  const [settings, setSettings] = useState<AppSettings>({
    provider: "embedding",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "qwen2.5-vl-3b",
    defaultLocation: "fridge",
    localBackend: "auto",
    embeddingBackend: "cpu",
    matchingLabels: "",
  });

  const [embeddingBusy, setEmbeddingBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [appInfo, setAppInfo] = useState<{
    zig: string;
    mode: string;
    dev: boolean;
  } | null>(null);

  // Dynamic models state
  const [fetchingModels, setFetchingModels] = useState(false);
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [modelFetchError, setModelFetchError] = useState<string | null>(null);
  const [customModelMode, setCustomModelMode] = useState(false);
  const [modelFilter, setModelFilter] = useState<"vision" | "all" | "text">(
    "vision",
  );
  const [modelSearch, setModelSearch] = useState("");

  // Local ("On this device") models state
  const [localStatus, setLocalStatus] = useState<LocalStatus | null>(null);
  const [localProgress, setLocalProgress] = useState<{
    id: string;
    state: string;
    done_mb: number;
    total_mb: number;
  } | null>(null);
  const [localBusy, setLocalBusy] = useState<string | null>(null);
  const [localMessage, setLocalMessage] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);

  const {
    status: systemStatus,
    busy: systemBusy,
    check: checkSystemAi,
  } = useSystemAi(settings.provider === "system");

  const refreshLocalStatus = React.useCallback(async () => {
    try {
      const res = await invoke("local_status");
      setLocalStatus(res as any);
    } catch (err: any) {
      setLocalStatus(null);
      setLocalMessage({ ok: false, text: err?.message || String(err) });
    }
  }, []);

  useEffect(() => {
    refreshLocalStatus();
    const unlisten = window.oriel
      ? listen("local_model_download", (p: any) => {
          const ev = p as any;
          setLocalProgress({
            id: ev.id,
            state: ev.state,
            done_mb: ev.done_mb ?? 0,
            total_mb: ev.total_mb ?? 0,
          });
          if (ev.state === "done") {
            setLocalMessage({ ok: true, text: "Model downloaded and ready." });
            setLocalProgress(null);
            refreshLocalStatus();
          } else if (ev.state === "cancelled") {
            setLocalMessage({
              ok: false,
              text: "Download paused — it resumes from where it stopped.",
            });
            setLocalProgress(null);
          } else if (ev.state === "error") {
            setLocalMessage({
              ok: false,
              text: "The download failed. Try again — it resumes from where it stopped.",
            });
            setLocalProgress(null);
          }
        })
      : undefined;
    return unlisten;
  }, [refreshLocalStatus]);

  const handleLocalDownload = async (id: string) => {
    setLocalBusy(id);
    setLocalMessage(null);
    try {
      await invoke("local_download", { id });
    } catch (err: any) {
      setLocalMessage({
        ok: false,
        text: err?.message || String(err),
      });
    } finally {
      setLocalBusy(null);
      refreshLocalStatus();
    }
  };

  const handleLocalCancel = async () => {
    try {
      await invoke("local_cancel_download");
    } catch {
      /* the download also stops itself when it fails */
    }
  };

  const handleLocalDelete = async (id: string) => {
    if (
      !window.confirm(
        "Delete this model from the device? You can download it again later.",
      )
    )
      return;
    setLocalBusy(id);
    try {
      await invoke("local_delete", { id });
      setLocalMessage({ ok: true, text: "Model deleted." });
    } catch (err: any) {
      setLocalMessage({ ok: false, text: err?.message || String(err) });
    } finally {
      setLocalBusy(null);
      refreshLocalStatus();
    }
  };

  const handleLocalTest = async (id: string) => {
    const entry = localStatus?.models.find((m) => m.id === id);
    if (!entry) return;
    setLocalBusy(id);
    setLocalMessage(null);
    try {
      await invoke("save_settings", {
        settings: { ...settings, provider: "local", model: id } as any,
      });
      const res: any = await invoke("local_test", {
        id,
        backend: settings.localBackend || "auto",
        fast: settings.localScanMode === "fast",
      });
      const where = res.gpu ? `on the ${res.gpu}` : `on the ${res.backend}`;
      setLocalMessage({
        ok: true,
        text: `${entry.label} loaded ${where} in ${((res.load_ms || 0) / 1000).toFixed(1)} s (${res.ctx}-token context${res.vision ? ", reads images" : ""}).`,
      });
      setSettings((prev) => ({ ...prev, provider: "local", model: id }));
      refreshLocalStatus();
    } catch (err: any) {
      setLocalMessage({ ok: false, text: err?.message || String(err) });
    } finally {
      setLocalBusy(null);
    }
  };

  const handleLocalUse = (id: string) => {
    setSettings((prev) => ({ ...prev, provider: "local", model: id }));
    setLocalMessage(null);
  };

  useEffect(() => {
    if (!window.oriel) return;
    loadSettings();
    invoke("app_info")
      .then((info) => setAppInfo(info as any))
      .catch(() => {});
  }, []);

  const loadSettings = async () => {
    try {
      const res = await invoke("get_settings");
      if (res) {
        setSettings({
          provider:
            res.provider === "embedding"
              ? "embedding"
              : res.provider === "system"
                ? "system"
                : res.provider === "local"
                  ? "local"
                  : "api",
          baseUrl: res.baseUrl || "https://api.openai.com/v1",
          apiKey: res.apiKey || "",
          model: res.model || "qwen2.5-vl-3b",
          defaultLocation: res.defaultLocation || "fridge",
          localBackend: (res as any).localBackend || "auto",
          localScanMode: res.localScanMode || "balanced",
          embeddingBackend: res.embeddingBackend || "cpu",
          matchingLabels: res.matchingLabels || "",
        });
      }
    } catch (err: any) {
      console.error("Failed to load settings:", err);
    }
  };

  const handleProviderChange = (
    segment: "local" | "system" | "api" | "embedding",
  ) => {
    setSettings((prev) => ({ ...prev, provider: segment }));
  };

  const handleFetchModels = async () => {
    setFetchingModels(true);
    setModelFetchError(null);

    let models: ModelInfo[] = [];

    // 1. Native backend command (handles LAN IPs & ignores CORS)
    try {
      const res = await invoke("get_available_models", {
        baseUrl: settings.baseUrl || "",
        apiKey: settings.apiKey ? settings.apiKey : null,
      });
      if (Array.isArray(res) && res.length > 0) {
        models = (res as any[]).map((m: any) => ({
          id: m.id || m.name,
          name: m.name || m.id,
          vision: Boolean(m.vision),
        }));
      }
    } catch (err: any) {
      console.warn(
        "Backend model fetch failed, trying direct browser fetch...",
        err,
      );
    }

    // 2. Direct browser fetch fallback
    if (models.length === 0) {
      try {
        const rawBase = (settings.baseUrl || "").trim().replace(/\/+$/, "");
        const cleanBase = rawBase.endsWith("/chat/completions")
          ? rawBase.substring(0, rawBase.length - "/chat/completions".length)
          : rawBase;
        const url = cleanBase.endsWith("/models")
          ? cleanBase
          : `${cleanBase}/models`;

        const headers: Record<string, string> = { Accept: "application/json" };
        if (settings.apiKey && settings.apiKey.trim().length > 0) {
          headers["Authorization"] = `Bearer ${settings.apiKey.trim()}`;
        }

        const resp = await fetch(url, { headers, mode: "cors" });
        if (!resp.ok) {
          throw new Error(
            `Server returned HTTP ${resp.status}: ${resp.statusText}`,
          );
        }
        const data = await resp.json();
        const rawList = Array.isArray(data?.data)
          ? data.data
          : Array.isArray(data?.models)
            ? data.models
            : Array.isArray(data)
              ? data
              : [];
        models = rawList.map((m: any) => {
          const id = typeof m === "string" ? m : m.id || m.name;
          const name =
            typeof m === "string" ? m : m.display_name || m.name || id;
          const isVision =
            m?.capabilities?.vision !== undefined
              ? Boolean(m.capabilities.vision)
              : /vision|vl|4o|gemini|llava|clip/i.test(id) ||
                /vision|vl|4o|gemini|llava|clip/i.test(name);
          return { id, name, vision: isVision };
        });
      } catch (err: any) {
        console.error("Direct fetch failed:", err);
        setModelFetchError(
          err?.message ||
            "Could not connect to model server. Verify IP & port.",
        );
      }
    }

    if (models.length > 0) {
      const visionModels = models
        .filter((m) => m.vision)
        .sort((a, b) => a.name.localeCompare(b.name));
      const textModels = models
        .filter((m) => !m.vision)
        .sort((a, b) => a.name.localeCompare(b.name));
      const sorted = [...visionModels, ...textModels];

      setAvailableModels(sorted);
      setCustomModelMode(false);

      if (visionModels.length > 0) {
        setModelFilter("vision");
      } else {
        setModelFilter("all");
      }

      // Auto-select first vision model if current selection is not vision-capable
      const currentSelected = sorted.find((m) => m.id === settings.model);
      if (!currentSelected || !currentSelected.vision) {
        if (visionModels.length > 0) {
          setSettings((prev) => ({ ...prev, model: visionModels[0].id }));
        } else if (sorted.length > 0) {
          setSettings((prev) => ({ ...prev, model: sorted[0].id }));
        }
      }
    } else if (!modelFetchError) {
      setModelFetchError("No models were returned by the server.");
    }
    setFetchingModels(false);
  };

  const handleSave = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setSaving(true);
    setSavedSuccess(false);

    try {
      await invoke("save_settings", { settings: settings as any });
      setSavedSuccess(true);
      onSettingsSaved();
      setTimeout(() => setSavedSuccess(false), 3000);
    } catch (err: any) {
      alert("Error saving settings: " + (err?.message || err));
    } finally {
      setSaving(false);
    }
  };

  const handleTestConnection = async () => {
    if (settings.provider === "embedding") {
      setTesting(true);
      setTestResult(null);
      try {
        await invoke("save_settings", { settings });
        const status = await invoke("embedding_prepare", {
          backend: settings.embeddingBackend || "cpu",
        });
        setTestResult({
          success: true,
          message: status.message || "Fast local model is ready.",
        });
      } catch (err) {
        setTestResult({
          success: false,
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setTesting(false);
      }
      return;
    }

    if (settings.provider === "system") {
      await checkSystemAi();
      return;
    }
    if (settings.provider === "local") {
      await handleLocalTest(settings.model || "");
      return;
    }
    setTesting(true);
    setTestResult(null);

    // Save inside the try block so a failed save also releases the loading state.

    // Send a 1x1 test image to verify vision endpoint
    const test1x1Png =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

    try {
      await invoke("save_settings", { settings: settings as any });
      const res = await invoke("analyze_image", {
        location: "Test Shelf",
        image: test1x1Png,
      });

      setTestResult({
        success: true,
        message: `Connection verified! Model "${settings.model}" responded successfully (${res.summary || "ready"}).`,
      });
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      setTestResult({
        success: false,
        message: `Connection failed: ${errMsg}`,
      });
    } finally {
      setTesting(false);
    }
  };

  const handleClearInventory = async () => {
    if (
      window.confirm(
        "Empty entire pantry inventory? This removes all preloaded sample items so your inventory starts completely clean for your actual food photos.",
      )
    ) {
      try {
        await invoke("clear_all_items");
        onResetData();
        alert(
          "Inventory completely cleared! You can now take photos to add your real items.",
        );
      } catch (err: any) {
        alert("Error clearing inventory: " + (err?.message || err));
      }
    }
  };

  const isFast = settings.provider === "embedding";
  const isLocal = settings.provider === "local";
  const isSystem = settings.provider === "system";

  const filteredModels = availableModels.filter((m) => {
    if (modelFilter === "vision" && !m.vision) return false;
    if (modelFilter === "text" && m.vision) return false;
    if (modelSearch.trim()) {
      const q = modelSearch.toLowerCase();
      return m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q);
    }
    return true;
  });

  const visionCount = availableModels.filter((m) => m.vision).length;

  return (
    <div className="view-container">
      <div className="view-header">
        <div>
          <h2>Settings</h2>
          <p className="text-muted">
            Configure your AI vision endpoint and manage your pantry inventory.
          </p>
        </div>
      </div>

      {savedSuccess && (
        <div className="alert alert-success">Settings saved successfully!</div>
      )}

      {testResult && (
        <div
          className={`alert ${testResult.success ? "alert-success" : "alert-danger"}`}
        >
          <div className="alert-content">
            <strong>
              {testResult.success ? "✓ Test Passed" : "✕ Connection Error"}
            </strong>
            <p>{testResult.message}</p>
          </div>
          <button
            type="button"
            className="btn-close"
            onClick={() => setTestResult(null)}
          >
            ✕
          </button>
        </div>
      )}

      <form onSubmit={handleSave} className="settings-form">
        {/* Provider */}
        <div className="settings-section">
          <h3>1. Vision provider</h3>
          <div
            className="seg provider-seg provider-grid"
            role="radiogroup"
            aria-label="Vision provider"
          >
            <button
              type="button"
              className={`seg-btn ${isFast ? "active" : ""}`}
              role="radio"
              aria-checked={isFast}
              onClick={() => handleProviderChange("embedding")}
            >
              Fast local
            </button>
            <button
              type="button"
              className={`seg-btn ${isLocal ? "active" : ""}`}
              role="radio"
              aria-checked={isLocal}
              onClick={() => handleProviderChange("local")}
            >
              Local LLM
            </button>
            <button
              type="button"
              className={`seg-btn ${!isLocal && !isSystem && !isFast ? "active" : ""}`}
              role="radio"
              aria-checked={!isLocal && !isSystem && !isFast}
              onClick={() => handleProviderChange("api")}
            >
              Server / API
            </button>
            <button
              type="button"
              role="radio"
              className={`seg-btn ${isSystem ? "active" : ""}`}
              aria-checked={isSystem}
              onClick={() => handleProviderChange("system")}
            >
              System AI
            </button>
          </div>
        </div>

        {/* On-device models, or endpoint & key */}
        {isFast ? (
          <>
            <EmbeddingGemmaPanel
              selectedBackend={
                settings.embeddingBackend === "gpu" ? "gpu" : "cpu"
              }
              onBackendChange={(backend) =>
                setSettings((prev) => ({ ...prev, embeddingBackend: backend }))
              }
              disabled={testing || localBusy !== null}
              onBusyChange={setEmbeddingBusy}
            />
            <div className="settings-section">
              <h3>Food labels for fast scans</h3>
              <p className="text-muted">
                Start with common foods, then use the names you keep in your
                kitchen. Each scan suggests the ten closest labels for you to
                review.
              </p>
              <div className="embedding-actions">
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    setSettings((prev) => ({
                      ...prev,
                      matchingLabels:
                        "pasta\nrice noodles\nbaby pasta\nramen noodles\nrisotto rice",
                    }))
                  }
                >
                  Use pasta and rice labels
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={saving || embeddingBusy}
                  onClick={() => {
                    void invoke("embedding_default_labels")
                      .then((labels) => {
                        setSettings((previous) => ({
                          ...previous,
                          matchingLabels: labels.join("\n"),
                        }));
                        setSavedSuccess(false);
                      })
                      .catch((error) =>
                        setTestResult({
                          success: false,
                          message: String(error),
                        }),
                      );
                  }}
                >
                  Use full food list (710)
                </button>
              </div>
              <div className="form-group">
                <label htmlFor="matching-food-labels">One food per line</label>
                <textarea
                  id="matching-food-labels"
                  rows={10}
                  value={settings.matchingLabels || ""}
                  onChange={(e) =>
                    setSettings((prev) => ({
                      ...prev,
                      matchingLabels: e.target.value,
                    }))
                  }
                />
                <small className="text-muted">
                  {
                    (settings.matchingLabels || "")
                      .split(/[\n,]/)
                      .filter((label) => label.trim()).length
                  }{" "}
                  labels in this list. 2–1,024 unique labels, up to 120
                  characters each. The first scan prepares the labels; later
                  scans reuse the cache. Similarity suggests food types; it does
                  not count packages or confirm presence.
                </small>
              </div>
            </div>
          </>
        ) : isSystem ? (
          <div className="settings-section">
            <h3>2. Android system AI</h3>
            <p className="text-muted">
              Uses the phone’s shared Gemini Nano model. Android checks support
              on this device; no API key is needed and scans run on the phone.
            </p>
            <SystemAiStatusPanel
              status={systemStatus}
              busy={systemBusy}
              onCheck={() => void checkSystemAi()}
              onDownload={() => void checkSystemAi(true)}
            />
            <div className="system-ai-actions">
              {systemStatus?.state !== "available" && (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => handleProviderChange("local")}
                >
                  Choose a local model
                </button>
              )}
            </div>
            <small className="text-muted">
              This provider never switches to a cloud API automatically. If
              system AI is unavailable, choose and download a local model, then
              save your settings.
            </small>
          </div>
        ) : isLocal ? (
          <div className="settings-section">
            <h3>2. On this device</h3>
            <p className="text-muted">
              Downloads a vision model once; scans then run entirely on this
              device — no server, no API key, offline.
            </p>

            {localStatus && (
              <div className="llm-list">
                <div className="llm-row static">
                  <div className="llm-info">
                    <span className="llm-path">
                      Inference: <b>{localStatus.backend}</b>
                      {localStatus.gpu ? ` (${localStatus.gpu})` : ""} ·{" "}
                      {localStatus.loaded
                        ? `model loaded${
                            localStatus.load_ms
                              ? ` in ${(localStatus.load_ms / 1000).toFixed(1)} s`
                              : ""
                          }`
                        : "no model loaded"}
                    </span>
                  </div>
                </div>
                {localStatus.models.map((m) => {
                  const active = settings.model === m.id;
                  const prog =
                    localProgress && localProgress.id === m.id
                      ? localProgress
                      : null;
                  const busyRow = localBusy === m.id || prog !== null;
                  const totalMb = m.mb + m.projector_mb;
                  return (
                    <div
                      key={m.id}
                      className={`llm-row ${active ? "active" : ""}`}
                    >
                      <div className="llm-info">
                        <div>
                          <b>{m.label}</b>
                          {active && <span className="llm-badge">in use</span>}
                          {m.present && (
                            <span className="llm-badge vision">downloaded</span>
                          )}
                          {m.partial && (
                            <span className="llm-badge text">
                              {m.partial_mb > 0
                                ? `${m.partial_mb} MB downloaded`
                                : "unfinished"}
                            </span>
                          )}
                          <span className="llm-badge">
                            {"●".repeat(m.speed)}
                            {"○".repeat(5 - m.speed)} speed
                          </span>
                          <span className="llm-badge">
                            {"●".repeat(m.quality)}
                            {"○".repeat(5 - m.quality)} quality
                          </span>
                        </div>
                        <span className="llm-path">
                          {m.note} · {(totalMb / 1024).toFixed(1)} GB (model +
                          vision projector)
                        </span>
                        {prog && prog.state === "downloading" && (
                          <div className="local-progress">
                            <div className="local-progress-track">
                              <div
                                className="local-progress-fill"
                                style={{
                                  width: `${prog.total_mb > 0 ? Math.min(100, Math.round((prog.done_mb / prog.total_mb) * 100)) : 0}%`,
                                }}
                              />
                            </div>
                            <span className="text-muted small">
                              {prog.done_mb} / {prog.total_mb} MB
                            </span>
                          </div>
                        )}
                        {prog && prog.state === "verifying" && (
                          <div className="text-muted small">
                            Checking the partial download…
                          </div>
                        )}
                      </div>
                      <div className="llm-actions">
                        {!m.present && !busyRow && (
                          <button
                            type="button"
                            className="btn primary"
                            onClick={() => handleLocalDownload(m.id)}
                          >
                            {m.partial_mb > 0 ? "Resume" : "Download"}
                          </button>
                        )}
                        {prog &&
                          (prog.state === "downloading" ||
                            prog.state === "verifying") && (
                            <button
                              type="button"
                              className="btn"
                              onClick={handleLocalCancel}
                            >
                              Cancel
                            </button>
                          )}
                        {m.present && !busyRow && (
                          <>
                            <button
                              type="button"
                              className="btn"
                              disabled={embeddingBusy}
                              onClick={() => handleLocalTest(m.id)}
                            >
                              Test
                            </button>
                            <button
                              type="button"
                              className="btn danger"
                              onClick={() => handleLocalDelete(m.id)}
                            >
                              Delete
                            </button>
                          </>
                        )}
                        {m.present && !busyRow && !active && (
                          <button
                            type="button"
                            className="btn"
                            onClick={() => handleLocalUse(m.id)}
                          >
                            Use
                          </button>
                        )}
                        {busyRow && <span className="spinner-sm" />}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {localMessage && (
              <div
                className={
                  localMessage.ok ? "alert alert-success" : "alert alert-danger"
                }
                style={{ marginTop: 12 }}
              >
                {localMessage.text}
              </div>
            )}

            <small
              className="text-muted"
              style={{ display: "block", marginTop: 12 }}
            >
              A downloaded model stays on the device (in{" "}
              <code>{localStatus?.models_dir || "the app's data folder"}</code>
              ). The first scan after opening the app loads it once; Android
              frees it again when memory runs low.
            </small>

            <div className="form-group" style={{ marginTop: 16 }}>
              <label>Scan detail</label>
              <div className="seg" role="radiogroup" aria-label="Scan detail">
                {(["fast", "balanced"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={
                      (settings.localScanMode || "balanced") === mode
                    }
                    className={`seg-btn ${(settings.localScanMode || "balanced") === mode ? "active" : ""}`}
                    onClick={() =>
                      setSettings((prev) => ({ ...prev, localScanMode: mode }))
                    }
                  >
                    {mode === "fast" ? "Fast" : "Detailed"}
                  </button>
                ))}
              </div>
              <small className="text-muted">
                Fast uses fewer image tokens and shorter output. Small labels
                and crowded shelves may need Detailed mode. Scan results show
                timing so you can compare on your phone.
              </small>
            </div>

            <div className="form-group" style={{ marginTop: 16 }}>
              <label>Processor</label>
              <div className="seg" role="radiogroup" aria-label="Processor">
                {(["auto", "gpu", "cpu"] as const).map((b) => (
                  <button
                    key={b}
                    type="button"
                    className={`seg-btn ${(settings.localBackend || "auto") === b ? "active" : ""}`}
                    onClick={() =>
                      setSettings((prev) => ({ ...prev, localBackend: b }))
                    }
                  >
                    {b === "auto" ? "Auto" : b === "gpu" ? "GPU" : "CPU"}
                  </button>
                ))}
              </div>
              <small
                className="text-muted"
                style={{ display: "block", marginTop: 6 }}
              >
                {localStatus?.gpu
                  ? `GPU backend available: ${localStatus.gpu}. Auto uses it on desktops.`
                  : "No GPU backend here: the model runs on the CPU."}
              </small>
            </div>
          </div>
        ) : (
          <div className="settings-section">
            <h3>2. Open-compatible API</h3>
            <p className="text-muted">
              Any OpenAI-compatible endpoint: a hosted API, or a local server on
              this network. Models that read images are marked in the picker.
            </p>

            <div className="form-group">
              <label>API Base URL</label>
              <input
                type="url"
                required
                value={settings.baseUrl || ""}
                onChange={(e) =>
                  setSettings({ ...settings, baseUrl: e.target.value })
                }
                placeholder="http://192.168.1.100:11434/v1 or https://api.openai.com/v1"
              />
              <ul className="provider-hints">
                {PROVIDER_HINTS.map((h) => (
                  <li key={h}>{h}</li>
                ))}
              </ul>
            </div>

            <div className="form-group">
              <label>API Key / Token Allowance</label>
              <div className="input-with-button">
                <input
                  type={showKey ? "text" : "password"}
                  value={settings.apiKey || ""}
                  onChange={(e) =>
                    setSettings({ ...settings, apiKey: e.target.value })
                  }
                  placeholder="Optional for local servers"
                />
                <button
                  type="button"
                  className="btn"
                  onClick={() => setShowKey(!showKey)}
                >
                  {showKey ? "Hide" : "Show"}
                </button>
              </div>
              <small className="text-muted">
                Not needed for Ollama/LM Studio unless password-protected.
              </small>
            </div>

            {/* Model Name & GhostPen-style model selector */}
            <div className="form-group">
              <div className="label-with-action">
                <label>Model Name</label>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={handleFetchModels}
                  disabled={fetchingModels}
                >
                  {fetchingModels ? (
                    <>
                      <span className="spinner-sm"></span>
                      Fetching...
                    </>
                  ) : (
                    "🔄 Get Models from Server"
                  )}
                </button>
              </div>

              {modelFetchError && (
                <div className="model-fetch-error">⚠️ {modelFetchError}</div>
              )}

              {availableModels.length > 0 && !customModelMode ? (
                <div className="ghostpen-model-picker">
                  <div className="model-picker-head">
                    <div className="seg">
                      <button
                        type="button"
                        className={`seg-btn ${modelFilter === "vision" ? "active" : ""}`}
                        onClick={() => setModelFilter("vision")}
                      >
                        📷 Vision ({visionCount})
                      </button>
                      <button
                        type="button"
                        className={`seg-btn ${modelFilter === "all" ? "active" : ""}`}
                        onClick={() => setModelFilter("all")}
                      >
                        All ({availableModels.length})
                      </button>
                      <button
                        type="button"
                        className={`seg-btn ${modelFilter === "text" ? "active" : ""}`}
                        onClick={() => setModelFilter("text")}
                      >
                        Text ({availableModels.length - visionCount})
                      </button>
                    </div>
                    <input
                      type="text"
                      className="model-search-input"
                      placeholder="Filter models..."
                      value={modelSearch}
                      onChange={(e) => setModelSearch(e.target.value)}
                    />
                  </div>

                  <div className="llm-list">
                    {filteredModels.length === 0 ? (
                      <div className="text-muted small p-2">
                        No matching models found.
                      </div>
                    ) : (
                      filteredModels.map((m) => {
                        const active = settings.model === m.id;
                        return (
                          <div
                            key={m.id}
                            className={`llm-row ${active ? "active" : ""}`}
                          >
                            <div className="llm-info">
                              <div>
                                <b>{m.name}</b>
                                {active && (
                                  <span className="llm-badge">in use</span>
                                )}
                                {m.vision ? (
                                  <span className="llm-badge vision">
                                    reads images
                                  </span>
                                ) : (
                                  <span className="llm-badge text">
                                    text only
                                  </span>
                                )}
                              </div>
                              <span className="llm-path" title={m.id}>
                                {m.id}
                              </span>
                            </div>
                            <div className="llm-actions">
                              <button
                                type="button"
                                className={`btn ${active ? "primary" : ""}`}
                                disabled={active}
                                onClick={() =>
                                  setSettings({ ...settings, model: m.id })
                                }
                              >
                                {active ? "Using" : "Use"}
                              </button>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>

                  <div className="model-picker-footer">
                    <span className="text-muted small">
                      Selected: <b>{settings.model}</b>
                    </span>
                    <button
                      type="button"
                      className="btn-text-link"
                      onClick={() => setCustomModelMode(true)}
                    >
                      Enter custom name manually
                    </button>
                  </div>

                  {availableModels.find(
                    (m) => m.id === settings.model && !m.vision,
                  ) && (
                    <div className="model-fetch-error mt-2">
                      ⚠️ Selected model lacks a vision projector. Choose a model
                      marked <b>reads images</b> above to analyze food photos.
                    </div>
                  )}
                </div>
              ) : (
                <div className="model-input-wrapper">
                  <input
                    type="text"
                    required
                    value={settings.model || ""}
                    onChange={(e) =>
                      setSettings({ ...settings, model: e.target.value })
                    }
                    placeholder="gpt-4o-mini, llama3.2-vision, qwen2.5-vl"
                  />
                  {availableModels.length > 0 && customModelMode && (
                    <button
                      type="button"
                      className="btn-text-link mt-1"
                      onClick={() => setCustomModelMode(false)}
                    >
                      ← Browse {availableModels.length} models in visual picker
                    </button>
                  )}
                </div>
              )}

              <small className="text-muted">
                Tap <strong>"Get Models from Server"</strong> above to list the
                models the server offers, with vision capability tags, and pick
                one.
              </small>
            </div>
          </div>
        )}

        {/* Preferences */}
        <div className="settings-section">
          <h3>3. Defaults</h3>
          <div className="form-group">
            <label>Default Camera Target Area</label>
            <select
              value={settings.defaultLocation || "fridge"}
              onChange={(e) =>
                setSettings({ ...settings, defaultLocation: e.target.value })
              }
            >
              <option value="fridge">❄️ Fridge</option>
              <option value="pantry">🥫 Food Pantry</option>
              <option value="freezer">🧊 Freezer</option>
            </select>
          </div>
        </div>

        {/* GhostPen-styled Actions Footer */}
        <div className="settings-footer-actions">
          <button
            type="submit"
            className="btn primary btn-lg"
            disabled={saving}
          >
            {saving ? "Saving..." : "💾 Save Settings"}
          </button>

          <div className="settings-sub-actions">
            <button
              type="button"
              className="btn"
              onClick={handleTestConnection}
              disabled={
                embeddingBusy ||
                testing ||
                systemBusy !== null ||
                localBusy !== null
              }
            >
              {testing ? (
                <>
                  <span className="spinner-sm"></span>
                  Testing AI Vision...
                </>
              ) : isFast ? (
                "Test fast local model"
              ) : isSystem ? (
                "Check system AI"
              ) : isLocal ? (
                "Test selected model"
              ) : (
                "📡 Test Connection"
              )}
            </button>

            <button
              type="button"
              className="btn danger"
              onClick={handleClearInventory}
            >
              🗑️ Clear Inventory
            </button>
          </div>
        </div>
      </form>

      <p className="text-muted small"><button type="button" className="btn"
        onClick={() => void openExternal("https://highercomve.github.io/ghostpantry/privacy/")}>
        Privacy policy
      </button></p>

      {appInfo && (
        <div className="app-info-footer">
          <span>
            GhostPantry v0.1.0 • Built with Oriel & Zig {appInfo.zig} •{" "}
            {appInfo.mode}
          </span>
        </div>
      )}
    </div>
  );
};
