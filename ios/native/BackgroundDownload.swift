// pantry.vision on Apple: the MobileCLIP download as a background URLSession,
// so it keeps going while the app is in the background, suspended, or ended
// by the system. iOS then relaunches the app for the session's events and
// Oriel offers them to the platform hooks (PantryVisionExtension's
// handleEventsForBackgroundURLSession, oriel_hooks.h).
//
// Every missing file is one download task (the system runs them; the app
// needn't be awake to start the next). Each finished file is checked by
// size and SHA-256 before it is moved into place; the last one compiles the
// models (MobileClip.verifyAndCompile). "cancel" pauses: each task is
// cancelled with resume data, kept beside the file, and "download" resumes
// from it. A user's force quit cancels the tasks too; their resume data
// arrives when the session is recreated on the next launch.
//
// HTTPS only: background sessions follow redirects themselves (the redirect
// delegate method isn't called for them), so the final URL of each response
// is checked instead, and App Transport Security blocks plain HTTP anyway.

import Foundation
import UIKit

enum Download {
    static let identifier = "dev.ghostpantry.app.mobileclip"

    private static let lock = NSLock()
    private static var session: URLSession?
    /// Bytes written per file path, for progress (finished files count whole).
    private static var written: [String: Int64] = [:]
    /// File paths with a task the system is running.
    private static var active: Set<String> = []
    private static var compiling = false
    private static var pausing = false
    private static var error: String?
    /// From the hook: called once the session's events are delivered.
    private static var eventsDone: (() -> Void)?

    private static let delegate = Delegate()

    // MARK: State

    static var running: Bool { lock.withLock { !active.isEmpty || compiling } }

    static func snapshot() -> (running: Bool, state: String, error: String?, bytes: Int64) {
        ensureSession()
        return lock.withLock {
            let bytes = MobileClip.files.reduce(Int64(0)) { $0 + min(written[$1.path] ?? 0, $1.bytes) }
            return (!active.isEmpty || compiling, compiling ? "verifying" : "downloading", error, bytes)
        }
    }

    static func clearError() { lock.withLock { error = nil } }

    /// Downloaded or paused bytes when nothing runs: finished files, plus what
    /// the resume data recorded.
    static func pausedBytes() -> Int64 { snapshot().bytes }

    // MARK: The session

    /// The background session (created once per process: the same identifier
    /// twice would be an error). Creating it delivers whatever happened while
    /// the app wasn't running.
    @discardableResult
    static func ensureSession() -> URLSession {
        lock.lock()
        if let session { lock.unlock(); return session }
        let configuration = URLSessionConfiguration.background(withIdentifier: identifier)
        configuration.sessionSendsLaunchEvents = true
        // A user-started download: not left to the system's discretion.
        configuration.isDiscretionary = false
        configuration.timeoutIntervalForRequest = 60
        // No HTTP cache: a revalidated file comes back as 304 with no body.
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        queue.name = "pantry.vision download"
        let made = URLSession(configuration: configuration, delegate: delegate, delegateQueue: queue)
        session = made
        loadProgress()
        lock.unlock()
        // Tasks still running from an earlier launch.
        made.getAllTasks { tasks in
            lock.withLock {
                for task in tasks where task.state == .running || task.state == .suspended {
                    if let path = task.taskDescription { active.insert(path) }
                }
            }
        }
        return made
    }

    /// Oriel's hook: iOS woke or relaunched the app for this session's events.
    static func claim(_ identifier: String, completionHandler: @escaping () -> Void) -> Bool {
        guard identifier == Download.identifier else { return false }
        lock.withLock { eventsDone = completionHandler }
        NSLog("pantry.vision: claimed background session \(identifier)")
        ensureSession()
        return true
    }

    // MARK: Operations

    static func start() throws {
        if MobileClip.installed() { clearError(); return }
        let session = ensureSession()
        let root = try MobileClip.downloads()
        var missing: [(MobileClip.File, Data?)] = []
        let idle = lock.withLock { active.isEmpty && !compiling }
        guard idle else { return }
        lock.withLock {
            error = nil
            pausing = false
            for file in MobileClip.files where !present(file, root) {
                let resume = try? Data(contentsOf: resumeURL(file, root))
                missing.append((file, resume))
            }
        }
        if missing.isEmpty {
            // Everything arrived while the app was away: only the compile is left.
            finishIfComplete()
            return
        }
        for (file, resume) in missing {
            let task = resume.map { session.downloadTask(withResumeData: $0) } ?? session.downloadTask(with: request(file))
            task.taskDescription = file.path
            task.countOfBytesClientExpectsToReceive = file.bytes
            _ = lock.withLock { active.insert(file.path) }
            try? FileManager.default.removeItem(at: resumeURL(file, root))
            task.resume()
        }
    }

    /// Pause: every task ends with resume data (kept for "download").
    static func cancel() {
        let session = lock.withLock { () -> URLSession? in
            pausing = true
            return self.session
        }
        session?.getAllTasks { tasks in
            for case let task as URLSessionDownloadTask in tasks {
                task.cancel(byProducingResumeData: { _ in })  // the data arrives in didCompleteWithError
            }
        }
    }

    /// Before deleting the model: drop the resume data and the progress.
    static func forget() {
        lock.withLock {
            written = [:]
            error = nil
        }
        if let root = try? MobileClip.downloads() { try? FileManager.default.removeItem(at: root) }
    }

    // MARK: Files

    private static func request(_ file: MobileClip.File) -> URLRequest {
        var request = URLRequest(url: MobileClip.url(file), cachePolicy: .reloadIgnoringLocalAndRemoteCacheData)
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        return request
    }

    private static func present(_ file: MobileClip.File, _ root: URL) -> Bool {
        let size = (try? FileManager.default.attributesOfItem(atPath: root.appendingPathComponent(file.path).path))?[.size] as? Int64
        return size == file.bytes
    }

    private static func resumeURL(_ file: MobileClip.File, _ root: URL) -> URL {
        root.appendingPathComponent(file.path).appendingPathExtension("resume")
    }

    private static func progressURL() throws -> URL { try MobileClip.downloads().appendingPathComponent("progress.json") }

    /// Under the lock.
    private static func loadProgress() {
        guard let url = try? progressURL(), let data = try? Data(contentsOf: url),
              let saved = try? JSONDecoder().decode([String: Int64].self, from: data) else { return }
        written = saved
    }

    private static func saveProgress() {
        guard let url = try? progressURL() else { return }
        let data = lock.withLock { try? JSONEncoder().encode(written) }
        try? data?.write(to: url, options: .atomic)
    }

    // MARK: Events (the delegate queue)

    fileprivate static func progress(_ path: String, _ bytes: Int64) {
        lock.withLock { written[path] = bytes }
    }

    /// The finished file, before the system removes `location`: checked, then
    /// moved into place.
    fileprivate static func finished(_ task: URLSessionDownloadTask, at location: URL) {
        guard let path = task.taskDescription, let file = MobileClip.files.first(where: { $0.path == path }) else { return }
        do {
            guard let http = task.response as? HTTPURLResponse, http.url?.scheme == "https" else {
                throw VisionError.failed("Model download must use HTTPS")
            }
            guard http.statusCode == 200 else { throw VisionError.failed("Download failed (HTTP \(http.statusCode)). Try again.") }
            let size = (try? FileManager.default.attributesOfItem(atPath: location.path))?[.size] as? Int64
            guard size == file.bytes else { throw VisionError.failed("Incomplete download. Try again to resume.") }
            guard try MobileClip.sha256(location, cancelled: { false }) == file.sha256 else {
                throw VisionError.failed("Model checksum failed. Download it again.")
            }
            let target = try MobileClip.downloads().appendingPathComponent(file.path)
            try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            if FileManager.default.fileExists(atPath: target.path) { try FileManager.default.removeItem(at: target) }
            try FileManager.default.moveItem(at: location, to: target)
            lock.withLock { written[path] = file.bytes }
        } catch {
            NSLog("pantry.vision: \(path) rejected: \(error.localizedDescription)")
            lock.withLock {
                written[path] = 0
                if self.error == nil { self.error = error.localizedDescription }
            }
        }
    }

    fileprivate static func completed(_ task: URLSessionTask, error failure: Error?) {
        guard let path = task.taskDescription, let file = MobileClip.files.first(where: { $0.path == path }) else { return }
        if let failure = failure as NSError? {
            // Paused, force quit, lost network...: keep where it got to.
            if let resume = failure.userInfo[NSURLSessionDownloadTaskResumeData] as? Data, let root = try? MobileClip.downloads() {
                try? FileManager.default.createDirectory(at: resumeURL(file, root).deletingLastPathComponent(), withIntermediateDirectories: true)
                try? resume.write(to: resumeURL(file, root), options: .atomic)
            } else {
                lock.withLock { written[path] = 0 }
            }
            lock.withLock {
                let paused = pausing || failure.code == NSURLErrorCancelled
                if !paused && error == nil { error = failure.localizedDescription }
            }
            NSLog("pantry.vision: download of \(path) stopped: \(failure.localizedDescription)")
        }
        let last = lock.withLock { () -> Bool in
            active.remove(path)
            return active.isEmpty
        }
        saveProgress()
        if last { finishIfComplete() }
    }

    /// Every file present: compile (once), then the model is installed. The
    /// files often arrive while the app is in the background, and iOS
    /// suspends it right after: a background task asks for the time the
    /// compile needs. Should iOS still stop it, the next status or download
    /// finds every file present and compiles then.
    static func finishIfComplete() {
        guard let root = try? MobileClip.downloads(), MobileClip.files.allSatisfy({ present($0, root) }) else { return }
        let begin = lock.withLock { () -> Bool in
            if compiling || error != nil { return false }
            compiling = true
            return true
        }
        guard begin else { return }
        let task = BackgroundTime.begin("pantry.vision compile")
        defer { BackgroundTime.end(task) }
        do { try MobileClip.verifyAndCompile(cancelled: { false }, state: { _ in }) }
        catch { lock.withLock { self.error = error.localizedDescription } }
        lock.withLock {
            compiling = false
            written = [:]
        }
        NSLog("pantry.vision: model download finished\(MobileClip.installed() ? "" : " but did not install")")
    }

    fileprivate static func eventsFinished() {
        let handler = lock.withLock { () -> (() -> Void)? in
            defer { eventsDone = nil }
            return eventsDone
        }
        if let handler { DispatchQueue.main.async(execute: handler) }
    }

    private final class Delegate: NSObject, URLSessionDownloadDelegate {
        func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
            Download.finished(downloadTask, at: location)
        }

        func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
                        totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
            if let path = downloadTask.taskDescription { Download.progress(path, totalBytesWritten) }
        }

        func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didResumeAtOffset fileOffset: Int64,
                        expectedTotalBytes: Int64) {
            if let path = downloadTask.taskDescription { Download.progress(path, fileOffset) }
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            Download.completed(task, error: error)
        }

        func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
            Download.eventsFinished()
        }
    }
}

/// UIApplication's background tasks, from any thread (begin and end run on
/// the main thread, as UIKit asks).
private enum BackgroundTime {
    /// Out of time, iOS would end the app if the task were still open: end
    /// it (the compile resumes on the next status).
    static func begin(_ name: String) -> UIBackgroundTaskIdentifier {
        let work = { () -> UIBackgroundTaskIdentifier in
            var task = UIBackgroundTaskIdentifier.invalid
            task = UIApplication.shared.beginBackgroundTask(withName: name) {
                UIApplication.shared.endBackgroundTask(task)
                task = .invalid
            }
            return task
        }
        return Thread.isMainThread ? work() : DispatchQueue.main.sync(execute: work)
    }

    static func end(_ task: UIBackgroundTaskIdentifier) {
        guard task != .invalid else { return }
        DispatchQueue.main.async { UIApplication.shared.endBackgroundTask(task) }
    }
}
