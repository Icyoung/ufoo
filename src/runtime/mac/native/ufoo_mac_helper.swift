import AppKit
import ApplicationServices
import CoreGraphics
import Darwin
import Foundation
import ImageIO
import UniformTypeIdentifiers

private let UFOO_EVENT_TAG: Int64 = 0x5546_4F4F // "UFOO"
private let HELPER_VERSION = "1.1.0"

// Cross-process NSEvent routing needs a window-local point in addition to its
// public global location. Resolve the macOS SPI at runtime; never substitute
// global HID posting when an OS version does not provide it.
private typealias SetWindowLocation = @convention(c) (CGEvent, Double, Double) -> Void
private let setEventWindowLocation: SetWindowLocation? = {
  guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGEventSetWindowLocation") else { return nil }
  return unsafeBitCast(symbol, to: SetWindowLocation.self)
}()

// MARK: - Coordinate Helpers (CoreGraphics top-left <-> AppKit bottom-left)

private func primaryScreenHeight() -> CGFloat {
  if let first = NSScreen.screens.first {
    return first.frame.height
  }
  return CGFloat(CGDisplayPixelsHigh(CGMainDisplayID()))
}

private func cgPointToNS(_ pt: CGPoint) -> NSPoint {
  return NSPoint(x: pt.x, y: primaryScreenHeight() - pt.y)
}

private func nsPointToCG(_ pt: NSPoint) -> CGPoint {
  return CGPoint(x: pt.x, y: primaryScreenHeight() - pt.y)
}

private func cgRectToNS(_ rect: CGRect) -> NSRect {
  return NSRect(
    x: rect.origin.x,
    y: primaryScreenHeight() - rect.origin.y - rect.size.height,
    width: rect.size.width,
    height: rect.size.height
  )
}

private func nsRectToCG(_ rect: NSRect) -> CGRect {
  return CGRect(
    x: rect.origin.x,
    y: primaryScreenHeight() - rect.origin.y - rect.size.height,
    width: rect.size.width,
    height: rect.size.height
  )
}

private func rectDict(_ rect: CGRect) -> [String: Any] {
  return [
    "x": Int(rect.origin.x.rounded()),
    "y": Int(rect.origin.y.rounded()),
    "width": Int(rect.size.width.rounded()),
    "height": Int(rect.size.height.rounded()),
  ]
}

private func currentCGMouseLocation() -> CGPoint {
  if let ev = CGEvent(source: nil) {
    return ev.location
  }
  return nsPointToCG(NSEvent.mouseLocation)
}

// MARK: - Human Takeover Monitor

final class TakeoverMonitor {
  struct TakeoverState {
    let reason: String
    let detail: String
    let timestamp: Double
    let turnScope: String
  }

  private let lock = NSLock()
  private var enabled: Bool = true
  private var isPerformingInput: Bool = false
  private var activeTurnScope: String = ""
  private var lastAgentPoint: CGPoint?
  private var lastAgentActionTime: Double = 0
  private var accumulatedPhysicalDelta: CGFloat = 0
  private var lastObservedPhysicalPoint: CGPoint?
  private var lastPhysicalDelta: CGPoint?
  private var shakeStartedAt: Double = 0
  private var shakeReversals = 0
  private var targetBounds: CGRect?
  private var latched: TakeoverState?
  private var mouseMonitor: Any?
  private var keyMonitor: Any?
  var onTakeover: ((TakeoverState) -> Void)?

  func setTargetBounds(_ bounds: CGRect?) {
    lock.lock()
    targetBounds = bounds
    lock.unlock()
  }

  func startMonitorsOnMain() {
    if mouseMonitor == nil {
      let mask: NSEvent.EventTypeMask = [
        .mouseMoved, .leftMouseDragged, .rightMouseDragged, .leftMouseDown, .rightMouseDown,
      ]
      mouseMonitor = NSEvent.addGlobalMonitorForEvents(matching: mask) { [weak self] event in
        self?.handleGlobalMouseEvent(event)
      }
    }
    if keyMonitor == nil {
      keyMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.keyDown]) { [weak self] event in
        self?.handleGlobalKeyEvent(event)
      }
    }
  }

  func setEnabled(_ flag: Bool) {
    lock.lock()
    enabled = flag
    if !flag {
      latched = nil
      accumulatedPhysicalDelta = 0
    }
    lock.unlock()
  }

  func syncTurnScope(_ scope: String) {
    let trimmed = scope.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return }
    lock.lock()
    if !activeTurnScope.isEmpty && activeTurnScope != trimmed {
      // A new user request/turn clears prior turn's takeover latch automatically.
      if let current = latched, current.turnScope != trimmed {
        latched = nil
        accumulatedPhysicalDelta = 0
      }
    }
    activeTurnScope = trimmed
    lock.unlock()
  }

  func clear() {
    lock.lock()
    latched = nil
    accumulatedPhysicalDelta = 0
    lastObservedPhysicalPoint = nil
    lock.unlock()
  }

  func currentTakeover() -> [String: Any]? {
    lock.lock()
    defer { lock.unlock() }
    guard let st = latched else { return nil }
    return [
      "reason": st.reason,
      "detail": st.detail,
      "timestamp": Int((st.timestamp * 1000).rounded()),
      "turnScope": st.turnScope,
    ]
  }

  func beginAgentInput(at point: CGPoint?) -> TakeoverState? {
    lock.lock()
    defer { lock.unlock() }
    if enabled, let st = latched {
      return st
    }
    isPerformingInput = true
    accumulatedPhysicalDelta = 0
    lastObservedPhysicalPoint = nil
    lastPhysicalDelta = nil
    shakeReversals = 0
    shakeStartedAt = CFAbsoluteTimeGetCurrent()
    if let pt = point {
      lastAgentPoint = pt
    }
    lastAgentActionTime = CFAbsoluteTimeGetCurrent()
    return nil
  }

  func recordAgentMouseStep(_ pt: CGPoint) {
    lock.lock()
    lastAgentPoint = pt
    lastAgentActionTime = CFAbsoluteTimeGetCurrent()
    lock.unlock()
  }

  func endAgentInput(finalPoint: CGPoint?) {
    lock.lock()
    isPerformingInput = false
    if let pt = finalPoint {
      lastAgentPoint = pt
    }
    lastAgentActionTime = CFAbsoluteTimeGetCurrent()
    accumulatedPhysicalDelta = 0
    lastObservedPhysicalPoint = nil
    lock.unlock()
  }

  func checkStepOrAbort(expectedNear expected: CGPoint?) -> TakeoverState? {
    lock.lock()
    if !enabled {
      lock.unlock()
      return nil
    }
    if let st = latched {
      lock.unlock()
      return st
    }
    lock.unlock()
    // Agent and physical cursor positions are independent. Comparing them
    // would falsely treat every agent move as a user takeover.
    return nil
  }

  private func latch(_ state: TakeoverState) {
    var shouldNotify = false
    lock.lock()
    if latched == nil {
      latched = state
      shouldNotify = true
    }
    lock.unlock()
    if shouldNotify {
      onTakeover?(state)
    }
  }

  private func handleGlobalMouseEvent(_ event: NSEvent) {
    if let cg = event.cgEvent, cg.getIntegerValueField(.eventSourceUserData) == UFOO_EVENT_TAG {
      return
    }
    let now = CFAbsoluteTimeGetCurrent()
    let pt = event.cgEvent?.location ?? nsPointToCG(NSEvent.mouseLocation)

    lock.lock()
    guard enabled, latched == nil else {
      lock.unlock()
      return
    }
    let active = isPerformingInput
    let recent = (now - lastAgentActionTime) < 1.8
    guard active || recent else {
      lock.unlock()
      return
    }
    let scope = activeTurnScope

    if event.type == .leftMouseDown || event.type == .rightMouseDown {
      let inTarget = targetBounds?.contains(pt) == true
      lock.unlock()
      guard inTarget else { return }
      latch(TakeoverState(
        reason: "user_mouse_clicked",
        detail: "User clicked inside the agent's target window",
        timestamp: now,
        turnScope: scope
      ))
      return
    }

    if now - shakeStartedAt > 0.8 {
      shakeStartedAt = now
      shakeReversals = 0
      accumulatedPhysicalDelta = 0
      lastPhysicalDelta = nil
    }
    if let prev = lastObservedPhysicalPoint {
      let delta = CGPoint(x: pt.x - prev.x, y: pt.y - prev.y)
      if hypot(delta.x, delta.y) >= 4 {
        accumulatedPhysicalDelta += hypot(delta.x, delta.y)
        if let prior = lastPhysicalDelta, delta.x * prior.x + delta.y * prior.y < 0 {
          shakeReversals += 1
        }
        lastPhysicalDelta = delta
      }
    }
    lastObservedPhysicalPoint = pt
    let delta = accumulatedPhysicalDelta
    let shaking = shakeReversals >= 3 && delta >= 160
    lock.unlock()

    if shaking {
      latch(TakeoverState(
        reason: "user_mouse_shake",
        detail: "User shook physical mouse (\(Int(delta.rounded()))pt)",
        timestamp: now,
        turnScope: scope
      ))
    }
  }

  private func handleGlobalKeyEvent(_ event: NSEvent) {
    if let cg = event.cgEvent, cg.getIntegerValueField(.eventSourceUserData) == UFOO_EVENT_TAG {
      return
    }
    guard event.keyCode == 53 else { return } // Escape key
    let now = CFAbsoluteTimeGetCurrent()
    lock.lock()
    guard enabled, latched == nil else {
      lock.unlock()
      return
    }
    let active = isPerformingInput || (now - lastAgentActionTime) < 4.0
    let scope = activeTurnScope
    lock.unlock()

    if active {
      latch(TakeoverState(
        reason: "user_pressed_escape",
        detail: "User pressed Esc emergency yield shortcut",
        timestamp: now,
        turnScope: scope
      ))
    }
  }
}

// MARK: - Agent Mouse & Highlight Visual HUD (Main Thread)

private enum AgentMouseTheme {
  // Dominant orange from extensions/ufoo-browser/icons/toolbar-logo.png.
  static let orange = NSColor(srgbRed: 252.0 / 255, green: 93.0 / 255, blue: 35.0 / 255, alpha: 1)
}

private final class AgentCursorView: NSView {
  var hotSpot: NSPoint = NSPoint(x: 48, y: 72)
  var clickProgress: CGFloat?

  override var isOpaque: Bool { false }

  override func draw(_ dirtyRect: NSRect) {
    guard let ctx = NSGraphicsContext.current?.cgContext else { return }
    ctx.clear(bounds)
    ctx.setAllowsAntialiasing(true)
    ctx.setShouldAntialias(true)

    // Three compact, translucent ripples; no ring while moving or idle.
    if let progress = clickProgress {
      for layer in 0..<3 {
        let phase = (progress - CGFloat(layer) * 0.16) / 0.68
        guard phase > 0, phase < 1 else { continue }
        let radius = 3 + 25 * (1 - pow(1 - phase, 1.4))
        let opacity = 0.30 * sin(.pi * phase)
        let ring = NSBezierPath(ovalIn: NSRect(
          x: hotSpot.x - radius, y: hotSpot.y - radius,
          width: radius * 2, height: radius * 2
        ))
        AgentMouseTheme.orange.withAlphaComponent(opacity).setStroke()
        ring.lineWidth = 1.15
        ring.stroke()
      }
    }

    // The top vertex is the exact input coordinate.
    let pointer = NSBezierPath()
    pointer.move(to: hotSpot)
    pointer.line(to: NSPoint(x: hotSpot.x, y: hotSpot.y - 16))
    pointer.line(to: NSPoint(x: hotSpot.x + 4.5, y: hotSpot.y - 12.2))
    pointer.line(to: NSPoint(x: hotSpot.x + 11.5, y: hotSpot.y - 13.5))
    pointer.close()
    AgentMouseTheme.orange.setFill()
    pointer.fill()
    NSColor.white.withAlphaComponent(0.95).setStroke()
    pointer.lineWidth = 1.3
    pointer.stroke()
  }
}

private final class HighlightFrameView: NSView {
  override var isOpaque: Bool { false }
  override func draw(_ dirtyRect: NSRect) {
    let inset = bounds.insetBy(dx: 2, dy: 2)
    guard inset.width > 2, inset.height > 2 else { return }
    let accent = AgentMouseTheme.orange
    let path = NSBezierPath(roundedRect: inset, xRadius: 6, yRadius: 6)
    accent.withAlphaComponent(0.10).setFill()
    path.fill()
    accent.withAlphaComponent(0.92).setStroke()
    path.lineWidth = 2.2
    path.stroke()
  }
}

final class AgentHudController {
  var enabled: Bool = true
  var agentName: String = "ufoo"

  private var cursorWindow: NSWindow?
  private var cursorView: AgentCursorView?
  private var highlightWindow: NSWindow?
  private var idleHideWorkItem: DispatchWorkItem?
  private var highlightHideWorkItem: DispatchWorkItem?
  private var rippleTimer: Timer?
  private let canvasSize = NSSize(width: 112, height: 112)

  private func ensureCursorWindowOnMain() {
    if cursorWindow != nil { return }
    let win = NSWindow(
      contentRect: NSRect(origin: .zero, size: canvasSize),
      styleMask: .borderless,
      backing: .buffered,
      defer: false
    )
    win.isReleasedWhenClosed = false
    win.isOpaque = false
    win.backgroundColor = .clear
    win.hasShadow = false
    win.ignoresMouseEvents = true
    win.level = .screenSaver
    win.sharingType = .none
    win.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    let view = AgentCursorView(frame: NSRect(origin: .zero, size: canvasSize))
    win.contentView = view
    cursorWindow = win
    cursorView = view
  }

  private func ensureHighlightWindowOnMain() {
    if highlightWindow != nil { return }
    let win = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 60, height: 30),
      styleMask: .borderless,
      backing: .buffered,
      defer: false
    )
    win.isReleasedWhenClosed = false
    win.isOpaque = false
    win.backgroundColor = .clear
    win.hasShadow = false
    win.ignoresMouseEvents = true
    win.level = .screenSaver
    win.sharingType = .none
    win.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    win.contentView = HighlightFrameView(frame: NSRect(x: 0, y: 0, width: 60, height: 30))
    highlightWindow = win
  }

  func updateCursor(cgPoint: CGPoint, actionLabel: String = "", mode: String = "normal", idleHideAfter: Double = 3.2) {
    guard enabled else { return }
    DispatchQueue.main.async { [weak self] in
      guard let self = self, self.enabled else { return }
      self.ensureCursorWindowOnMain()
      guard let win = self.cursorWindow, let view = self.cursorView else { return }
      self.stopRippleOnMain()
      let nsPt = cgPointToNS(cgPoint)
      // Leave room around the click point for the expanding pulse.
      let anchorX = self.canvasSize.width / 2
      let anchorY = self.canvasSize.height / 2
      let origin = NSPoint(x: nsPt.x - anchorX, y: nsPt.y - anchorY)
      win.setFrameOrigin(origin)
      view.hotSpot = NSPoint(x: anchorX, y: anchorY)
      view.needsDisplay = true
      win.alphaValue = 1.0
      win.orderFrontRegardless()
      self.scheduleIdleHideOnMain(after: idleHideAfter)
    }
  }

  func pulseClick(cgPoint: CGPoint, actionLabel: String, rightClick: Bool = false, doubleClick: Bool = false) {
    updateCursor(cgPoint: cgPoint)
    DispatchQueue.main.async { [weak self] in
      guard let self = self, self.enabled, let view = self.cursorView else { return }
      self.stopRippleOnMain()
      view.clickProgress = 0
      view.needsDisplay = true
      let started = ProcessInfo.processInfo.systemUptime
      let duration = doubleClick ? 1.25 : 1.1
      let timer = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] timer in
        guard let self = self else { timer.invalidate(); return }
        let progress = (ProcessInfo.processInfo.systemUptime - started) / duration
        if progress >= 1 {
          self.stopRippleOnMain()
        } else {
          self.cursorView?.clickProgress = CGFloat(progress)
          self.cursorView?.needsDisplay = true
        }
      }
      self.rippleTimer = timer
      RunLoop.main.add(timer, forMode: .common)
    }
  }

  private func stopRippleOnMain() {
    rippleTimer?.invalidate()
    rippleTimer = nil
    cursorView?.clickProgress = nil
    cursorView?.needsDisplay = true
  }

  func flashHighlight(cgRect: CGRect, duration: Double = 0.65) {
    guard enabled, cgRect.width > 2, cgRect.height > 2 else { return }
    DispatchQueue.main.async { [weak self] in
      guard let self = self, self.enabled else { return }
      self.ensureHighlightWindowOnMain()
      guard let win = self.highlightWindow else { return }
      let nsRect = cgRectToNS(cgRect).insetBy(dx: -4, dy: -4)
      win.setFrame(nsRect, display: true)
      win.contentView?.needsDisplay = true
      win.alphaValue = 1.0
      win.orderFrontRegardless()
      self.highlightHideWorkItem?.cancel()
      let item = DispatchWorkItem { [weak self] in
        self?.highlightWindow?.orderOut(nil)
      }
      self.highlightHideWorkItem = item
      DispatchQueue.main.asyncAfter(deadline: .now() + duration, execute: item)
    }
  }

  func showTakeoverPaused() {
    hideImmediatelySync()
  }

  func hideImmediatelySync() {
    if Thread.isMainThread {
      stopRippleOnMain()
      idleHideWorkItem?.cancel()
      highlightHideWorkItem?.cancel()
      cursorWindow?.orderOut(nil)
      highlightWindow?.orderOut(nil)
    } else {
      DispatchQueue.main.sync {
        self.stopRippleOnMain()
        self.idleHideWorkItem?.cancel()
        self.highlightHideWorkItem?.cancel()
        self.cursorWindow?.orderOut(nil)
        self.highlightWindow?.orderOut(nil)
      }
    }
  }

  private func scheduleIdleHideOnMain(after seconds: Double) {
    idleHideWorkItem?.cancel()
    let item = DispatchWorkItem { [weak self] in
      self?.cursorWindow?.orderOut(nil)
    }
    idleHideWorkItem = item
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: item)
  }
}

// MARK: - Keycode & Modifier Mapping

private let KEYCODE_MAP: [String: CGKeyCode] = [
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
  "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
  "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26,
  "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35,
  "return": 36, "enter": 36, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42,
  ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "tab": 48, "space": 49, "`": 50,
  "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
  "f17": 64, "f18": 79, "f19": 80, "f20": 90,
  "f5": 96, "f6": 97, "f7": 98, "f3": 99, "f8": 100, "f9": 101, "f11": 103,
  "f13": 105, "f16": 106, "f14": 107, "f10": 109, "f12": 111, "f15": 113,
  "help": 114, "home": 115, "pageup": 116, "forwarddelete": 117, "f4": 118,
  "end": 119, "f2": 120, "pagedown": 121, "f1": 122,
  "left": 123, "arrowleft": 123, "right": 124, "arrowright": 124,
  "down": 125, "arrowdown": 125, "up": 126, "arrowup": 126,
]

private func parseKeyAndModifiers(keyRaw: String, modifiersRaw: [String]) -> (CGKeyCode?, CGEventFlags) {
  var modTokens = modifiersRaw.map { $0.lowercased().trimmingCharacters(in: .whitespacesAndNewlines) }
  var baseKey = keyRaw.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
  if baseKey.contains("+") && baseKey != "+" {
    let parts = baseKey.split(separator: "+").map(String.init)
    if let last = parts.last {
      modTokens.append(contentsOf: parts.dropLast())
      baseKey = last
    }
  }
  var flags = CGEventFlags()
  for tok in modTokens {
    switch tok {
    case "cmd", "command", "meta", "super":
      flags.insert(.maskCommand)
    case "shift":
      flags.insert(.maskShift)
    case "alt", "opt", "option":
      flags.insert(.maskAlternate)
    case "ctrl", "control":
      flags.insert(.maskControl)
    default:
      break
    }
  }
  return (KEYCODE_MAP[baseKey], flags)
}

private func parseModifierFlags(_ modifiersRaw: [String]) -> CGEventFlags {
  return parseKeyAndModifiers(keyRaw: "", modifiersRaw: modifiersRaw).1
}

// MARK: - Accessibility (AXUIElement) Helpers

@_silgen_name("_AXUIElementGetWindow")
private func _AXUIElementGetWindow(_ element: AXUIElement, _ windowID: UnsafeMutablePointer<CGWindowID>) -> AXError

private func axCopyAttr(_ element: AXUIElement, _ attr: String) -> CFTypeRef? {
  var out: CFTypeRef?
  let err = AXUIElementCopyAttributeValue(element, attr as CFString, &out)
  return err == .success ? out : nil
}

private func axString(_ element: AXUIElement, _ attr: String) -> String {
  guard let val = axCopyAttr(element, attr) else { return "" }
  if let str = val as? String { return str }
  if let num = val as? NSNumber { return num.stringValue }
  return ""
}

private func axBool(_ element: AXUIElement, _ attr: String, defaultValue: Bool = false) -> Bool {
  guard let val = axCopyAttr(element, attr) else { return defaultValue }
  if let b = val as? Bool { return b }
  if let n = val as? NSNumber { return n.boolValue }
  return defaultValue
}

private func axFrame(_ element: AXUIElement) -> CGRect? {
  guard
    let posRef = axCopyAttr(element, kAXPositionAttribute),
    let sizeRef = axCopyAttr(element, kAXSizeAttribute),
    CFGetTypeID(posRef) == AXValueGetTypeID(),
    CFGetTypeID(sizeRef) == AXValueGetTypeID()
  else {
    return nil
  }
  var pt = CGPoint.zero
  var sz = CGSize.zero
  guard
    AXValueGetValue(posRef as! AXValue, .cgPoint, &pt),
    AXValueGetValue(sizeRef as! AXValue, .cgSize, &sz)
  else {
    return nil
  }
  return CGRect(origin: pt, size: sz)
}

private func axChildren(_ element: AXUIElement) -> [AXUIElement] {
  if let arr = axCopyAttr(element, kAXChildrenAttribute) as? [AXUIElement] {
    return arr
  }
  return []
}

// A known window ID remains authoritative after windows close or reorder.
private func snapshotWindow<T>(_ windows: [T], windowId: Int, rootIndex: Int, id: (T) -> Int) -> T? {
  if windowId > 0 {
    return windows.first(where: { id($0) == windowId })
  }
  return windows.indices.contains(rootIndex) ? windows[rootIndex] : nil
}

private func axActions(_ element: AXUIElement) -> [String] {
  var namesRef: CFArray?
  guard AXUIElementCopyActionNames(element, &namesRef) == .success,
        let names = namesRef as? [String]
  else {
    return []
  }
  let keep: Set<String> = [
    kAXPressAction, kAXConfirmAction, kAXCancelAction, kAXPickAction,
    kAXShowMenuAction, kAXIncrementAction, kAXDecrementAction, kAXRaiseAction,
  ]
  return names.filter { keep.contains($0) }
}

private let INTERACTIVE_ROLES: Set<String> = [
  "AXButton", "AXRadioButton", "AXCheckBox", "AXPopUpButton", "AXMenuButton",
  "AXMenuItem", "AXMenuBarItem", "AXTextField", "AXTextArea", "AXSearchField",
  "AXComboBox", "AXSlider", "AXLink", "AXTab", "AXTabGroup", "AXDisclosureTriangle",
  "AXIncrementor", "AXColorWell", "AXCell", "AXRow", "AXOutlineRow",
]

// MARK: - Core Operations Engine

final class MacAutomationEngine {
  let takeover = TakeoverMonitor()
  let hud = AgentHudController()
  private struct InputTarget {
    let pid: pid_t
    let windowId: Int
    let bounds: CGRect
  }
  private var inputTarget: InputTarget?
  private var inputSession = "default"
  private var cursorPositions: [String: CGPoint] = [:]
  private var agentPoint: CGPoint? {
    get { cursorPositions[inputSession] }
    set {
      if cursorPositions.count >= 128 && cursorPositions[inputSession] == nil {
        cursorPositions.removeValue(forKey: cursorPositions.keys.first!)
      }
      cursorPositions[inputSession] = newValue
    }
  }

  init() {
    takeover.onTakeover = { [weak self] _ in
      self?.hud.showTakeoverPaused()
    }
  }

  func collectPermissions(prompt: Bool = false, openSettings: Bool = false) -> [String: Any] {
    let axTrusted: Bool
    if prompt {
      let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
      axTrusted = AXIsProcessTrustedWithOptions(opts)
    } else {
      axTrusted = AXIsProcessTrusted()
    }

    let screenTrusted: Bool
    if prompt {
      screenTrusted = CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess()
    } else {
      screenTrusted = CGPreflightScreenCaptureAccess()
    }

    if openSettings {
      if !axTrusted, let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
        NSWorkspace.shared.open(url)
      } else if !screenTrusted, let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") {
        NSWorkspace.shared.open(url)
      }
    }

    return [
      "accessibility": axTrusted,
      "screenRecording": screenTrusted,
    ]
  }

  func collectDisplays() -> [[String: Any]] {
    var out: [[String: Any]] = []
    for (idx, screen) in NSScreen.screens.enumerated() {
      let cgBounds = nsRectToCG(screen.frame)
      let screenNumber = (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? 0
      out.append([
        "index": idx + 1,
        "displayId": screenNumber,
        "main": idx == 0,
        "bounds": rectDict(cgBounds),
        "scaleFactor": Double(screen.backingScaleFactor),
      ])
    }
    return out
  }

  func frontmostAppDict() -> [String: Any]? {
    guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
    return [
      "name": app.localizedName ?? "",
      "bundleId": app.bundleIdentifier ?? "",
      "pid": Int(app.processIdentifier),
    ]
  }

  func statusPayload(prompt: Bool = false, openSettings: Bool = false) -> [String: Any] {
    let perms = collectPermissions(prompt: prompt, openSettings: openSettings)
    let cursor = currentCGMouseLocation()
    var res: [String: Any] = [
      "helperVersion": HELPER_VERSION,
      "pid": Int(ProcessInfo.processInfo.processIdentifier),
      "osVersion": ProcessInfo.processInfo.operatingSystemVersionString,
      "permissions": perms,
      "displays": collectDisplays(),
      "cursor": ["x": Int(cursor.x.rounded()), "y": Int(cursor.y.rounded())],
      "hudEnabled": hud.enabled,
      "pointerMode": "independent",
    ]
    if let front = frontmostAppDict() {
      res["frontmostApp"] = front
    }
    if let tk = takeover.currentTakeover() {
      res["takeover"] = tk
    }
    return res
  }

  private func rawWindowList(includeOffscreen: Bool = false) -> [[String: Any]] {
    let opts: CGWindowListOption = includeOffscreen
      ? [.optionAll, .excludeDesktopElements]
      : [.optionOnScreenOnly, .excludeDesktopElements]
    guard let info = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else {
      return []
    }
    return info
  }

  private func resolveRunningApps() -> [pid_t: NSRunningApplication] {
    var map: [pid_t: NSRunningApplication] = [:]
    for app in NSWorkspace.shared.runningApplications {
      map[app.processIdentifier] = app
    }
    return map
  }

  private func appMatches(_ app: NSRunningApplication?, ownerName: String, filterApp: String, filterBundleId: String, filterPid: Int) -> Bool {
    if filterPid > 0 {
      guard let p = app?.processIdentifier, Int(p) == filterPid else { return false }
    }
    if !filterBundleId.isEmpty {
      let bid = (app?.bundleIdentifier ?? "").lowercased()
      if bid != filterBundleId.lowercased() { return false }
    }
    if !filterApp.isEmpty {
      let needle = filterApp.lowercased()
      let name = (app?.localizedName ?? ownerName).lowercased()
      let bid = (app?.bundleIdentifier ?? "").lowercased()
      if !name.contains(needle) && bid != needle && !bid.hasSuffix(".\(needle)") {
        return false
      }
    }
    return true
  }

  func listApps(includeBackground: Bool = false) -> [[String: Any]] {
    let windows = rawWindowList(includeOffscreen: false)
    var winCountByPid: [Int: Int] = [:]
    for w in windows {
      let layer = (w[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
      if layer != 0 { continue }
      if let pid = (w[kCGWindowOwnerPID as String] as? NSNumber)?.intValue {
        winCountByPid[pid, default: 0] += 1
      }
    }
    var rows: [[String: Any]] = []
    for app in NSWorkspace.shared.runningApplications {
      if app.isTerminated { continue }
      let policy = app.activationPolicy
      if !includeBackground && policy != .regular { continue }
      let pid = Int(app.processIdentifier)
      rows.append([
        "name": app.localizedName ?? "",
        "bundleId": app.bundleIdentifier ?? "",
        "pid": pid,
        "active": app.isActive,
        "hidden": app.isHidden,
        "windowCount": winCountByPid[pid] ?? 0,
      ])
    }
    rows.sort { a, b in
      let aActive = (a["active"] as? Bool) ?? false
      let bActive = (b["active"] as? Bool) ?? false
      if aActive != bActive { return aActive && !bActive }
      let aWins = (a["windowCount"] as? Int) ?? 0
      let bWins = (b["windowCount"] as? Int) ?? 0
      if (aWins > 0) != (bWins > 0) { return aWins > 0 }
      return ((a["name"] as? String) ?? "") < ((b["name"] as? String) ?? "")
    }
    return rows
  }

  func listWindows(appFilter: String = "", bundleIdFilter: String = "", pidFilter: Int = 0, windowIdFilter: Int = 0, includeOffscreen: Bool = false) -> [[String: Any]] {
    let appMap = resolveRunningApps()
    let frontPid = Int(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1)
    var out: [[String: Any]] = []
    var seenFrontForApp = false

    for w in rawWindowList(includeOffscreen: includeOffscreen) {
      let winId = (w[kCGWindowNumber as String] as? NSNumber)?.intValue ?? 0
      if windowIdFilter > 0 && winId != windowIdFilter { continue }
      let layer = (w[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
      // Keep normal app windows (layer == 0) unless explicitly querying a windowId
      if windowIdFilter <= 0 && layer != 0 { continue }
      let pid = (w[kCGWindowOwnerPID as String] as? NSNumber)?.intValue ?? 0
      if pid == Int(ProcessInfo.processInfo.processIdentifier) { continue }
      let ownerName = (w[kCGWindowOwnerName as String] as? String) ?? ""
      let runningApp = appMap[pid_t(pid)]
      if !appMatches(runningApp, ownerName: ownerName, filterApp: appFilter, filterBundleId: bundleIdFilter, filterPid: pidFilter) {
        continue
      }
      var bounds = CGRect.zero
      if let bDict = w[kCGWindowBounds as String] as? NSDictionary {
        CGRectMakeWithDictionaryRepresentation(bDict, &bounds)
      }
      if windowIdFilter <= 0 && (bounds.width < 24 || bounds.height < 24) { continue }
      let alpha = (w[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1.0
      if windowIdFilter <= 0 && alpha <= 0.01 { continue }

      let isFront = (pid == frontPid) && !seenFrontForApp
      if isFront { seenFrontForApp = true }

      out.append([
        "windowId": winId,
        "title": (w[kCGWindowName as String] as? String) ?? "",
        "app": runningApp?.localizedName ?? ownerName,
        "bundleId": runningApp?.bundleIdentifier ?? "",
        "pid": pid,
        "bounds": rectDict(bounds),
        "layer": layer,
        "onScreen": (w[kCGWindowIsOnscreen as String] as? Bool) ?? true,
        "frontmost": isFront,
      ])
    }
    return out
  }

  func resolveTargetApp(appName: String = "", bundleId: String = "", pid: Int = 0, windowId: Int = 0) -> NSRunningApplication? {
    if pid > 0 {
      return NSRunningApplication(processIdentifier: pid_t(pid))
    }
    if windowId > 0 {
      let wins = listWindows(windowIdFilter: windowId, includeOffscreen: true)
      if let wPid = wins.first?["pid"] as? Int, wPid > 0 {
        return NSRunningApplication(processIdentifier: pid_t(wPid))
      }
      return nil
    }
    let apps = NSWorkspace.shared.runningApplications.filter { !$0.isTerminated }
    if !bundleId.isEmpty {
      if let exact = apps.first(where: { ($0.bundleIdentifier ?? "").caseInsensitiveCompare(bundleId) == .orderedSame }) {
        return exact
      }
      return nil
    }
    if !appName.isEmpty {
      let needle = appName.lowercased()
      if let exact = apps.first(where: { ($0.localizedName ?? "").lowercased() == needle }) {
        return exact
      }
      if let partial = apps.first(where: {
        ($0.localizedName ?? "").lowercased().contains(needle)
          || ($0.bundleIdentifier ?? "").lowercased().contains(needle)
      }) {
        return partial
      }
      return nil
    }
    return NSWorkspace.shared.frontmostApplication
  }

  private func activateRunningApp(_ app: NSRunningApplication) {
    app.unhide()
    if AXIsProcessTrusted() {
      let appElem = AXUIElementCreateApplication(app.processIdentifier)
      AXUIElementSetMessagingTimeout(appElem, 1.0)
      _ = AXUIElementSetAttributeValue(appElem, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
    }
    if #available(macOS 14.0, *) {
      _ = app.activate()
    } else {
      _ = app.activate(options: [.activateIgnoringOtherApps])
    }
    if !app.isActive {
      let proc = Process()
      proc.executableURL = URL(fileURLWithPath: "/usr/bin/open")
      if let bid = app.bundleIdentifier, !bid.isEmpty {
        proc.arguments = ["-b", bid]
      } else if let url = app.bundleURL {
        proc.arguments = ["-a", url.path]
      }
      if proc.arguments != nil {
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        try? proc.run()
        proc.waitUntilExit()
      }
    }
  }

  func launchOrFocusApp(appName: String, bundleId: String, waitMs: Int = 4000) throws -> [String: Any] {
    if let existing = resolveTargetApp(appName: appName, bundleId: bundleId),
       (!appName.isEmpty || !bundleId.isEmpty)
    {
      let matchesExplicit: Bool = {
        if !bundleId.isEmpty {
          return (existing.bundleIdentifier ?? "").caseInsensitiveCompare(bundleId) == .orderedSame
        }
        let needle = appName.lowercased()
        let name = (existing.localizedName ?? "").lowercased()
        return name == needle || name.contains(needle)
      }()
      if matchesExplicit {
        activateRunningApp(existing)
        Thread.sleep(forTimeInterval: 0.15)
        let pid = Int(existing.processIdentifier)
        return [
          "launched": false,
          "activated": true,
          "name": existing.localizedName ?? appName,
          "bundleId": existing.bundleIdentifier ?? bundleId,
          "pid": pid,
          "windows": listWindows(pidFilter: pid),
        ]
      }
    }

    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    if !bundleId.isEmpty {
      proc.arguments = ["-b", bundleId]
    } else if !appName.isEmpty {
      proc.arguments = ["-a", appName]
    } else {
      throw NSError(domain: "ufoo.mac", code: 400, userInfo: [NSLocalizedDescriptionKey: "Provide app or bundleId to launch_app"])
    }
    let errPipe = Pipe()
    proc.standardError = errPipe
    try proc.run()
    proc.waitUntilExit()
    if proc.terminationStatus != 0 {
      let errText = String(data: errPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "open failed"
      throw NSError(domain: "ufoo.mac", code: 404, userInfo: [NSLocalizedDescriptionKey: errText])
    }

    let deadline = CFAbsoluteTimeGetCurrent() + Double(max(200, min(waitMs, 15000))) / 1000.0
    var target: NSRunningApplication?
    while CFAbsoluteTimeGetCurrent() < deadline {
      if let found = resolveTargetApp(appName: appName, bundleId: bundleId) {
        let okMatch = !bundleId.isEmpty
          ? (found.bundleIdentifier ?? "").caseInsensitiveCompare(bundleId) == .orderedSame
          : (found.localizedName ?? "").lowercased().contains(appName.lowercased())
        if okMatch {
          target = found
          activateRunningApp(found)
          let wins = listWindows(pidFilter: Int(found.processIdentifier))
          if !wins.isEmpty { break }
        }
      }
      Thread.sleep(forTimeInterval: 0.12)
    }

    let pid = Int(target?.processIdentifier ?? 0)
    return [
      "launched": true,
      "activated": target?.isActive ?? false,
      "name": target?.localizedName ?? appName,
      "bundleId": target?.bundleIdentifier ?? bundleId,
      "pid": pid,
      "windows": pid > 0 ? listWindows(pidFilter: pid) : [],
    ]
  }

  func focusAppOrWindow(appName: String = "", bundleId: String = "", pid: Int = 0, windowId: Int = 0) throws -> [String: Any] {
    guard let app = resolveTargetApp(appName: appName, bundleId: bundleId, pid: pid, windowId: windowId) else {
      throw NSError(domain: "ufoo.mac", code: 404, userInfo: [NSLocalizedDescriptionKey: "Target application not found"])
    }
    var targetWindow: AXUIElement?
    if windowId > 0 {
      guard AXIsProcessTrusted() else {
        throw NSError(domain: "ufoo.mac.permission", code: 403, userInfo: [
          NSLocalizedDescriptionKey: "Accessibility permission is required to focus a specific window.",
          "permission": "accessibility",
        ])
      }
      let appElem = AXUIElementCreateApplication(app.processIdentifier)
      AXUIElementSetMessagingTimeout(appElem, 1.5)
      let axWins = (axCopyAttr(appElem, kAXWindowsAttribute) as? [AXUIElement]) ?? []
      targetWindow = snapshotWindow(axWins, windowId: windowId, rootIndex: 0) { w in
        var wid: CGWindowID = 0
        return _AXUIElementGetWindow(w, &wid) == .success ? Int(wid) : 0
      }
      guard targetWindow != nil else {
        throw NSError(domain: "ufoo.mac.stale", code: 409, userInfo: [NSLocalizedDescriptionKey: "Target window no longer exists; take a fresh snapshot."])
      }
    }
    activateRunningApp(app)
    if let window = targetWindow {
      let raised = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
      guard raised == .success else {
        throw NSError(domain: "ufoo.mac", code: 422, userInfo: [NSLocalizedDescriptionKey: "Could not focus target window (AXError \(raised.rawValue))."])
      }
      _ = AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
    }
    Thread.sleep(forTimeInterval: 0.08)
    guard app.isActive else {
      throw NSError(domain: "ufoo.mac", code: 409, userInfo: [NSLocalizedDescriptionKey: "Target application did not become active; input was not sent."])
    }
    let resolvedPid = Int(app.processIdentifier)
    return [
      "name": app.localizedName ?? "",
      "bundleId": app.bundleIdentifier ?? "",
      "pid": resolvedPid,
      "windows": listWindows(pidFilter: resolvedPid),
    ]
  }

  func manageWindow(action: String, appName: String = "", bundleId: String = "", pid: Int = 0, windowId: Int = 0, x: Double?, y: Double?, width: Double?, height: Double?) throws -> [String: Any] {
    guard AXIsProcessTrusted() else {
      throw NSError(domain: "ufoo.mac.permission", code: 403, userInfo: [
        NSLocalizedDescriptionKey: "Accessibility permission is required to manage windows. Run `ufoo mac permissions` to grant access.",
        "permission": "accessibility",
      ])
    }
    guard let app = resolveTargetApp(appName: appName, bundleId: bundleId, pid: pid, windowId: windowId) else {
      throw NSError(domain: "ufoo.mac", code: 404, userInfo: [NSLocalizedDescriptionKey: "Target application not found"])
    }
    let appElem = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(appElem, 1.5)
    guard let axWins = axCopyAttr(appElem, kAXWindowsAttribute) as? [AXUIElement], !axWins.isEmpty else {
      throw NSError(domain: "ufoo.mac", code: 404, userInfo: [NSLocalizedDescriptionKey: "No accessible window found for \(app.localizedName ?? "application")"])
    }
    var targetWin = axWins[0]
    var matchedWid: Int = 0
    if windowId > 0 {
      var found = false
      for w in axWins {
        var wid: CGWindowID = 0
        if _AXUIElementGetWindow(w, &wid) == .success && Int(wid) == windowId {
          targetWin = w
          matchedWid = Int(wid)
          found = true
          break
        }
      }
      if !found {
        throw NSError(domain: "ufoo.mac", code: 404, userInfo: [NSLocalizedDescriptionKey: "Window \(windowId) not found in \(app.localizedName ?? "application")"])
      }
    } else {
      var wid: CGWindowID = 0
      if _AXUIElementGetWindow(targetWin, &wid) == .success {
        matchedWid = Int(wid)
      }
    }

    switch action {
    case "focus":
      activateRunningApp(app)
      _ = AXUIElementPerformAction(targetWin, kAXRaiseAction as CFString)
      _ = AXUIElementSetAttributeValue(targetWin, kAXMainAttribute as CFString, kCFBooleanTrue)
    case "move", "resize", "set_bounds":
      if let nx = x, let ny = y {
        var pt = CGPoint(x: nx, y: ny)
        if let val = AXValueCreate(.cgPoint, &pt) {
          _ = AXUIElementSetAttributeValue(targetWin, kAXPositionAttribute as CFString, val)
        }
      }
      if let nw = width, let nh = height {
        var sz = CGSize(width: max(80, nw), height: max(60, nh))
        if let val = AXValueCreate(.cgSize, &sz) {
          _ = AXUIElementSetAttributeValue(targetWin, kAXSizeAttribute as CFString, val)
        }
      }
    case "minimize":
      _ = AXUIElementSetAttributeValue(targetWin, kAXMinimizedAttribute as CFString, kCFBooleanTrue)
    case "close":
      if let closeBtn = axCopyAttr(targetWin, kAXCloseButtonAttribute) {
        _ = AXUIElementPerformAction(closeBtn as! AXUIElement, kAXPressAction as CFString)
      } else {
        throw NSError(domain: "ufoo.mac", code: 400, userInfo: [NSLocalizedDescriptionKey: "Window does not expose a close button"])
      }
    case "fullscreen":
      let cur = axBool(targetWin, "AXFullScreen")
      _ = AXUIElementSetAttributeValue(targetWin, "AXFullScreen" as CFString, (!cur) as CFBoolean)
    default:
      throw NSError(domain: "ufoo.mac", code: 400, userInfo: [NSLocalizedDescriptionKey: "Unsupported windowAction: \(action)"])
    }

    Thread.sleep(forTimeInterval: 0.08)
    let frame = axFrame(targetWin) ?? .zero
    return [
      "windowAction": action,
      "windowId": matchedWid,
      "app": app.localizedName ?? "",
      "pid": Int(app.processIdentifier),
      "bounds": rectDict(frame),
    ]
  }

  // MARK: - AX Snapshot & AX Action

  func snapshotAX(
    appName: String = "",
    bundleId: String = "",
    pid: Int = 0,
    windowId: Int = 0,
    maxDepth: Int = 7,
    maxNodes: Int = 350,
    interactiveOnly: Bool = false,
    includeMenuBar: Bool = false,
    query: String = ""
  ) throws -> [String: Any] {
    guard AXIsProcessTrusted() else {
      throw NSError(domain: "ufoo.mac.permission", code: 403, userInfo: [
        NSLocalizedDescriptionKey: "Accessibility permission is required for UI tree snapshots. Run `ufoo mac permissions` to grant access.",
        "permission": "accessibility",
      ])
    }
    guard let app = resolveTargetApp(appName: appName, bundleId: bundleId, pid: pid, windowId: windowId) else {
      throw NSError(domain: "ufoo.mac", code: 404, userInfo: [NSLocalizedDescriptionKey: "Target application not found"])
    }
    let targetPid = app.processIdentifier
    let appElem = AXUIElementCreateApplication(targetPid)
    AXUIElementSetMessagingTimeout(appElem, 1.5)
    // Wake Chromium / Electron accessibility trees when queried
    _ = AXUIElementSetAttributeValue(appElem, "AXManualAccessibility" as CFString, kCFBooleanTrue)

    let boundedDepth = max(1, min(maxDepth, 14))
    let boundedNodes = max(20, min(maxNodes, 1000))
    let queryLower = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()

    var roots: [(rootKind: String, rootIndex: Int, winId: Int, elem: AXUIElement)] = []
    if let axWins = axCopyAttr(appElem, kAXWindowsAttribute) as? [AXUIElement] {
      for (idx, w) in axWins.enumerated() {
        var wid: CGWindowID = 0
        _ = _AXUIElementGetWindow(w, &wid)
        if windowId > 0 && Int(wid) != windowId { continue }
        roots.append(("window", idx, Int(wid), w))
      }
    }
    if includeMenuBar, let menuBar = axCopyAttr(appElem, kAXMenuBarAttribute) {
      roots.append(("menubar", 0, 0, menuBar as! AXUIElement))
    }

    var elements: [[String: Any]] = []
    var truncated = false

    func visit(_ elem: AXUIElement, rootKind: String, rootIndex: Int, winId: Int, path: [Int], depth: Int) {
      if elements.count >= boundedNodes {
        truncated = true
        return
      }
      let role = axString(elem, kAXRoleAttribute)
      let subrole = axString(elem, kAXSubroleAttribute)
      let title = axString(elem, kAXTitleAttribute)
      let desc = axString(elem, kAXDescriptionAttribute)
      let rawVal = axString(elem, kAXValueAttribute)
      let val = rawVal.count > 120 ? String(rawVal.prefix(120)) + "…" : rawVal
      let ident = axString(elem, "AXIdentifier")
      let actions = axActions(elem)
      let frame = axFrame(elem)
      let enabled = axBool(elem, kAXEnabledAttribute, defaultValue: true)
      let focused = axBool(elem, kAXFocusedAttribute, defaultValue: false)

      let isInteractive = INTERACTIVE_ROLES.contains(role) || !actions.isEmpty
      let hasSemanticText = !title.isEmpty || !desc.isEmpty || (!val.isEmpty && role != "AXGroup")
      let shouldConsider = depth == 0 || (interactiveOnly ? isInteractive : (isInteractive || hasSemanticText))

      let matchesQuery: Bool = {
        if queryLower.isEmpty { return true }
        let hay = "\(role) \(subrole) \(title) \(desc) \(val) \(ident)".lowercased()
        return hay.contains(queryLower)
      }()

      if shouldConsider && matchesQuery {
        var item: [String: Any] = [
          "role": role.isEmpty ? "AXElement" : role,
          "depth": depth,
          "rootKind": rootKind,
          "rootIndex": rootIndex,
          "windowId": winId,
          "axPath": path,
          "enabled": enabled,
          "focused": focused,
          "actions": actions,
        ]
        if !subrole.isEmpty { item["subrole"] = subrole }
        if !title.isEmpty { item["title"] = title }
        if !desc.isEmpty && desc != title { item["label"] = desc }
        if !val.isEmpty && val != title { item["value"] = val }
        if !ident.isEmpty { item["identifier"] = ident }
        if let f = frame, f.width > 0, f.height > 0 {
          item["frame"] = rectDict(f)
          item["center"] = [
            "x": Int(f.midX.rounded()),
            "y": Int(f.midY.rounded()),
          ]
        }
        elements.append(item)
      }

      if depth >= boundedDepth { return }
      let children = axChildren(elem)
      for (cIdx, child) in children.enumerated() {
        if elements.count >= boundedNodes {
          truncated = true
          return
        }
        visit(child, rootKind: rootKind, rootIndex: rootIndex, winId: winId, path: path + [cIdx], depth: depth + 1)
      }
    }

    for root in roots {
      visit(root.elem, rootKind: root.rootKind, rootIndex: root.rootIndex, winId: root.winId, path: [], depth: 0)
      if truncated { break }
    }

    return [
      "app": app.localizedName ?? "",
      "bundleId": app.bundleIdentifier ?? "",
      "pid": Int(targetPid),
      "windowCount": roots.filter { $0.rootKind == "window" }.count,
      "truncated": truncated,
      "elements": elements,
    ]
  }

  func performAXAction(
    pid: Int,
    rootKind: String,
    rootIndex: Int,
    windowId: Int,
    axPath: [Int],
    expectedRole: String = "",
    axAction: String,
    value: String = ""
  ) throws -> [String: Any] {
    guard AXIsProcessTrusted() else {
      throw NSError(domain: "ufoo.mac.permission", code: 403, userInfo: [
        NSLocalizedDescriptionKey: "Accessibility permission is required for ax_action.",
        "permission": "accessibility",
      ])
    }
    let appElem = AXUIElementCreateApplication(pid_t(pid))
    AXUIElementSetMessagingTimeout(appElem, 1.5)

    var current: AXUIElement?
    if rootKind == "menubar" {
      if let mb = axCopyAttr(appElem, kAXMenuBarAttribute) {
        current = (mb as! AXUIElement)
      }
    } else if let axWins = axCopyAttr(appElem, kAXWindowsAttribute) as? [AXUIElement] {
      current = snapshotWindow(axWins, windowId: windowId, rootIndex: rootIndex) { w in
        var wid: CGWindowID = 0
        return _AXUIElementGetWindow(w, &wid) == .success ? Int(wid) : 0
      }
    }

    guard var elem = current else {
      throw NSError(domain: "ufoo.mac.stale", code: 409, userInfo: [
        NSLocalizedDescriptionKey: "Target window/menu root no longer exists; take a fresh snapshot.",
      ])
    }

    for idx in axPath {
      let children = axChildren(elem)
      guard idx >= 0 && idx < children.count else {
        throw NSError(domain: "ufoo.mac.stale", code: 409, userInfo: [
          NSLocalizedDescriptionKey: "UI hierarchy changed since snapshot; call snapshot again to refresh element refs.",
        ])
      }
      elem = children[idx]
    }

    let actualRole = axString(elem, kAXRoleAttribute)
    if !expectedRole.isEmpty && !actualRole.isEmpty && actualRole != expectedRole {
      throw NSError(domain: "ufoo.mac.stale", code: 409, userInfo: [
        NSLocalizedDescriptionKey: "Element at snapshot path changed from \(expectedRole) to \(actualRole); call snapshot again.",
      ])
    }

    if let frame = axFrame(elem), frame.width > 1, frame.height > 1 {
      hud.flashHighlight(cgRect: frame)
    }

    let err: AXError
    switch axAction {
    case "press":
      err = AXUIElementPerformAction(elem, kAXPressAction as CFString)
    case "confirm":
      err = AXUIElementPerformAction(elem, kAXConfirmAction as CFString)
    case "cancel":
      err = AXUIElementPerformAction(elem, kAXCancelAction as CFString)
    case "pick":
      err = AXUIElementPerformAction(elem, kAXPickAction as CFString)
    case "show_menu":
      err = AXUIElementPerformAction(elem, kAXShowMenuAction as CFString)
    case "increment":
      err = AXUIElementPerformAction(elem, kAXIncrementAction as CFString)
    case "decrement":
      err = AXUIElementPerformAction(elem, kAXDecrementAction as CFString)
    case "focus":
      if let app = NSRunningApplication(processIdentifier: pid_t(pid)) {
        activateRunningApp(app)
      }
      err = AXUIElementSetAttributeValue(elem, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    case "set_value":
      err = AXUIElementSetAttributeValue(elem, kAXValueAttribute as CFString, value as CFTypeRef)
    default:
      throw NSError(domain: "ufoo.mac", code: 400, userInfo: [NSLocalizedDescriptionKey: "Unsupported axAction: \(axAction)"])
    }

    if err != .success {
      throw NSError(domain: "ufoo.mac", code: 422, userInfo: [
        NSLocalizedDescriptionKey: "AX action '\(axAction)' failed on \(actualRole.isEmpty ? "element" : actualRole) (AXError \(err.rawValue)). Try click with ref or coordinates if the control is custom-rendered.",
      ])
    }

    let updatedFrame = axFrame(elem)
    var out: [String: Any] = [
      "axAction": axAction,
      "role": actualRole,
      "title": axString(elem, kAXTitleAttribute),
    ]
    if let f = updatedFrame {
      out["frame"] = rectDict(f)
    }
    return out
  }

  // MARK: - Screenshot (Shadowless Window / Region / Display + 1x Logical Scaling)

  func captureScreenshot(
    outputPath: String,
    appName: String = "",
    bundleId: String = "",
    pid: Int = 0,
    windowId: Int = 0,
    displayIndex: Int = 1,
    region: CGRect? = nil,
    retina: Bool = false
  ) throws -> [String: Any] {
    guard CGPreflightScreenCaptureAccess() else {
      throw NSError(domain: "ufoo.mac.permission", code: 403, userInfo: [
        NSLocalizedDescriptionKey: "Screen Recording permission is required to capture Mac screenshots. Run `ufoo mac permissions` and grant Screen Recording to your terminal/host app, then restart if prompted.",
        "permission": "screen_recording",
      ])
    }

    var resolvedWindowId = windowId
    var windowMeta: [String: Any]?
    if resolvedWindowId > 0 {
      windowMeta = listWindows(windowIdFilter: resolvedWindowId, includeOffscreen: true).first
      if windowMeta == nil {
        throw NSError(domain: "ufoo.mac", code: 404, userInfo: [NSLocalizedDescriptionKey: "Window \(resolvedWindowId) not found"])
      }
    } else if !appName.isEmpty || !bundleId.isEmpty || pid > 0 {
      let wins = listWindows(appFilter: appName, bundleIdFilter: bundleId, pidFilter: pid, includeOffscreen: false)
      guard let first = wins.first, let wid = first["windowId"] as? Int else {
        throw NSError(domain: "ufoo.mac", code: 404, userInfo: [NSLocalizedDescriptionKey: "No visible on-screen window found for requested app"])
      }
      resolvedWindowId = wid
      windowMeta = first
    }

    var logicalBounds = CGRect.zero
    var captureKind = "screen"
    var args: [String] = ["-x"]

    if let reg = region, reg.width > 1, reg.height > 1 {
      captureKind = "region"
      logicalBounds = reg
      let rx = Int(reg.origin.x.rounded())
      let ry = Int(reg.origin.y.rounded())
      let rw = max(1, Int(reg.size.width.rounded()))
      let rh = max(1, Int(reg.size.height.rounded()))
      args.append("-R\(rx),\(ry),\(rw),\(rh)")
    } else if resolvedWindowId > 0, let meta = windowMeta {
      captureKind = "window"
      if let b = meta["bounds"] as? [String: Int] {
        logicalBounds = CGRect(
          x: b["x"] ?? 0,
          y: b["y"] ?? 0,
          width: b["width"] ?? 0,
          height: b["height"] ?? 0
        )
      }
      args.append(contentsOf: ["-o", "-l\(resolvedWindowId)"])
    } else {
      let screens = collectDisplays()
      let chosen = screens.first(where: { ($0["index"] as? Int) == displayIndex }) ?? screens.first
      if let b = chosen?["bounds"] as? [String: Int] {
        logicalBounds = CGRect(
          x: b["x"] ?? 0,
          y: b["y"] ?? 0,
          width: b["width"] ?? 1440,
          height: b["height"] ?? 900
        )
      }
      let idx = (chosen?["index"] as? Int) ?? 1
      args.append("-D\(idx)")
    }

    let rawTempPath = outputPath + ".raw.png"
    defer { try? FileManager.default.removeItem(atPath: rawTempPath) }

    // Ensure HUD overlays are completely hidden around capture
    hud.hideImmediatelySync()

    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    proc.arguments = args + [rawTempPath]
    let errPipe = Pipe()
    proc.standardError = errPipe
    try proc.run()
    proc.waitUntilExit()
    if proc.terminationStatus != 0 || !FileManager.default.fileExists(atPath: rawTempPath) {
      let errStr = String(data: errPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "screencapture failed"
      throw NSError(domain: "ufoo.mac", code: 500, userInfo: [NSLocalizedDescriptionKey: "Screenshot capture failed: \(errStr)"])
    }

    let rawURL = URL(fileURLWithPath: rawTempPath)
    guard let src = CGImageSourceCreateWithURL(rawURL as CFURL, nil),
          let cgImg = CGImageSourceCreateImageAtIndex(src, 0, nil)
    else {
      throw NSError(domain: "ufoo.mac", code: 500, userInfo: [NSLocalizedDescriptionKey: "Failed to decode captured screenshot"])
    }

    let targetW: Int
    let targetH: Int
    if !retina && logicalBounds.width > 1 && logicalBounds.height > 1 && cgImg.width > Int(logicalBounds.width * 1.05) {
      targetW = max(1, Int(logicalBounds.width.rounded()))
      targetH = max(1, Int(logicalBounds.height.rounded()))
    } else {
      targetW = cgImg.width
      targetH = cgImg.height
      if logicalBounds.width <= 1 || logicalBounds.height <= 1 {
        logicalBounds = CGRect(x: logicalBounds.origin.x, y: logicalBounds.origin.y, width: CGFloat(targetW), height: CGFloat(targetH))
      }
    }

    var finalImage = cgImg
    if targetW != cgImg.width || targetH != cgImg.height {
      let colorSpace = CGColorSpaceCreateDeviceRGB()
      if let ctx = CGContext(
        data: nil,
        width: targetW,
        height: targetH,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
      ) {
        ctx.interpolationQuality = .high
        ctx.draw(cgImg, in: CGRect(x: 0, y: 0, width: targetW, height: targetH))
        if let scaled = ctx.makeImage() {
          finalImage = scaled
        }
      }
    }

    let outURL = URL(fileURLWithPath: outputPath)
    var mediaType = "image/png"
    guard let pngDest = CGImageDestinationCreateWithURL(outURL as CFURL, UTType.png.identifier as CFString, 1, nil) else {
      throw NSError(domain: "ufoo.mac", code: 500, userInfo: [NSLocalizedDescriptionKey: "Failed to create PNG image destination"])
    }
    CGImageDestinationAddImage(pngDest, finalImage, nil)
    guard CGImageDestinationFinalize(pngDest) else {
      throw NSError(domain: "ufoo.mac", code: 500, userInfo: [NSLocalizedDescriptionKey: "Failed to write PNG screenshot"])
    }

    // Keep well below the 5 MiB provider vision limit
    let attrs = try FileManager.default.attributesOfItem(atPath: outputPath)
    let sizeBytes = (attrs[.size] as? NSNumber)?.intValue ?? 0
    var finalPath = outputPath
    if sizeBytes > 4_600_000 {
      let jpgPath = (outputPath as NSString).deletingPathExtension + ".jpg"
      let jpgURL = URL(fileURLWithPath: jpgPath)
      if let jpgDest = CGImageDestinationCreateWithURL(jpgURL as CFURL, UTType.jpeg.identifier as CFString, 1, nil) {
        let props = [kCGImageDestinationLossyCompressionQuality: 0.84] as CFDictionary
        CGImageDestinationAddImage(jpgDest, finalImage, props)
        if CGImageDestinationFinalize(jpgDest) {
          try? FileManager.default.removeItem(atPath: outputPath)
          finalPath = jpgPath
          mediaType = "image/jpeg"
        }
      }
    }

    let scaleX = Double(logicalBounds.width) / Double(max(1, finalImage.width))
    let scaleY = Double(logicalBounds.height) / Double(max(1, finalImage.height))

    var result: [String: Any] = [
      "captureKind": captureKind,
      "coordinateSpace": (captureKind == "screen" && logicalBounds.origin.x == 0 && logicalBounds.origin.y == 0) ? "screen" : "window",
      "bounds": rectDict(logicalBounds),
      "imageWidth": finalImage.width,
      "imageHeight": finalImage.height,
      "scaleX": scaleX,
      "scaleY": scaleY,
      "path": finalPath,
      "mediaType": mediaType,
    ]
    if resolvedWindowId > 0 {
      result["windowId"] = resolvedWindowId
    }
    if let meta = windowMeta {
      result["app"] = meta["app"] ?? ""
      result["title"] = meta["title"] ?? ""
      result["pid"] = meta["pid"] ?? 0
    }
    return result
  }

  // MARK: - Agent Mouse & Keyboard Injection (CGEvent + Smooth Glide + Takeover Guard)

  private func ensureAccessibilityForInput() throws {
    guard AXIsProcessTrusted() else {
      throw NSError(domain: "ufoo.mac.permission", code: 403, userInfo: [
        NSLocalizedDescriptionKey: "Accessibility permission is required to control the Mac mouse/keyboard. Run `ufoo mac permissions` to grant access.",
        "permission": "accessibility",
      ])
    }
  }

  private func throwTakeover(_ st: TakeoverMonitor.TakeoverState) throws -> Never {
    throw NSError(domain: "ufoo.mac.takeover", code: 409, userInfo: [
      NSLocalizedDescriptionKey: "Agent yielded control (\(st.reason)): \(st.detail). Stop current GUI actions and ask or wait for the user before continuing.",
      "reason": st.reason,
      "detail": st.detail,
    ])
  }

  private func resolveInputTarget(params: [String: Any], point: CGPoint?) throws -> InputTarget {
    let pid = (params["pid"] as? NSNumber)?.intValue ?? 0
    let windowId = (params["windowId"] as? NSNumber)?.intValue ?? 0
    let app = (params["app"] as? String) ?? ""
    let bundleId = (params["bundleId"] as? String) ?? ""
    let explicit = pid > 0 || windowId > 0 || !app.isEmpty || !bundleId.isEmpty
    let windows = listWindows(appFilter: app, bundleIdFilter: bundleId, pidFilter: pid,
                              windowIdFilter: windowId, includeOffscreen: explicit)
    func bounds(_ window: [String: Any]) -> CGRect {
      let b = (window["bounds"] as? [String: Int]) ?? [:]
      return CGRect(x: b["x"] ?? 0, y: b["y"] ?? 0, width: b["width"] ?? 0, height: b["height"] ?? 0)
    }
    // Coordinates without an explicit target hit-test a window, never the
    // physical pointer or whichever application happens to be frontmost.
    let window = point.flatMap { p in windows.first(where: { bounds($0).contains(p) }) }
      ?? (explicit ? windows.first : nil)
    guard let selected = window, let targetPid = selected["pid"] as? Int,
          let targetId = selected["windowId"] as? Int, targetPid > 0,
          targetPid != Int(getpid()), targetId > 0 else {
      throw NSError(domain: "ufoo.mac", code: 404, userInfo: [NSLocalizedDescriptionKey:
        "No target window found for independent input. Specify app/windowId or take a fresh snapshot; system input is never used as a fallback."])
    }
    return InputTarget(pid: pid_t(targetPid), windowId: targetId, bounds: bounds(selected))
  }

  private func postTagged(_ event: CGEvent?, flags: CGEventFlags? = nil) throws {
    guard let original = event, let target = inputTarget else {
      throw NSError(domain: "ufoo.mac", code: 400, userInfo: [NSLocalizedDescriptionKey: "Input requires a live target window."])
    }
    let cleanFlags = flags ?? []
    let ev: CGEvent
    if original.type == .keyDown || original.type == .keyUp {
      ev = original
    } else {
      guard let setWindowLocation = setEventWindowLocation else {
        throw NSError(domain: "ufoo.mac.independent", code: 501, userInfo: [NSLocalizedDescriptionKey:
          "Independent mouse input is unavailable on this macOS version. Use Accessibility actions; system mouse fallback is disabled."])
      }
      // NSEvent supplies both the window number and window-local coordinates.
      // Posting that event to the PID avoids WindowServer's physical HID path.
      let local = NSPoint(x: original.location.x - target.bounds.minX,
                          y: target.bounds.maxY - original.location.y)
      let type = original.type == .scrollWheel ? NSEvent.EventType.mouseMoved
        : NSEvent.EventType(rawValue: UInt(original.type.rawValue))
      guard let type = type,
            let routed = NSEvent.mouseEvent(with: type, location: local,
              modifierFlags: NSEvent.ModifierFlags(rawValue: UInt(cleanFlags.rawValue)),
              timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: target.windowId,
              context: nil, eventNumber: 0,
              clickCount: Int(original.getIntegerValueField(.mouseEventClickState)), pressure: 1)?.cgEvent else {
        throw NSError(domain: "ufoo.mac", code: 422, userInfo: [NSLocalizedDescriptionKey: "Could not construct a window-targeted mouse event."])
      }
      ev = routed
      ev.location = original.location
      ev.type = original.type
      setWindowLocation(ev, original.location.x - target.bounds.minX, original.location.y - target.bounds.minY)
      ev.setIntegerValueField(.mouseEventSubtype, value: 3)
      ev.setIntegerValueField(.mouseEventButtonNumber, value: original.getIntegerValueField(.mouseEventButtonNumber))
      ev.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(target.windowId))
      ev.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(target.windowId))
      if original.type == .scrollWheel {
        for field: CGEventField in [.scrollWheelEventDeltaAxis1, .scrollWheelEventDeltaAxis2,
          .scrollWheelEventFixedPtDeltaAxis1, .scrollWheelEventFixedPtDeltaAxis2,
          .scrollWheelEventPointDeltaAxis1, .scrollWheelEventPointDeltaAxis2, .scrollWheelEventIsContinuous] {
          ev.setIntegerValueField(field, value: original.getIntegerValueField(field))
        }
      }
    }
    ev.flags = cleanFlags
    ev.setIntegerValueField(.eventSourceUserData, value: UFOO_EVENT_TAG)
    ev.postToPid(target.pid)
  }

  private func glideCursor(to target: CGPoint, eventType: CGEventType = .mouseMoved, button: CGMouseButton = .left, actionLabel: String = "Move", durationMs: Int = 135, flags: CGEventFlags = []) throws {
    let start = agentPoint ?? target
    let dist = hypot(target.x - start.x, target.y - start.y)
    let steps = dist < 4 ? 1 : max(4, min(14, Int((dist / 45.0).rounded()) + 4))
    let stepSleep = Double(max(16, durationMs)) / 1000.0 / Double(steps)
    let src = CGEventSource(stateID: .privateState)

    for i in 1...steps {
      if let tk = takeover.checkStepOrAbort(expectedNear: nil) {
        try throwTakeover(tk)
      }
      let t = CGFloat(i) / CGFloat(steps)
      // Cubic ease-out: 1 - (1 - t)^3
      let eased = 1.0 - pow(1.0 - t, 3.0)
      let pt = CGPoint(
        x: start.x + (target.x - start.x) * eased,
        y: start.y + (target.y - start.y) * eased
      )
      takeover.recordAgentMouseStep(pt)
      let ev = CGEvent(mouseEventSource: src, mouseType: eventType, mouseCursorPosition: pt, mouseButton: button)
      try postTagged(ev, flags: flags)
      hud.updateCursor(cgPoint: pt, actionLabel: actionLabel)
      agentPoint = pt
      if i < steps {
        Thread.sleep(forTimeInterval: stepSleep)
      }
    }
  }

  func mouseMove(to target: CGPoint, turnScope: String = "") throws -> [String: Any] {
    try ensureAccessibilityForInput()
    takeover.syncTurnScope(turnScope)
    if let tk = takeover.beginAgentInput(at: nil) {
      try throwTakeover(tk)
    }
    defer { takeover.endAgentInput(finalPoint: target) }

    try glideCursor(to: target, eventType: .mouseMoved, button: .left, actionLabel: "Move")
    return ["x": Int(target.x.rounded()), "y": Int(target.y.rounded())]
  }

  func mouseClick(
    at target: CGPoint,
    buttonName: String = "left",
    clickCount: Int = 1,
    modifiersRaw: [String] = [],
    turnScope: String = ""
  ) throws -> [String: Any] {
    try ensureAccessibilityForInput()
    takeover.syncTurnScope(turnScope)
    if let tk = takeover.beginAgentInput(at: nil) {
      try throwTakeover(tk)
    }
    defer { takeover.endAgentInput(finalPoint: target) }

    let isRight = buttonName == "right"
    let isMiddle = buttonName == "middle"
    let cgButton: CGMouseButton = isRight ? .right : (isMiddle ? .center : .left)
    let downType: CGEventType = isRight ? .rightMouseDown : (isMiddle ? .otherMouseDown : .leftMouseDown)
    let upType: CGEventType = isRight ? .rightMouseUp : (isMiddle ? .otherMouseUp : .leftMouseUp)
    let count = max(1, min(clickCount, 3))
    let label = isRight ? "Right Click" : (count == 2 ? "Double Click" : (count == 3 ? "Triple Click" : "Click"))

    try glideCursor(to: target, eventType: .mouseMoved, button: .left, actionLabel: label)
    if let tk = takeover.checkStepOrAbort(expectedNear: nil) {
      try throwTakeover(tk)
    }

    let flags = parseModifierFlags(modifiersRaw)
    let src = CGEventSource(stateID: .privateState)
    hud.pulseClick(cgPoint: target, actionLabel: label, rightClick: isRight, doubleClick: count >= 2)

    for c in 1...count {
      let down = CGEvent(mouseEventSource: src, mouseType: downType, mouseCursorPosition: target, mouseButton: cgButton)
      down?.setIntegerValueField(.mouseEventClickState, value: Int64(c))
      try postTagged(down, flags: flags)
      Thread.sleep(forTimeInterval: 0.028)
      let up = CGEvent(mouseEventSource: src, mouseType: upType, mouseCursorPosition: target, mouseButton: cgButton)
      up?.setIntegerValueField(.mouseEventClickState, value: Int64(c))
      try postTagged(up, flags: flags)
      if c < count {
        Thread.sleep(forTimeInterval: 0.045)
      }
    }

    return [
      "x": Int(target.x.rounded()),
      "y": Int(target.y.rounded()),
      "button": buttonName,
      "clickCount": count,
    ]
  }

  func mouseDrag(
    from startPt: CGPoint,
    to endPt: CGPoint,
    holdMs: Int = 80,
    modifiersRaw: [String] = [],
    turnScope: String = ""
  ) throws -> [String: Any] {
    try ensureAccessibilityForInput()
    takeover.syncTurnScope(turnScope)
    if let tk = takeover.beginAgentInput(at: nil) {
      try throwTakeover(tk)
    }
    defer { takeover.endAgentInput(finalPoint: endPt) }

    let flags = parseModifierFlags(modifiersRaw)
    let src = CGEventSource(stateID: .privateState)

    try glideCursor(to: startPt, eventType: .mouseMoved, button: .left, actionLabel: "Drag")
    hud.pulseClick(cgPoint: startPt, actionLabel: "Drag")
    let down = CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: startPt, mouseButton: .left)
    try postTagged(down, flags: flags)
    Thread.sleep(forTimeInterval: Double(max(30, min(holdMs, 1000))) / 1000.0)

    do {
      try glideCursor(to: endPt, eventType: .leftMouseDragged, button: .left, actionLabel: "Dragging", durationMs: 220, flags: flags)
    } catch {
      // Always release mouse button if aborted mid-drag!
      let cur = agentPoint ?? startPt
      let upAbort = CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: cur, mouseButton: .left)
      try? postTagged(upAbort)
      throw error
    }

    Thread.sleep(forTimeInterval: 0.04)
    let up = CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: endPt, mouseButton: .left)
    try postTagged(up, flags: flags)

    return [
      "from": ["x": Int(startPt.x.rounded()), "y": Int(startPt.y.rounded())],
      "to": ["x": Int(endPt.x.rounded()), "y": Int(endPt.y.rounded())],
    ]
  }

  func mouseScroll(
    at target: CGPoint?,
    deltaX: Int,
    deltaY: Int,
    turnScope: String = ""
  ) throws -> [String: Any] {
    try ensureAccessibilityForInput()
    takeover.syncTurnScope(turnScope)
    if let tk = takeover.beginAgentInput(at: nil) {
      try throwTakeover(tk)
    }
    let retainedPoint = agentPoint.flatMap { inputTarget!.bounds.contains($0) ? $0 : nil }
    let finalPt = target ?? retainedPoint ?? CGPoint(x: inputTarget!.bounds.midX, y: inputTarget!.bounds.midY)
    defer { takeover.endAgentInput(finalPoint: finalPt) }

    if let pt = target {
      try glideCursor(to: pt, eventType: .mouseMoved, button: .left, actionLabel: "Scroll")
    } else {
      hud.updateCursor(cgPoint: finalPt, actionLabel: "Scroll")
    }

    let src = CGEventSource(stateID: .privateState)
    let steps = 4
    let stepY = Int32((Double(deltaY) / Double(steps)).rounded())
    let stepX = Int32((Double(deltaX) / Double(steps)).rounded())
    for _ in 0..<steps {
      if let tk = takeover.checkStepOrAbort(expectedNear: nil) {
        try throwTakeover(tk)
      }
      if let ev = CGEvent(
        scrollWheelEvent2Source: src,
        units: .pixel,
        wheelCount: 2,
        wheel1: stepY,
        wheel2: stepX,
        wheel3: 0
      ) {
        ev.location = finalPt
        try postTagged(ev)
      }
      Thread.sleep(forTimeInterval: 0.018)
    }

    return [
      "x": Int(finalPt.x.rounded()),
      "y": Int(finalPt.y.rounded()),
      "deltaX": deltaX,
      "deltaY": deltaY,
    ]
  }

  func typeText(text: String, submit: Bool = false, turnScope: String = "") throws -> [String: Any] {
    try ensureAccessibilityForInput()
    takeover.syncTurnScope(turnScope)
    if let tk = takeover.beginAgentInput(at: nil) {
      try throwTakeover(tk)
    }
    defer { takeover.endAgentInput(finalPoint: nil) }

    hud.updateCursor(cgPoint: agentPoint ?? CGPoint(x: inputTarget!.bounds.midX, y: inputTarget!.bounds.midY), actionLabel: "Type")
    let src = CGEventSource(stateID: .privateState)

    for ch in text {
      if let tk = takeover.checkStepOrAbort(expectedNear: nil) {
        try throwTakeover(tk)
      }
      if ch == "\n" || ch == "\r" {
        try postTagged(CGEvent(keyboardEventSource: src, virtualKey: 36, keyDown: true))
        try postTagged(CGEvent(keyboardEventSource: src, virtualKey: 36, keyDown: false))
      } else if ch == "\t" {
        try postTagged(CGEvent(keyboardEventSource: src, virtualKey: 48, keyDown: true))
        try postTagged(CGEvent(keyboardEventSource: src, virtualKey: 48, keyDown: false))
      } else {
        var utf16 = Array(String(ch).utf16)
        if let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true),
           let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false)
        {
          down.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
          up.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
          try postTagged(down)
          try postTagged(up)
        }
      }
      Thread.sleep(forTimeInterval: 0.008)
    }

    if submit {
      Thread.sleep(forTimeInterval: 0.025)
      try postTagged(CGEvent(keyboardEventSource: src, virtualKey: 36, keyDown: true))
      try postTagged(CGEvent(keyboardEventSource: src, virtualKey: 36, keyDown: false))
    }

    return [
      "typedLength": text.count,
      "submitted": submit,
    ]
  }

  func pressKey(keyRaw: String, modifiersRaw: [String] = [], repeatCount: Int = 1, turnScope: String = "") throws -> [String: Any] {
    try ensureAccessibilityForInput()
    takeover.syncTurnScope(turnScope)
    if let tk = takeover.beginAgentInput(at: nil) {
      try throwTakeover(tk)
    }
    defer { takeover.endAgentInput(finalPoint: nil) }

    let (codeOpt, flags) = parseKeyAndModifiers(keyRaw: keyRaw, modifiersRaw: modifiersRaw)
    guard let keyCode = codeOpt else {
      throw NSError(domain: "ufoo.mac", code: 400, userInfo: [
        NSLocalizedDescriptionKey: "Unknown key '\(keyRaw)'. Use standard key names like return, escape, tab, space, backspace, up, down, left, right, f1-f12, or single characters a-z / 0-9.",
      ])
    }

    let label = modifiersRaw.isEmpty ? "Key \(keyRaw)" : "Shortcut"
    hud.updateCursor(cgPoint: agentPoint ?? CGPoint(x: inputTarget!.bounds.midX, y: inputTarget!.bounds.midY), actionLabel: label)
    let src = CGEventSource(stateID: .privateState)
    let times = max(1, min(repeatCount, 20))

    for i in 0..<times {
      if let tk = takeover.checkStepOrAbort(expectedNear: nil) {
        try throwTakeover(tk)
      }
      let down = CGEvent(keyboardEventSource: src, virtualKey: keyCode, keyDown: true)
      let up = CGEvent(keyboardEventSource: src, virtualKey: keyCode, keyDown: false)
      try postTagged(down, flags: flags)
      Thread.sleep(forTimeInterval: 0.02)
      try postTagged(up, flags: flags)
      if i + 1 < times {
        Thread.sleep(forTimeInterval: 0.03)
      }
    }

    return [
      "key": keyRaw,
      "modifiers": modifiersRaw,
      "repeat": times,
    ]
  }

  // MARK: - RPC Dispatcher

  func dispatch(method: String, params: [String: Any]) throws -> [String: Any] {
    if let hudFlag = params["hud"] as? Bool {
      hud.enabled = hudFlag
      if !hudFlag { hud.hideImmediatelySync() }
    }
    if let tkFlag = params["takeoverGuard"] as? Bool {
      takeover.setEnabled(tkFlag)
    }
    if let agentLabel = params["agentLabel"] as? String, !agentLabel.isEmpty {
      hud.agentName = agentLabel
    }

    let str = { (key: String) -> String in
      (params[key] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }
    let intVal = { (key: String, def: Int) -> Int in
      if let n = params[key] as? NSNumber { return n.intValue }
      if let s = params[key] as? String, let n = Int(s) { return n }
      return def
    }
    let dblOpt = { (key: String) -> Double? in
      if let n = params[key] as? NSNumber { return n.doubleValue }
      if let s = params[key] as? String, let n = Double(s) { return n }
      return nil
    }
    let boolVal = { (key: String, def: Bool) -> Bool in
      (params[key] as? Bool) ?? def
    }
    let strArr = { (key: String) -> [String] in
      (params[key] as? [String]) ?? []
    }

    inputSession = str("sessionId").isEmpty ? "default" : str("sessionId")
    inputTarget = nil
    if method.hasPrefix("mouse_") || method.hasPrefix("key_") {
      let x = dblOpt("fromX") ?? dblOpt("x")
      let y = dblOpt("fromY") ?? dblOpt("y")
      let point: CGPoint? = x.flatMap { px in y.map { CGPoint(x: px, y: $0) } }
      let target = try resolveInputTarget(params: params, point: point ?? (method == "mouse_scroll" ? agentPoint : nil))
      if method.hasPrefix("key_") {
        let appElement = AXUIElementCreateApplication(target.pid)
        AXUIElementSetMessagingTimeout(appElement, 1.0)
        var focusedId: CGWindowID = 0
        guard let focused = axCopyAttr(appElement, kAXFocusedWindowAttribute),
              _AXUIElementGetWindow(focused as! AXUIElement, &focusedId) == .success,
              Int(focusedId) == target.windowId else {
          throw NSError(domain: "ufoo.mac", code: 409, userInfo: [NSLocalizedDescriptionKey:
            "Target window does not own keyboard focus. Use an AX action or explicitly request focusApp=true; keys were not sent."])
        }
      }
      inputTarget = target
      takeover.setTargetBounds(target.bounds)
    }
    defer { inputTarget = nil }

    func perform() throws -> [String: Any] {
    switch method {
    case "ping", "status":
      return statusPayload(prompt: boolVal("prompt", false), openSettings: boolVal("openSettings", false))

    case "request_permissions":
      return statusPayload(prompt: true, openSettings: boolVal("openSettings", true))

    case "configure":
      return statusPayload()

    case "clear_takeover":
      takeover.clear()
      return statusPayload()

    case "hide_hud":
      hud.hideImmediatelySync()
      return ["hidden": true]

    case "list_apps":
      return ["apps": listApps(includeBackground: boolVal("includeBackground", false))]

    case "list_windows":
      return [
        "windows": listWindows(
          appFilter: str("app"),
          bundleIdFilter: str("bundleId"),
          pidFilter: intVal("pid", 0),
          windowIdFilter: intVal("windowId", 0),
          includeOffscreen: boolVal("includeOffscreen", false)
        ),
      ]

    case "launch_app":
      return try launchOrFocusApp(
        appName: str("app"),
        bundleId: str("bundleId"),
        waitMs: intVal("waitMs", 4000)
      )

    case "focus_app":
      return try focusAppOrWindow(
        appName: str("app"),
        bundleId: str("bundleId"),
        pid: intVal("pid", 0),
        windowId: intVal("windowId", 0)
      )

    case "manage_window":
      return try manageWindow(
        action: str("windowAction"),
        appName: str("app"),
        bundleId: str("bundleId"),
        pid: intVal("pid", 0),
        windowId: intVal("windowId", 0),
        x: dblOpt("x"),
        y: dblOpt("y"),
        width: dblOpt("width"),
        height: dblOpt("height")
      )

    case "snapshot":
      return try snapshotAX(
        appName: str("app"),
        bundleId: str("bundleId"),
        pid: intVal("pid", 0),
        windowId: intVal("windowId", 0),
        maxDepth: intVal("maxDepth", 7),
        maxNodes: intVal("maxNodes", 350),
        interactiveOnly: boolVal("interactiveOnly", false),
        includeMenuBar: boolVal("includeMenuBar", false),
        query: str("query")
      )

    case "ax_action":
      let axPath = (params["axPath"] as? [NSNumber])?.map { $0.intValue } ?? []
      return try performAXAction(
        pid: intVal("pid", 0),
        rootKind: str("rootKind"),
        rootIndex: intVal("rootIndex", 0),
        windowId: intVal("windowId", 0),
        axPath: axPath,
        expectedRole: str("expectedRole"),
        axAction: str("axAction"),
        value: (params["value"] as? String) ?? ""
      )

    case "screenshot":
      var regionRect: CGRect?
      if let reg = params["region"] as? [String: Any],
         let rx = (reg["x"] as? NSNumber)?.doubleValue,
         let ry = (reg["y"] as? NSNumber)?.doubleValue,
         let rw = (reg["width"] as? NSNumber)?.doubleValue,
         let rh = (reg["height"] as? NSNumber)?.doubleValue
      {
        regionRect = CGRect(x: rx, y: ry, width: rw, height: rh)
      }
      return try captureScreenshot(
        outputPath: str("outputPath"),
        appName: str("app"),
        bundleId: str("bundleId"),
        pid: intVal("pid", 0),
        windowId: intVal("windowId", 0),
        displayIndex: intVal("display", 1),
        region: regionRect,
        retina: boolVal("retina", false)
      )

    case "mouse_move":
      guard let x = dblOpt("x"), let y = dblOpt("y") else {
        throw NSError(domain: "ufoo.mac", code: 400, userInfo: [NSLocalizedDescriptionKey: "x and y are required"])
      }
      return try mouseMove(to: CGPoint(x: x, y: y), turnScope: str("turnScope"))

    case "mouse_click":
      guard let x = dblOpt("x"), let y = dblOpt("y") else {
        throw NSError(domain: "ufoo.mac", code: 400, userInfo: [NSLocalizedDescriptionKey: "x and y are required"])
      }
      if boolVal("focusFirst", false) {
        _ = try focusAppOrWindow(
          appName: str("app"),
          bundleId: str("bundleId"),
          pid: intVal("pid", 0),
          windowId: intVal("windowId", 0)
        )
      }
      return try mouseClick(
        at: CGPoint(x: x, y: y),
        buttonName: str("button").isEmpty ? "left" : str("button"),
        clickCount: intVal("clickCount", 1),
        modifiersRaw: strArr("modifiers"),
        turnScope: str("turnScope")
      )

    case "mouse_drag":
      guard let fx = dblOpt("fromX"), let fy = dblOpt("fromY"),
            let tx = dblOpt("toX"), let ty = dblOpt("toY")
      else {
        throw NSError(domain: "ufoo.mac", code: 400, userInfo: [NSLocalizedDescriptionKey: "fromX, fromY, toX, toY are required"])
      }
      return try mouseDrag(
        from: CGPoint(x: fx, y: fy),
        to: CGPoint(x: tx, y: ty),
        holdMs: intVal("holdMs", 80),
        modifiersRaw: strArr("modifiers"),
        turnScope: str("turnScope")
      )

    case "mouse_scroll":
      var pt: CGPoint?
      if let x = dblOpt("x"), let y = dblOpt("y") {
        pt = CGPoint(x: x, y: y)
      }
      return try mouseScroll(
        at: pt,
        deltaX: intVal("deltaX", 0),
        deltaY: intVal("deltaY", -240),
        turnScope: str("turnScope")
      )

    case "key_type":
      let rawText = (params["text"] as? String) ?? ""
      if rawText.isEmpty && !boolVal("submit", false) {
        throw NSError(domain: "ufoo.mac", code: 400, userInfo: [NSLocalizedDescriptionKey: "text is required for type"])
      }
      return try typeText(text: rawText, submit: boolVal("submit", false), turnScope: str("turnScope"))

    case "key_press":
      let key = str("key")
      if key.isEmpty {
        throw NSError(domain: "ufoo.mac", code: 400, userInfo: [NSLocalizedDescriptionKey: "key is required for press_key"])
      }
      return try pressKey(
        keyRaw: key,
        modifiersRaw: strArr("modifiers"),
        repeatCount: intVal("repeat", 1),
        turnScope: str("turnScope")
      )

    default:
      throw NSError(domain: "ufoo.mac", code: 400, userInfo: [NSLocalizedDescriptionKey: "Unknown helper method: \(method)"])
    }
    }
    var result = try perform()
    if let target = inputTarget {
      result["pid"] = Int(target.pid)
      result["windowId"] = target.windowId
      result["pointerMode"] = "independent"
      result["delivery"] = "posted" // Posting does not prove the app acted; inspect its result.
    }
    return result
  }
}

// MARK: - Unix Domain Socket Daemon Server

final class UnixSocketDaemon {
  private let socketPath: String
  private let idleTimeoutSec: Double
  private let engine = MacAutomationEngine()
  private let rpcQueue = DispatchQueue(label: "com.ufoo.mac.rpc")
  private var listenFD: Int32 = -1
  private var acceptSource: DispatchSourceRead?
  private var idleTimer: DispatchSourceTimer?
  private var sigIntSource: DispatchSourceSignal?
  private var sigTermSource: DispatchSourceSignal?

  init(socketPath: String, idleMs: Int) {
    self.socketPath = socketPath
    self.idleTimeoutSec = Double(max(1_000, idleMs)) / 1000.0
  }

  func start() throws {
    let dir = (socketPath as NSString).deletingLastPathComponent
    try FileManager.default.createDirectory(
      atPath: dir,
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700]
    )
    unlink(socketPath)

    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else {
      throw NSError(domain: "ufoo.mac.socket", code: Int(errno), userInfo: [NSLocalizedDescriptionKey: "socket() failed"])
    }
    listenFD = fd

    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let pathBytes = Array(socketPath.utf8CString)
    let maxLen = MemoryLayout.size(ofValue: addr.sun_path)
    guard pathBytes.count <= maxLen else {
      close(fd)
      throw NSError(domain: "ufoo.mac.socket", code: 63, userInfo: [NSLocalizedDescriptionKey: "Socket path exceeds sun_path limit"])
    }
    withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
      ptr.withMemoryRebound(to: CChar.self, capacity: maxLen) { dst in
        dst.initialize(repeating: 0, count: maxLen)
        for (i, ch) in pathBytes.enumerated() {
          dst[i] = ch
        }
      }
    }

    let bindRes = withUnsafePointer(to: &addr) { ptr -> Int32 in
      ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
        Darwin.bind(fd, sa, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    guard bindRes == 0 else {
      let code = errno
      close(fd)
      throw NSError(domain: "ufoo.mac.socket", code: Int(code), userInfo: [NSLocalizedDescriptionKey: "bind() failed (\(code))"])
    }
    chmod(socketPath, 0o600)
    guard Darwin.listen(fd, 16) == 0 else {
      let code = errno
      close(fd)
      unlink(socketPath)
      throw NSError(domain: "ufoo.mac.socket", code: Int(code), userInfo: [NSLocalizedDescriptionKey: "listen() failed (\(code))"])
    }

    let flags = fcntl(fd, F_GETFL, 0)
    _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK)

    let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: DispatchQueue.global(qos: .userInitiated))
    source.setEventHandler { [weak self] in
      self?.acceptPendingClients()
    }
    source.resume()
    acceptSource = source

    engine.takeover.startMonitorsOnMain()
    installSignalHandlers()
    touchIdleTimer()
  }

  private func installSignalHandlers() {
    signal(SIGPIPE, SIG_IGN)
    signal(SIGINT, SIG_IGN)
    signal(SIGTERM, SIG_IGN)
    let sInt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
    sInt.setEventHandler { [weak self] in self?.shutdownAndExit() }
    sInt.resume()
    sigIntSource = sInt

    let sTerm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    sTerm.setEventHandler { [weak self] in self?.shutdownAndExit() }
    sTerm.resume()
    sigTermSource = sTerm
  }

  private func touchIdleTimer() {
    idleTimer?.cancel()
    let t = DispatchSource.makeTimerSource(queue: .main)
    t.schedule(deadline: .now() + idleTimeoutSec)
    t.setEventHandler { [weak self] in
      self?.shutdownAndExit()
    }
    t.resume()
    idleTimer = t
  }

  private func acceptPendingClients() {
    while true {
      var clientAddr = sockaddr_un()
      var len = socklen_t(MemoryLayout<sockaddr_un>.size)
      let clientFD = withUnsafeMutablePointer(to: &clientAddr) { ptr -> Int32 in
        ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
          Darwin.accept(listenFD, sa, &len)
        }
      }
      if clientFD < 0 { break }
      // On Darwin/BSD, accepted sockets inherit O_NONBLOCK from listenFD; restore blocking mode for worker thread reads.
      let cFlags = fcntl(clientFD, F_GETFL, 0)
      if cFlags >= 0 {
        _ = fcntl(clientFD, F_SETFL, cFlags & ~O_NONBLOCK)
      }
      var noSigPipe: Int32 = 1
      setsockopt(clientFD, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
      DispatchQueue.global(qos: .userInitiated).async { [weak self] in
        self?.handleClientConnection(clientFD)
      }
    }
  }

  private func handleClientConnection(_ fd: Int32) {
    defer { close(fd) }
    var buffer = Data()
    var chunk = [UInt8](repeating: 0, count: 8192)
    while true {
      let n = Darwin.read(fd, &chunk, chunk.count)
      if n < 0 && errno == EINTR { continue }
      if n <= 0 { break }
      buffer.append(contentsOf: chunk[0..<n])
      while let nlIndex = buffer.firstIndex(of: 0x0A) {
        let lineData = buffer.subdata(in: 0..<nlIndex)
        buffer.removeSubrange(0...nlIndex)
        if lineData.isEmpty { continue }
        let shouldShutdown = processLine(lineData, clientFD: fd)
        if shouldShutdown {
          DispatchQueue.main.async { [weak self] in
            self?.shutdownAndExit()
          }
          return
        }
      }
    }
  }

  private func processLine(_ lineData: Data, clientFD: Int32) -> Bool {
    DispatchQueue.main.async { [weak self] in
      self?.touchIdleTimer()
    }
    guard
      let obj = (try? JSONSerialization.jsonObject(with: lineData)) as? [String: Any]
    else {
      writeJSON(["id": "", "ok": false, "code": "invalid_json", "error": "Malformed JSON request"], to: clientFD)
      return false
    }
    let id = (obj["id"] as? String) ?? ""
    let method = (obj["method"] as? String) ?? ""
    let params = (obj["params"] as? [String: Any]) ?? [:]

    if method == "shutdown" {
      engine.hud.hideImmediatelySync()
      writeJSON(["id": id, "ok": true, "result": ["stopped": true]], to: clientFD)
      return true
    }

    var response: [String: Any] = ["id": id]
    rpcQueue.sync {
      do {
        let res = try engine.dispatch(method: method, params: params)
        response["ok"] = true
        response["result"] = res
      } catch let err as NSError {
        response["ok"] = false
        response["error"] = err.localizedDescription
        if err.domain == "ufoo.mac.permission" {
          response["code"] = "permission_denied"
          if let perm = err.userInfo["permission"] as? String {
            response["permission"] = perm
          }
        } else if err.domain == "ufoo.mac.takeover" {
          response["code"] = "user_takeover"
          response["reason"] = err.userInfo["reason"] as? String ?? "user_takeover"
        } else if err.domain == "ufoo.mac.stale" {
          response["code"] = "stale_element_ref"
        } else if err.domain == "ufoo.mac.independent" {
          response["code"] = "independent_input_unavailable"
        } else {
          response["code"] = "mac_action_failed"
        }
      }
    }
    writeJSON(response, to: clientFD)
    return false
  }

  private func writeJSON(_ dict: [String: Any], to fd: Int32) {
    guard var data = try? JSONSerialization.data(withJSONObject: dict) else { return }
    data.append(0x0A)
    data.withUnsafeBytes { rawBuf in
      guard let base = rawBuf.baseAddress else { return }
      var sent = 0
      while sent < rawBuf.count {
        let written = Darwin.write(fd, base.advanced(by: sent), rawBuf.count - sent)
        if written <= 0 { break }
        sent += written
      }
    }
  }

  func shutdownAndExit() {
    engine.hud.hideImmediatelySync()
    acceptSource?.cancel()
    if listenFD >= 0 {
      close(listenFD)
      listenFD = -1
    }
    unlink(socketPath)
    exit(0)
  }
}

// MARK: - CLI Entrypoint

@main
struct UfooMacHelperMain {
  static func main() {
    let args = Array(CommandLine.arguments.dropFirst())
    let subcmd = args.first ?? "check"

    if subcmd == "check" {
      let prompt = args.contains("--prompt")
      let openSettings = args.contains("--open-settings")
      let engine = MacAutomationEngine()
      let payload: [String: Any] = [
        "ok": true,
        "status": engine.statusPayload(prompt: prompt, openSettings: openSettings),
      ]
      if let data = try? JSONSerialization.data(withJSONObject: payload),
         let str = String(data: data, encoding: .utf8)
      {
        print(str)
      }
      return
    }

    if subcmd == "daemon" {
      var sockPath = ""
      var idleMs = 600_000
      var i = 1
      while i < args.count {
        if args[i] == "--socket", i + 1 < args.count {
          sockPath = args[i + 1]
          i += 2
        } else if args[i] == "--idle-ms", i + 1 < args.count {
          idleMs = Int(args[i + 1]) ?? 600_000
          i += 2
        } else {
          i += 1
        }
      }
      guard !sockPath.isEmpty else {
        fputs("Missing --socket <path>\n", stderr)
        exit(2)
      }

      let app = NSApplication.shared
      app.setActivationPolicy(.accessory)
      let daemon = UnixSocketDaemon(socketPath: sockPath, idleMs: idleMs)
      do {
        try daemon.start()
      } catch {
        fputs("Failed to start ufoo-mac-helper daemon: \(error.localizedDescription)\n", stderr)
        exit(1)
      }
      withExtendedLifetime(daemon) {
        app.run()
      }
      return
    }

    fputs("Usage: ufoo-mac-helper [check [--prompt] [--open-settings] | daemon --socket <path> [--idle-ms <ms>]]\n", stderr)
    exit(2)
  }
}
