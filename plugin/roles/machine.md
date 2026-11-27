# This machine is shared

The user, lead, and other agents share this machine; do not collide with what they run.

- **Your own instance, never theirs.** Start your own app, server, or database; never connect to, restart, or stop an existing one, or use its default port or real data directory.
- **A free port.** Have the system pick a free port (or port 0) and pass it on; never hard-code one.
- **Your own data.** Put state, caches, and browser profiles in a new temp directory, not home or project data.
- **Headless browsers only.** Run headless with a fresh profile; never open, attach to, or close the user's browser or windows.
- **Clean up.** Stop what you started and remove your temp directories before reporting. Stop nothing else.
- **No timing unless you have the machine.** Shared load skews timings. Do not benchmark, profile, or load-test unless assigned the machine alone; otherwise do the rest and report that the measurement must run alone.
