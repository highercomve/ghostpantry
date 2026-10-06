import { RegionExperiment } from "./RegionExperiment";
import { splitSuggestions } from "../foodSuggestions";
import React, { useEffect, useState } from "react";
import { EmbeddingGemmaPanel } from "./EmbeddingGemmaPanel";
import { CameraCapture } from "./CameraCapture";
import { Commands, invoke } from "../oriel";
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
  const [showAlternatives, setShowAlternatives] = useState(false);
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [embeddingBusy, setEmbeddingBusy] = useState(false);
  const [changingBackend, setChangingBackend] = useState(false);
  const [showRegions, setShowRegions] = useState(false);
  const [showEmbedding, setShowEmbedding] = useState(false);
  const [isSystem, setIsSystem] = useState(false);
  const [isFast, setIsFast] = useState(false);
  const [fastBackend, setFastBackend] = useState<"cpu" | "gpu">("cpu");
  const [fastResult, setFastResult] = useState<
    Commands["fast_scan"]["result"] | null
  >(null);
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
          setIsFast(settings.provider === "embedding");
          setFastBackend(settings.embeddingBackend === "gpu" ? "gpu" : "cpu");
        })
        .catch(() => {});
  }, []);

  const [location, setLocation] = useState<string>(defaultLocation);
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [hasAnalyzed, setHasAnalyzed] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  // Results to review before persisting to SQLite
  const [detectedItems, setDetectedItems] = useState<
    (VisionDetectedItem & {
      selected: boolean;
      desired: number;
      similarity?: number;
      adjustment?: number;
      stronger?: boolean;
    })[]
  >([]);
  const [scanSummary, setScanSummary] = useState<string>("");
  const [scanTiming, setScanTiming] = useState<VisionResult["timing"]>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccessMsg, setSaveSuccessMsg] = useState<string | null>(null);

  const handleStartAnalysis = async () => {
    if (!selectedImage) return;

    setShowAlternatives(false);
    setFeedbackMessage(null);
    setFeedbackError(null);
    setScanTiming(null);
    setFastResult(null);
    setIsAnalyzing(true);
    setAnalysisError(null);
    setSaveSuccessMsg(null);

    try {
      // Check saved provider and live readiness again at the point of use.
      const settings = await invoke("get_settings");
      const system = settings.provider === "system";
      setIsSystem(system);
      setIsFast(settings.provider === "embedding");
      if (settings.provider === "embedding") {
        const result = await invoke("fast_scan", { image: selectedImage });
        setFastResult(result);
        if (result.feedback_warning) setFeedbackError(result.feedback_warning);
        setHasAnalyzed(true);
        setScanSummary(
          "Select only the foods you can see. Rename labels and set package counts and fill levels before saving.",
        );
        const strongerNames = new Set(
          splitSuggestions(
            result.matches,
            result.background_score,
          ).stronger.map((match) => match.label),
        );
        setDetectedItems(
          result.matches.map((match) => ({
            name: match.label,
            selected: false,
            desired: 1,
            quantity: 1,
            fill_percentage: 100,
            unit: "package",
            similarity: match.score,
            adjustment: match.adjustment,
            stronger: strongerNames.has(match.label),
            notes:
              "Confirmed from a fast local suggestion; quantity and fill level set during review.",
          })),
        );
        return;
      }
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

  const rememberLabel = async (name: string, accepted: boolean) => {
    if (!fastResult?.scan_id || feedbackBusy) return;
    setFeedbackBusy(true);
    setFeedbackError(null);
    setFeedbackMessage(null);
    try {
      const result = await invoke("embedding_feedback", {
        scan_id: fastResult.scan_id,
        label: name.trim(),
        accepted,
      });
      setFastResult((previous) =>
        previous ? { ...previous, correction_count: result.count } : previous,
      );
      setFeedbackMessage(
        `${accepted ? "Remembered" : "Marked as wrong"}: ${name.trim()}. This will affect future scans of very similar photos.`,
      );
    } catch (error) {
      setFeedbackError(error instanceof Error ? error.message : String(error));
    } finally {
      setFeedbackBusy(false);
    }
  };

  const clearCorrections = async () => {
    if (
      !window.confirm(
        "Clear all learned food corrections on this phone? Your pantry and downloaded model will be kept.",
      )
    )
      return;
    setFeedbackBusy(true);
    setFeedbackError(null);
    setFeedbackMessage(null);
    try {
      await invoke("embedding_clear_feedback");
      setFastResult((previous) =>
        previous ? { ...previous, correction_count: 0 } : previous,
      );
      setFeedbackMessage(
        "Learned corrections cleared. Scan again to refresh the suggestions.",
      );
    } catch (error) {
      setFeedbackError(error instanceof Error ? error.message : String(error));
    } finally {
      setFeedbackBusy(false);
    }
  };

  const handleApplyResults = async () => {
    const selected = detectedItems.filter((it) => it.selected);
    if (selected.length === 0) {
      alert("Please select at least one item to save.");
      return;
    }

    if (
      selected.some(
        (item) =>
          !item.name.trim() ||
          !Number.isFinite(item.quantity ?? 1) ||
          (item.quantity ?? 1) < 0,
      )
    ) {
      setAnalysisError(
        "Enter a food name and a valid quantity for every selected item.",
      );
      return;
    }
    setIsSaving(true);
    try {
      const itemsToSave: InventoryItem[] = selected.map((it) => ({
        name: it.name.trim(),
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
      next[index] = {
        ...next[index],
        [field]: value,
        ...(field === "name"
          ? { similarity: undefined, adjustment: undefined }
          : {}),
      };
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
            disabled={
              isAnalyzing ||
              isSaving ||
              changingBackend ||
              embeddingBusy ||
              feedbackBusy
            }
          >
            Fridge
          </button>
          <button
            type="button"
            className={`seg-btn ${location === "pantry" ? "active" : ""}`}
            onClick={() => setLocation("pantry")}
            disabled={
              isAnalyzing ||
              isSaving ||
              changingBackend ||
              embeddingBusy ||
              feedbackBusy
            }
          >
            Pantry
          </button>
          <button
            type="button"
            className={`seg-btn ${location === "freezer" ? "active" : ""}`}
            onClick={() => setLocation("freezer")}
            disabled={
              isAnalyzing ||
              isSaving ||
              changingBackend ||
              embeddingBusy ||
              feedbackBusy
            }
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

      {isFast && !hasAnalyzed && (
        <EmbeddingGemmaPanel
          setupOnly
          selectedBackend={fastBackend}
          onBackendChange={(backend) => {
            const previous = fastBackend;
            setChangingBackend(true);
            setFastBackend(backend);
            void invoke("get_settings")
              .then((settings) =>
                invoke("save_settings", {
                  settings: { ...settings, embeddingBackend: backend },
                }),
              )
              .catch((err) => {
                setFastBackend(previous);
                setAnalysisError(
                  err instanceof Error ? err.message : String(err),
                );
              })
              .finally(() => setChangingBackend(false));
          }}
          disabled={isAnalyzing || isSaving || changingBackend || feedbackBusy}
          onBusyChange={setEmbeddingBusy}
        />
      )}

      {isFast && (
        <div className="suggestion-intro">
          <strong>Learn from your corrections</strong>
          <p>
            After a scan, remember a correct label or mark a wrong suggestion.
            Corrections stay on this phone and only adjust very similar photos.
            Nothing is learned from unchecked items. CPU and GPU keep separate
            memories.
          </p>
          {fastResult && (
            <p>
              {fastResult.correction_count} saved examples for this processor.
            </p>
          )}
          <button
            type="button"
            className="btn"
            onClick={clearCorrections}
            disabled={
              feedbackBusy ||
              isAnalyzing ||
              isSaving ||
              changingBackend ||
              embeddingBusy
            }
          >
            Clear learned corrections
          </button>
          {feedbackMessage && <p role="status">{feedbackMessage}</p>}
          {feedbackError && <p role="alert">{feedbackError}</p>}
        </div>
      )}

      {isSystem && !hasAnalyzed && (
        <div className="settings-section">
          <h3>System AI</h3>
          <SystemAiStatusPanel
            status={systemStatus}
            busy={systemBusy}
            disabled={
              isAnalyzing ||
              isSaving ||
              changingBackend ||
              embeddingBusy ||
              feedbackBusy
            }
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
            setFeedbackMessage(null);
            setFeedbackError(null);
            setHasAnalyzed(false);
            setFastResult(null);
            setSelectedImage(img);
            setDetectedItems([]);
            setAnalysisError(null);
          }}
          onClear={() => {
            setFeedbackMessage(null);
            setFeedbackError(null);
            setHasAnalyzed(false);
            setFastResult(null);
            setSelectedImage(null);
            setDetectedItems([]);
            setAnalysisError(null);
          }}
          disabled={
            isAnalyzing ||
            isSaving ||
            changingBackend ||
            embeddingBusy ||
            feedbackBusy
          }
        />

        {/* Immediate CTA directly below image preview */}
        {selectedImage && detectedItems.length === 0 && (
          <div className="scan-cta-block">
            <button
              type="button"
              className="btn primary btn-lg w-full"
              onClick={handleStartAnalysis}
              disabled={
                changingBackend ||
                feedbackBusy ||
                embeddingBusy ||
                isAnalyzing ||
                isSaving ||
                (isSystem &&
                  (systemBusy !== null || systemStatus?.state !== "available"))
              }
            >
              {isAnalyzing ? (
                <>
                  <span className="spinner-sm"></span>
                  {isFast
                    ? "Matching foods on your phone…"
                    : "Analyzing shelf with AI..."}
                </>
              ) : isSystem && systemStatus?.state !== "available" ? (
                systemBusy === "downloading" ||
                systemStatus?.state === "downloading" ? (
                  "Waiting for system model…"
                ) : (
                  "System AI must be ready to scan"
                )
              ) : isFast ? (
                "Suggest foods in this photo"
              ) : (
                "Find items in this photo"
              )}
            </button>
          </div>
        )}
      </div>

      {selectedImage && (
        <div className="embedding-entry">
          <button
            type="button"
            className="btn"
            aria-expanded={showRegions}
            disabled={
              isAnalyzing ||
              isSaving ||
              changingBackend ||
              embeddingBusy ||
              feedbackBusy
            }
            onClick={() => setShowRegions((shown) => !shown)}
          >
            {showRegions
              ? "Close multi-item comparison"
              : "Compare multi-item scanning"}
          </button>
          {showRegions && (
            <RegionExperiment
              key={selectedImage}
              image={selectedImage}
              disabled={
                isAnalyzing || isSaving || changingBackend || feedbackBusy
              }
              onBusyChange={setEmbeddingBusy}
            />
          )}
        </div>
      )}

      {selectedImage && !isFast && (
        <div className="embedding-entry">
          <button
            type="button"
            className="btn"
            aria-expanded={showEmbedding}
            disabled={
              isAnalyzing ||
              isSaving ||
              changingBackend ||
              embeddingBusy ||
              feedbackBusy
            }
            onClick={() => setShowEmbedding(!showEmbedding)}
          >
            {showEmbedding ? "Close image matching" : "Try image matching"}
          </button>
          {showEmbedding && (
            <EmbeddingGemmaPanel
              key={selectedImage}
              image={selectedImage}
              disabled={
                isAnalyzing || isSaving || changingBackend || feedbackBusy
              }
              onBusyChange={setEmbeddingBusy}
            />
          )}
        </div>
      )}

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
              <h3>
                {fastResult ? "Stronger suggestions" : "Detected Items"} (
                {fastResult
                  ? detectedItems.filter((item) => item.stronger !== false)
                      .length
                  : detectedItems.length}
                )
              </h3>
              <p className="text-muted small">{scanSummary}</p>
              {fastResult && (
                <p className="text-muted small fast-scan-timing">
                  {fastResult.backend.toUpperCase()} ·{" "}
                  {(fastResult.total_ms / 1000).toFixed(2)} s total · photo{" "}
                  {(fastResult.image_ms / 1000).toFixed(2)} s · labels{" "}
                  {(fastResult.labels_ms / 1000).toFixed(2)} s
                  {fastResult.labels_cached
                    ? ` (${fastResult.label_cache})`
                    : ""}
                </p>
              )}
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

          {fastResult && (
            <div className="suggestion-intro">
              <strong>Which foods are actually here?</strong>
              {detectedItems.every((item) => item.stronger === false) && (
                <p>
                  No clear food match from this list. Add the food you can see,
                  or inspect the alternatives.
                </p>
              )}
              <p>
                Compared {fastResult.labels_count} food labels from your saved
                list. These are the closest food labels, not confirmed
                detections. Nothing is selected automatically. Quantities start
                at one package and fill at 100%; adjust them to match your
                shelf.
              </p>
              {fastResult.needs_review && (
                <p role="status">
                  Other food, non-food objects, or an empty shelf matched better
                  than these suggestions. Your list may be missing the food in
                  this photo.
                </p>
              )}
              <p>
                If a food is missing, add it below or use the full food list in
                Settings.
              </p>
              <button
                type="button"
                className="btn"
                onClick={() =>
                  setDetectedItems((items) => [
                    ...items,
                    {
                      name: "",
                      selected: true,
                      desired: 1,
                      quantity: 1,
                      fill_percentage: 100,
                      unit: "package",
                      notes: "Added during fast local scan review.",
                    },
                  ])
                }
              >
                Add a missing food
              </button>
            </div>
          )}
          {fastResult &&
            detectedItems.some((item) => item.stronger === false) && (
              <div className="suggestion-intro">
                <button
                  type="button"
                  className="btn"
                  aria-expanded={showAlternatives}
                  onClick={() => setShowAlternatives((shown) => !shown)}
                >
                  {showAlternatives ? "Hide" : "Show"} weaker alternatives (
                  {
                    detectedItems.filter((item) => item.stronger === false)
                      .length
                  }
                  )
                </button>
                <p>
                  These are related labels, not additional detected foods. Open
                  them if a food on your shelf is missing.
                </p>
              </div>
            )}
          <div className="detected-items-list">
            {detectedItems.map((item, index) => {
              if (
                fastResult &&
                item.stronger === false &&
                !showAlternatives &&
                !item.selected
              )
                return null;
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
                      aria-label={`Confirm ${item.name || "new food"}`}
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
                          maxLength={fastResult ? 120 : undefined}
                          placeholder="e.g. Milk, Pasta"
                        />
                      </div>

                      {item.similarity !== undefined && (
                        <small className="suggestion-score">
                          Similarity {item.similarity.toFixed(3)} · not a
                          probability
                          {!!item.adjustment && (
                            <span> · Adjusted using your corrections</span>
                          )}
                        </small>
                      )}
                      {fastResult?.scan_id && (
                        <div className="embedding-actions">
                          <button
                            type="button"
                            className="btn"
                            disabled={
                              feedbackBusy || isSaving || !item.name.trim()
                            }
                            onClick={() => void rememberLabel(item.name, true)}
                          >
                            Remember this label
                          </button>
                          <button
                            type="button"
                            className="btn"
                            disabled={
                              feedbackBusy || isSaving || !item.name.trim()
                            }
                            onClick={() => void rememberLabel(item.name, false)}
                          >
                            Wrong suggestion
                          </button>
                        </div>
                      )}
                      <div className="field-row">
                        <div className="field-group flex-1">
                          <label>
                            {fastResult ? "Quantity (you set)" : "Quantity"}
                          </label>
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
                          <label>
                            {fastResult ? "Fill (you set)" : "Fill Level"}:{" "}
                            {fill}%
                          </label>
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
                isSaving ||
                feedbackBusy ||
                detectedItems.filter((i) => i.selected).length === 0 ||
                detectedItems.some((i) => i.selected && !i.name.trim())
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
