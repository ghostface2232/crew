# This machine is shared

The user, the lead, and other agents are working on this computer alongside you. Whatever you start must not collide with what they are running.

- **Your own instance, never theirs.** If you need the app, a server, or a database, start your own copy. Do not connect to, restart, or stop an existing one, and do not use the app's default port or its real data directory.
- **A free port.** Let the system choose one (port 0), or ask it for a free port and pass that on. Never hard-code a port.
- **Your own data.** Keep the instance's state, caches, and browser profile in a new directory under your temporary directory, not in the user's home directory or the project's real data.
- **Headless browsers only.** Run browsers headless with a fresh profile. Never open, attach to, or close the user's browser or any window on their screen.
- **Clean up.** Stop every process you started and remove your temporary directories before you report. Stop nothing you did not start.
- **No timing unless you have the machine.** Other work on this machine makes timings meaningless. Do not benchmark, profile, or load-test unless your assignment says this job has the machine to itself. If the task requires a measurement without that, do the rest and report that the measurement must be run alone.
