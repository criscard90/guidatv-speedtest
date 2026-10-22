#!/bin/sh
set -u

cd "$(dirname "$0")"
exec >> /tmp/cline-port-visibility.log 2>&1

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js is unavailable; bridge not started." >&2
  exit 1
fi
NODE_MAJOR=$(node -p "Number(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "ERROR: Cline requires Node.js 22 or newer (found $(node --version)); bridge not started." >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm is unavailable; cannot install bridge dependencies." >&2
  exit 1
fi
if [ ! -d node_modules/ws ] || [ ! -x node_modules/cline/bin/.cline ]; then
  if ! npm install --no-audit --no-fund; then
    echo "ERROR: bridge dependency installation failed; bridge not started." >&2
    exit 1
  fi
fi
if [ ! -x node_modules/cline/bin/.cline ]; then
  echo "ERROR: the pinned Cline CLI is unavailable; bridge not started." >&2
  exit 1
fi

if ! pgrep -f '[n]ode .*server\.js' >/dev/null; then
  if ! command -v setsid >/dev/null 2>&1; then
    echo "ERROR: setsid is unavailable; bridge not started." >&2
    exit 1
  fi
  setsid -f node server.js > /tmp/cline-bridge.log 2>&1 < /dev/null
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "ERROR: curl is unavailable; cannot verify the bridge." >&2
  exit 1
fi

attempt=1
while [ "$attempt" -le 15 ]; do
  if curl -fsS --max-time 2 http://127.0.0.1:3000/ 2>/dev/null |
    grep -Fxq "Cline Agent Mobile Bridge Server"; then
    echo "Bridge server pronto sulla porta 3000."
    break
  fi
  if [ "$attempt" -eq 15 ]; then
    echo "ERROR: bridge is not responding on port 3000; recent logs:" >&2
    tail -n 20 /tmp/cline-bridge.log >&2 || true
    exit 1
  fi
  sleep 2
  attempt=$((attempt + 1))
done

if ! command -v gh >/dev/null 2>&1; then
  echo "ERROR: GitHub CLI is unavailable; bridge started but port 3000 was not published." >&2
  exit 1
fi
if [ -z "${CODESPACE_NAME:-}" ]; then
  echo "ERROR: CODESPACE_NAME is not set; bridge started but port 3000 was not published." >&2
  exit 1
fi

attempt=1
while [ "$attempt" -le 12 ]; do
  if gh codespace ports visibility "3000:private" --codespace "$CODESPACE_NAME" &&
    gh codespace ports visibility "3000:public" --codespace "$CODESPACE_NAME"; then
    echo "Port 3000 published automatically."
    exit 0
  fi
  echo "Port publication failed (attempt $attempt/12)." >&2
  sleep 5
  attempt=$((attempt + 1))
done

echo "ERROR: unable to publish port 3000; bridge remains running for diagnostics." >&2
exit 1
