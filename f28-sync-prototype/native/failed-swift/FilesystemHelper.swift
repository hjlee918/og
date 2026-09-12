import Foundation
import Darwin
import CryptoKit

let approvedRoot = "/Users/johnlee/Library/Mobile Documents/com~apple~CloudDocs/Logseq Test"

enum HelperError: Error { case refused(String) }

func refuse(_ message: String) throws -> Never { throw HelperError.refused(message) }
func err(_ label: String) -> String { "\(label): errno \(errno)" }
func component(_ value: Any?, _ label: String) throws -> String {
  guard let s = value as? String, s.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else {
    try refuse("invalid \(label)")
  }
  return s
}
func relativePath(_ value: Any?) throws -> [String] {
  guard let s = value as? String, !s.isEmpty, !s.hasPrefix("/"), !s.contains("\\"), !s.contains("\0") else {
    try refuse("invalid relative path")
  }
  let parts = s.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
  guard !parts.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) else { try refuse("path traversal refused") }
  guard s.hasSuffix(".md") || s.hasSuffix(".org") else { try refuse("only Markdown/Org files are supported") }
  return parts
}
func jsonData(_ value: Any) throws -> Data {
  try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
}
func sha(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
func writeAll(_ fd: Int32, _ data: Data) throws {
  try data.withUnsafeBytes { raw in
    var done = 0
    while done < raw.count {
      let n = Darwin.write(fd, raw.baseAddress!.advanced(by: done), raw.count - done)
      if n < 0 { try refuse(err("write")) }
      done += n
    }
  }
}
func fullSync(_ fd: Int32) throws {
  if fcntl(fd, F_FULLFSYNC) != 0 { try refuse(err("F_FULLFSYNC unsupported or failed")) }
}
func syncDir(_ fd: Int32) throws { if Darwin.fsync(fd) != 0 { try refuse(err("directory fsync failed")) } }
func openDirAt(_ parent: Int32, _ name: String) throws -> Int32 {
  let fd = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
  if fd < 0 { try refuse(err("open directory \(name) refused")) }
  var st = stat(); if fstat(fd, &st) != 0 || (st.st_mode & S_IFMT) != S_IFDIR { close(fd); try refuse("not a directory: \(name)") }
  return fd
}
func createDirAt(_ parent: Int32, _ name: String) throws -> Int32 {
  if mkdirat(parent, name, 0o700) != 0 && errno != EEXIST { try refuse(err("mkdir \(name)")) }
  return try openDirAt(parent, name)
}
func statIdentity(_ fd: Int32) throws -> (UInt64, UInt64) {
  var st = stat(); if fstat(fd, &st) != 0 { try refuse(err("fstat")) }
  return (UInt64(st.st_dev), UInt64(st.st_ino))
}
func identityAt(_ parent: Int32, _ name: String) throws -> (UInt64, UInt64) {
  var st = stat()
  if fstatat(parent, name, &st, AT_SYMLINK_NOFOLLOW) != 0 || (st.st_mode & S_IFMT) == S_IFLNK { try refuse("entry identity refused: \(name)") }
  return (UInt64(st.st_dev), UInt64(st.st_ino))
}
func sameIdentity(_ a: (UInt64, UInt64), _ b: (UInt64, UInt64)) -> Bool { a.0 == b.0 && a.1 == b.1 }
func openRoot() throws -> Int32 {
  let slash = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
  if slash < 0 { try refuse(err("open root")) }
  var current = slash
  for part in approvedRoot.split(separator: "/").map(String.init) {
    let next = try openDirAt(current, part)
    close(current); current = next
  }
  return current
}
func readFileAt(_ parent: Int32, _ name: String, limit: Int = 8_000_000) throws -> Data {
  let fd = openat(parent, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
  if fd < 0 { try refuse(err("open file \(name) refused")) }
  defer { close(fd) }
  var st = stat(); if fstat(fd, &st) != 0 || (st.st_mode & S_IFMT) != S_IFREG || st.st_size < 0 || st.st_size > limit { try refuse("invalid file \(name)") }
  var data = Data(count: Int(st.st_size)); let count = data.count
  if count > 0 {
    let got = data.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, count) }
    if got != count { try refuse(err("short read \(name)")) }
  }
  return data
}
func exclusiveFile(_ parent: Int32, _ name: String, _ data: Data) throws {
  let fd = openat(parent, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode_t(0o600))
  if fd < 0 { try refuse(err("exclusive create \(name) refused")) }
  defer { close(fd) }
  try writeAll(fd, data); try fullSync(fd)
}
func parseObject(_ data: Data, _ label: String) throws -> [String: Any] {
  guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { try refuse("invalid \(label)") }
  return value
}
func existsAt(_ parent: Int32, _ name: String) -> Bool {
  var st = stat(); return fstatat(parent, name, &st, AT_SYMLINK_NOFOLLOW) == 0
}
func validateSelector(_ data: Data) throws -> String {
  guard let s = String(data: data, encoding: .utf8), s.range(of: "^[A-Fa-f0-9]{64}\\n$", options: .regularExpression) != nil else { try refuse("unsafe CURRENT selector") }
  return String(s.dropLast())
}
func openPathFile(_ generation: Int32, _ parts: [String]) throws -> Data {
  var dir = dup(generation); if dir < 0 { try refuse(err("dup")) }
  defer { close(dir) }
  for p in parts.dropLast() { let next = try openDirAt(dir, p); close(dir); dir = next }
  return try readFileAt(dir, parts.last!)
}
func validateGeneration(_ generations: Int32, _ directoryName: String, generationName: String? = nil,
  expected: [String: Any]? = nil) throws -> [String: Any] {
  let name = generationName ?? directoryName
  guard name.range(of: "^[A-Fa-f0-9]{64}$", options: .regularExpression) != nil,
        directoryName == name || directoryName == name + ".staging" else { try refuse("unsafe generation name") }
  let gen = try openDirAt(generations, directoryName); defer { close(gen) }
  let manifestData = try readFileAt(gen, "manifest.json")
  let manifest = try parseObject(manifestData, "manifest")
  guard manifest["status"] as? String == "PREPARED", manifest["generation"] as? String == name,
        let stateHash = manifest["stateHash"] as? String,
        let files = manifest["files"] as? [[String: Any]] else { try refuse("invalid manifest schema") }
  let state = try readFileAt(gen, "state.json")
  guard sha(state) == stateHash else { try refuse("state hash mismatch") }
  var seen = Set<String>()
  for file in files {
    guard let p = file["path"] as? String, let h = file["hash"] as? String else { try refuse("invalid manifest file") }
    let parts = try relativePath(p); let key = p.precomposedStringWithCanonicalMapping.lowercased()
    guard seen.insert(key).inserted else { try refuse("normalized path collision") }
    guard sha(try openPathFile(gen, parts)) == h else { try refuse("file hash mismatch: \(p)") }
  }
  if let e = expected {
    for key in ["basisFingerprint", "projectedFingerprint", "planId"] where manifest[key] as? String != e[key] as? String { try refuse("prepared generation does not match request") }
  }
  return manifest
}

func makeDirsForFile(_ generation: Int32, _ parts: [String]) throws -> Int32 {
  var dir = dup(generation); if dir < 0 { try refuse(err("dup")) }
  for p in parts.dropLast() { let next = try createDirAt(dir, p); close(dir); dir = next }
  return dir
}
func verifyRunPath(_ root: Int32, _ runName: String, _ expected: (UInt64, UInt64)) throws {
  let fresh = try openDirAt(root, runName); defer { close(fresh) }
  guard sameIdentity(try statIdentity(fresh), expected) else { try refuse("run identity changed") }
}
func verifyChildPath(_ parent: Int32, _ name: String, _ expected: (UInt64, UInt64)) throws {
  let fresh = try openDirAt(parent, name); defer { close(fresh) }
  guard sameIdentity(try statIdentity(fresh), expected) else { try refuse("child identity changed: \(name)") }
}

func main(_ request: [String: Any]) throws -> [String: Any] {
  guard request["root"] as? String == approvedRoot else { try refuse("approved root mismatch") }
  let command = try component(request["command"], "command")
  let runName = try component(request["runName"], "runName")
  let caseName = try component(request["caseName"], "caseName")
  guard let owner = request["ownerToken"] as? String, owner.range(of: "^[A-Fa-f0-9]{32,128}$", options: .regularExpression) != nil else { try refuse("invalid owner token") }
  let root = try openRoot(); defer { close(root) }
  var createdRun = false
  if mkdirat(root, runName, 0o700) == 0 { createdRun = true }
  else if errno != EEXIST { try refuse(err("create run")) }
  let run = try openDirAt(root, runName); defer { close(run) }
  let runID = try statIdentity(run)
  if createdRun { try exclusiveFile(run, "OWNER", Data((owner + "\n").utf8)); try syncDir(run); try syncDir(root) }
  guard try readFileAt(run, "OWNER") == Data((owner + "\n").utf8) else { try refuse("run ownership refused") }
  try verifyRunPath(root, runName, runID)

  var createdCase = false
  if mkdirat(run, caseName, 0o700) == 0 { createdCase = true }
  else if errno != EEXIST { try refuse(err("create case")) }
  let cfd = try openDirAt(run, caseName); defer { close(cfd) }
  if createdCase { try exclusiveFile(cfd, "OWNER", Data((owner + "\n").utf8)); try syncDir(cfd); try syncDir(run) }
  guard try readFileAt(cfd, "OWNER") == Data((owner + "\n").utf8) else { try refuse("case ownership refused") }
  let caseID = try statIdentity(cfd)

  let meta = try createDirAt(cfd, ".f28-sync"); defer { close(meta) }
  let metaID = try statIdentity(meta)
  let generations = try createDirAt(meta, "generations"); defer { close(generations) }
  let lockfd = openat(meta, "LOCK", O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, mode_t(0o600))
  if lockfd < 0 { try refuse(err("lock open refused")) }; defer { close(lockfd) }
  var lockStat = stat(); if fstat(lockfd, &lockStat) != 0 || (lockStat.st_mode & S_IFMT) != S_IFREG { try refuse("invalid lock inode") }
  let lockID = (UInt64(lockStat.st_dev), UInt64(lockStat.st_ino))
  guard sameIdentity(try identityAt(meta, "LOCK"), lockID) else { try refuse("lock inode substituted") }
  if flock(lockfd, LOCK_EX | LOCK_NB) != 0 { try refuse("another helper owns this case") }
  defer { flock(lockfd, LOCK_UN) }

  if command == "hold" { let seconds = request["seconds"] as? Int ?? 2; sleep(UInt32(seconds)); return ["status":"held"] }

  guard let stateText = request["state"] as? String, let stateData = stateText.data(using: .utf8),
        let fingerprint = request["projectedFingerprint"] as? String else { try refuse("missing state or fingerprint") }
  if !existsAt(meta, "CURRENT") {
    guard command == "initialize", createdCase else { try refuse("uninitialized or partial case") }
    try publishGeneration(meta: meta, generations: generations, cfd: cfd, run: run, root: root, runName: runName, caseName: caseName, runID: runID, caseID: caseID, metaID: metaID, lockID: lockID,
      name: String(repeating: "0", count: 64), basis: fingerprint, projected: fingerprint, planId: "genesis", operationIds: [], state: stateData, files: [], failure: nil)
    return ["status":"initialized", "generation":String(repeating: "0", count: 64)]
  }
  guard command == "apply" || command == "inspect" else { try refuse("case already initialized") }
  let currentName = try validateSelector(readFileAt(meta, "CURRENT"))
  let current = try validateGeneration(generations, currentName)
  if command == "inspect" { return ["status":"inspected", "generation":currentName, "manifest":current] }

  guard let basis = request["basisFingerprint"] as? String,
        let planId = request["planId"] as? String,
        let tx = request["transactionId"] as? String,
        tx.range(of: "^[A-Fa-f0-9]{64}$", options: .regularExpression) != nil,
        let operations = request["operationIds"] as? [String],
        let files = request["files"] as? [[String: Any]] else { try refuse("invalid apply request") }
  let expected:[String:Any] = ["basisFingerprint":basis,"projectedFingerprint":fingerprint,"planId":planId]
  if current["projectedFingerprint"] as? String == fingerprint && current["planId"] as? String == planId {
    try syncDir(meta)
    return ["status":"already-applied","generation":currentName]
  }
  guard current["projectedFingerprint"] as? String == basis else { try refuse("stale basis") }
  let failure = request["failurePoint"] as? String
  try publishGeneration(meta: meta, generations: generations, cfd: cfd, run: run, root: root, runName: runName, caseName: caseName, runID: runID, caseID: caseID, metaID: metaID, lockID: lockID,
    name: tx, basis: basis, projected: fingerprint, planId: planId, operationIds: operations, state: stateData, files: files, failure: failure, expected: expected)
  return ["status":"acknowledged","generation":tx]
}

func publishGeneration(meta: Int32, generations: Int32, cfd: Int32, run: Int32, root: Int32, runName: String, caseName: String,
  runID: (UInt64,UInt64), caseID: (UInt64,UInt64), metaID: (UInt64,UInt64), lockID: (UInt64,UInt64), name: String, basis: String, projected: String,
  planId: String, operationIds: [String], state: Data, files: [[String:Any]], failure: String?, expected: [String:Any]? = nil) throws {
  let staging = name + ".staging"
  if existsAt(generations, name) {
    _ = try validateGeneration(generations, name, expected: expected)
  } else if existsAt(generations, staging) {
    _ = try validateGeneration(generations, staging, generationName: name, expected: expected)
    if renameat(generations, staging, generations, name) != 0 { try refuse(err("prepared recovery rename")) }
    try syncDir(generations)
  } else {
    if mkdirat(generations, staging, 0o700) != 0 { try refuse(err("create staging")) }
    let gen = try openDirAt(generations, staging); defer { close(gen) }
    var manifestFiles:[[String:Any]] = []; var normalized = Set<String>()
    for (index, file) in files.enumerated() {
      guard let path = file["path"] as? String, let content = file["content"] as? String, let data = content.data(using:.utf8), data.count <= 1_000_000 else { try refuse("invalid synthetic file") }
      let parts = try relativePath(path); let key = path.precomposedStringWithCanonicalMapping.lowercased()
      guard normalized.insert(key).inserted else { try refuse("normalized path collision") }
      let dir = try makeDirsForFile(gen, parts); defer { close(dir) }
      try exclusiveFile(dir, parts.last!, data); try syncDir(dir)
      manifestFiles.append(["path":path,"hash":sha(data)])
      if failure == "during-staging" && index == 0 { try refuse("injected during-staging") }
    }
    try exclusiveFile(gen, "state.json", state)
    if failure == "before-prepared" { try refuse("injected before-prepared") }
    let manifest:[String:Any] = ["schema":"f28-fs-generation/1","status":"PREPARED","generation":name,
      "basisFingerprint":basis,"projectedFingerprint":projected,"planId":planId,"operationIds":operationIds,
      "stateHash":sha(state),"files":manifestFiles]
    try exclusiveFile(gen, "manifest.json", try jsonData(manifest)); try syncDir(gen); try syncDir(generations)
    if failure == "after-prepared" { try refuse("injected after-prepared") }
    if renameat(generations, staging, generations, name) != 0 { try refuse(err("prepare generation rename")) }
    try syncDir(generations)
    if failure == "after-generation-rename" { try refuse("injected after-generation-rename") }
  }
  _ = try validateGeneration(generations, name, expected: expected)
  let currentName = existsAt(meta,"CURRENT") ? try validateSelector(readFileAt(meta,"CURRENT")) : nil
  if let currentName {
    let current = try validateGeneration(generations,currentName)
    guard current["projectedFingerprint"] as? String == basis || currentName == name else { try refuse("basis changed before publication") }
  }
  guard sameIdentity(try statIdentity(cfd), caseID) else { try refuse("case identity changed") }
  try verifyRunPath(root, runName, runID)
  try verifyChildPath(run, caseName, caseID)
  try verifyChildPath(cfd, ".f28-sync", metaID)
  guard sameIdentity(try identityAt(meta, "LOCK"), lockID) else { try refuse("lock inode changed") }
  if failure == "before-current-rename" { try refuse("injected before-current-rename") }
  let pending = "CURRENT.\(name).pending"
  if !existsAt(meta,pending) { try exclusiveFile(meta,pending,Data((name+"\n").utf8)) }
  if failure == "during-synchronization" { try refuse("injected during-synchronization") }
  try syncDir(meta)
  if renameat(meta,pending,meta,"CURRENT") != 0 { try refuse(err("CURRENT rename")) }
  if failure == "after-current-rename" { try refuse("injected after-current-rename") }
  try syncDir(meta)
  let selected = try validateSelector(readFileAt(meta,"CURRENT")); guard selected == name else { try refuse("selector verification failed") }
  _ = try validateGeneration(generations,name,expected:expected)
  if failure == "before-ack" { try refuse("injected before-ack") }
}

do {
  let input = FileHandle.standardInput.readDataToEndOfFile()
  guard let request = try JSONSerialization.jsonObject(with: input) as? [String:Any] else { try refuse("invalid request") }
  let output = try main(request); FileHandle.standardOutput.write(try jsonData(output)); FileHandle.standardOutput.write(Data("\n".utf8))
} catch HelperError.refused(let message) {
  FileHandle.standardError.write(Data(("REFUSED: " + message + "\n").utf8)); exit(23)
} catch {
  FileHandle.standardError.write(Data(("ERROR: \(error)\n").utf8)); exit(24)
}
