# native

The macOS app: SwiftUI and AppKit in Swift 6 language mode, macOS 26 and later, built as a Swift package (`Package.swift`). It is a client of the daemon over HTTP and SSE, and it bundles its own Node and a compiled copy of the bridge to start the daemon. How it works is in [docs/macos-app.md](../docs/macos-app.md); its tokens are in [docs/design-tokens.md](../docs/design-tokens.md).

## Rules

- The app and the React board (`plugin/board/src/`) show the same state and offer the same actions. A change to what one shows or offers usually needs the same change in the other.
- Every size, gap, color, type style, and animation comes from `Sources/Crew/DesignTokens.swift`. When no token fits, add one there and in `docs/design-tokens.md`; do not hardcode raw numbers in the view. The exceptions are listed in that doc.
- A repeating SwiftUI animation re-renders the window's entire view graph on every frame, so run one only while its cause lasts (such as the workflow strip while its session panel is open). A turning symbol uses a layer animation (`Turning`) and stays still under Reduce Motion.
- Arrival motion starts from one place. `CrewStore` applies layout-changing daemon updates under `Motion.arrive`, and state arriving any other way is set inside `Motion.arrive` too; only the activity log is applied plainly, and its list keeps its own animation. Do not add an `.animation(_:value:)` keyed on store data to animate new UI: give a block that comes and goes `.transition(.card)` instead ([docs/design-tokens.md](../docs/design-tokens.md#motion--motion)).
- `Sources/Crew/Models.swift` decodes the daemon's JSON. Fields an older daemon does not send are optional.

## Where things are

| Area | Files |
| --- | --- |
| App, windows, menu bar item, and notifications | `CrewApp.swift`, `CompletionTracker.swift`, `InstanceLock.swift` |
| Daemon connection, sign-in, and starting the daemon | `Transport.swift`, `CrewStore.swift` |
| State as decoded | `Models.swift` |
| Pages, missions, and job details | `BoardView.swift`, `WorkspaceNavigation.swift`, `JobDetailView.swift` |
| New Job, settings, scores, and the setup checklist | `DispatchView.swift`, `SettingsView.swift`, `ScoresView.swift`, `SetupView.swift` |
| Shared views and tokens | `Components.swift`, `DesignTokens.swift`, `WorkspaceStyle.swift` |
| Self-update | `Updater.swift` |

## Build and test

- `npm run desktop` builds `native/build/Crew.app` (`scripts/build-desktop.mjs`) and opens it; it needs Xcode 27 or later for the icon (`assets/crew.icon`). `npm run package:desktop` adds the `.dmg` and `.zip`.
- `npm run test:native` runs the Swift tests in `Tests/CrewTests/` against fixtures, then a stream check against a local fake daemon (`scripts/test-native.mjs`). `npm run test:desktop` smoke-tests the built app.
