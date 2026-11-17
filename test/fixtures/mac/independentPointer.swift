// AppKit fixture appended to the real helper, with its CLI @main removed.
// The parent owns disposable windows; a separate child process posts input.
private final class PointerProbeView: NSView {
  var events: [[String: Any]] = []
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  private func record(_ event: NSEvent) {
    events.append(["type": event.type.rawValue, "x": event.locationInWindow.x,
                   "y": event.locationInWindow.y, "dy": event.type == .scrollWheel ? event.scrollingDeltaY : 0])
  }
  override func mouseMoved(with event: NSEvent) { record(event) }
  override func mouseDown(with event: NSEvent) { record(event) }
  override func mouseUp(with event: NSEvent) { record(event) }
  override func rightMouseDown(with event: NSEvent) { record(event) }
  override func rightMouseUp(with event: NSEvent) { record(event) }
  override func mouseDragged(with event: NSEvent) { record(event) }
  override func scrollWheel(with event: NSEvent) { record(event) }
}

private final class PointerProbeApplication: NSApplication {
  static var received: [[String: Any]] = []
  override func sendEvent(_ event: NSEvent) {
    Self.received.append(["type": event.type.rawValue, "window": event.windowNumber,
                          "x": event.locationInWindow.x, "y": event.locationInWindow.y])
    super.sendEvent(event)
  }
}

private enum GlobalPointerProbe {
  static var userMotionEvents = 0
  static var userInputEvents = 0
  static var injectedGlobalEvents = 0
}

private func observeGlobalPointer(_ proxy: CGEventTapProxy, _ type: CGEventType, _ event: CGEvent,
                                  _ context: UnsafeMutableRawPointer?) -> Unmanaged<CGEvent>? {
  if event.getIntegerValueField(.eventSourceUserData) == UFOO_EVENT_TAG {
    GlobalPointerProbe.injectedGlobalEvents += 1
  } else {
    GlobalPointerProbe.userInputEvents += 1
    if [.mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged].contains(type) {
      GlobalPointerProbe.userMotionEvents += 1
    }
  }
  return Unmanaged.passUnretained(event)
}

@main
struct IndependentPointerFixture {
  static func main() throws {
    if CommandLine.arguments.count > 1 {
      let data = Data(base64Encoded: CommandLine.arguments[1])!
      let params = try JSONSerialization.jsonObject(with: data) as! [String: Any]
      let engine = MacAutomationEngine()
      let x = params["x"] as! Double
      let y = params["y"] as! Double
      var base = params
      base["hud"] = false
      base["takeoverGuard"] = false
      base["sessionId"] = "fixture-agent"
      var samples: [[String: Any]] = []
      for (method, additions) in [
        ("mouse_move", ["x": x, "y": y] as [String: Any]),
        ("mouse_click", ["x": x, "y": y]),
        ("mouse_click", ["x": x, "y": y, "button": "right"]),
        ("mouse_drag", ["fromX": x, "fromY": y, "toX": x + 35, "toY": y + 25]),
        ("mouse_scroll", ["x": x, "y": y, "deltaY": -120]),
      ] {
        var args = base
        args.merge(additions) { _, value in value }
        let before = currentCGMouseLocation()
        let result = try engine.dispatch(method: method, params: args)
        precondition((result["pointerMode"] as? String) == "independent")
        Thread.sleep(forTimeInterval: 0.15)
        let after = currentCGMouseLocation()
        samples.append(["method": method, "before": [before.x, before.y], "after": [after.x, after.y]])
      }
      print(String(data: try JSONSerialization.data(withJSONObject: samples), encoding: .utf8)!)
      return
    }

    let app = PointerProbeApplication.shared
    app.setActivationPolicy(.accessory)
    let window = NSWindow(contentRect: NSRect(x: 160, y: 200, width: 260, height: 180),
                          styleMask: [.titled], backing: .buffered, defer: false)
    window.title = "ufoo independent pointer test"
    let view = PointerProbeView(frame: NSRect(x: 0, y: 0, width: 260, height: 180))
    window.contentView = view
    window.acceptsMouseMovedEvents = true
    window.orderFrontRegardless()
    let eventTypes: [CGEventType] = [.mouseMoved, .leftMouseDown, .leftMouseUp, .rightMouseDown,
      .rightMouseUp, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .scrollWheel, .keyDown]
    let mask = eventTypes.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
    guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap,
      options: .listenOnly, eventsOfInterest: mask, callback: observeGlobalPointer, userInfo: nil) else {
      fputs("Accessibility/Input Monitoring permission is required to verify the global input stream.\n", stderr)
      exit(2)
    }
    let tapSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)!
    CFRunLoopAddSource(CFRunLoopGetMain(), tapSource, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
    let initial = currentCGMouseLocation()
    let foreground = NSWorkspace.shared.frontmostApplication?.processIdentifier
    var targetActivated = false
    let observer = NSWorkspace.shared.notificationCenter.addObserver(
      forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
    ) { notification in
      if let activated = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
         activated.processIdentifier == getpid() { targetActivated = true }
    }
    let screenPoint = CGPoint(x: window.frame.minX + 70,
                              y: primaryScreenHeight() - window.frame.minY - 70)
    let params: [String: Any] = ["pid": Int(getpid()), "windowId": window.windowNumber,
                                "x": screenPoint.x, "y": screenPoint.y]
    let child = Process()
    let childOutput = Pipe()
    child.standardOutput = childOutput
    child.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
    child.arguments = [try JSONSerialization.data(withJSONObject: params).base64EncodedString()]
    child.terminationHandler = { process in
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
        let final = currentCGMouseLocation()
        let result: [String: Any] = [
          "childExit": process.terminationStatus,
          "physicalCursorDelta": hypot(final.x - initial.x, final.y - initial.y),
          "foregroundUnchanged": foreground == NSWorkspace.shared.frontmostApplication?.processIdentifier,
          "userMotionEvents": GlobalPointerProbe.userMotionEvents,
          "userInputEvents": GlobalPointerProbe.userInputEvents,
          "targetActivated": targetActivated,
          "injectedGlobalEvents": GlobalPointerProbe.injectedGlobalEvents,
          "events": view.events,
          "received": PointerProbeApplication.received,
          "samples": (try? JSONSerialization.jsonObject(with: childOutput.fileHandleForReading.readDataToEndOfFile())) ?? [],
        ]
        let data = try! JSONSerialization.data(withJSONObject: result)
        print(String(data: data, encoding: .utf8)!)
        window.orderOut(nil)
        CFMachPortInvalidate(tap)
        NSWorkspace.shared.notificationCenter.removeObserver(observer)
        exit(0)
      }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { try! child.run() }
    DispatchQueue.main.asyncAfter(deadline: .now() + 15) {
      if child.isRunning { child.terminate() }
      window.orderOut(nil)
      exit(2)
    }
    app.run()
  }
}
