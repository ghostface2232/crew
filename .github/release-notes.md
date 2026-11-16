## Installation

| Platform | Download |
| --- | --- |
| macOS 26 or later, Apple silicon | `Crew-macOS-arm64-<version>.dmg`: open it and drag Crew to Applications. The `.zip` beside it is what the app's updater downloads |
| Windows 10 or later, x64 | `Crew-Setup-<version>.exe`: installs for the current user, with no administrator rights |

The apps are not signed by a recognized publisher yet, so the first launch needs one extra step:

- **macOS:** Gatekeeper blocks the first launch. Open System Settings → Privacy & Security and click **Open Anyway** next to the message about Crew.
- **Windows:** SmartScreen shows "Windows protected your PC". Click **More info**, then **Run anyway**.

After that, both apps update themselves from this page: a newer release downloads while you are away, and installs only when you choose **Restart to Update**.

The app does not install the Claude Code plugin yet. Install it from source as the [README](https://github.com/ghostface2232/crew#getting-started) describes.
