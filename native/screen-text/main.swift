// screen-text: the text a macOS app shows in its focused window, read through the
// Accessibility API — the channel VoiceOver uses. Run by src/main/screenText.ts for the
// app in front, with its pid; prints "TEXT=" and the text, or "UNTRUSTED" (exit 2) when
// this app has not been granted Accessibility. Never reads a secure (password) field,
// skips menus, toolbars, buttons and sidebars (outlines, source lists), starts from what
// has focus (the note, the message, the document being worked in) before the rest of the
// window, and stops at a character, element and time budget.
// For a long text area only the part on screen is read when the app says which that is.
//
//   screen-text <pid> [maxChars=1200] [budgetMs=1500]

import ApplicationServices
import Foundation

let args = CommandLine.arguments
guard args.count >= 2, let pid = pid_t(args[1]) else {
    FileHandle.standardError.write("usage: screen-text <pid> [maxChars] [budgetMs]\n".data(using: .utf8)!)
    exit(64)
}
let maxChars = args.count > 2 ? Int(args[2]) ?? 1200 : 1200
let budget = (args.count > 3 ? Double(args[3]) ?? 1500 : 1500) / 1000
let deadline = Date().addingTimeInterval(budget)

guard AXIsProcessTrusted() else {
    print("UNTRUSTED")
    exit(2)
}

func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
    var value: AnyObject?
    return AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success ? value : nil
}

/// The visible part of a text area when the app reports it, else its whole value.
func visibleText(_ el: AXUIElement) -> String? {
    if let rangeValue = attr(el, kAXVisibleCharacterRangeAttribute) {
        var out: AnyObject?
        if AXUIElementCopyParameterizedAttributeValue(el, kAXStringForRangeParameterizedAttribute as CFString, rangeValue, &out) == .success, let s = out as? String, !s.isEmpty {
            return s
        }
    }
    return attr(el, kAXValueAttribute) as? String
}

let skipRoles: Set<String> = ["AXOutline", "AXMenuBar", "AXMenu", "AXMenuItem", "AXMenuBarItem", "AXToolbar", "AXButton", "AXPopUpButton", "AXMenuButton", "AXCheckBox", "AXRadioButton", "AXScrollBar", "AXImage", "AXTabGroup", "AXDisclosureTriangle", "AXIncrementor", "AXSlider"]

// Every element answers within half a second or is skipped; a hung app cannot stall the read.
AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.5)
let app = AXUIElementCreateApplication(pid)
// Chromium and Electron apps (Teams, Slack, most practice software) build their
// accessible tree only for a client that asks, as screen readers do.
AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
guard let window = (attr(app, kAXFocusedWindowAttribute) ?? attr(app, kAXMainWindowAttribute)) else {
    print("TEXT=")
    exit(0)
}

var pieces: [String] = []
var seen = Set<String>()
var total = 0
var visited = 0
// What has focus first: the text being worked in says more than the window around it.
var queue: [AXUIElement] = []
if let focused = attr(app, kAXFocusedUIElementAttribute) { queue.append(focused as! AXUIElement) } // an element, when present
queue.append(window as! AXUIElement) // the focused window attribute is always an element

while !queue.isEmpty, total < maxChars, visited < 5000, Date() < deadline {
    let el = queue.removeFirst()
    visited += 1
    let role = attr(el, kAXRoleAttribute) as? String ?? ""
    let subrole = attr(el, kAXSubroleAttribute) as? String ?? ""
    if subrole == "AXSecureTextField" || role == "AXSecureTextField" || subrole == "AXSourceList" || skipRoles.contains(role) { continue }
    var text: String? = nil
    switch role {
    case "AXTextArea", "AXTextField", "AXComboBox":
        text = visibleText(el)
    case "AXStaticText", "AXHeading":
        text = (attr(el, kAXValueAttribute) as? String) ?? (attr(el, kAXTitleAttribute) as? String)
    default:
        break
    }
    if let t = text?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty, !seen.contains(t) {
        seen.insert(t)
        pieces.append(t)
        total += t.count + 1
    }
    if let children = attr(el, kAXChildrenAttribute) as? [AXUIElement] { queue.append(contentsOf: children) }
}

let joined = pieces.joined(separator: "\n")
print("TEXT=" + String(joined.prefix(maxChars)))
