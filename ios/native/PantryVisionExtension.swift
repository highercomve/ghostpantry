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
final class PantryVisionExtension: NSObject, OrielAppExtension {
    func callMethod(_ method: String, input: Data, call: OrielCall) throws -> Data {
        do {
            return try JSONSerialization.data(withJSONObject: Vision.request(method, input, call: call))
        } catch let failure as VisionError {
            throw NSError(domain: "failed", code: 1, userInfo: [NSLocalizedDescriptionKey: failure.localizedDescription])
        } catch {
            throw NSError(domain: "failed", code: 1, userInfo: [NSLocalizedDescriptionKey: error.localizedDescription])
        }
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
        let (running, state, error, downloaded) = Download.snapshot()
        let present = MobileClip.installed()
        let loaded = engine
        let current = running ? state : error != nil ? "error" : loaded != nil ? "ready" : present ? "downloaded" : "downloadable"
        let message: String
        switch current {
        case "downloading": message = "Downloading \(MobileClip.label), Apple's image-and-text model. You can pause and resume."
        case "verifying": message = "Checking the downloaded model's SHA-256 checksums and preparing it."
        case "error": message = error ?? "Model download failed"
        case "ready": message = "Image matching is ready on \(loaded?.backend == "gpu" ? "GPU and Neural Engine" : "CPU")."
        case "downloaded": message = "Model downloaded. Test CPU or GPU support on this device."
        default: message = "Download the \(MobileClip.totalBytes / 1_000_000) MB model once; photo matching then runs offline."
        }
        return ["state": current, "message": message, "supported": true, "device": device(),
                "backend": loaded?.backend ?? "", "loaded": loaded != nil, "model": MobileClip.label,
                "bytes_downloaded": running ? downloaded : present ? MobileClip.totalBytes : MobileClip.partBytes(),
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

/// The model download, on its own thread: resumable per file (HTTP Range),
/// paused by "cancel", then verified and compiled (MobileClip).
enum Download {
    private static let lock = NSLock()
    private static var isRunning = false
    private static var state = ""
    private static var error: String?
    private static var bytes: Int64 = 0
    private static var cancelled = false
    private static var task: URLSessionDataTask?

    static var running: Bool { lock.withLock { isRunning } }

    static func snapshot() -> (running: Bool, state: String, error: String?, bytes: Int64) {
        lock.withLock { (isRunning, state.isEmpty ? "downloading" : state, error, bytes) }
    }

    static func clearError() { lock.withLock { error = nil } }

    static func cancel() {
        lock.withLock {
            cancelled = true
            task?.cancel()
        }
    }

    static func start() throws {
        if MobileClip.installed() { clearError(); return }
        let begin: Bool = lock.withLock {
            if isRunning { return false }
            isRunning = true
            cancelled = false
            state = "downloading"
            error = nil
            return true
        }
        guard begin else { return }
        let thread = Thread {
            do { try run() }
            catch {
                lock.withLock { if !cancelled { self.error = error.localizedDescription } }
                NSLog("pantry.vision: model download stopped: \(error.localizedDescription)")
            }
            lock.withLock {
                isRunning = false
                task = nil
            }
        }
        thread.name = "pantry.vision download"
        thread.start()
    }

    private static func run() throws {
        let root = try MobileClip.downloads()
        var done: Int64 = 0
        for file in MobileClip.files {
            let target = root.appendingPathComponent(file.path)
            try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            if (try? FileManager.default.attributesOfItem(atPath: target.path))?[.size] as? Int64 == file.bytes {
                done += file.bytes
                continue
            }
            try fetch(file, to: target, before: done)
            done += file.bytes
        }
        try MobileClip.verifyAndCompile(cancelled: { lock.withLock { cancelled } }, state: { s in lock.withLock { state = s } })
    }

    /// One file into <target>.part from where it stopped, then renamed.
    private static func fetch(_ file: MobileClip.File, to target: URL, before: Int64) throws {
        let part = target.appendingPathExtension("part")
        var offset = ((try? FileManager.default.attributesOfItem(atPath: part.path))?[.size] as? Int64) ?? 0
        if offset > file.bytes { try FileManager.default.removeItem(at: part); offset = 0 }
        if offset < file.bytes {
            if !FileManager.default.fileExists(atPath: part.path) { FileManager.default.createFile(atPath: part.path, contents: nil) }
            let sink = Sink(part: part, offset: offset, limit: file.bytes) { written in lock.withLock { bytes = before + written } }
            var request = URLRequest(url: MobileClip.url(file), timeoutInterval: 30)
            request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
            if offset > 0 { request.setValue("bytes=\(offset)-", forHTTPHeaderField: "Range") }
            let session = URLSession(configuration: .ephemeral, delegate: sink, delegateQueue: nil)
            defer { session.invalidateAndCancel() }
            let started: Bool = lock.withLock {
                if cancelled { return false }
                task = session.dataTask(with: request)
                task?.resume()
                return true
            }
            guard started else { throw VisionError.failed("Download paused") }
            sink.finished.wait()
            if lock.withLock({ cancelled }) { throw VisionError.failed("Download paused") }
            if let failure = sink.failure { throw failure }
        }
        let size = ((try? FileManager.default.attributesOfItem(atPath: part.path))?[.size] as? Int64) ?? 0
        guard size == file.bytes else { throw VisionError.failed("Incomplete download. Try again to resume.") }
        if FileManager.default.fileExists(atPath: target.path) { try FileManager.default.removeItem(at: target) }
        try FileManager.default.moveItem(at: part, to: target)
    }

    /// Streams the response into the part file; HTTPS only, and a resume must
    /// get exactly the range it asked for.
    private final class Sink: NSObject, URLSessionDataDelegate {
        let finished = DispatchSemaphore(value: 0)
        var failure: Error?
        private let part: URL
        private var offset: Int64
        private let limit: Int64
        private let progress: (Int64) -> Void
        private var handle: FileHandle?

        init(part: URL, offset: Int64, limit: Int64, progress: @escaping (Int64) -> Void) {
            self.part = part
            self.offset = offset
            self.limit = limit
            self.progress = progress
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(request.url?.scheme == "https" ? request : nil)
        }

        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
            guard let http = response as? HTTPURLResponse, http.url?.scheme == "https" else {
                failure = VisionError.failed("Model download must use HTTPS")
                return completionHandler(.cancel)
            }
            do {
                switch http.statusCode {
                case 200:
                    offset = 0
                    try Data().write(to: part)
                case 206:
                    let range = http.value(forHTTPHeaderField: "Content-Range") ?? ""
                    guard range.hasPrefix("bytes \(offset)-"), range.hasSuffix("/\(limit)") else {
                        throw VisionError.failed("Invalid resume range")
                    }
                default:
                    throw VisionError.failed("Download failed (HTTP \(http.statusCode)). Try again.")
                }
                handle = try FileHandle(forWritingTo: part)
                try handle?.seek(toOffset: UInt64(offset))
                completionHandler(.allow)
            } catch {
                failure = error
                completionHandler(.cancel)
            }
        }

        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
            guard failure == nil else { return }
            do {
                guard offset + Int64(data.count) <= limit else { throw VisionError.failed("Downloaded model exceeds its expected size") }
                try handle?.write(contentsOf: data)
                offset += Int64(data.count)
                progress(offset)
            } catch {
                failure = error
                dataTask.cancel()
            }
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            try? handle?.synchronize()
            try? handle?.close()
            if failure == nil, let error, (error as NSError).code != NSURLErrorCancelled { failure = error }
            finished.signal()
        }
    }
}
