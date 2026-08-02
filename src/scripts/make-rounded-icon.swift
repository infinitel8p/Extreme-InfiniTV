// Masks a full-bleed 1024 icon into the Apple template (824x824 rounded rect,
// radius 185). Run: swift ./src/scripts/make-rounded-icon.swift <in.png> <out.png>

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let arguments = CommandLine.arguments
guard arguments.count == 3 else {
    FileHandle.standardError.write("usage: make-rounded-icon.swift <in.png> <out.png>\n".data(using: .utf8)!)
    exit(2)
}

let inputUrl = URL(fileURLWithPath: arguments[1])
let outputUrl = URL(fileURLWithPath: arguments[2])

guard
    let source = CGImageSourceCreateWithURL(inputUrl as CFURL, nil),
    let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
else {
    FileHandle.standardError.write("could not read \(inputUrl.path)\n".data(using: .utf8)!)
    exit(1)
}

let canvas: CGFloat = 1024
let body: CGFloat = 824
let radius: CGFloat = 185
let inset = (canvas - body) / 2

guard
    let context = CGContext(
        data: nil,
        width: Int(canvas),
        height: Int(canvas),
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    )
else {
    FileHandle.standardError.write("could not create canvas\n".data(using: .utf8)!)
    exit(1)
}

let bodyRect = CGRect(x: inset, y: inset, width: body, height: body)
context.addPath(CGPath(roundedRect: bodyRect, cornerWidth: radius, cornerHeight: radius, transform: nil))
context.clip()
context.interpolationQuality = .high
context.draw(image, in: bodyRect)

guard
    let output = context.makeImage(),
    let destination = CGImageDestinationCreateWithURL(outputUrl as CFURL, UTType.png.identifier as CFString, 1, nil)
else {
    FileHandle.standardError.write("could not encode output\n".data(using: .utf8)!)
    exit(1)
}
CGImageDestinationAddImage(destination, output, nil)
guard CGImageDestinationFinalize(destination) else {
    FileHandle.standardError.write("could not write \(outputUrl.path)\n".data(using: .utf8)!)
    exit(1)
}
