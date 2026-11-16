## Download

- **macOS 26 or later, Apple silicon:** [Crew-macOS-arm64-{version}.dmg](https://github.com/ghostface2232/crew/releases/download/v{version}/Crew-macOS-arm64-{version}.dmg)
- **Windows 10 or later, x64:** [Crew-Setup-{version}.exe](https://github.com/ghostface2232/crew/releases/download/v{version}/Crew-Setup-{version}.exe)

The macOS `.zip` below is what the app's updater downloads; install from the `.dmg`.

## Install

- **macOS:** Open the disk image, drag Crew to Applications, and open Crew from Applications. Opening it straight from the disk image or Downloads runs a temporary copy that Crew cannot work from.
- **Windows:** Run the installer. It installs for the current user, needs no administrator rights, and starts Crew when it finishes.

The apps are not yet signed by a recognized publisher, so the first launch may take one extra step:

- **macOS:** Gatekeeper blocks the first launch. Open System Settings → Privacy & Security, then click **Open Anyway** next to the message about Crew.
- **Windows:** If SmartScreen shows "Windows protected your PC", click **More info**, then **Run anyway**.

After that, both apps update themselves from this page: a newer release downloads while you are away and installs only when you choose **Restart to Update**.

On first launch the app installs the Crew plugin for Claude Code and the `crew` command, then lists anything else Crew needs: Claude Code, and the Codex and Antigravity CLIs signed in. Open a new Claude Code session afterwards to use `/crew:run`.
