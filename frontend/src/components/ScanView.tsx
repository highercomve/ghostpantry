import React, { useEffect, useState } from "react";
import { CameraCapture } from "./CameraCapture";
import { invoke } from "../oriel";
import { useSystemAi } from "../hooks/useSystemAi";
import { SystemAiStatusPanel } from "./SystemAiStatusPanel";
import { InventoryItem, VisionDetectedItem, VisionResult } from "../types";

interface ScanViewProps {
  onScanSuccess: () => void;
  defaultLocation?: string;
}

export const ScanView: React.FC<ScanViewProps> = ({
  onScanSuccess,
  defaultLocation = "fridge",
}) => {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isSystem, setIsSystem] = useState(false);
  const {
    status: systemStatus,
    busy: systemBusy,
    check: checkSystemAi,
  } = useSystemAi(isSystem && !isAnalyzing);
  useEffect(() => {
    if (window.oriel)
      void invoke("get_settings")
        .then((settings) => {
          setIsSystem(settings.provider === "system");
        })
        .catch(() => {});
  }, []);

  const [location, setLocation] = useState<string>(defaultLocation);
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [hasAnalyzed, setHasAnalyzed] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  // Results to review before persisting to SQLite
  const [detectedItems, setDetectedItems] = useState<
    (VisionDetectedItem & { selected: boolean; desired: number })[]
  >([]);
  const [scanSummary, setScanSummary] = useState<string>("");
  const [scanTiming, setScanTiming] = useState<VisionResult["timing"]>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccessMsg, setSaveSuccessMsg] = useState<string | null>(null);

  const handleStartAnalysis = async () => {
    if (!selectedImage) return;

    setScanTiming(null);
    setIsAnalyzing(true);
    setAnalysisError(null);
    setSaveSuccessMsg(null);

    try {
      // Check saved provider and live readiness again at the point of use.
      const settings = await invoke("get_settings");
      const system = settings.provider === "system";
      setIsSystem(system);
      if (system) {
        const status = await checkSystemAi();
        if (status.state !== "available") return;
      }
      const res = await invoke("analyze_image", {
        location:
          location === "fridge"
            ? "Refrigerator"
            : location === "freezer"
              ? "Freezer"
              : "Food Pantry",
        image: selectedImage,
      });

      setScanTiming(
        res.timing
          ? {
              total_ms: res.timing.total_ms,
              load_ms: res.timing.load_ms ?? 0,
              vision_ms: res.timing.vision_ms ?? 0,
              generation_ms: res.timing.generation_ms ?? 0,
              input_tokens: res.timing.input_tokens ?? 0,
              output_tokens: res.timing.output_tokens ?? 0,
            }
          : null,
      );
      setHasAnalyzed(true);
      setScanSummary(res.summary || `Found ${res.items.length} items`);
      setDetectedItems(
        res.items.map((it) => ({
          ...it,
          selected: true,
          desired: it.quantity && it.quantity > 1 ? it.quantity : 1,
        })),
      );
    } catch (err: any) {
      console.error("Vision analysis error:", err);
      const msg =
        typeof err === "string"
          ? err
          : err?.message || "Failed to analyze image with AI.";
      setAnalysisError(msg);
      if (isSystem) void checkSystemAi();
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleApplyResults = async () => {
    const selected = detectedItems.filter((it) => it.selected);
    if (selected.length === 0) {
      alert("Please select at least one item to save.");
      return;
    }

    setIsSaving(true);
    try {
      const itemsToSave: InventoryItem[] = selected.map((it) => ({
        name: it.name,
        category: location,
        location:
          location === "fridge"
            ? "Fridge"
            : location === "freezer"
              ? "Freezer"
              : "Pantry",
        quantity: it.quantity ?? 1.0,
        fill_percentage: it.fill_percentage ?? 100.0,
        unit: it.unit || "unit",
        desired_quantity: it.desired || 1.0,
        notes:
          it.notes ||
          (it.fill_percentage && it.fill_percentage <= 50
            ? "Usage recognized from photo"
            : ""),
      }));

      await invoke("apply_scan_results", {
        location,
        summary: scanSummary || `Added ${itemsToSave.length} items from photo`,
        items: itemsToSave as any,
      });

      setSaveSuccessMsg(`Added ${itemsToSave.length} items to your pantry.`);
      // Reset scan view
      setDetectedItems([]);
      setSelectedImage(null);
      onScanSuccess();
    } catch (err: any) {
      console.error("Failed to save scan results:", err);
      alert("Error saving items: " + (err?.message || err));
    } finally {
      setIsSaving(false);
    }
  };

  const updateItemField = (index: number, field: string, value: any) => {
    setDetectedItems((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  };

  const removeItem = (index: number) => {
    setDetectedItems((prev) => prev.filter((_, i) => i !== index));
  };

  return (
    <div className="view-container">
      {/* Header & Target Area Segmented Control */}
      <div className="view-header">
        <div>
          <span className="eyebrow">FROM A PHOTO TO YOUR PANTRY</span>
          <h2>
            Meet your shelf<span>.</span>
          </h2>
          <p className="text-muted">
            A clear photo is all it takes. Review what we find before adding it.
          </p>
        </div>
      </div>

      <ol className="scan-steps" aria-label="Scan progress">
        <li className={!selectedImage ? "current" : "complete"}>
          <span>01</span> Add a photo
        </li>
        <li
          className={
            selectedImage && !hasAnalyzed
              ? "current"
              : hasAnalyzed
                ? "complete"
                : ""
          }
        >
          <span>02</span> Discover & review
        </li>
        <li>
          <span>03</span> Save to pantry
        </li>
      </ol>
      <div className="target-area-card">
        <span className="target-label">Where are we looking?</span>
        <div className="seg">
          <button
            type="button"
            className={`seg-btn ${location === "fridge" ? "active" : ""}`}
            onClick={() => setLocation("fridge")}
            disabled={isAnalyzing || isSaving}
          >
            Fridge
          </button>
          <button
            type="button"
            className={`seg-btn ${location === "pantry" ? "active" : ""}`}
            onClick={() => setLocation("pantry")}
            disabled={isAnalyzing || isSaving}
          >
            Pantry
          </button>
          <button
            type="button"
            className={`seg-btn ${location === "freezer" ? "active" : ""}`}
            onClick={() => setLocation("freezer")}
            disabled={isAnalyzing || isSaving}
          >
            Freezer
          </button>
        </div>
      </div>

      {saveSuccessMsg && (
        <div className="alert alert-success">✓ {saveSuccessMsg}</div>
      )}

      {analysisError && (
        <div className="alert alert-danger">
          <div className="alert-content">
            <strong>⚠️ Vision Analysis Failed</strong>
            <p>{analysisError}</p>
          </div>
          <button
            type="button"
            className="btn-close"
            onClick={() => setAnalysisError(null)}
          >
            ✕
          </button>
        </div>
      )}

      {isSystem && !hasAnalyzed && (
        <div className="settings-section">
          <h3>System AI</h3>
          <SystemAiStatusPanel
            status={systemStatus}
            busy={systemBusy}
            disabled={isAnalyzing || isSaving}
            onCheck={() => {
              setAnalysisError(null);
              void checkSystemAi();
            }}
            onDownload={() => {
              setAnalysisError(null);
              void checkSystemAi(true);
            }}
          />
          {systemStatus?.state === "unavailable" && (
            <p className="text-muted">
              Choose a local model or server in Settings to scan on this device.
            </p>
          )}
        </div>
      )}

      {/* Camera Capture Card */}
      <div className="scan-card">
        <CameraCapture
          selectedImage={selectedImage}
          onImageSelected={(img) => {
            setHasAnalyzed(false);
            setSelectedImage(img);
            setDetectedItems([]);
            setAnalysisError(null);
          }}
          onClear={() => {
            setHasAnalyzed(false);
            setSelectedImage(null);
            setDetectedItems([]);
            setAnalysisError(null);
          }}
          disabled={isAnalyzing || isSaving}
        />

        {/* Immediate CTA directly below image preview */}
        {selectedImage && detectedItems.length === 0 && (
          <div className="scan-cta-block">
            <button
              type="button"
              className="btn primary btn-lg w-full"
              onClick={handleStartAnalysis}
              disabled={
                isAnalyzing ||
                isSaving ||
                (isSystem &&
                  (systemBusy !== null || systemStatus?.state !== "available"))
              }
            >
              {isAnalyzing ? (
                <>
                  <span className="spinner-sm"></span>
                  Analyzing shelf with AI...
                </>
              ) : isSystem && systemStatus?.state !== "available" ? (
                systemBusy === "downloading" ||
                systemStatus?.state === "downloading" ? (
                  "Waiting for system model…"
                ) : (
                  "System AI must be ready to scan"
                )
              ) : (
                "Find items in this photo"
              )}
            </button>
          </div>
        )}
      </div>

      {hasAnalyzed && detectedItems.length === 0 && (
        <div className="alert alert-info" role="status">
          {scanSummary ||
            "No food items found. Try a closer, well-lit photo of your shelf."}
        </div>
      )}
      <div className="scan-tip">
        <span className="eyebrow">A GOOD PHOTO MAKES A DIFFERENCE</span>
        <p>
          Keep labels facing forward, use natural light, and capture one shelf
          at a time.
        </p>
      </div>
      {/* Review Results */}
      {detectedItems.length > 0 && (
        <div className="review-card">
          <div className="review-card-head">
            <div>
              <h3>Detected Items ({detectedItems.length})</h3>
              <p className="text-muted small">{scanSummary}</p>
              {scanTiming && (
                <p className="text-muted small">
                  Scan: {(scanTiming.total_ms / 1000).toFixed(1)} s
                  {scanTiming.input_tokens > 0 && (
                    <>
                      {" "}
                      · load {(scanTiming.load_ms / 1000).toFixed(1)} s · photo{" "}
                      {(scanTiming.vision_ms / 1000).toFixed(1)} s · answer{" "}
                      {(scanTiming.generation_ms / 1000).toFixed(1)} s ·{" "}
                      {scanTiming.output_tokens} tokens
                    </>
                  )}
                </p>
              )}
            </div>
            <span className="badge badge-primary">Review & Save</span>
          </div>

          <div className="detected-items-list">
            {detectedItems.map((item, index) => {
              const fill = item.fill_percentage ?? 100;

              return (
                <div key={index} className="detected-item-row">
                  <div className="item-row-main">
                    <input
                      type="checkbox"
                      checked={item.selected}
                      onChange={(e) =>
                        updateItemField(index, "selected", e.target.checked)
                      }
                      className="item-check"
                    />

                    <div className="item-inputs-grid">
                      <div className="field-group">
                        <label>Item Name</label>
                        <input
                          type="text"
                          value={item.name}
                          onChange={(e) =>
                            updateItemField(index, "name", e.target.value)
                          }
                          placeholder="e.g. Milk, Pasta"
                        />
                      </div>

                      <div className="field-row">
                        <div className="field-group flex-1">
                          <label>Quantity</label>
                          <input
                            type="number"
                            step="0.5"
                            min="0"
                            value={item.quantity ?? 1}
                            onChange={(e) =>
                              updateItemField(
                                index,
                                "quantity",
                                Math.max(0, parseFloat(e.target.value) || 0),
                              )
                            }
                          />
                        </div>

                        <div className="field-group flex-1">
                          <label>Fill Level: {fill}%</label>
                          <input
                            type="range"
                            min="0"
                            max="100"
                            step="5"
                            value={fill}
                            onChange={(e) =>
                              updateItemField(
                                index,
                                "fill_percentage",
                                parseInt(e.target.value),
                              )
                            }
                          />
                        </div>
                      </div>
                    </div>

                    <button
                      type="button"
                      className="btn-remove-item"
                      onClick={() => removeItem(index)}
                      title="Remove item"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="review-card-footer">
            <button
              type="button"
              className="btn primary btn-lg w-full"
              onClick={handleApplyResults}
              disabled={
                isSaving || detectedItems.filter((i) => i.selected).length === 0
              }
            >
              {isSaving
                ? "Saving..."
                : `Add ${detectedItems.filter((i) => i.selected).length} items to pantry`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
