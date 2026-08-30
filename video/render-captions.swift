import AppKit
import Foundation

struct Cue {
  let index: Int
  let start: Double
  let end: Double
  let text: String
}

enum CaptionError: Error, CustomStringConvertible {
  case usage
  case invalidCue(String)
  case cannotCreateBitmap

  var description: String {
    switch self {
    case .usage:
      return "usage: render-captions.swift <subtitles.srt> <output-directory> <duration>"
    case let .invalidCue(value):
      return "invalid SRT cue: \(value)"
    case .cannotCreateBitmap:
      return "cannot create caption bitmap"
    }
  }
}

func seconds(from timestamp: String) throws -> Double {
  let parts = timestamp
    .replacingOccurrences(of: ",", with: ".")
    .split(separator: ":")
  guard parts.count == 3,
        let hours = Double(parts[0]),
        let minutes = Double(parts[1]),
        let seconds = Double(parts[2]) else {
    throw CaptionError.invalidCue(timestamp)
  }
  return hours * 3_600 + minutes * 60 + seconds
}

func parseSRT(_ contents: String) throws -> [Cue] {
  let normalized = contents.replacingOccurrences(of: "\r\n", with: "\n")
  return try normalized
    .components(separatedBy: "\n\n")
    .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    .map { block in
      let lines = block
        .split(separator: "\n", omittingEmptySubsequences: false)
        .map(String.init)
      guard lines.count >= 3,
            let index = Int(lines[0].trimmingCharacters(in: .whitespaces)),
            lines[1].contains(" --> ") else {
        throw CaptionError.invalidCue(block)
      }
      let range = lines[1].components(separatedBy: " --> ")
      guard range.count == 2 else {
        throw CaptionError.invalidCue(lines[1])
      }
      return Cue(
        index: index,
        start: try seconds(from: range[0]),
        end: try seconds(from: range[1]),
        text: lines.dropFirst(2).joined(separator: " ")
      )
    }
}

func fittedText(_ value: String, startingAt fontSize: CGFloat, maxWidth: CGFloat) -> NSAttributedString {
  var size = fontSize
  while size >= 20 {
    let font = NSFont.systemFont(ofSize: size, weight: .medium)
    let attributed = NSAttributedString(
      string: value,
      attributes: [
        .font: font,
        .foregroundColor: NSColor.white,
      ]
    )
    if attributed.size().width <= maxWidth {
      return attributed
    }
    size -= 1
  }
  throwFatal("caption is too wide: \(value)")
}

func throwFatal(_ message: String) -> Never {
  FileHandle.standardError.write(Data("\(message)\n".utf8))
  exit(1)
}

func writePNG(text: String, destination: URL, placement: String) throws {
  let isLabel = placement == "label"
  let width = isLabel ? 300 : 1_920
  let height = isLabel ? 70 : 168
  guard let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: width,
    pixelsHigh: height,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
  ), let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
    throw CaptionError.cannotCreateBitmap
  }

  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = context
  context.imageInterpolation = .high
  (isLabel ? NSColor.clear : NSColor.black).setFill()
  NSRect(x: 0, y: 0, width: width, height: height).fill()

  if text.isEmpty {
    NSGraphicsContext.restoreGraphicsState()
    guard let data = bitmap.representation(using: .png, properties: [:]) else {
      throw CaptionError.cannotCreateBitmap
    }
    try data.write(to: destination)
    return
  }

  let attributed = fittedText(
    text,
    startingAt: isLabel ? 28 : 46,
    maxWidth: isLabel ? 250 : 1_740
  )
  let textSize = attributed.size()
  let textPoint: NSPoint
  if isLabel {
    textPoint = NSPoint(x: (CGFloat(width) - textSize.width) / 2, y: 18)
  } else {
    textPoint = NSPoint(x: (CGFloat(width) - textSize.width) / 2, y: 55)
  }

  if isLabel {
    let background = NSRect(
      x: textPoint.x - 18,
      y: textPoint.y - 10,
      width: textSize.width + 36,
      height: textSize.height + 20
    )
    NSColor(calibratedWhite: 0, alpha: 0.72).setFill()
    NSBezierPath(roundedRect: background, xRadius: 10, yRadius: 10).fill()
  }
  attributed.draw(at: textPoint)

  NSGraphicsContext.restoreGraphicsState()
  guard let data = bitmap.representation(using: .png, properties: [:]) else {
    throw CaptionError.cannotCreateBitmap
  }
  try data.write(to: destination)
}

do {
  guard CommandLine.arguments.count == 4,
        let totalDuration = Double(CommandLine.arguments[3]),
        totalDuration > 0 else {
    throw CaptionError.usage
  }
  let source = URL(fileURLWithPath: CommandLine.arguments[1])
  let outputDirectory = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
  try FileManager.default.createDirectory(
    at: outputDirectory,
    withIntermediateDirectories: true
  )

  let cues = try parseSRT(String(contentsOf: source, encoding: .utf8))
  let blank = outputDirectory.appendingPathComponent("blank.png")
  try writePNG(text: "", destination: blank, placement: "caption")

  var timeline = "ffconcat version 1.0\n"
  var cursor = 0.0
  var lastPath = blank.path
  for cue in cues {
    guard cue.start >= cursor, cue.end > cue.start else {
      throw CaptionError.invalidCue("cue \(cue.index) overlaps or has no duration")
    }
    let filename = String(format: "caption-%02d.png", cue.index)
    let destination = outputDirectory.appendingPathComponent(filename)
    try writePNG(text: cue.text, destination: destination, placement: "caption")
    if cue.start > cursor {
      timeline += "file '\(blank.path)'\n"
      timeline += String(format: "duration %.3f\n", cue.start - cursor)
    }
    timeline += "file '\(destination.path)'\n"
    timeline += String(format: "duration %.3f\n", cue.end - cue.start)
    cursor = cue.end
    lastPath = destination.path
  }
  guard cursor <= totalDuration else {
    throw CaptionError.invalidCue("last cue exceeds video duration")
  }
  if cursor < totalDuration {
    timeline += "file '\(blank.path)'\n"
    timeline += String(format: "duration %.3f\n", totalDuration - cursor)
    lastPath = blank.path
  }
  // concat demuxer 需要重复最后一帧，才能保留上一行声明的 duration。
  timeline += "file '\(lastPath)'\n"
  try timeline.write(
    to: outputDirectory.appendingPathComponent("caption-timeline.ffconcat"),
    atomically: true,
    encoding: .utf8
  )
} catch {
  throwFatal(String(describing: error))
}
