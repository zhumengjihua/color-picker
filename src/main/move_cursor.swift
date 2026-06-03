import Foundation
import CoreGraphics

func main() {
    let args = CommandLine.arguments
    guard args.count >= 3 else {
        print("Usage: move_cursor <x> <y>")
        exit(1)
    }
    
    // Parse x and y coordinates, rounding them to nearest integer
    guard let x = Double(args[1]), let y = Double(args[2]) else {
        print("Invalid coordinates")
        exit(1)
    }
    
    let point = CGPoint(x: x, y: y)
    
    // Warp cursor (teleport)
    CGWarpMouseCursorPosition(point)
    
    // Post a mouse-moved event so the OS and Chromium register the movement immediately
    if let event = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) {
        event.post(tap: .cghidEventTap)
    }
}

main()
