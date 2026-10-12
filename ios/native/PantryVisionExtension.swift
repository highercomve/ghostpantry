// The "pantry.vision" app extension on Apple (build.zig, `.extensions`):
// fast local matching with YOLOE (CoreML) and MobileCLIP-S2, the same
// methods, JSON and replies as android/native/EmbeddingGemmaExtension.kt, so
// src/embedding.zig and the page don't change. Oriel calls in on the
// extension's workers (two at once: status and cancel answer while a match
// or detection runs; the rest is serialized here and reports busy).

import CoreGraphics
import CoreVideo
import Foundation

@objc(PantryVisionExtension)
final class PantryVisionExtension: NSObject, OrielAppExtension, OrielPlatformHooks {
    func callMethod(_ method: String, input: Data, call: OrielCall) throws -> Data {
        do {
            return try JSONSerialization.data(withJSONObject: Vision.request(method, input, call: call))
        } catch let failure as VisionError {
            throw NSError(domain: "failed", code: 1, userInfo: [NSLocalizedDescriptionKey: failure.localizedDescription])
        } catch {
            throw NSError(domain: "failed", code: 1, userInfo: [NSLocalizedDescriptionKey: error.localizedDescription])
        }
    }

    /// Oriel's iOS hook (build.zig `.ios.hooks`, the same instance as the
    /// extension): iOS launched or woke the app for the model download's
    /// background URLSession (BackgroundDownload.swift).
    func handleEvents(forBackgroundURLSession identifier: String, completionHandler: @escaping () -> Void) -> Bool {
        Download.claim(identifier, completionHandler: completionHandler)
    }

    /// Critical memory pressure: drop the matcher and the label vectors
    /// unless a call is using them; the next match loads them again.
    func lifecycle(_ event: String, level: String?) {
        guard event == "memory_pressure", level == "critical" else { return }
        // The main thread never waits behind a long match.
        guard Vision.work.try() else { return }
        defer { Vision.work.unlock() }
        if Vision.engine != nil {
            Vision.release()
            NSLog("pantry.vision: memory pressure: released the matching engine")
        }
    }
}

enum Vision {
    /// Held by every operation but status and cancel.
    static let work = NSLock()
    static var engine: MobileClip.Engine?
    private static var cachedLabels: [String] = []
    private static var cachedVectors: [[Float]] = []
    private static let pendingScans = FeedbackSessions()
    private static let background = ["other food", "non-food objects", "empty shelf"]

    static func request(_ operation: String, _ bytes: Data, call: OrielCall) throws -> [String: Any] {
        guard bytes.count <= 8 * 1024 * 1024 else { throw VisionError.failed("Photo request is too large") }
        let input = bytes.isEmpty ? [:] : (try JSONSerialization.jsonObject(with: bytes) as? [String: Any] ?? [:])
        switch operation {
        case "status": return status()
        case "cancel":
            // Only flips what the download polls: never waits behind a match.
            Download.cancel()
            return status()
        default: break
        }
        guard work.try() else { throw VisionError.failed("Image matching is busy. Wait for the current operation.") }
        defer { work.unlock() }
        switch operation {
        case "download":
            try Download.start()
            return status()
        case "prepare":
            _ = try load(input["backend"] as? String ?? "cpu")
            try probe()
            return status()
        case "detect":
            return try YoloeDetector.detect(input, call: call)
        case "match":
            do { return try match(input, call: call) }
            // Bad labels or photos keep the engine loaded; engine failures drop it.
            catch let failure as VisionError { throw failure }
            catch { release(); throw error }
        case "feedback": return try feedback(input)
        case "clear_feedback":
            for backend in ["cpu", "gpu"] {
                for scope in ["photo", "crop"] {
                    let url = try feedbackFile(backend, scope)
                    if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
                }
            }
            pendingScans.clear()
            return ["count": 0]
        case "release":
            release()
            return status()
        case "delete":
            guard !Download.running else { throw VisionError.failed("Pause the download before deleting the model") }
            release()
            Download.forget()
            try MobileClip.delete()
            for backend in ["cpu", "gpu"] {
                // Not fatal: the cache key includes the model, so a stale file is never reused.
                try? FileManager.default.removeItem(at: labelsFile(backend))
            }
            Download.clearError()
            return status()
        default:
            throw VisionError.failed("Unknown image matching operation")
        }
    }

    static func device() -> String {
        var info = utsname()
        uname(&info)
        let machine = withUnsafeBytes(of: &info.machine) { String(decoding: $0.prefix(while: { $0 != 0 }), as: UTF8.self) }
        let simulator = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"]
        let os = ProcessInfo.processInfo.operatingSystemVersion
        return "\(simulator.map { "\($0) Simulator" } ?? machine) · iOS \(os.majorVersion).\(os.minorVersion)"
    }

    static func status() -> [String: Any] {
        // Every file arrived but the compile didn't run (iOS suspended the
        // app first): finish it now.
        if !MobileClip.installed() && !Download.running { Download.finishIfComplete() }
        let (running, state, error, downloaded) = Download.snapshot()
        let present = MobileClip.installed()
        let loaded = engine
        let current = running ? state : error != nil ? "error" : loaded != nil ? "ready" : present ? "downloaded" : "downloadable"
        let message: String
        switch current {
        case "downloading": message = "Downloading \(MobileClip.label), Apple's image-and-text model. It continues if you leave the app; you can pause and resume."
        case "verifying": message = "Checking the downloaded model's SHA-256 checksums and preparing it."
        case "error": message = error ?? "Model download failed"
        case "ready": message = "Image matching is ready on \(loaded?.backend == "gpu" ? "GPU and Neural Engine" : "CPU")."
        case "downloaded": message = "Model downloaded. Test CPU or GPU support on this device."
        default: message = "Download the \(Int((Double(MobileClip.totalBytes) / 1_000_000).rounded())) MB model once; photo matching then runs offline."
        }
        return ["state": current, "message": message, "supported": true, "device": device(),
                "backend": loaded?.backend ?? "", "loaded": loaded != nil, "model": MobileClip.label,
                "bytes_downloaded": running ? downloaded : present ? MobileClip.totalBytes : downloaded,
                "total_bytes": MobileClip.totalBytes]
    }

    @discardableResult
    static func load(_ backend: String) throws -> Int {
        guard backend == "cpu" || backend == "gpu" else { throw VisionError.failed("Choose CPU or GPU") }
        guard !Download.running else { throw VisionError.failed("Wait for the model download to finish") }
        if let engine, engine.backend == backend { return 0 }
        release()
        let started = DispatchTime.now()
        do { engine = try MobileClip.Engine(backend: backend) }
        catch let failure as VisionError { throw failure }
        catch {
            throw VisionError.failed("\(backend.uppercased()) could not initialize on this device. \(backend == "gpu" ? "Try CPU. " : "")\(error.localizedDescription)")
        }
        return Int(YoloeDetector.elapsed(started))
    }

    private static func probe() throws {
        do {
            guard let engine else { throw VisionError.failed("Download the model before testing") }
            _ = try engine.embed(text: "A photo of an apple")
            let blank = try Images.buffer(width: 32, height: 32, fill: 0.5) { _ in }
            guard let tiny = cgImage(blank) else { throw VisionError.failed("Cannot draw the probe image") }
            _ = try engine.embed(image: tiny)
        } catch { release(); throw error }
    }

    private static func cgImage(_ buffer: CVPixelBuffer) -> CGImage? {
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        return CGContext(data: CVPixelBufferGetBaseAddress(buffer), width: CVPixelBufferGetWidth(buffer), height: CVPixelBufferGetHeight(buffer),
                         bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(buffer), space: CGColorSpaceCreateDeviceRGB(),
                         bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)?.makeImage()
    }

    /// The matcher's identity in caches and correction files.
    private static func configuration(_ backend: String) -> String {
        "\(MobileClip.id)@\(MobileClip.revision)|coreml|\(backend)|\(MobileClip.dimensions)"
    }

    private static func labelsFile(_ backend: String) throws -> URL {
        try MobileClip.folder().appendingPathComponent("labels-\(MobileClip.id)-\(backend).bin")
    }

    private static func feedbackFile(_ backend: String, _ scope: String) throws -> URL {
        try MobileClip.folder().appendingPathComponent("\(scope == "crop" ? "crop-corrections" : "corrections")-\(MobileClip.id)-\(backend).bin")
    }

    private static func prepareLabels(_ labels: [String], call: OrielCall) throws -> String {
        if labels == cachedLabels { return "memory" }
        guard let engine else { throw VisionError.failed("Download the model before testing") }
        let key = EmbeddingCache.key(configuration(engine.backend) + "|caption-v1", labels)
        let file = try labelsFile(engine.backend)
        let restored = EmbeddingCache.read(file, key: key, count: labels.count, dimensions: MobileClip.dimensions)
        let vectors = try restored ?? labels.map { label in
            if call.cancelled { throw VisionError.failed("Cancelled") }
            return try engine.embed(text: "A photo of \(label)")
        }
        cachedLabels = labels
        cachedVectors = vectors
        if restored == nil {
            do { try EmbeddingCache.write(file, key: key, vectors: vectors) }
            catch { NSLog("pantry.vision: label cache could not be saved: \(error.localizedDescription)") }
        }
        return restored == nil ? "computed" : "disk"
    }

    private static func match(_ input: [String: Any], call: OrielCall) throws -> [String: Any] {
        let started = DispatchTime.now()
        guard let raw = input["labels"] as? [String], (2...1024).contains(raw.count) else {
            throw VisionError.failed("Provide 2–1,024 food labels")
        }
        var seen = Set<String>()
        let userLabels = raw.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { seen.insert($0).inserted }
        var labels = userLabels
        for label in background where !labels.contains(label) { labels.append(label) }
        guard userLabels.count >= 2, labels.allSatisfy({ !$0.isEmpty && $0.count <= 120 }) else {
            throw VisionError.failed("Each food label must contain 1–120 characters")
        }
        let photo = try Images.decode(input["image"] as? String ?? "")
        let loadMs = try load(input["backend"] as? String ?? "cpu")
        guard let engine else { throw VisionError.failed("Download the model before testing") }
        let labelsStarted = DispatchTime.now()
        let labelCache = try prepareLabels(labels, call: call)
        let labelsMs = YoloeDetector.elapsed(labelsStarted)
        let imageStarted = DispatchTime.now()
        let imageVector = try engine.embed(image: photo)
        let imageMs = YoloeDetector.elapsed(imageStarted)
        let personalized = input["personalized"] as? Bool ?? false
        let scope = input["feedback_scope"] as? String ?? "photo"
        guard scope == "photo" || scope == "crop" else { throw VisionError.failed("Invalid feedback scope") }
        let config = configuration(engine.backend) + (scope == "crop" ? "|crop-v1" : "")
        var feedbackWarning = ""
        var examples: [EmbeddingFeedback.Example] = []
        if personalized && (input["use_feedback"] as? Bool ?? true) {
            do { examples = try EmbeddingFeedback.read(feedbackFile(engine.backend, scope), configuration: config, dimensions: MobileClip.dimensions) }
            catch { feedbackWarning = error.localizedDescription }
        }
        let backgroundScore = labels.indices.filter { background.contains(labels[$0]) }
            .map { EmbeddingMath.similarity(imageVector, cachedVectors[$0]) }.max() ?? -1
        var candidates = labels.indices.filter { !background.contains(labels[$0]) }.map { (labels[$0], cachedVectors[$0]) }
        let known = Set(labels.map(EmbeddingFeedback.canonical))
        var recalledSeen = Set<String>()
        let recalled = examples.reversed().filter {
            $0.accepted && EmbeddingMath.similarity(imageVector, $0.vector) > EmbeddingFeedback.sameItem
        }.filter { recalledSeen.insert(EmbeddingFeedback.canonical($0.label)).inserted }
            .filter { !known.contains(EmbeddingFeedback.canonical($0.label)) && !background.contains($0.label) }.prefix(16)
        for example in recalled { candidates.append((example.label, try engine.embed(text: "A photo of \(example.label)"))) }
        let limit = min(10, max(1, input["max_matches"] as? Int ?? 5))
        let ranked = candidates.map { label, vector in
            (label: label, score: EmbeddingMath.similarity(imageVector, vector),
             adjustment: EmbeddingFeedback.adjustment(examples, label: label, vector: imageVector))
        }.sorted { $0.score + $0.adjustment > $1.score + $1.adjustment }.prefix(limit)
        let needsReview = ranked.first.map { backgroundScore >= $0.score + $0.adjustment } ?? true
        let scanId = personalized ? UUID().uuidString.lowercased() : ""
        if personalized {
            pendingScans.remember(scanId, .init(vector: imageVector, configuration: config, backend: engine.backend, scope: scope))
        }
        return ["matches": ranked.map { ["label": $0.label, "score": $0.score, "adjustment": $0.adjustment] },
                "device": device(), "backend": engine.backend, "labels_count": userLabels.count,
                "needs_review": needsReview, "background_score": backgroundScore, "scan_id": scanId,
                "correction_count": examples.count, "feedback_warning": feedbackWarning,
                "total_ms": Int(YoloeDetector.elapsed(started)), "load_ms": loadMs, "labels_ms": Int(labelsMs), "image_ms": Int(imageMs),
                "pss_mb": Images.footprintMB(), "dimensions": MobileClip.dimensions, "vision_tokens": 0,
                "labels_cached": labelCache != "computed", "label_cache": labelCache]
    }

    private static func feedback(_ input: [String: Any]) throws -> [String: Any] {
        guard let id = input["scan_id"] as? String, let scan = pendingScans[id] else {
            throw VisionError.failed("Scan this region again before teaching a correction")
        }
        guard let label = input["label"] as? String, let accepted = input["accepted"] as? Bool else {
            throw VisionError.failed("Invalid correction")
        }
        let file = try feedbackFile(scan.backend, scan.scope)
        let examples = try EmbeddingFeedback.read(file, configuration: scan.configuration, dimensions: MobileClip.dimensions)
        let updated = try EmbeddingFeedback.remember(examples, label: label, accepted: accepted, vector: scan.vector)
        try EmbeddingFeedback.write(file, configuration: scan.configuration, examples: updated)
        return ["count": updated.count]
    }

    static func release() {
        engine = nil
        cachedLabels = []
        cachedVectors = []
    }
}
