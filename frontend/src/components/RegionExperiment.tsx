import { useEffect, useRef, useState } from "react";
import { invoke, type Commands } from "../oriel";
import {
  gridRegions,
  mergeRegions,
  paddedRegion,
  type Region,
} from "../regionExperiment";

type MatchResult = Commands["embedding_match"]["result"];
type Mode = "whole" | "grid" | "efficientdet_lite0" | "efficientdet_lite2";
type CropResult = { region: Region; image: string; result: MatchResult };
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
};
const MODES: { id: Mode; label: string }[] = [
  { id: "whole", label: "Whole photo" },
  { id: "grid", label: "Overlapping grid" },
  { id: "efficientdet_lite0", label: "Lite0 detector" },
  { id: "efficientdet_lite2", label: "Lite2 detector" },
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
  return canvas.toDataURL("image/jpeg", 0.9);
}
export function RegionExperiment({
  image,
  disabled,
  onBusyChange,
}: {
  image: string;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const [mode, setMode] = useState<Mode>("grid");
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [activeRegion, setActiveRegion] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
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
    if (pending.current || disabled) return;
    pending.current = true;
    cancelled.current = false;
    setBusy(true);
    onBusyChange(true);
    setError(null);
    setElapsed(0);
    setActiveRegion(null);
    setProgress({ done: 0, total: 0 });
    setStage("Reading saved food labels…");
    const started = performance.now();
    let complete: CropResult[] = [];
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
      else {
        setStage("Finding object regions on CPU…");
        const detection = await invoke("detect_regions", {
          image,
          detector: mode,
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
        const result = await invoke("embedding_match", {
          image: cropped,
          backend,
          labels,
        });
        complete.push({ region: regions[index], image: cropped, result });
        if (!mounted.current) break;
        setProgress({ done: index + 1, total: regions.length });
      }
      if (mounted.current) {
        setStage(
          cancelled.current
            ? "Stopped after the current region. Partial results below."
            : regions.length
              ? "Comparison ready."
              : "Detector found no regions above its 0.25 threshold.",
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
        boxes can miss pantry packages. These runs do not add anything to your
        inventory or teach corrections.
      </p>
      <div className="embedding-actions">
        {MODES.map((choice) => (
          <button
            type="button"
            className={`btn ${mode === choice.id ? "primary" : ""}`}
            key={choice.id}
            disabled={busy || disabled}
            aria-pressed={mode === choice.id}
            onClick={() => setMode(choice.id)}
          >
            {choice.label}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="btn primary"
        disabled={busy || disabled}
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
                    </td>
                    <td>{(result.totalMs / 1000).toFixed(2)} s</td>
                    <td>{result.regions.length}</td>
                    <td>
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
          <h4>Combined suggestions</h4>
          <p>
            Labels are merged by their best crop score. Matching regions are
            evidence, not package counts. Tap a region to inspect it.
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
          <details>
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
