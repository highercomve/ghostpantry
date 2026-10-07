import { useEffect, useRef, useState, type PointerEvent } from "react";
import { invoke, type Commands } from "../oriel";
import { recognizeFood, type Recognition } from "../foodRecognition";
import {
  gridRegions,
  mergeRegions,
  paddedRegion,
  drawnRegion,
  type Region,
} from "../regionExperiment";

type MatchResult = Commands["embedding_match"]["result"];
type Mode =
  | "whole"
  | "grid"
  | "manual"
  | "efficientdet_lite0"
  | "efficientdet_lite2"
  | "rfdetr_nano";
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
const MODES: { id: Mode; label: string }[] = [
  { id: "manual", label: "Mark packages" },
  { id: "whole", label: "Whole photo" },
  { id: "grid", label: "Overlapping grid" },
  { id: "efficientdet_lite0", label: "Lite0 detector" },
  { id: "efficientdet_lite2", label: "Lite2 detector" },
  { id: "rfdetr_nano", label: "RF-DETR Nano · CPU" },
];

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
export function RegionExperiment({
  image,
  disabled,
  onBusyChange,
  onReviewItem,
}: {
  image: string;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onReviewItem: (label: string) => void;
}) {
  const [mode, setMode] = useState<Mode>("efficientdet_lite2");
  const [rfThreshold, setRfThreshold] = useState(0.25);
  const [busy, setBusy] = useState(false);
  const [useMemory, setUseMemory] = useState(true);
  const [teaching, setTeaching] = useState(false);
  const [corrections, setCorrections] = useState<Record<number, string>>({});
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
  const cancelled = useRef(false),
    mounted = useRef(true),
    pending = useRef(false);
  useEffect(() => {
    mounted.current = true;
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
    const threshold = mode === "rfdetr_nano" ? rfThreshold : 0.25;
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
      if (mode === "whole") regions = [gridRegions()[0]];
      else if (mode === "grid") regions = gridRegions();
      else if (mode === "manual") regions = manualRegions;
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
        regions = detection.boxes.slice(0, 12).map(paddedRegion);
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
              ? "Comparison ready."
              : `Detector found no regions above its ${threshold.toFixed(2)} threshold.`,
        );
        setRuns((previous) => [
          ...previous.slice(-3),
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
        `${accepted ? "Confirmed" : "Rejected"} “${label}” for region ${index + 1}. ${saved.count} crop examples saved on this phone. Run again to compare.`,
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
  const latest = runs.at(-1);
  const selected =
    latest && activeRegion !== null ? latest.regions[activeRegion] : null;
  return (
    <section className="settings-section embedding-panel">
      <span className="eyebrow">ON-DEVICE COMPARISON</span>
      <h3>Multi-item scan experiment</h3>
      <p>
        Compare the same photo and saved food list. The grid checks 10
        overlapping regions; detectors propose up to 12 regions. Generic COCO
        boxes can miss pantry packages. Review a crop label to add it to
        inventory, with quantity and fill set by you. Only explicit
        confirmations and rejections teach corrections.
      </p>
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
          matching on this phone. Turn examples off to compare the original
          image scores.
        </small>
      </div>
      <div className="embedding-actions">
        {MODES.map((choice) => (
          <button
            type="button"
            className={`btn ${mode === choice.id ? "primary" : ""}`}
            key={choice.id}
            disabled={busy || teaching || disabled}
            aria-pressed={mode === choice.id}
            onClick={() => setMode(choice.id)}
          >
            {choice.label}
          </button>
        ))}
      </div>
      {mode === "rfdetr_nano" && (
        <div className="region-options">
          <p>
            RF-DETR Nano runs on CPU with pretrained object categories. Compare
            its boxes with Lite2; it has not been trained for pantry packages yet.
            First use also prepares the detector model on this phone.
          </p>
          <label>
            Minimum detector score
            <select value={rfThreshold} disabled={busy || teaching || disabled}
              onChange={(event) => setRfThreshold(Number(event.target.value))}>
              <option value={0.1}>0.10 · inspect weaker proposals</option>
              <option value={0.25}>0.25 · comparison baseline</option>
              <option value={0.5}>0.50 · stronger proposals</option>
            </select>
          </label>
          <small>Lower scores can include package fragments and background objects.</small>
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
        Run comparison
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
      {runs.length > 0 && (
        <div className="embedding-results">
          <h4>Results on this photo</h4>
          <div className="region-table">
            <table>
              <thead>
                <tr>
                  <th>Method</th>
                  <th>Total</th>
                  <th>Regions</th>
                  <th>Peak PSS*</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((result, index) => (
                  <tr key={index}>
                    <td>
                      {MODES.find((x) => x.id === result.mode)?.label} ·{" "}
                      {result.backend.toUpperCase()}
                      {result.partial ? " (partial)" : ""}
                      {" · visual matching"}
                      {result.useMemory ? " · crop memory" : ""}
                      {result.mode === "rfdetr_nano" ? ` · threshold ${result.threshold.toFixed(2)}` : ""}
                    </td>
                    <td data-label="Total">
                      {(result.totalMs / 1000).toFixed(2)} s
                    </td>
                    <td data-label="Regions">{result.regions.length}</td>
                    <td data-label="Sampled PSS">
                      {Math.max(
                        result.detectorPeak,
                        ...result.regions.map((x) => x.result.pss_mb),
                        0,
                      ).toFixed(0)}{" "}
                      MiB
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <small>
            *Highest sampled app PSS, not continuous peak measurement. Detector
            timing includes CPU inference; total includes initialization,
            cropping and matching.
          </small>
        </div>
      )}
      {latest && (
        <>
          <p>
            Latest run: {latest.labelCount} labels · detector load{" "}
            {(latest.detectorLoadMs / 1000).toFixed(2)} s · detection{" "}
            {(latest.detectorMs / 1000).toFixed(2)} s.
          </p>
          <details open>
            <summary>Combined suggestions</summary>
            <h4>Combined suggestions</h4>
            <p>
              Suggestions from all {latest.regions.length} scanned regions are
              shown here, including regions marked Unknown. Labels are merged by
              their best crop score. Tap a region to inspect it.
            </p>
            <ul>
              {mergeRegions(latest.regions.map((x) => x.result)).map((food) => (
                <li key={food.label}>
                  {food.label} · {food.score.toFixed(3)}
                  <div className="embedding-actions">
                    {food.regions.map((index) => (
                      <button
                        type="button"
                        className="btn"
                        key={index}
                        onClick={() => setActiveRegion(index)}
                      >
                        Region {index + 1}
                      </button>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </details>
          {
            <>
              <h4>Image review and corrections</h4>
              <p>
                Confirm the category for each crop below. “Unknown” is kept when
                evidence is weak; package quantities are never inferred from
                overlapping crops.
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
              No regions were classified. Try the overlapping grid; no fallback
              was applied to the detector result.
            </p>
          )}
          <div className="region-photo">
            <img src={image} alt="Original comparison photo" />
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
                      Confirmed category for this crop
                      <input
                        type="text"
                        maxLength={120}
                        placeholder="Type the actual food category"
                        value={
                          corrections[index] ?? result.recognition.label ?? ""
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
                        onClick={() =>
                          onReviewItem(
                            (
                              corrections[index] ??
                              result.recognition?.label ??
                              ""
                            ).trim(),
                          )
                        }
                      >
                        Review for inventory
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
                    <small>
                      {result.result.correction_count ?? 0} local crop examples
                    </small>
                    <small className="recognition-diagnostics">
                      Best image similarity{" "}
                      {result.result.matches[0]?.score.toFixed(3) ?? "—"} ·
                      background{" "}
                      {result.result.background_score?.toFixed(3) ?? "—"}.
                    </small>
                    {result.result.feedback_warning && (
                      <p role="alert">{result.result.feedback_warning}</p>
                    )}
                  </div>
                )}
                <ol>
                  {result.result.matches.map((match) => (
                    <li key={match.label}>
                      {match.label} · {match.score.toFixed(3)}
                    </li>
                  ))}
                </ol>
                <small>
                  Cosine similarity, not food-presence probability. Photo{" "}
                  {(result.result.image_ms / 1000).toFixed(2)} s; labels{" "}
                  {(result.result.labels_ms / 1000).toFixed(2)} s (
                  {result.result.label_cache}).
                </small>
              </div>
            ))}
          </details>
        </>
      )}
    </section>
  );
}
