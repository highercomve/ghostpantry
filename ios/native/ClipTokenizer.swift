// CLIP's byte-pair tokenizer (OpenAI CLIP's simple_tokenizer.py), for
// MobileCLIP's text encoder: lowercased text, CLIP's word pattern, BPE over
// bytes mapped to printable characters, <start> ... <end> padded to 77.
// The merges are resources/clip/clip_merges.txt (the first 48,894 merges of
// OpenAI's bpe_simple_vocab_16e6.txt, MIT; see resources/clip/LICENSE).

import Foundation

final class ClipTokenizer {
    static let contextLength = 77

    private let encoder: [String: Int32]
    private let ranks: [Pair: Int]
    private let byteCharacters: [Character]
    private let pattern: NSRegularExpression
    private var cache: [String: [Int32]] = [:]
    private let sot: Int32
    private let eot: Int32

    private struct Pair: Hashable {
        let first: String
        let second: String
    }

    init(mergesURL: URL) throws {
        let text = try String(contentsOf: mergesURL, encoding: .utf8)
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        // Line 0 is the version header; then exactly the merges CLIP uses.
        guard lines.count >= 48895, lines[0].hasPrefix("\"bpe_simple_vocab_16e6.txt#version") else {
            throw VisionError.failed("The CLIP vocabulary is damaged")
        }
        let merges: [Pair] = try lines[1...48894].map { line in
            let parts = line.split(separator: " ")
            guard parts.count == 2 else { throw VisionError.failed("The CLIP vocabulary is damaged") }
            return Pair(first: String(parts[0]), second: String(parts[1]))
        }
        let (byteCharacters, ordered) = ClipTokenizer.bytesToUnicode()
        self.byteCharacters = byteCharacters
        // The vocabulary lists the byte characters in the table's own order
        // (printable bytes first), not by byte value.
        var vocab = ordered.map { String($0) }
        vocab += ordered.map { "\($0)</w>" }
        vocab += merges.map { $0.first + $0.second }
        vocab += ["<|startoftext|>", "<|endoftext|>"]
        var encoder: [String: Int32] = [:]
        encoder.reserveCapacity(vocab.count)
        for (index, token) in vocab.enumerated() { encoder[token] = Int32(index) }
        self.encoder = encoder
        var ranks: [Pair: Int] = [:]
        ranks.reserveCapacity(merges.count)
        for (index, pair) in merges.enumerated() { ranks[pair] = index }
        self.ranks = ranks
        sot = encoder["<|startoftext|>"]!
        eot = encoder["<|endoftext|>"]!
        pattern = try NSRegularExpression(
            pattern: #"<\|startoftext\|>|<\|endoftext\|>|'s|'t|'re|'ve|'m|'ll|'d|[\p{L}]+|[\p{N}]|[^\s\p{L}\p{N}]+"#,
            options: [.caseInsensitive])
    }

    /// 77 token ids: <start>, the text's tokens (truncated, keeping <end>), zeros.
    func encode(_ text: String) -> [Int32] {
        // CLIP runs ftfy first; of what it fixes, food labels mostly meet
        // curly quotes (ftfy straightens them), so do that much.
        let straight = text.replacingOccurrences(of: "[‘’‚‛]", with: "'", options: .regularExpression)
            .replacingOccurrences(of: "[“”„‟]", with: "\"", options: .regularExpression)
        let clean = straight.split(whereSeparator: \.isWhitespace).joined(separator: " ").lowercased()
        var tokens: [Int32] = [sot]
        let range = NSRange(clean.startIndex..., in: clean)
        for match in pattern.matches(in: clean, range: range) {
            guard let r = Range(match.range, in: clean) else { continue }
            let word = String(String(clean[r]).utf8.map { byteCharacters[Int($0)] })
            tokens += bpe(word)
        }
        if tokens.count > ClipTokenizer.contextLength - 1 { tokens = Array(tokens.prefix(ClipTokenizer.contextLength - 1)) }
        tokens.append(eot)
        return tokens + Array(repeating: 0, count: ClipTokenizer.contextLength - tokens.count)
    }

    private func bpe(_ token: String) -> [Int32] {
        if let hit = cache[token] { return hit }
        var word = token.map { String($0) }
        word[word.count - 1] += "</w>"
        while word.count > 1 {
            var best: (rank: Int, index: Int)? = nil
            for i in 0..<(word.count - 1) {
                if let rank = ranks[Pair(first: word[i], second: word[i + 1])], rank < (best?.rank ?? Int.max) {
                    best = (rank, i)
                }
            }
            guard let chosen = best else { break }
            let first = word[chosen.index], second = word[chosen.index + 1]
            // Merge every occurrence of the pair, left to right, as CLIP does.
            var merged: [String] = []
            var i = 0
            while i < word.count {
                if i < word.count - 1 && word[i] == first && word[i + 1] == second {
                    merged.append(first + second)
                    i += 2
                } else {
                    merged.append(word[i])
                    i += 1
                }
            }
            word = merged
        }
        let ids = word.compactMap { encoder[$0] }
        if cache.count < 4096 { cache[token] = ids }
        return ids
    }

    /// CLIP's reversible byte → printable character table: indexed by byte,
    /// and in the table's order (the order the vocabulary starts with).
    private static func bytesToUnicode() -> (byByte: [Character], ordered: [Character]) {
        var bytes = Array(33...126) + Array(161...172) + Array(174...255)
        var chars = bytes
        var extra = 0
        for b in 0..<256 where !bytes.contains(b) {
            bytes.append(b)
            chars.append(256 + extra)
            extra += 1
        }
        let ordered = chars.map { Character(Unicode.Scalar(UInt32($0))!) }
        var table = [Character](repeating: " ", count: 256)
        for (b, c) in zip(bytes, ordered) { table[b] = c }
        return (table, ordered)
    }
}
