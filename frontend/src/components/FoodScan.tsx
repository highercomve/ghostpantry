import { useEffect, useRef, useState, type PointerEvent } from "react";
import { invoke, type Commands } from "../oriel";
import { recognizeFood, type Recognition } from "../foodRecognition";
import {
  paddedRegion,
  drawnRegion,
  type Region,
} from "../foodRegions";

type MatchResult = Commands["embedding_region_match"]["result"];
type Mode = "manual" | "yoloe";
type CropResult = {
  region: Region;
  image: string;
  result: MatchResult;
  recognition?: Recognition;
};
type Run = {
  mode: Mode;
  backend: string;
  regions: CropResult[];
  totalMs: number;
  detectorMs: number;
  detectorLoadMs: number;
  detectorPeak: number;
  partial: boolean;
  labelCount: number;
  useMemory: boolean;
  threshold: number;
};
async function decodePhoto(image: string): Promise<HTMLImageElement> {
  const photo = new Image();
  photo.src = image;
  await photo.decode();
  return photo;
}
function crop(photo: HTMLImageElement, region: Region): string {
  const canvas = document.createElement("canvas");
  const left = Math.floor(region.x * photo.naturalWidth),
    top = Math.floor(region.y * photo.naturalHeight);
  canvas.width = Math.max(
    1,
    Math.min(
      photo.naturalWidth - left,
      Math.ceil(region.width * photo.naturalWidth),
    ),
  );
  canvas.height = Math.max(
    1,
    Math.min(
      photo.naturalHeight - top,
      Math.ceil(region.height * photo.naturalHeight),
    ),
  );
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Cannot prepare photo regions");
  context.drawImage(
    photo,
    left,
    top,
    canvas.width,
    canvas.height,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  const encoded = canvas.toDataURL("image/jpeg", 0.9);
  if (encoded.length > 7 * 1024 * 1024)
    throw new Error("Crop is too large. Use smaller regions.");
  return encoded;
}
export function FoodScan({
  image,
  disabled,
  onBusyChange,
  onReviewItem,
  onFinishReview,
  queuedCrops = {},
  runRequest = 0,
}: {
  image: string;
  runRequest?: number;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onReviewItem: (label: string, cropId: string) => Promise<void>;
  queuedCrops?: Record<string, string>;
  onFinishReview: () => void;
}) {
  const [mode, setMode] = useState<Mode>("yoloe");
  const [packageThreshold, setPackageThreshold] = useState(0.1);
  const [busy, setBusy] = useState(false);
  const [useMemory, setUseMemory] = useState(true);
  const [teaching, setTeaching] = useState(false);
  const [corrections, setCorrections] = useState<Record<number, string>>({});
  const [addingCrop, setAddingCrop] = useState<string | null>(null);
  const [cropErrors, setCropErrors] = useState<Record<string, string>>({});
  const [feedbackMessage, setFeedbackMessage] = useState("");
  const [stage, setStage] = useState("");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [activeRegion, setActiveRegion] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [manualRegions, setManualRegions] = useState<Region[]>([]);
  const [draft, setDraft] = useState<Region | null>(null);
  const drag = useRef<{ x: number; y: number; pointer: number } | null>(null);
  const point = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: (event.clientX - bounds.left) / bounds.width,
      y: (event.clientY - bounds.top) / bounds.height,
    };
  };
  const lastRunRequest = useRef(0);
  const cancelled = useRef(false),
    mounted = useRef(true),
    pending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    cancelled.current = false;
    return () => {
      mounted.current = false;
      cancelled.current = true;
    };
  }, []);
  useEffect(() => {
    if (!busy) return;
    const started = performance.now();
    const timer = window.setInterval(
      () => setElapsed((performance.now() - started) / 1000),
      250,
    );
    return () => window.clearInterval(timer);
  }, [busy]);
  const run = async () => {
    if (pending.current || disabled || teaching) return;
    if (mode === "manual" && manualRegions.length === 0) return;
    pending.current = true;
    cancelled.current = false;
    setBusy(true);
    onBusyChange(true);
    setError(null);
    setCorrections({});
    setFeedbackMessage("");
    setElapsed(0);
    setActiveRegion(null);
    setProgress({ done: 0, total: 0 });
    setStage("Reading saved food labels…");
    const started = performance.now();
    const threshold = packageThreshold;
    const complete: CropResult[] = [];
    try {
      const settings = await invoke("get_settings");
      const backend = settings.embeddingBackend === "gpu" ? "gpu" : "cpu";
      const labels = [
        ...new Set(
          (settings.matchingLabels || "")
            .split(/[\n,]/)
            .map((label) => label.trim())
            .filter(Boolean),
        ),
      ];
      if (labels.length < 2 || labels.length > 1024)
        throw new Error(
          "Save a food list of 2–1,024 labels in Settings first.",
        );
      const photo = await decodePhoto(image);
      let regions: Region[],
        detectorMs = 0,
        detectorLoadMs = 0,
        detectorPeak = 0;
      if (mode === "manual") regions = manualRegions;
      else {
        setStage("Finding object regions on CPU…");
        const detection = await invoke("detect_regions", {
          image,
          detector: mode,
          threshold,
        });
        detectorMs = detection.detect_ms;
        detectorLoadMs = detection.load_ms;
        detectorPeak = detection.pss_mb;
        regions = detection.boxes.slice(0, 24).map(paddedRegion);
      }
      setProgress({ done: 0, total: regions.length });
      for (let index = 0; index < regions.length; index++) {
        if (cancelled.current) break;
        setStage(
          index === 0
            ? "Preparing label cache and identifying region 1…"
            : `Identifying region ${index + 1} of ${regions.length}…`,
        );
        const cropped = crop(photo, regions[index]);
        const result = await invoke("embedding_region_match", {
          image: cropped,
          backend,
          labels,
          use_feedback: useMemory,
        });
        complete.push({
          region: regions[index],
          image: cropped,
          result,
          recognition: recognizeFood(
            "",
            labels,
            result.matches,
            result.background_score,
          ),
        });
        if (!mounted.current) break;
        setProgress({ done: index + 1, total: regions.length });
      }
      if (mounted.current) {
        setStage(
          cancelled.current
            ? "Stopped after the current region. Partial results below."
            : regions.length
              ? "Foods ready for review."
              : `Detector found no regions above its ${threshold.toFixed(2)} threshold.`,
        );
        setRuns([
          {
            mode,
            backend,
            regions: complete,
            totalMs: performance.now() - started,
            detectorMs,
            detectorLoadMs,
            detectorPeak,
            partial: cancelled.current,
            labelCount: labels.length,
            useMemory,
            threshold,
          },
        ]);
      }
    } catch (failure) {
      if (mounted.current)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      pending.current = false;
      if (mounted.current) {
        setBusy(false);
        onBusyChange(false);
      }
    }
  };
  useEffect(() => {
    if (runRequest <= lastRunRequest.current || disabled || teaching || pending.current) return;
    lastRunRequest.current = runRequest;
    void run();
  }, [runRequest, disabled, teaching, run]);
  const teach = async (index: number, accepted: boolean) => {
    const region = runs.at(-1)?.regions[index];
    const label = (
      corrections[index] ??
      region?.recognition?.label ??
      ""
    ).trim();
    if (
      !region?.result.scan_id ||
      !label ||
      pending.current ||
      teaching ||
      disabled
    )
      return;
    setTeaching(true);
    onBusyChange(true);
    setFeedbackMessage("");
    try {
      const saved = await invoke("embedding_feedback", {
        scan_id: region.result.scan_id,
        label,
        accepted,
      });
      setFeedbackMessage(
        `${accepted ? "Confirmed" : "Rejected"} “${label}” for region ${index + 1}. ${saved.count} crop examples saved on this phone. Scan again to use the correction.`,
      );
    } catch (failure) {
      setFeedbackMessage(
        failure instanceof Error ? failure.message : String(failure),
      );
    } finally {
      if (mounted.current) {
        setTeaching(false);
        onBusyChange(false);
      }
    }
  };
  const cropKey = (region: Region) => [region.x, region.y, region.width, region.height].join(":");
  const addCrop = async (index: number) => {
    const result = runs.at(-1)?.regions[index];
    const label = corrections[index]?.trim();
    if (!result || !label || addingCrop !== null) return;
    const key = cropKey(result.region);
    if (queuedCrops[key] === label) return;
    setAddingCrop(key);
    setCropErrors((previous) => ({ ...previous, [key]: "" }));
    try {
      await onReviewItem(label, key);
    } catch (failure) {
      setCropErrors((previous) => ({ ...previous, [key]: failure instanceof Error ? failure.message : String(failure) }));
    } finally {
      if (mounted.current) setAddingCrop(null);
    }
  };
  const latest = runs.at(-1);
  const selected =
    latest && activeRegion !== null ? latest.regions[activeRegion] : null;
  return (
    <section className="settings-section embedding-panel">
      <span className="eyebrow">FAST & OFFLINE</span>
      <h3>Find foods to add</h3>
      <p>Scan packages and loose produce together. Choose the product for each
        crop, then review grouped quantities and fill before saving.</p>
      <div className="region-options">
        <label>
          <input
            type="checkbox"
            checked={useMemory}
            disabled={busy || teaching || disabled}
            onChange={(e) => setUseMemory(e.target.checked)}
          />{" "}
          Use my confirmed crop examples
        </label>
        <small>
          Confirm or correct each crop below. Saved examples improve visual
          matching on this phone. Use saved examples to recognize familiar products.
        </small>
      </div>
      <div className="embedding-actions">
        <button type="button" className={`btn ${mode === "yoloe" ? "primary" : ""}`}
          disabled={busy || teaching || disabled} aria-pressed={mode === "yoloe"}
          onClick={() => setMode("yoloe")}>Automatic food scan</button>
        <button type="button" className={`btn ${mode === "manual" ? "primary" : ""}`}
          disabled={busy || teaching || disabled} aria-pressed={mode === "manual"}
          onClick={() => setMode("manual")}>Mark missed foods</button>
      </div>
      {mode === "yoloe" && (
        <div className="region-options">
          <p>
            Scans packages first, then loose fruit and vegetables on CPU. Both
            phases use the whole photo and overlapping crops. Their boxes are
            merged before foods are matched for your review.
          </p>
          <label>
            Minimum detection score
            <select value={packageThreshold} disabled={busy || teaching || disabled}
              onChange={(event) => setPackageThreshold(Number(event.target.value))}>
              <option value={0.1}>0.10 · tuned setting</option>
              <option value={0.15}>0.15 · fewer weak proposals</option>
              <option value={0.25}>0.25 · stronger proposals</option>
            </select>
          </label>
          <small>Loose produce uses a minimum score of 0.15. Overlapping boxes are merged; confirm foods and quantities before adding them.</small>
        </div>
      )}
      {mode === "manual" && (
        <div className="package-editor">
          <p>
            Drag a box around each package you want to scan. Include its label
            and keep nearby packages outside the box. Mark up to 12 packages.
          </p>
          <div
            className="region-photo package-editor-photo"
            aria-label="Photo for marking packages"
            onPointerDown={(event) => {
              if (
                busy ||
                teaching ||
                disabled ||
                manualRegions.length >= 12 ||
                !event.isPrimary ||
                event.button !== 0
              )
                return;
              drag.current = { ...point(event), pointer: event.pointerId };
              event.currentTarget.setPointerCapture(event.pointerId);
              setDraft(null);
            }}
            onPointerMove={(event) => {
              if (!drag.current || drag.current.pointer !== event.pointerId)
                return;
              setDraft(drawnRegion(drag.current, point(event), "New package"));
            }}
            onPointerUp={(event) => {
              if (!drag.current || drag.current.pointer !== event.pointerId)
                return;
              const region = drawnRegion(
                drag.current,
                point(event),
                `Package ${manualRegions.length + 1}`,
              );
              drag.current = null;
              setDraft(null);
              if (region)
                setManualRegions((previous) =>
                  [...previous, region].slice(0, 12),
                );
              event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onPointerCancel={() => {
              drag.current = null;
              setDraft(null);
            }}
            onLostPointerCapture={() => {
              drag.current = null;
              setDraft(null);
            }}
          >
            <img
              src={image}
              alt="Mark each pantry package with a box"
              draggable={false}
            />
            {[...manualRegions, ...(draft ? [draft] : [])].map(
              (region, index) => (
                <div
                  key={index}
                  className="region-outline package-outline"
                  style={{
                    left: `${region.x * 100}%`,
                    top: `${region.y * 100}%`,
                    width: `${region.width * 100}%`,
                    height: `${region.height * 100}%`,
                  }}
                >
                  <span>{index + 1}</span>
                </div>
              ),
            )}
          </div>
          <p role="status">{manualRegions.length} packages marked</p>
          <div className="embedding-actions">
            <button
              type="button"
              className="btn"
              disabled={
                busy || teaching || disabled || manualRegions.length === 0
              }
              onClick={() =>
                setManualRegions((previous) => previous.slice(0, -1))
              }
            >
              Undo last box
            </button>
            <button
              type="button"
              className="btn"
              disabled={
                busy || teaching || disabled || manualRegions.length === 0
              }
              onClick={() => setManualRegions([])}
            >
              Clear boxes
            </button>
          </div>
        </div>
      )}
      <button
        type="button"
        className="btn primary"
        disabled={
          busy ||
          teaching ||
          disabled ||
          (mode === "manual" && manualRegions.length === 0)
        }
        onClick={() => void run()}
      >
        Scan foods
      </button>
      {busy && (
        <div className="embedding-progress" role="status">
          <strong>{stage}</strong>
          <span>{elapsed.toFixed(1)} s elapsed</span>
          {progress.total > 0 && (
            <progress max={progress.total} value={progress.done} />
          )}
          <p>
            First use of a food list prepares its cache. Later runs reuse it.
            Keep the app open.
          </p>
          <button
            type="button"
            className="btn"
            onClick={() => {
              cancelled.current = true;
              setStage("Stopping after the current region…");
            }}
          >
            Stop after current region
          </button>
        </div>
      )}
      {!busy && stage && <p role="status">{stage}</p>}
      {error && <p role="alert">{error}</p>}
      {latest && (
        <>
          {
            <>
              <h4>Image review and corrections</h4>
              <p>
                Choose a suggestion or type the product for each crop, then add it
                to the final review. Matching products are grouped and each chosen
                crop counts as one unit. Review quantity and fill at the end before
                saving to inventory.
              </p>
              <p role="status">{feedbackMessage}</p>
            </>
          }
          {
            <ul>
              {latest.regions.map((region, index) => (
                <li key={index}>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setActiveRegion(index)}
                  >
                    Region {index + 1}: {region.recognition?.label ?? "Unknown"}
                  </button>{" "}
                  · {region.recognition?.state ?? "review"}
                </li>
              ))}
            </ul>
          }
          {latest.regions.length === 0 && (
            <p>
              No foods were detected. Use “Mark missed foods” to draw boxes around visible products.
            </p>
          )}
          <div className="region-photo">
            <img src={image} alt="Original food photo" />
            {selected && (
              <div
                className="region-outline"
                style={{
                  left: `${selected.region.x * 100}%`,
                  top: `${selected.region.y * 100}%`,
                  width: `${selected.region.width * 100}%`,
                  height: `${selected.region.height * 100}%`,
                }}
              />
            )}
          </div>
          <details open>
            <summary>
              Inspect all {latest.regions.length} regions and weaker matches
            </summary>
            {latest.regions.map((result, index) => (
              <div className="embedding-results" key={index}>
                <button
                  type="button"
                  className="btn"
                  onClick={() => setActiveRegion(index)}
                >
                  Highlight region {index + 1}
                </button>
                <p>
                  {result.region.label}
                  {result.region.score !== undefined
                    ? ` · detector score ${result.region.score.toFixed(3)}`
                    : ""}
                </p>
                <img
                  className="region-crop"
                  src={result.image}
                  alt={`Region ${index + 1}`}
                />
                {result.recognition && (
                  <div className="region-recognition">
                    <strong>
                      {result.recognition.label ?? "Unknown"}
                      {result.recognition.state !== "unknown"
                        ? ` · ${result.recognition.state}`
                        : ""}
                    </strong>
                    <p>{result.recognition.reason}</p>
                    <label>
                      Product for this crop
                      <input
                        type="text"
                        maxLength={120}
                        placeholder="Type the actual food category"
                        value={
                          corrections[index] ?? queuedCrops[cropKey(result.region)] ?? ""
                        }
                        disabled={busy || teaching || disabled}
                        onChange={(e) =>
                          setCorrections((previous) => ({
                            ...previous,
                            [index]: e.target.value,
                          }))
                        }
                      />
                    </label>
                    <div className="embedding-actions">
                      <button
                        type="button"
                        className="btn primary"
                        disabled={busy || teaching || disabled || addingCrop !== null || (!!queuedCrops[cropKey(result.region)] && queuedCrops[cropKey(result.region)] === (corrections[index] ?? queuedCrops[cropKey(result.region)])?.trim()) || !corrections[index]?.trim()}
                        onClick={() => void addCrop(index)}
                      >
                        {addingCrop === cropKey(result.region) ? "Adding…" : queuedCrops[cropKey(result.region)] === (corrections[index] ?? queuedCrops[cropKey(result.region)])?.trim() && queuedCrops[cropKey(result.region)] ? "Added to review" : "Add to final review"}
                      </button>
                      <button
                        type="button"
                        className="btn primary"
                        disabled={
                          busy ||
                          teaching ||
                          disabled ||
                          !(
                            corrections[index] ??
                            result.recognition.label ??
                            ""
                          ).trim()
                        }
                        onClick={() => void teach(index, true)}
                      >
                        Confirm and remember crop
                      </button>
                      <button
                        type="button"
                        className="btn"
                        disabled={
                          busy ||
                          teaching ||
                          disabled ||
                          !(
                            corrections[index] ??
                            result.recognition.label ??
                            ""
                          ).trim()
                        }
                        onClick={() => void teach(index, false)}
                      >
                        Wrong category for this crop
                      </button>
                    </div>
                    {queuedCrops[cropKey(result.region)] && <p role="status">{queuedCrops[cropKey(result.region)]} is in the final review. Continue choosing crops; quantity and fill are reviewed at the end.</p>}
                    {cropErrors[cropKey(result.region)] && <p role="alert">{cropErrors[cropKey(result.region)]}</p>}
                    <ul>
                      {result.recognition.suggestions.map((suggestion) => (
                        <li key={suggestion.label}>
                          <button
                            type="button"
                            className="btn"
                            disabled={busy || teaching || disabled}
                            onClick={() =>
                              setCorrections((previous) => ({
                                ...previous,
                                [index]: suggestion.label,
                              }))
                            }
                          >
                            {suggestion.label}
                          </button>{" "}
                          · {suggestion.source}
                          {suggestion.score !== undefined
                            ? ` · similarity ${suggestion.score.toFixed(3)}`
                            : ""}
                        </li>
                      ))}
                    </ul>
                    {result.result.feedback_warning && (
                      <p role="alert">{result.result.feedback_warning}</p>
                    )}
                  </div>
                )}
              </div>
            ))}
          </details>
          <button
            type="button"
            className="btn primary"
            disabled={busy || teaching || disabled || Object.keys(queuedCrops).length === 0}
            onClick={onFinishReview}
          >
            Review quantities and fill
          </button>
        </>
      )}
    </section>
  );
}
