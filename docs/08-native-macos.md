# 08. Native macOS app

Implemented 2026-11-13. The desktop UI is now SwiftUI and AppKit, with Swift 6 language mode and a macOS 26 minimum deployment target. The existing TypeScript daemon, agent adapters, CLI, worktrees, configuration, and React web board remain the execution and browser layers.

## Architecture

```text
SwiftUI + AppKit app ── HTTP / SSE ── independent TypeScript daemon
                                         ├── agent CLIs / worktrees
Claude plugin / crew CLI ─────────────────┘
React web board ──────────────────────────┘
```

The app contains a standalone Node runtime and compiled bridge JavaScript. Startup invokes the existing `crew daemon start` implementation, retaining its active-job protection and version negotiation. No worker authentication is copied or read by the native app. Closing the window hides it; quitting the UI leaves the daemon and jobs running. Reopening attaches to the same daemon. A process lock scoped to `CREW_HOME` prevents duplicate native instances and a distributed notification reopens the first window.

## Interface

- The native window toolbar combines workspace navigation, search, and primary actions. Project selection stays in the content. A detail panel preserves the workspace layout and disables obscured controls until closed.
- The workspace uses a neutral canvas, rounded 38-point headlines and 40-point summary values, service cards, and mission stage rings and tracks. Lime is restricted to progress accents; the background has no gradient. System appearance remains automatic. Opening an inspector preserves the list and search context; narrow layouts retain agent status labels.
- Needs You always includes every project. Approval and question responses share request-specific action locks with the inspector and notification actions.
- Missions retain stage progress, lead disclosures, job membership, outcomes, token totals, and dismissal without cancelling jobs. History keeps completed work reachable.
- Job details include reports, changed and out-of-scope files, refusal reasons, notes, original prompts, follow-ups, cancellation, resume commands, and diff commands.
- New Job uses role assignments, a native folder picker, isolated implementation/polish jobs, and read-only review of uncommitted changes. Full missions still begin with `/crew:run` in Claude.
- Settings has separate role and shared-instruction tabs, project scopes, failed-load protection, save-generation checks, and unsaved-change protection on close and quit. Role cards and a fixed save footer share the workspace typography and surfaces. New Job also confirms before discarding a draft with Cancel or Escape.
- Native text editors preserve marked text and use Return for a newline. Sending requires an explicit button; IME confirmation cannot submit a message.
- Navigation, controls, and statuses use SF Symbols. Service marks come from the supplied SVGs in `assets/`, compiled as template vector assets so they remain legible in light and dark appearances. Cursor's asset is packaged but no unsupported Cursor adapter is implied.
- Liquid Glass is provided by system navigation/toolbars and glass buttons, with a custom glass attention banner. Reports and logs use readable content surfaces. System materials and controls inherit accessibility appearance settings; there are no custom continuous animations.

Keyboard shortcuts: Command-N creates a job, Command-comma opens Settings, Command-1 through Command-4 select workspace sections, and Command-S saves the selected settings tab, and Command-F focuses toolbar search. Escape closes job details.

## Transport and state

`URLSessionDataDelegate` feeds received data chunks directly into an incremental SSE parser on a serial delegate queue. UTF-8 split across chunks, CRLF, multiple data lines, and comments are handled without byte-by-byte async iteration. The stream has a bounded queue; overflow reconnects for a replacement snapshot instead of silently losing events. Reconnection replaces event history, including sequence numbers reset by a restarted daemon.

The API is Sendable, observable state is MainActor-isolated, and stream cancellation shares a lock with connection teardown. HTTP job responses cannot replace a newer SSE update, including changes that keep the same sequence number. Job events decode once, and idle windows do not poll full snapshots. Detail loads cancel with the selected job. Settings responses are scoped to the load generation, and successful saves preserve edits made while the request was pending.

Native notifications revalidate the current request ID before acting. A heartbeat suppresses duplicate daemon input notifications only when OS notification authorization is available. Completion notifications negotiate a short server-timestamped ownership lease. Ordered SSE lease events and historical ownership intervals prevent duplicate daemon/native notifications and handle delayed completions. Legacy daemons retain notification ownership. Window-hidden UI clocks stop updating; durations below a minute display `<1m`.

## Build and run

Requirements: macOS 26+, Xcode 26+ with Swift 6, and a standalone Node.js 22.18+ distribution for packaging. The app builds for the host architecture. Development and verification have used Xcode 27.2 on macOS 27.2.1; runtime behavior on macOS 26 needs a separate machine or VM.

```bash
npm ci
npm run desktop
npm run package:desktop
```

The development bundle is `native/build/Crew.app`; the release copy is `release/Crew.app`. The old Electron output directory is not overwritten. Open `native/Package.swift` in Xcode to edit Swift sources; use the packaging script to run with the bundled daemon and image assets.

The build copies the current Node executable and its LICENSE. It rejects Node binaries linked against non-system libraries. `CREW_NODE_LICENSE` can specify the matching license path when the Node distribution uses a different directory layout. `CREW_BUILD_CONFIGURATION=debug` selects a debug build.

Bundles are locally ad-hoc signed and verified. Public Developer ID signing, notarization, automatic updates, and login launch are not configured. This is a local app distribution, not an App Store build.

## Verification

```bash
npm test
npm run typecheck
npm run test:native
npm run test:e2e
npm run test:desktop
```

The native suite covers wire framing, split Unicode, large snapshots, bounded event history, reconnect replacement, repeated waiting identities, duplicate request locking, failed-answer retry, same-sequence HTTP races including job creation, inspector context, cross-project attention, settings load races, edits during saves, and failed-load protection. Its runner also starts an ephemeral loopback SSE fixture to verify the real URLSession delegate path, decoded store updates, and socket cancellation. Direct `swift test` skips that integration case unless `CREW_STREAM_TEST_PORT` is supplied.

The desktop smoke script uses an isolated temporary home and port with notifications disabled. It checks bundled Node startup with a minimal PATH, single-instance behavior, daemon survival across UI termination/reopen, web board availability, and code signatures. It never starts worker jobs.

Manual UI checks use `test/e2e/server.ts` fixtures with `CREW_ATTACH_ONLY=1`, `CREW_TEST_MODE=1`, and a separate `CREW_HOME`. These environment switches bypass daemon startup and OS notification prompts for fixtures; they do not grant additional permissions or change agent behavior.

OS Notification Center presentation requires a manual acceptance check with notifications authorized. Resource figures from the smoke script describe the native process RSS only and are not directly comparable to the former sum of Electron working sets.

### Review record (2026-11-13)

Nine reviewers covered concurrency, accessibility, build and tests, design and layout, motion, usability, performance, logic, and the final integrated implementation. Findings were addressed in settings readiness, mutation timeouts, foreground notifications, stale response protection, stream decode cost, unnecessary polling, inspector context, request search, loading layout shifts, compact status visibility, and dark-appearance contrast. The performance and logic reviewers rechecked their fixes; the final reviewer found no additional release-blocking or major regressions in source review.

Final validation passed 79 TypeScript tests, 24 native tests, 14 browser tests, TypeScript checking, release packaging, and signature verification. Manual native checks covered service assets, workspace hierarchy, request search, inspector context, project-field accessibility, settings close behavior, the visible save action, draft discard confirmation, Escape, and toolbar search. Follow-up logic and integrated reviews also covered completion ownership ordering and hidden controls behind the detail panel. These checks do not replace the macOS 26 and notification acceptance checks above.

## References

- [Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars)
- [Scroll views](https://developer.apple.com/design/human-interface-guidelines/scroll-views)
- [Adopting Liquid Glass](https://developer.apple.com/documentation/TechnologyOverviews/adopting-liquid-glass)
- [Applying Liquid Glass to custom views](https://developer.apple.com/documentation/SwiftUI/Applying-Liquid-Glass-to-custom-views)
- [SwiftUI and AppKit integration](https://developer.apple.com/documentation/swiftui/appkit-integration)
