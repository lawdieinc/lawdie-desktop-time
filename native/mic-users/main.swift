// mic-users: which apps are recording from a microphone right now, through Core Audio's
// process objects (macOS 14.2+) — the same list the orange menu-bar dot is drawn from.
// Run by src/main/calls.ts every sample; prints one bundle id per line, or "UNSUPPORTED"
// on an older macOS. Needs no permission: it asks who is recording, never for the audio.
//
//   mic-users

import CoreAudio
import Foundation

guard #available(macOS 14.2, *) else {
    print("UNSUPPORTED")
    exit(0)
}

func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: 0)
}

let system = AudioObjectID(kAudioObjectSystemObject)
var listAddress = address(kAudioHardwarePropertyProcessObjectList)
var size: UInt32 = 0
guard AudioObjectGetPropertyDataSize(system, &listAddress, 0, nil, &size) == noErr else { exit(1) }
var processes = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
guard AudioObjectGetPropertyData(system, &listAddress, 0, nil, &size, &processes) == noErr else { exit(1) }

var seen = Set<String>()
for process in processes {
    var running: UInt32 = 0
    var runningSize = UInt32(MemoryLayout<UInt32>.size)
    var runningAddress = address(kAudioProcessPropertyIsRunningInput)
    guard AudioObjectGetPropertyData(process, &runningAddress, 0, nil, &runningSize, &running) == noErr, running != 0 else { continue }
    var bundle: Unmanaged<CFString>?
    var bundleSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    var bundleAddress = address(kAudioProcessPropertyBundleID)
    guard AudioObjectGetPropertyData(process, &bundleAddress, 0, nil, &bundleSize, &bundle) == noErr,
          let id = bundle?.takeRetainedValue() as String?, !id.isEmpty, seen.insert(id).inserted else { continue }
    print(id)
}
