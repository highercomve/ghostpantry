// pantry.vision on Apple: the embedding math, the label-vector cache and
// the correction memory, as android/native/Embedding{Math,Cache,Feedback}.kt.
// Files are per model (MobileClip.id is in every name and checksummed key),
// so vectors from different models never mix.

import CryptoKit
import Foundation

enum VisionError: LocalizedError {
    case failed(String)
    var errorDescription: String? {
        switch self { case .failed(let message): return message }
    }
}

enum EmbeddingMath {
    static func normalize(_ vector: [Float], dimensions: Int) throws -> [Float] {
        guard vector.count == dimensions else { throw VisionError.failed("Expected a \(dimensions)-dimensional embedding") }
        guard vector.allSatisfy({ $0.isFinite }) else { throw VisionError.failed("Model returned non-finite embedding values") }
        let length = vector.reduce(0.0) { $0 + Double($1) * Double($1) }.squareRoot()
        guard length > 1e-12 else { throw VisionError.failed("Model returned an empty embedding") }
        return vector.map { Float(Double($0) / length) }
    }

    static func similarity(_ a: [Float], _ b: [Float]) -> Double {
        precondition(a.count == b.count)
        var sum = 0.0
        for i in a.indices { sum += Double(a[i]) * Double(b[i]) }
        return min(1, max(-1, sum))
    }
}

/// Length-prefixed big-endian fields, then a SHA-256 of everything before it.
private struct Writer {
    var data = Data()
    mutating func string(_ s: String) {
        let bytes = Data(s.utf8)
        u32(UInt32(bytes.count))
        data.append(bytes)
    }
    mutating func u32(_ v: UInt32) { withUnsafeBytes(of: v.bigEndian) { data.append(contentsOf: $0) } }
    mutating func float(_ v: Float) { u32(v.bitPattern) }
    mutating func bool(_ v: Bool) { data.append(v ? 1 : 0) }
    func sealed() -> Data { data + Data(SHA256.hash(data: data)) }
}

private struct Reader {
    let data: Data
    var offset: Int
    init?(sealed: Data, maxBytes: Int) {
        guard sealed.count >= 32 + 4, sealed.count <= maxBytes else { return nil }
        let body = sealed.prefix(sealed.count - 32)
        guard Data(SHA256.hash(data: body)) == sealed.suffix(32) else { return nil }
        data = Data(body)
        offset = 0
    }
    var atEnd: Bool { offset == data.count }
    mutating func bytes(_ n: Int) throws -> Data {
        guard n >= 0, offset + n <= data.count else { throw VisionError.failed("Truncated file") }
        defer { offset += n }
        return data.subdata(in: offset..<(offset + n))
    }
    mutating func u32() throws -> UInt32 { try bytes(4).reduce(0) { $0 << 8 | UInt32($1) } }
    mutating func float() throws -> Float { Float(bitPattern: try u32()) }
    mutating func bool() throws -> Bool { try bytes(1)[0] != 0 }
    mutating func string(max: Int) throws -> String {
        let n = Int(try u32())
        guard n <= max, let s = String(data: try bytes(n), encoding: .utf8) else { throw VisionError.failed("Bad string") }
        return s
    }
}

/// Written beside the target and renamed over it (Data's atomic write).
private func install(_ data: Data, at url: URL) throws {
    try data.write(to: url, options: .atomic)
}

/// One bounded, checksummed label vocabulary per model and compute units;
/// any mismatch is a miss.
enum EmbeddingCache {
    private static let maxBytes = 4 * 1024 * 1024

    static func key(_ configuration: String, _ labels: [String]) -> Data {
        var w = Writer()
        w.string(configuration)
        labels.forEach { w.string($0) }
        return Data(SHA256.hash(data: w.data))
    }

    static func read(_ url: URL, key: Data, count: Int, dimensions: Int) -> [[Float]]? {
        guard (2...1027).contains(count), let sealed = try? Data(contentsOf: url),
              var r = Reader(sealed: sealed, maxBytes: maxBytes) else { return nil }
        do {
            guard try r.bytes(32) == key, Int(try r.u32()) == count else { return nil }
            let vectors = try (0..<count).map { _ in
                try EmbeddingMath.normalize((0..<dimensions).map { _ in try r.float() }, dimensions: dimensions)
            }
            return r.atEnd ? vectors : nil
        } catch { return nil }
    }

    static func write(_ url: URL, key: Data, vectors: [[Float]]) throws {
        var w = Writer()
        w.data.append(key)
        w.u32(UInt32(vectors.count))
        for vector in vectors { vector.forEach { w.float($0) } }
        let sealed = w.sealed()
        guard sealed.count <= maxBytes else { throw VisionError.failed("Too many labels to cache") }
        try install(sealed, at: url)
    }
}

/// Bounded local examples of accepted and rejected labels: no photos, no
/// model updates. The thresholds are cosine similarities between photo
/// vectors (EmbeddingFeedback.kt), so they need checking per model.
enum EmbeddingFeedback {
    static let maxExamples = 128
    private static let maxBytes = 400_000
    /// Photos at least this similar count as the same item.
    static let sameItem = 0.94
    /// The most a correction moves a label's score, up or down.
    static let weight = 0.12

    struct Example {
        let label: String
        let accepted: Bool
        let vector: [Float]
    }

    static func canonical(_ label: String) -> String {
        label.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    static func validate(_ label: String) throws {
        let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, label.count <= 120, !label.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
            throw VisionError.failed("Use a food label of 1–120 characters")
        }
    }

    static func read(_ url: URL, configuration: String, dimensions: Int) throws -> [Example] {
        guard FileManager.default.fileExists(atPath: url.path) else { return [] }
        let damaged = VisionError.failed("Correction memory is damaged. Clear it to start again.")
        guard let sealed = try? Data(contentsOf: url), var r = Reader(sealed: sealed, maxBytes: maxBytes) else { throw damaged }
        do {
            if try r.string(max: 512) != configuration { return [] }
            let count = Int(try r.u32())
            guard count <= maxExamples else { throw damaged }
            let examples = try (0..<count).map { _ -> Example in
                let label = try r.string(max: 480)
                try validate(label)
                let accepted = try r.bool()
                let vector = try EmbeddingMath.normalize((0..<dimensions).map { _ in try r.float() }, dimensions: dimensions)
                return Example(label: label, accepted: accepted, vector: vector)
            }
            guard r.atEnd else { throw damaged }
            return examples
        } catch { throw damaged }
    }

    static func remember(_ examples: [Example], label: String, accepted: Bool, vector: [Float]) throws -> [Example] {
        try validate(label)
        let normalized = try EmbeddingMath.normalize(vector, dimensions: vector.count)
        // A newer decision replaces the same label on effectively the same photo.
        let kept = examples.filter { !(canonical($0.label) == canonical(label) && EmbeddingMath.similarity($0.vector, normalized) >= 0.995) }
        let updated = kept + [Example(label: label.trimmingCharacters(in: .whitespacesAndNewlines), accepted: accepted, vector: normalized)]
        return Array(updated.suffix(maxExamples))
    }

    static func adjustment(_ examples: [Example], label: String, vector: [Float]) -> Double {
        var closest = sameItem
        var adjustment = 0.0
        // Newest wins a tie; feedback never affects dissimilar photos.
        for example in examples.reversed() where canonical(example.label) == canonical(label) {
            let similarity = EmbeddingMath.similarity(vector, example.vector)
            if similarity <= closest { continue }
            closest = similarity
            adjustment = min(1, max(0, (similarity - sameItem) / (1 - sameItem))) * (example.accepted ? weight : -weight)
        }
        return adjustment
    }

    static func write(_ url: URL, configuration: String, examples: [Example]) throws {
        precondition(examples.count <= maxExamples)
        var w = Writer()
        w.string(configuration)
        w.u32(UInt32(examples.count))
        for example in examples {
            try validate(example.label)
            w.string(example.label)
            w.bool(example.accepted)
            example.vector.forEach { w.float($0) }
        }
        let sealed = w.sealed()
        guard sealed.count <= maxBytes else { throw VisionError.failed("Cannot save correction memory") }
        try install(sealed, at: url)
    }
}

/// Recent scans, so feedback on an earlier crop can't teach the last one.
final class FeedbackSessions {
    struct Crop {
        let vector: [Float]
        let configuration: String
        let backend: String
        let scope: String
    }
    private var scans: [(id: String, crop: Crop)] = []

    func remember(_ id: String, _ crop: Crop) {
        scans.append((id, crop))
        if scans.count > 64 { scans.removeFirst(scans.count - 64) }
    }
    subscript(id: String) -> Crop? { scans.last(where: { $0.id == id })?.crop }
    func clear() { scans.removeAll() }
}
