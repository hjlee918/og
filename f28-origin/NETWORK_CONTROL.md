# Experiment startup control

Only the experiment build script ships experiment-main.js as pilot-main.js and
network-bootstrap.js. The accepted entry, package and profile are unchanged.
The entry verifies manifest hashes and establishes existing isolation before
installing the control, then requires the application bundle. A ready listener
registered before application code installs the default session; session-created
installs every subsequent session. Window construction additionally checks active
state. Any incomplete installation exits 78. No post-launch installer exists.

Chromium onBeforeRequest refuses remote schemes, including loopback HTTP and
WebSocket URLs; its registration is locked against replacement. Existing lsp
canonical root checks and G5 assets checks remain authoritative for local files.
Raw file requests are refused. Permissions, webviews and window-open are refused.
Main http/https request/get, Node socket/datagram, global fetch, Electron net,
child-process launches and utility-process forks are refused before application
module evaluation. Thus node-fetch cannot reach its HTTP transport. IPC HTTP,
CLI, git execution, marketplace installation, updater and native sync service
operations are refused. Electron shell activation is refused in main and in the
experimental first-party preload. Generic call-application IPC is refused.

Evidence contains only control version, counts and a maximum of 100 fixed refusal
kinds. URLs, hostnames, paths, query strings, request options and bodies are never
included. A refused attempt is successful enforcement, not a failed test merely
because its count is nonzero. Live service features remain out of scope.

This is application-level containment of reviewed plugin activation paths, not
an OS sandbox or protection against arbitrary native code. The inventoried plugin
bytes are separately verified; API-token inventory is an aid to review, not a
proof of arbitrary-code safety. Existing native search/index functions remain
available; native sync request IPC paths are refused. No native plugin is loaded.

Synthetic Electron tests cover pre-window active state, two actual sessions,
renderer fetch, main HTTP/node-fetch/Electron-net, HTTP/CLI/native-sync IPC,
shell and process launches, approved local resources, and installation failure
with process exit before a result/window. Existing protocol tests cover canonical
containment, encoded traversal and symlink escape. Fixture results do not prove
product loading or accepted-app rollback.

Electron references: https://www.electronjs.org/docs/latest/api/app (session-created,
ready ordering); https://www.electronjs.org/docs/latest/api/web-request (only the
last listener is used, hence registration is locked).
