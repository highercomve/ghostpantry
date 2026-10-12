// pantry.vision on Apple: the two-phase YOLOE package and produce detector,
// as android/native/YoloePackage{Detector,Math}.kt, on the CoreML exports
// (scripts/export_yoloe_coreml.py) bundled as yoloe-coreml/ (build.zig).
// Each tile is letterboxed into the models' fixed 640x640 input.

import CoreGraphics
import CoreML
import CoreVideo
import CryptoKit
import Foundation
import ImageIO

enum Images {
    /// A data URL's photo, at most 1600 pixels a side.
    static func decode(_ dataURL: String) throws -> CGImage {
        guard dataURL.hasPrefix("data:image/"), let comma = dataURL.range(of: ";base64,") else {
            throw VisionError.failed("Invalid photo")
        }
        guard let bytes = Data(base64Encoded: String(dataURL[comma.upperBound...]), options: .ignoreUnknownCharacters),
              let source = CGImageSourceCreateWithData(bytes as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
        else { throw VisionError.failed("Cannot decode photo") }
        guard (1...1600).contains(image.width), (1...1600).contains(image.height) else {
            throw VisionError.failed("Photo must be at most 1600 pixels per side")
        }
        return image
    }

    /// A BGRA buffer of `width` x `height`, filled with `fill`, then `draw` on it
    /// (CoreGraphics coordinates: origin bottom left).
    static func buffer(width: Int, height: Int, fill: CGFloat?, draw: (CGContext) -> Void) throws -> CVPixelBuffer {
        var made: CVPixelBuffer?
        let attributes = [kCVPixelBufferCGImageCompatibilityKey: true, kCVPixelBufferCGBitmapContextCompatibilityKey: true] as CFDictionary
        guard CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_32BGRA, attributes, &made) == kCVReturnSuccess,
              let buffer = made else { throw VisionError.failed("Cannot allocate an image buffer") }
        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        guard let context = CGContext(data: CVPixelBufferGetBaseAddress(buffer), width: width, height: height,
                                      bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
                                      space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
        else { throw VisionError.failed("Cannot draw the photo") }
        context.interpolationQuality = .high
        if let fill {
            context.setFillColor(red: fill, green: fill, blue: fill, alpha: 1)
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        }
        draw(context)
        return buffer
    }

    /// Physical footprint in MB (the iOS counterpart of Android's PSS).
    static func footprintMB() -> Double {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
        }
        return result == KERN_SUCCESS ? Double(info.phys_footprint) / 1_048_576 : 0
    }
}

enum YoloeMath {
    struct Box {
        let x: Float, y: Float, width: Float, height: Float
        let label: String
        let score: Float
    }
    struct Tile { let x: Int, y: Int, width: Int, height: Int }
    struct Letterbox { let scale: Float, width: Int, height: Int, left: Int, top: Int }

    static let side = 640

    /// The tile scaled to fit the 640x640 input, centred.
    static func letterbox(width: Int, height: Int) -> Letterbox {
        let scale = min(Float(side) / Float(width), Float(side) / Float(height))
        let w = max(1, Int((Float(width) * scale).rounded()))
        let h = max(1, Int((Float(height) * scale).rounded()))
        return Letterbox(scale: scale, width: w, height: h, left: (side - w) / 2, top: (side - h) / 2)
    }

    /// The four overlapping corner tiles, each 65% of the photo a side.
    static func tiles(width: Int, height: Int) -> [Tile] {
        let w = min(width, max(1, Int((Float(width) * 0.65).rounded())))
        let h = min(height, max(1, Int((Float(height) * 0.65).rounded())))
        return [Tile(x: 0, y: 0, width: w, height: h), Tile(x: width - w, y: 0, width: w, height: h),
                Tile(x: 0, y: height - h, width: w, height: h), Tile(x: width - w, y: height - h, width: w, height: h)]
    }

    /// The one-to-many head, (4 + labels + 32, anchors): pixel cxcywh, class
    /// probabilities, mask coefficients. Boxes in photo fractions.
    static func decode(_ output: MLMultiArray, labels: [String], tile: Tile, photoWidth: Int, photoHeight: Int, threshold: Float) throws -> [Box] {
        let shape = output.shape.map(\.intValue)
        guard shape.count == 3, shape[0] == 1, shape[1] == 4 + labels.count + 32, (1...8400).contains(shape[2]),
              output.dataType == .float32 else { throw VisionError.failed("Unexpected YOLOE output") }
        let strides = output.strides.map(\.intValue)
        let values = output.dataPointer.assumingMemoryBound(to: Float.self)
        @inline(__always) func at(_ channel: Int, _ anchor: Int) -> Float { values[channel * strides[1] + anchor * strides[2]] }
        let box = letterbox(width: tile.width, height: tile.height)
        var boxes: [Box] = []
        for anchor in 0..<shape[2] {
            var category = -1
            var score: Float = 0
            for label in labels.indices {
                let value = at(4 + label, anchor)
                if value.isFinite && (category < 0 || value > score) { category = label; score = value }
            }
            guard category >= 0, score >= threshold, score <= 1 else { continue }
            let cx = at(0, anchor), cy = at(1, anchor), w = at(2, anchor), h = at(3, anchor)
            guard w > 0, h > 0, cx.isFinite, cy.isFinite, w.isFinite, h.isFinite else { continue }
            let clampX = { (v: Float) in min(Float(tile.width), max(0, v)) }
            let clampY = { (v: Float) in min(Float(tile.height), max(0, v)) }
            let left = clampX((cx - w / 2 - Float(box.left)) / box.scale)
            let top = clampY((cy - h / 2 - Float(box.top)) / box.scale)
            let right = clampX((cx + w / 2 - Float(box.left)) / box.scale)
            let bottom = clampY((cy + h / 2 - Float(box.top)) / box.scale)
            guard right > left, bottom > top else { continue }
            boxes.append(Box(x: (Float(tile.x) + left) / Float(photoWidth), y: (Float(tile.y) + top) / Float(photoHeight),
                             width: (right - left) / Float(photoWidth), height: (bottom - top) / Float(photoHeight),
                             label: labels[category], score: score))
        }
        return boxes
    }

    static func iou(_ a: Box, _ b: Box) -> Float {
        let intersection = max(0, min(a.x + a.width, b.x + b.width) - max(a.x, b.x)) *
            max(0, min(a.y + a.height, b.y + b.height) - max(a.y, b.y))
        let union = a.width * a.height + b.width * b.height - intersection
        return union > 0 ? intersection / union : 0
    }

    static func suppress(_ boxes: [Box], threshold: Float = 0.3, limit: Int = 12) -> [Box] {
        var result: [Box] = []
        for box in boxes.sorted(by: { $0.score > $1.score }).prefix(512) {
            if result.allSatisfy({ iou(box, $0) < threshold }) { result.append(box) }
            if result.count == limit { break }
        }
        return result
    }

    /// Each phase gets its own proposal budget before cross-phase deduplication.
    static func mergePhases(_ packages: [Box], _ produce: [Box], threshold: Float = 0.3) -> [Box] {
        suppress(suppress(packages, threshold: threshold) + suppress(produce, threshold: threshold), threshold: threshold, limit: 24)
    }
}

enum YoloeDetector {
    private struct Profile: Decodable {
        let name: String
        let prompts: [String]
        let input: String
        let output: String
        let file: String
        let sha256: String
    }
    private struct Contract: Decodable {
        let input_size: Int
        let tile_fraction: Double
        let nms_iou: Double
        let profiles: [Profile]
    }

    private static let names = ["yoloe_packages_whole", "yoloe_packages_tiles", "yoloe_produce"]
    private static var contract: Contract?
    /// Bundles whose checksum matched in this process.
    private static var verified = Set<String>()

    private static func folder() throws -> URL {
        guard let url = Bundle.main.url(forResource: "yoloe-coreml", withExtension: nil) else {
            throw VisionError.failed("The YOLOE detectors aren't in this build")
        }
        return url
    }

    private static func loadContract() throws -> Contract {
        if let contract { return contract }
        let parsed = try JSONDecoder().decode(Contract.self, from: Data(contentsOf: folder().appendingPathComponent("yoloe_coreml.json")))
        guard parsed.input_size == YoloeMath.side, parsed.tile_fraction == 0.65, parsed.profiles.map(\.name) == names else {
            throw VisionError.failed("Unexpected YOLOE detector contract")
        }
        contract = parsed
        return parsed
    }

    /// scripts/export_yoloe_coreml.py's tree_digest: each file's relative
    /// path, size and bytes, in path order.
    static func treeDigest(_ root: URL) throws -> String {
        let root = root.standardizedFileURL.resolvingSymlinksInPath()
        guard let walk = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey]) else {
            throw VisionError.failed("Cannot read a YOLOE detector")
        }
        var files: [(parts: [String], url: URL)] = []
        for case let url as URL in walk where (try? url.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true {
            let parts = Array(url.standardizedFileURL.resolvingSymlinksInPath().pathComponents.dropFirst(root.pathComponents.count))
            files.append((parts, url))
        }
        files.sort { $0.parts.lexicographicallyPrecedes($1.parts) }
        var hash = SHA256()
        for file in files {
            let rel = Data(file.parts.joined(separator: "/").utf8)
            let bytes = try Data(contentsOf: file.url, options: .mappedIfSafe)
            withUnsafeBytes(of: UInt32(rel.count).bigEndian) { hash.update(bufferPointer: $0) }
            hash.update(data: rel)
            withUnsafeBytes(of: UInt64(bytes.count).bigEndian) { hash.update(bufferPointer: $0) }
            hash.update(data: bytes)
        }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private static func model(_ profile: Profile) throws -> MLModel {
        guard profile.file == "\(profile.name).mlmodelc", profile.sha256.count == 64 else {
            throw VisionError.failed("Unsupported YOLOE model: \(profile.file)")
        }
        let url = try folder().appendingPathComponent(profile.file)
        // CoreML parses the bundle natively: check it once per process.
        if !verified.contains(profile.sha256) {
            guard try treeDigest(url) == profile.sha256 else { throw VisionError.failed("The \(profile.name) detector is damaged") }
            verified.insert(profile.sha256)
        }
        let configuration = MLModelConfiguration()
        configuration.computeUnits = .all
        return try MLModel(contentsOf: url, configuration: configuration)
    }

    /// The "detect" method: package passes (whole photo, then corner tiles)
    /// and a produce pass, merged.
    static func detect(_ input: [String: Any], call: OrielCall) throws -> [String: Any] {
        guard (input["detector"] as? String) == "yoloe" else { throw VisionError.failed("Unknown detector") }
        let threshold = Float((input["threshold"] as? Double) ?? 0.25)
        guard threshold.isFinite, (0.1...0.9).contains(threshold) else { throw VisionError.failed("Invalid detector threshold") }
        let photo = try Images.decode(input["image"] as? String ?? "")
        let started = DispatchTime.now()
        let contract = try loadContract()
        var packages: [YoloeMath.Box] = []
        var produce: [YoloeMath.Box] = []
        var loadMs = 0.0, detectMs = 0.0, peak = 0.0
        let whole = [YoloeMath.Tile(x: 0, y: 0, width: photo.width, height: photo.height)]
        let corners = YoloeMath.tiles(width: photo.width, height: photo.height)
        for (index, profile) in contract.profiles.enumerated() {
            let loading = DispatchTime.now()
            // One model at a time, released before the next: keeping all three
            // beside the matcher raises the peak, as on Android.
            let detector = try model(profile)
            loadMs += elapsed(loading)
            let detecting = DispatchTime.now()
            var proposals: [YoloeMath.Box] = []
            for tile in index == 0 ? whole : index == 1 ? corners : whole + corners {
                if call.cancelled { throw VisionError.failed("Cancelled") }
                let box = YoloeMath.letterbox(width: tile.width, height: tile.height)
                let side = YoloeMath.side
                let buffer = try Images.buffer(width: side, height: side, fill: 114.0 / 255) { context in
                    // Scale the tile straight from the photo into the letterbox
                    // (y flipped: CoreGraphics' origin is bottom left).
                    let sx = CGFloat(box.width) / CGFloat(tile.width)
                    let sy = CGFloat(box.height) / CGFloat(tile.height)
                    context.clip(to: CGRect(x: box.left, y: side - box.top - box.height, width: box.width, height: box.height))
                    context.draw(photo, in: CGRect(x: CGFloat(box.left) - CGFloat(tile.x) * sx,
                                                   y: CGFloat(side - box.top - box.height) - CGFloat(photo.height - tile.y - tile.height) * sy,
                                                   width: CGFloat(photo.width) * sx, height: CGFloat(photo.height) * sy))
                }
                let result = try detector.prediction(from: MLDictionaryFeatureProvider(dictionary: [profile.input: MLFeatureValue(pixelBuffer: buffer)]))
                guard let output = result.featureValue(for: profile.output)?.multiArrayValue else {
                    throw VisionError.failed("YOLOE output missing")
                }
                proposals += try YoloeMath.decode(output, labels: profile.prompts, tile: tile, photoWidth: photo.width,
                                                  photoHeight: photo.height, threshold: index == 2 ? max(threshold, 0.15) : threshold)
            }
            if index == 2 { produce += YoloeMath.suppress(proposals, threshold: 0.5) } else { packages += YoloeMath.suppress(proposals, threshold: 0.5) }
            detectMs += elapsed(detecting)
            peak = max(peak, Images.footprintMB())
        }
        let merging = DispatchTime.now()
        let boxes = YoloeMath.mergePhases(packages, produce, threshold: Float(contract.nms_iou))
        detectMs += elapsed(merging)
        return ["boxes": boxes.map { ["x": Double($0.x), "y": Double($0.y), "width": Double($0.width), "height": Double($0.height),
                                      "label": $0.label, "score": Double($0.score)] },
                "detector": "yoloe", "load_ms": Int(loadMs), "detect_ms": Int(detectMs),
                "total_ms": Int(elapsed(started)), "pss_mb": peak]
    }

    static func elapsed(_ since: DispatchTime) -> Double {
        Double(DispatchTime.now().uptimeNanoseconds - since.uptimeNanoseconds) / 1_000_000
    }
}
