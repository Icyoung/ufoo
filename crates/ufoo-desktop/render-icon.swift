import CoreGraphics
import Foundation
import ImageIO
import SwiftUI
import UniformTypeIdentifiers

func renderIcon(artwork: CGImage) -> CGImage? {
    let canvasSize = 1024
    guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
          let context = CGContext(data: nil, width: canvasSize, height: canvasSize,
                                  bitsPerComponent: 8, bytesPerRow: 0, space: colorSpace,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }

    // Match the continuous corner contour and inset of Apple's legacy .icns icons.
    let body = CGRect(x: 100, y: 100, width: 824, height: 824)
    let outline = RoundedRectangle(cornerRadius: 184, style: .continuous).path(in: body).cgPath
    context.setFillColor(red: 9 / 255, green: 9 / 255, blue: 15 / 255, alpha: 1)
    context.saveGState()
    context.setShadow(offset: CGSize(width: 0, height: -9), blur: 18,
                      color: CGColor(gray: 0, alpha: 0.24))
    context.addPath(outline)
    context.fillPath()
    context.restoreGState()

    context.addPath(outline)
    context.clip()

    // The browser bitmap has its own small transparent margin. Bleed its dark
    // background under the desktop mask while retaining the original artwork.
    context.interpolationQuality = .high
    context.draw(artwork, in: body.insetBy(dx: -28, dy: -28))

    // Light catches the upper-left rim and leaves a softer reflection at lower right.
    // Clip both passes to the original silhouette so the highlight adds no bulk.
    let reflectionColors = [0.70, 0.52, 0.075, 0.13, 0.26].map { opacity in
        CGColor(srgbRed: 0.86, green: 0.91, blue: 1, alpha: opacity)
    }
    guard let reflection = CGGradient(colorsSpace: colorSpace, colors: reflectionColors as CFArray,
                                      locations: [0, 0.24, 0.58, 0.79, 1]) else { return nil }
    let lightStart = CGPoint(x: body.minX, y: body.maxY)
    let lightEnd = CGPoint(x: body.maxX, y: body.minY)
    for (width, opacity): (CGFloat, CGFloat) in [(22, 0.34), (8, 1)] {
        context.saveGState()
        context.addPath(outline)
        context.setLineWidth(width)
        context.replacePathWithStrokedPath()
        context.clip()
        context.setAlpha(opacity)
        context.drawLinearGradient(reflection, start: lightStart, end: lightEnd, options: [])
        context.restoreGState()
    }
    return context.makeImage()
}

let args = CommandLine.arguments
guard args.count == 3,
      let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: args[1]) as CFURL, nil),
      let artwork = CGImageSourceCreateImageAtIndex(source, 0, nil),
      let icon = renderIcon(artwork: artwork),
      let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: args[2]) as CFURL,
                                                        UTType.png.identifier as CFString, 1, nil) else {
    fputs("Could not render the macOS app icon.\n", stderr)
    exit(1)
}
CGImageDestinationAddImage(destination, icon, nil)
guard CGImageDestinationFinalize(destination) else {
    fputs("Could not write the macOS app icon.\n", stderr)
    exit(1)
}
