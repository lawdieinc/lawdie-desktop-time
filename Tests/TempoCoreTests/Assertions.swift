import Foundation

// A dependency-free test runner also works with Apple's Command Line Tools,
// which ship Swift but not XCTest. Failures exit nonzero and preserve call sites.
func checkEqual<T: Equatable>(_ actual: @autoclosure () throws -> T, _ expected: @autoclosure () throws -> T, file: StaticString = #file, line: UInt = #line) rethrows {
    let a = try actual(), b = try expected()
    guard a == b else { fatalError("Expected \(b); got \(a)", file: file, line: line) }
}
func checkTrue(_ value: @autoclosure () -> Bool, file: StaticString = #file, line: UInt = #line) {
    guard value() else { fatalError("Expected true", file: file, line: line) }
}
func checkNil<T>(_ value: @autoclosure () -> T?, _ message: String = "Expected nil", file: StaticString = #file, line: UInt = #line) {
    guard value() == nil else { fatalError(message, file: file, line: line) }
}
func checkNotNil<T>(_ value: @autoclosure () -> T?, file: StaticString = #file, line: UInt = #line) {
    guard value() != nil else { fatalError("Expected non-nil", file: file, line: line) }
}
func checkThrows<T>(_ action: @autoclosure () throws -> T, file: StaticString = #file, line: UInt = #line) {
    do { _ = try action() } catch { return }
    fatalError("Expected an error", file: file, line: line)
}
