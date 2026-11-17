#!/bin/sh
# scripts/kindle-key-install.sh
#
# PURPOSE
#   Runs ON a jailbroken Kindle (busybox /bin/sh). Installs one OpenSSH public
#   key into the authorized_keys file that the device's SSH daemon actually
#   reads, idempotently, so key-based login needs no password prompt.
#
# USAGE (from the Mac mini, over an SSH route that already works)
#   ssh -p 2222 root@<kindle-ip> 'sh -s' < scripts/kindle-key-install.sh
#   bin/lighthouse kindle-ssh key --device 1          # wrapper does the above
#
#   --dry-run          resolve and report the target path, write nothing
#   --target <path>    force an exact authorized_keys path (testing / override)
#   --key <file>       read the public key from a file instead of stdin
#   --uninstall        remove the key from the resolved target instead of adding it
#
# SAFETY
#   Writes ONLY the authorized_keys file and (if missing) its .ssh parent
#   directory. It never reads or modifies KOReader configuration, settings,
#   plugins, sidecar files, or books. It never restarts or stops a service.
#
# EXIT CODES
#   0 installed/already present/removed (or dry-run ok)
#   2 bad input (empty or malformed key)
#   3 filesystem write failure, or the authorized_keys file could not be read

set -u

DRY_RUN=0
UNINSTALL=0
TARGET_OVERRIDE=""
KEY_FILE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --target) shift; TARGET_OVERRIDE="${1:-}" ;;
    --key) shift; KEY_FILE="${1:-}" ;;
    -h|--help) sed -n '2,29p' "$0" 2>/dev/null; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

# ---------------------------------------------------------------------------
# 1. Read and validate the public key
# ---------------------------------------------------------------------------
if [ -n "$KEY_FILE" ]; then
  [ -r "$KEY_FILE" ] || { echo "ERROR: cannot read key file: $KEY_FILE" >&2; exit 2; }
  KEY=$(cat "$KEY_FILE")
else
  KEY=$(cat)
fi

# Strip CR so a key pasted through a Windows-ish path still matches.
KEY=$(printf '%s' "$KEY" | tr -d '\r')
[ -n "$KEY" ] || { echo "ERROR: no public key provided (stdin was empty)" >&2; exit 2; }

case "$KEY" in
  ssh-ed25519\ *|ssh-rsa\ *|ecdsa-sha2-nistp256\ *|ecdsa-sha2-nistp384\ *|ecdsa-sha2-nistp521\ *)
    : ;;
  *)
    echo "ERROR: input is not an OpenSSH public key (expected 'ssh-ed25519 AAAA...' etc.)" >&2
    exit 2 ;;
esac

# ---------------------------------------------------------------------------
# 2. Resolve which authorized_keys file the daemon reads
#    Authoritative source: root's home directory in the password database.
#    On Kindle firmware root's home is often volatile (/tmp/root), so we also
#    prefer an already-populated persistent file when one exists.
# ---------------------------------------------------------------------------
PASSWD_FILE="${KEYINSTALL_PASSWD:-/etc/passwd}"
ROOT_HOME=$(awk -F: '$1=="root"{print $6; exit}' "$PASSWD_FILE" 2>/dev/null)
[ -n "${ROOT_HOME:-}" ] || ROOT_HOME="/tmp/root"
HOME_KEYS="${ROOT_HOME%/}/.ssh/authorized_keys"

if [ -n "$TARGET_OVERRIDE" ]; then
  TARGET="$TARGET_OVERRIDE"
  BASIS="explicit --target"
elif [ -f "$HOME_KEYS" ] && grep -q '^ssh-\|^ecdsa-' "$HOME_KEYS" 2>/dev/null; then
  # A populated file under root's home proves this is the file dropbear reads.
  TARGET="$HOME_KEYS"
  BASIS="root home authorized_keys already populated (${HOME_KEYS})"
elif [ -f /etc/dropbear/authorized_keys ]; then
  TARGET="/etc/dropbear/authorized_keys"
  BASIS="dropbear system-wide authorized_keys"
else
  TARGET="$HOME_KEYS"
  BASIS="created root home authorized_keys (${HOME_KEYS})"
fi

DIR=$(dirname "$TARGET")

if [ "$DRY_RUN" = "1" ]; then
  if [ "$UNINSTALL" = "1" ]; then
    echo "[dry-run] would remove key from ${TARGET} (basis: ${BASIS})"
  else
    echo "[dry-run] would install key into ${TARGET} (basis: ${BASIS})"
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# 3. Apply
# ---------------------------------------------------------------------------
if [ "$UNINSTALL" = "1" ]; then
  if [ -f "$TARGET" ]; then
    TMP="${TARGET}.lighthouse.$$"
    grep -vF "$KEY" "$TARGET" > "$TMP" 2>/dev/null
    REMOVE_STATUS=$?
    if [ "$REMOVE_STATUS" -ne 0 ] && [ "$REMOVE_STATUS" -ne 1 ]; then
      rm -f "$TMP" 2>/dev/null
      echo "ERROR: could not read ${TARGET} (grep exit ${REMOVE_STATUS}); nothing was changed" >&2
      exit 3
    fi
    mv "$TMP" "$TARGET" 2>/dev/null || { echo "ERROR: could not rewrite ${TARGET}" >&2; exit 3; }
    chmod 600 "$TARGET" 2>/dev/null
    echo "REMOVED ${TARGET}"
  else
    echo "ABSENT ${TARGET}"
  fi
  echo "BASIS ${BASIS}"
  exit 0
fi

[ -d "$DIR" ] || mkdir -p "$DIR" 2>/dev/null || {
  echo "ERROR: cannot create ${DIR}" >&2; exit 3; }
chmod 700 "$DIR" 2>/dev/null || true

if [ -f "$TARGET" ] && grep -qF "$KEY" "$TARGET" 2>/dev/null; then
  echo "ALREADY_PRESENT ${TARGET}"
else
  printf '%s\n' "$KEY" >> "$TARGET" 2>/dev/null || {
    echo "ERROR: cannot append to ${TARGET}" >&2; exit 3; }
  echo "INSTALLED ${TARGET}"
fi
chmod 600 "$TARGET" 2>/dev/null || true
echo "BASIS ${BASIS}"

# ---------------------------------------------------------------------------
# 4. Warn when the chosen path will not survive a reboot
# ---------------------------------------------------------------------------
case "$TARGET" in
  /tmp/*|/var/tmp/*|/run/*)
    echo "VOLATILE ${TARGET} lives on a RAM-backed path; re-run this installer after a reboot,"
    echo "VOLATILE or mirror it once into a persistent file (see RUNBOOK.md, Kindle SSH section)."
    ;;
esac

exit 0
