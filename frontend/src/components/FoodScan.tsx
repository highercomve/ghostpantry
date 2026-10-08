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
  const [completedTimings, setCompletedTimings] = useState<MatchResult[]>([]);
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
    setSkipped([]);
    setFeedbackMessage("");
    setElapsed(0);
    setCompletedTimings([]);
    setActiveRegion(0);
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
            ? "Loading food matching and checking saved labels…"
            : `Identifying region ${index + 1} of ${regions.length}…`,
        );
        const cropped = crop(photo, regions[index]);
        const result = await invoke("embedding_region_match", {
          image: cropped,
          backend,
          labels,
          use_feedback: useMemory,
        });
        if (mounted.current) setCompletedTimings((previous) => [...previous, result]);
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
      setSkipped((previous) => previous.filter((value) => value !== index));
      setActiveRegion(Math.min(index + 1, (runs.at(-1)?.regions.length ?? 1) - 1));
    } catch (failure) {
      setCropErrors((previous) => ({ ...previous, [key]: failure instanceof Error ? failure.message : String(failure) }));
    } finally {
      if (mounted.current) setAddingCrop(null);
    }
  };
  const [skipped, setSkipped] = useState<number[]>([]);
  const latest = runs.at(-1);
  const selected =
    latest && activeRegion !== null ? latest.regions[activeRegion] : null;
  return (
    <section className="settings-section embedding-panel">
      <div className="food-scan-heading">
        <span className="eyebrow">{latest ? "CHOOSE YOUR FOODS" : "ON YOUR PHONE"}</span>
        <h3>{busy ? "Finding your foods…" : latest ? "What’s in your photo?" : "Ready to find foods"}</h3>
        <p>{latest ? "Choose a name for each food you want to keep. You’ll check amounts before saving." : "We’ll look for packages, fruit and vegetables. You choose what goes into your pantry."}</p>
      </div>
      {!busy && <div className="embedding-actions">
        <button type="button" className="btn" disabled={teaching || disabled}
          onClick={() => setMode(mode === "manual" ? "yoloe" : "manual")}>
          {mode === "manual" ? "Back to automatic scan" : "Add a missed food"}
        </button>
      </div>}
      <details className="scan-advanced">
        <summary>Scan options</summary>
        <label><input type="checkbox" checked={useMemory} disabled={busy || teaching || disabled}
          onChange={(event) => setUseMemory(event.target.checked)} /> Use saved food examples</label>
        <label>Detection sensitivity<select value={packageThreshold} disabled={busy || teaching || disabled}
          onChange={(event) => setPackageThreshold(Number(event.target.value))}>
          <option value={0.1}>Find more foods</option><option value={0.15}>Balanced</option><option value={0.25}>Stronger matches only</option>
        </select></label>
      </details>
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
      {(!latest || mode === "manual") && !busy && <button
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
        {mode === "manual" ? "Find these foods" : "Find foods"}
      </button>}
      {busy && (
        <div className="embedding-progress" role="status">
          <strong>{progress.total ? progress.done === 0 ? "Preparing food matching…" : `Identifying food ${Math.min(progress.done + 1, progress.total)} of ${progress.total}` : "Looking for foods in your photo…"}</strong>
          <span>This can take a moment. Keep the app open.</span>
          {progress.total > 0 && (
            <progress max={progress.total} value={progress.done} />
          )}
          <details><summary>Scan details</summary><p>{stage} · {elapsed.toFixed(1)} s</p>
            {completedTimings.map((result, index) => <p key={index}>Food {index + 1} · {result.backend?.toUpperCase()}<br />
              Model load: {(result.load_ms / 1000).toFixed(1)} s · Labels: {(result.labels_ms / 1000).toFixed(1)} s ({result.label_cache})<br />
              Image matching: {(result.image_ms / 1000).toFixed(1)} s · Memory: {Math.round(result.pss_mb)} MiB</p>)}
          </details>
          <button
            type="button"
            className="btn"
            onClick={() => {
              cancelled.current = true;
              setStage("Stopping after the current region…");
            }}
          >
            Stop scan
          </button>
        </div>
      )}
      {error && <div className="alert alert-danger" role="alert"><strong>Couldn’t finish the scan</strong><p>{error}</p><button className="btn" disabled={busy || disabled} onClick={() => void run()}>Try again</button></div>}
      {latest && !busy && <>
        <details className="scan-advanced"><summary>Scan timing</summary>
          <p>Total: {(latest.totalMs / 1000).toFixed(1)} s · Detection: {(latest.detectorMs / 1000).toFixed(1)} s · {latest.backend.toUpperCase()}</p>
          {completedTimings.map((result, index) => <p key={index}>Food {index + 1}: load {(result.load_ms / 1000).toFixed(1)} s · labels {(result.labels_ms / 1000).toFixed(1)} s ({result.label_cache}) · image {(result.image_ms / 1000).toFixed(1)} s · {Math.round(result.pss_mb)} MiB</p>)}
        </details>
        <div className="food-review-progress" role="status">
          <strong>{Object.keys(queuedCrops).length} chosen</strong><span>{skipped.length} skipped · {latest.regions.length} found</span>
        </div>
        <div className="food-review-nav" aria-label="Foods in this photo">
          {latest.regions.map((result, index) => <button type="button" key={index}
            className={`btn ${activeRegion === index ? "primary" : ""}`} aria-label={`Food ${index + 1}${queuedCrops[cropKey(result.region)] ? ", chosen" : skipped.includes(index) ? ", skipped" : ""}`}
            aria-pressed={activeRegion === index} onClick={() => setActiveRegion(index)}>
            {index + 1}{queuedCrops[cropKey(result.region)] ? " ✓" : skipped.includes(index) ? " −" : ""}
          </button>)}
        </div>
        {latest.regions.length === 0 && <p>No foods found. Tap “Add a missed food” to mark one in your photo.</p>}
        {selected && activeRegion !== null && <article className="food-choice-card" key={activeRegion}>
          <div className="food-choice-top"><span className="eyebrow">FOOD {activeRegion + 1} OF {latest.regions.length}</span><span>{queuedCrops[cropKey(selected.region)] ? "✓ Chosen" : "Your choice"}</span></div>
          <img className="food-choice-image" src={selected.image} alt={`Food ${activeRegion + 1} to identify`} />
          <h4>What food is this?</h4>
          <p className="text-muted">Tap a suggestion or enter a name.</p>
          <div className="food-suggestions">
            {selected.recognition?.suggestions.slice(0, 5).map((suggestion) => <button type="button" className={`btn ${corrections[activeRegion] === suggestion.label ? "primary" : ""}`} key={suggestion.label}
              disabled={teaching || disabled} onClick={() => setCorrections((previous) => ({ ...previous, [activeRegion]: suggestion.label }))}>{suggestion.label}</button>)}
          </div>
          <label htmlFor="food-choice-name">Food name</label>
          <input id="food-choice-name" type="text" maxLength={120} placeholder="e.g. avocado" value={corrections[activeRegion] ?? queuedCrops[cropKey(selected.region)] ?? ""}
            disabled={teaching || disabled} onChange={(event) => setCorrections((previous) => ({ ...previous, [activeRegion]: event.target.value }))} />
          <div className="food-choice-actions">
            <button className="btn primary" disabled={teaching || disabled || addingCrop !== null || !corrections[activeRegion]?.trim() || queuedCrops[cropKey(selected.region)] === corrections[activeRegion]?.trim()}
              onClick={() => void addCrop(activeRegion)}>{addingCrop ? "Adding…" : queuedCrops[cropKey(selected.region)] === corrections[activeRegion]?.trim() && queuedCrops[cropKey(selected.region)] ? "Chosen" : "Keep this food"}</button>
            <button className="btn" disabled={teaching || disabled || addingCrop !== null} onClick={() => {
              if (!queuedCrops[cropKey(selected.region)]) setSkipped((previous) => previous.includes(activeRegion) ? previous : [...previous, activeRegion]);
              setActiveRegion(Math.min(activeRegion + 1, latest.regions.length - 1));
            }}>Skip</button>
          </div>
          {cropErrors[cropKey(selected.region)] && <p role="alert">{cropErrors[cropKey(selected.region)]}</p>}
          <details className="scan-advanced"><summary>Remember this food & scan details</summary>
            <p>Save a correction on this device to help recognize similar foods next time.</p>
            <div className="embedding-actions"><button className="btn" disabled={teaching || disabled || !(corrections[activeRegion] ?? selected.recognition?.label ?? "").trim()} onClick={() => void teach(activeRegion, true)}>Remember name</button>
            <button className="btn" disabled={teaching || disabled || !(corrections[activeRegion] ?? selected.recognition?.label ?? "").trim()} onClick={() => void teach(activeRegion, false)}>Reject suggestion</button></div>
            {feedbackMessage && <p role="status">{feedbackMessage}</p>}
            <p>{selected.region.label} · detector score {selected.region.score?.toFixed(3) ?? "manual"}</p>
            <p>{selected.recognition?.reason}</p>
            {selected.result.feedback_warning && <p role="alert">{selected.result.feedback_warning}</p>}
          </details>
        </article>}
        <div className="food-review-footer">
          <p>Nothing is saved yet. Check quantities and fill next.</p>
          <button type="button" className="btn primary w-full" disabled={teaching || disabled || Object.keys(queuedCrops).length === 0} onClick={onFinishReview}>
            Review {Object.keys(queuedCrops).length} chosen {Object.keys(queuedCrops).length === 1 ? "food" : "foods"} →
          </button>
        </div>
      </>}
    </section>
  );
}
