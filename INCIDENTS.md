# Incident History & Technical Post-Mortems

This document chronicles the technical challenges encountered during the Kindle / KOReader sync and OPDS deployment, root causes identified, and structural mitigations implemented.

---

## 📋 Incident Summary Matrix

| ID | Title | Root Cause | Resolution | Impact |
|---|---|---|---|---|
| **INC-01** | Myanmar GFW/DPI Blocking Raw Kindle HTTPS | Myanmar ISPs filter dynamic DNS and raw VPS IP ranges on standard HTTPS ports | Transitioned primary stack to local Mac mini home server (`192.168.31.15`); set up sing-box VLESS proxy for external fallback | Resolved |
| **INC-02** | KOReader Cross-Device Sync Mismatch | Different book file encodings generated conflicting partial MD5 document hashes | Unified book delivery via central OPDS catalog ensuring byte-identical copies | Resolved |
| **INC-03** | KOReader Localhost Port 8321 Refusal | Proxy request destination misconfigured to localhost loopback `127.0.0.1:8321` | Separated Network Proxy settings from Custom Sync Server settings | Resolved |
| **INC-04** | Calibre SQLite Multi-Process Lock Contention | Direct filesystem mutation conflicted with active `calibre-server` process | Enabled `--enable-local-write` and switched CLI tools to server URL `http://127.0.0.1:8088` | Resolved |
| **INC-05** | Happ VPN Extension Overhead on Turn Start | Synchronous accessibility tree traversals on `input` and `before_agent_start` blocked Pi | Removed automatic turn-hooks; preserved manual `/happ` slash commands and tools | Resolved |
| **INC-06** | Telegram Ingest Bot Deadlock & Stalled Long-Poll Socket | Direct connection to `api.telegram.org` hung silently without request timeout; process became orphaned | Routed polling through Sing-box VLESS proxy (`:7890`), added `AbortSignal` timeouts, and enabled auto-restart | Resolved |
| **INC-07** | Calibre Ingestion Crash from Subprocess Proxy Leak | `HTTP_PROXY` in LaunchAgent env caused Python `calibredb` to append debug text to JSON output | Sanitized subprocess environment and implemented boundary-bracket `safeParseJson` | Resolved |
| **INC-08** | Sing-Box Outbound Drop via macOS Empty Resolv.conf | macOS lacks DNS in `/etc/resolv.conf`; Sing-box failed to resolve domain-based VLESS endpoints | Added explicit UDP DNS servers (`8.8.8.8`, `1.1.1.1`) and `default_domain_resolver` in `config.json` | Resolved |
| **INC-09** | Daily Backup Failure via macOS TCC Volume Restriction | Non-interactive LaunchAgent blocked from writing to `/Volumes/Ospeto_SSD` by macOS sandbox | Implemented dual-tier backup (local fallback + SSD mirror) and converted databases to SQLite WAL mode | Resolved |
| **INC-10** | Credentials Committed Before Public Publication | Bot token, KOSync salt, and a KOSync `X-Auth-Key` were hardcoded in tracked files, and history stays readable after a repo goes public | Scrubbed every literal from `HEAD`, rotated and out-of-band verified the bot token, and recorded the salt and `X-Auth-Key` exposures as accepted | Mitigated at `HEAD`; two exposures accepted |
| **INC-11** | Uploader LaunchAgent Hangs on a Removable-Volume Library | The live Calibre library symlinks onto `/Volumes/Ospeto_SSD`; TCC denies removable-volume access to launchd-spawned processes, and `bun` blocks inside `openat` when that volume stops answering — so the server bound its port and served nothing | Added a bounded out-of-process startup preflight that exits non-zero on every non-`ok` verdict, naming the cause and both remedies | Mitigated in code; host action pending (move the library internal, or grant FDA) |

---

## 🔍 Detailed Post-Mortems

### INC-01: Myanmar GFW Dropping Direct Kindle HTTPS
- **Symptom:** Kindle displayed *"Check your network connection"* when accessing overseas endpoints directly, while laptop/phone succeeded.
- **Root Cause:** Laptop and phone were tunneled through Happ VPN (VLESS Reality camouflage). Kindle lacked VPN capabilities and sent raw HTTPS packets to overseas IPs. Deep Packet Inspection (DPI) in Myanmar dropped direct TLS handshakes to international IP ranges.
- **Solution:** Moved sync server and book catalog directly onto Mac mini (`192.168.31.15`) on the local Wi-Fi subnet, and routed external connections through Singapore custom domains (`kosync-sg.wavypremium.xyz` and `opds.wavypremium.xyz`) and local Sing-box proxy (`0.0.0.0:7890`). Kindle now connects seamlessly with zero GFW exposure.

---

### INC-02: Conflicting Document Hashes on Same Book Title
- **Symptom:** Devices reported successful `HTTP 200` sync responses, but bookmarks and progress remained out of sync between Paperwhite and Kindle Basic.
- **Root Cause:** KOReader identifies documents by computing a partial MD5 hash of binary file chunks at exponentially spaced offsets. Because books had been converted or imported via different paths, the binary files were non-identical, causing the server to treat them as two distinct books (`fca01ed1...` vs `20820c7c...`).
- **Solution:** Standardized book ingestion via Calibre-Web/OPDS. Downloading from the central OPDS feed guarantees byte-identical files and identical document hashes on all e-readers.

---

### INC-03: Calibre Database Lock Contention (`calibredb add`)
- **Symptom:** Web uploader failed with *"Another calibre program such as calibre-server is running"*.
- **Root Cause:** SQLite does not allow concurrent write access from separate OS processes (`calibredb` and `calibre-server`) against the same `metadata.db` file.
- **Solution:** Added `--enable-local-write` flag to `calibre-server` on port `8088`. Updated all ingestion scripts to pass `--with-library http://127.0.0.1:8088` instead of directory paths. Calibre server now manages all database writes safely through its internal socket.

---

### INC-04: Happ Extension Blocking User Prompts
- **Symptom:** Pi coding harness experienced multi-second latency and notification spam on every user message.
- **Root Cause:** `happ-vpn-guard.ts` registered synchronous event listeners (`pi.on("input")` and `pi.on("before_agent_start")`) that executed `macos-harness` accessibility queries via `execSync` on every single turn.
- **Solution:** Removed automatic turn hooks from `happ-vpn-guard.ts`, fixed button detection bugs in `happ_helper.py`, and synced updated extensions across fleet machines.

---

### INC-06: Telegram Ingest Bot Deadlock & Stalled Socket
- **Symptom:** Telegram bot (`@saroat_ospeto_bot`) stopped responding to incoming book sends and `/start` commands.
- **Root Cause:** Direct outbound TLS connections to `api.telegram.org` (`149.154.166.110`) were subject to firewall silent drops. Bun's `fetch()` had no abort timeout, leaving the TCP socket in `ESTABLISHED` state indefinitely for days. Re-launch attempts failed with `HTTP 409 Conflict` because the orphaned process held the polling lock.
- **Solution:** Routed all Telegram API communication through the local Sing-box VLESS proxy (`http://127.0.0.1:7890`). Added strict `AbortController` timeouts (35s poll, 20s download, 15s message) to prevent socket hangs, and updated LaunchAgent with auto-restart keepalives.

---

### INC-07: Calibre CLI Output Contamination & JSON Parse Crash
- **Symptom:** Telegram bot crashed during book ingestion with error: `JSON Parse error: Unable to parse JSON string`.
- **Root Cause:** When `HTTP_PROXY` was exported in the LaunchAgent environment, Python's `calibredb` detected proxy variables and appended debug text (`Using proxies: {'http': '127.0.0.1:7890'}`) to its standard output right after the JSON array. Calling `JSON.parse(res.stdout)` failed.
- **Solution:** Isolated proxy environment variables so child CLI processes (`calibredb`) communicate directly with local `127.0.0.1:8088` with clean environments. Implemented `safeParseJson` to extract only valid JSON bracket boundaries `[...]` / `{...}`, ignoring any stdout warnings or debug banners.

---

### INC-08: Sing-Box DNS Blackhole on macOS Empty `/etc/resolv.conf`
- **Symptom:** Sing-box VLESS proxy failed to connect to overseas endpoints; `curl --proxy` returned `Connection reset by peer` and HTTP `000`.
- **Root Cause:** macOS does not populate `/etc/resolv.conf` with active DNS resolvers (uses `scutil` / mDNSResponder). Sing-box compiled in Go defaulted to querying `127.0.0.1:53` and `[::1]:53`, causing DNS connection refused errors when resolving domain-based VLESS outbounds (`jprobin.wavypremium.xyz`, `usrobin.wavypremium.xyz`).
- **Solution:** Configured explicit UDP DNS servers (`8.8.8.8`, `1.1.1.1`) and set `route.default_domain_resolver = "dns-remote"` in `~/.config/sing-box/config.json`. Outbounds now resolve reliably without depending on macOS `/etc/resolv.conf`.

---

### INC-09: Background LaunchAgent Backup Blocked by macOS TCC
- **Symptom:** Daily 04:00 AM backup daemon `com.ospeto.reading-stack-backup` exited with code 1; backup archives were not created.
- **Root Cause:** macOS Transparency, Consent, and Control (TCC) prohibits non-interactive background LaunchAgents from writing to Removable Volumes (`/Volumes/Ospeto_SSD`) without explicit user interactive entitlement.
- **Solution:** Re-architected backup strategy into a dual-tier pipeline:
  1. Primary backup archives are written to `~/.backups/reading-stack/` in the user's home directory (always permitted by macOS sandbox).
  2. Opportunistic mirror syncs to `/Volumes/Ospeto_SSD/backups/reading-stack/` when accessible.
  3. Switched all 4 SQLite databases (`koreader-sync.db`, `cache.db`, `manga.db`, `metadata.db`) to `WAL` mode (`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;`) for zero-corruption power-loss resilience.
  4. Deployed automated 15-minute watchdog (`watchdog.sh`) to self-heal any failed service across the stack.

---

### INC-10: Credentials Committed Before Public Publication
- **Symptom:** Preparing the repository for public publication revealed a real Telegram bot token in earlier history, a real KOSync password salt (`KOSYNC_PASSWORD_SALT`) still exposed as a hardcoded fallback default at `HEAD` in `docker-compose.yml` and twice in `RUNBOOK.md`, and a real-looking KOSync `X-Auth-Key` in a sample request in `RUNBOOK.md`.
- **Root Cause:** Convenience defaults. A secret that has a working fallback in tracked files is a published secret the moment the repository becomes readable, and git history keeps every value readable after publication even if `HEAD` is cleaned.
- **Solution:**
  1. Removed every literal from the working tree at `HEAD`. All three stay readable in git history, which the captain accepted rather than force-pushing a rewrite across every branch and fork.
  2. Rotated the bot token in BotFather and verified it out-of-band: the old value returns `401`, the replacement returns `200`.
  3. Accepted the salt exposure instead of rotating it, so the exposed salt is still the salt production hashes with. Stored hashes are argon2id with their own embedded per-hash salt, so the salt alone reveals no password, but any `koreader-sync.db` copy outside the repository is crackable against a known salt.
  4. Accepted the `moe` `X-Auth-Key` exposure instead of changing that password. Revoking it would require that password change, and a salt rotation would not have revoked it either.
  5. Removed the salt default from `docker-compose.yml` (`${KOSYNC_PASSWORD_SALT:?...}` now refuses to start when it is unset or empty) and from both `RUNBOOK.md` recovery snippets, which read the salt from the launchd plist on the Mac mini and otherwise fail loudly instead of hashing with a wrong salt. Documented the matching restore carve-out: restoring an existing `koreader-sync.db` requires the salt that database was hashed with.
  6. Replaced a further MD5-shaped KOSync `X-Auth-Key` example in `RUNBOOK.md` with a placeholder, hardened `.gitignore` against key material, and disclosed the whole picture in the RUNBOOK Security Notice and the README Credential Hygiene section. See the Exposed Credentials Policy in `RUNBOOK.md`.

---

### INC-11: Uploader LaunchAgent Hangs on a Removable-Volume Library
- **Symptom:** `com.ospeto.book-uploader` started under launchd and appeared in `launchctl list` with a live PID, but `curl http://127.0.0.1:8086/api/books` never answered. The identical command started by hand served HTTP 200 within seconds. Earlier attempts had ended in `EADDRINUSE`, so the failure read as a lost startup race and survived several start-order attempts.
- **Root Cause:** Two independent faults behind one location.
  1. `~/Calibre Libraries/Agent Library` is a symlink to `/Volumes/Ospeto_SSD/Lighthouse_Agent_Library`, a removable volume. macOS TCC (`kTCCServiceSystemPolicyRemovableVolumes`) denies removable-volume access to anything launchd spawns, because a launch agent is its own TCC client with no grant. An interactive shell, by contrast, runs under a chain that already holds the entitlement — which is why the hand start worked.
  2. Denial alone does not explain a *hang*. From one launchd job, `/bin/cat`, `/usr/bin/python3` and `/bin/ls` returned `Operation not permitted` immediately, while `bun` never returned at all: `sample` showed the main thread parked in `guarded_open_np` / `openat$NOCANCEL`. The same wedge appeared for **every** client, including an interactive shell, once `/Volumes/Ospeto_SSD` stopped answering real I/O (StorageKit logged the disk reappearing at 01:14 and 02:35 on that host). A library read that never returns cannot fail loudly, so the server sat on the port serving nothing.
- **Evidence:** a launchd agent with byte-identical `ProgramArguments`/`WorkingDirectory`/`EnvironmentVariables` served **200** when pointed at a copy of `metadata.db` on local storage, and wedged in `openDatabase -> sqlite3BtreeOpen -> unixOpen -> robust_open2 -> guarded_open_np` when pointed at the real path. `tccd` logged `kTCCServiceSystemPolicyRemovableVolumes, preflight=yes, accessing={identifier=bun}` with no grant and no prompt.
- **Solution:**
  1. Added `uploader/library-preflight.ts`: a bounded, out-of-process startup probe. An in-process check would block in the same syscall, so the probe runs as a killable `/bin/sh -c 'exec /bin/ls …'` child under a hard SIGKILL deadline (`5s`, override `LIGHTHOUSE_LIBRARY_PROBE_TIMEOUT_MS`).
  2. The server now refuses to bind unless the library root and `metadata.db` are readable, and exits non-zero naming the observed cause (`missing`, `permission-denied`, `unresponsive`, `error`) plus both remedies. `ok` is the only verdict that starts, and it prints nothing; an absent library is fatal too, so a volume that mounts after the agent starts cannot leave a live PID serving no catalog.
  3. **Not fixed by code:** supervision can only work when the library is actually readable. The host fix is either moving the live library onto local storage and keeping the SSD as a backup target (recommended — no TCC dependency, survives reboots and runtime upgrades, and it also un-breaks `reading-ssd-backup`, which refuses to run because the source sits inside its own destination), or granting Full Disk Access to the runtime (fragile — keyed to the binary hash, lost on every upgrade). Both are captain actions.
  4. Companion detection: `com.ospeto.reading-ssd-backup` logs `Security Error: Calibre Library source cannot be located inside the destination path`, the same relocation seen from the backup side.

