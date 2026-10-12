// pantry.vision on Apple: Apple's MobileCLIP-S2 (apple/coreml-mobileclip,
// apple-ascl licence) as the image-and-text matcher, in place of Android's
// EmbeddingGemma 2. Downloaded once from Hugging Face at a pinned revision,
// each file checked by size and SHA-256, compiled on the device, then kept
// in Application Support.

import CoreGraphics
import CoreML
import CryptoKit
import Foundation

enum MobileClip {
    /// In every cache and correction file name and key: vectors of other
    /// models never mix with these.
    static let id = "mobileclip-s2"
    static let label = "MobileCLIP-S2"
    static let revision = "3e0a7bfb9fe83da8a3efaa3fd8f7df24214bb947"
    static let dimensions = 512
    private static let imageSide = 256

    struct File {
        let path: String
        let bytes: Int64
        let sha256: String
    }
    static let files: [File] = [
        File(path: "mobileclip_s2_image.mlpackage/Manifest.json", bytes: 617, sha256: "6a1a3f93b8dca6c237dbb5dc7b19bb3c987042d14860288304986c099d8796b6"),
        File(path: "mobileclip_s2_image.mlpackage/Data/com.apple.CoreML/model.mlmodel", bytes: 299_056, sha256: "2aeb3359f6cde65e9f9248ec2a742e9939bd4bbf48c2f55fcd255b4504d96a1b"),
        File(path: "mobileclip_s2_image.mlpackage/Data/com.apple.CoreML/weights/weight.bin", bytes: 71_397_632, sha256: "6cbc7fb06b6072c1cae9c4496d67e0e6217adbf726dfeb82e44d4efe87c34c00"),
        File(path: "mobileclip_s2_text.mlpackage/Manifest.json", bytes: 617, sha256: "ea6a189d82fee2ee36eadb99022cda66a7f6b50a4bf9cc1d9541c7ea3b4242a0"),
        File(path: "mobileclip_s2_text.mlpackage/Data/com.apple.CoreML/model.mlmodel", bytes: 128_127, sha256: "b8651b6d030bae419a9548b41c8fae11f96b59cfa21b6e532a4c4434522b4b80"),
        File(path: "mobileclip_s2_text.mlpackage/Data/com.apple.CoreML/weights/weight.bin", bytes: 126_866_880, sha256: "8e8d5454f104b6cbb58d98bf11e038ff1f1943599efea111260a832f094cd0ce"),
    ]
    static let totalBytes = files.reduce(0) { $0 + $1.bytes }

    static func url(_ file: File) -> URL {
        URL(string: "https://huggingface.co/apple/coreml-mobileclip/resolve/\(revision)/\(file.path)")!
    }

    // MARK: Files

    static func folder() throws -> URL {
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        var url = base.appendingPathComponent("pantry-vision", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        // Downloadable again: keep it out of device backups.
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
        return url
    }
    static func downloads() throws -> URL { try folder().appendingPathComponent("\(id)-download", isDirectory: true) }
    static func compiled(_ part: String) throws -> URL { try folder().appendingPathComponent("\(id)-\(part).mlmodelc", isDirectory: true) }
    /// Written last: the compiled models are complete and verified.
    static func readyMarker() throws -> URL { try folder().appendingPathComponent("\(id).ready") }

    static func installed() -> Bool {
        guard let marker = try? readyMarker(), let text = try? String(contentsOf: marker, encoding: .utf8) else { return false }
        return text == revision
    }

    static func partBytes() -> Int64 {
        guard let root = try? downloads() else { return 0 }
        return files.reduce(0) { total, file in
            let done = root.appendingPathComponent(file.path)
            let part = done.appendingPathExtension("part")
            let size = { (u: URL) in ((try? FileManager.default.attributesOfItem(atPath: u.path))?[.size] as? Int64) ?? 0 }
            return total + max(size(done), size(part))
        }
    }

    static func delete() throws {
        for url in [try downloads(), try compiled("image"), try compiled("text"), try readyMarker()]
        where FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.removeItem(at: url)
        }
    }

    static func sha256(_ url: URL, cancelled: () -> Bool) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hash = SHA256()
        while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty {
            if cancelled() { throw VisionError.failed("Download paused") }
            hash.update(data: chunk)
        }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }

    /// Checked downloads → compiled models → the ready marker; the packages
    /// are removed once compiled.
    static func verifyAndCompile(cancelled: () -> Bool, state: (String) -> Void) throws {
        let root = try downloads()
        state("verifying")
        for file in files {
            let url = root.appendingPathComponent(file.path)
            guard try sha256(url, cancelled: cancelled) == file.sha256 else {
                try? FileManager.default.removeItem(at: url)
                throw VisionError.failed("Model checksum failed. Download it again.")
            }
        }
        for part in ["image", "text"] {
            let package = root.appendingPathComponent("mobileclip_s2_\(part).mlpackage")
            let built = try MLModel.compileModel(at: package)
            let target = try compiled(part)
            if FileManager.default.fileExists(atPath: target.path) { try FileManager.default.removeItem(at: target) }
            try FileManager.default.moveItem(at: built, to: target)
        }
        try revision.write(to: readyMarker(), atomically: true, encoding: .utf8)
        try? FileManager.default.removeItem(at: root)
    }

    // MARK: The engine

    final class Engine {
        let backend: String
        private let image: MLModel
        private let text: MLModel
        private let tokenizer: ClipTokenizer

        init(backend: String) throws {
            guard installed() else { throw VisionError.failed("Download the model before testing") }
            guard let merges = Bundle.main.url(forResource: "clip_merges", withExtension: "txt", subdirectory: "clip") else {
                throw VisionError.failed("The CLIP vocabulary isn't in this build")
            }
            let configuration = MLModelConfiguration()
            // "cpu" as on Android; "gpu" lets CoreML use the GPU and the Neural Engine.
            configuration.computeUnits = backend == "gpu" ? .all : .cpuOnly
            image = try MLModel(contentsOf: compiled("image"), configuration: configuration)
            text = try MLModel(contentsOf: compiled("text"), configuration: configuration)
            tokenizer = try ClipTokenizer(mergesURL: merges)
            self.backend = backend
        }

        func embed(text caption: String) throws -> [Float] {
            let tokens = tokenizer.encode(caption)
            let array = try MLMultiArray(shape: [1, NSNumber(value: ClipTokenizer.contextLength)], dataType: .int32)
            for (i, token) in tokens.enumerated() { array[i] = NSNumber(value: token) }
            return try output(text.prediction(from: MLDictionaryFeatureProvider(dictionary: ["text": MLFeatureValue(multiArray: array)])))
        }

        /// CLIP's preprocessing: the shorter side scaled to 256, centre crop.
        func embed(image photo: CGImage) throws -> [Float] {
            let side = MobileClip.imageSide
            let scale = CGFloat(side) / CGFloat(min(photo.width, photo.height))
            let w = CGFloat(photo.width) * scale, h = CGFloat(photo.height) * scale
            let buffer = try Images.buffer(width: side, height: side, fill: nil) { context in
                context.draw(photo, in: CGRect(x: (CGFloat(side) - w) / 2, y: (CGFloat(side) - h) / 2, width: w, height: h))
            }
            return try output(image.prediction(from: MLDictionaryFeatureProvider(dictionary: ["image": MLFeatureValue(pixelBuffer: buffer)])))
        }

        private func output(_ result: MLFeatureProvider) throws -> [Float] {
            guard let array = result.featureValue(for: "final_emb_1")?.multiArrayValue, array.count == MobileClip.dimensions else {
                throw VisionError.failed("MobileCLIP returned no embedding")
            }
            return try EmbeddingMath.normalize((0..<array.count).map { array[$0].floatValue }, dimensions: MobileClip.dimensions)
        }
    }
}
