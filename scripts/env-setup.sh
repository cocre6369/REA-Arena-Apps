#!/usr/bin/env bash
# env-setup.sh - check (and optionally install) the reverse-engineering toolchain.
#
#   ./scripts/env-setup.sh --check      # report what's present, what's missing
#   ./scripts/env-setup.sh --install    # install what can be installed without a package manager
#   ./scripts/env-setup.sh --android    # install jadx + apktool into ./tools
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS="$ROOT/tools"
mkdir -p "$TOOLS"

have() { command -v "$1" >/dev/null 2>&1; }
ok()   { printf '  \033[32mok\033[0m      %-14s %s\n' "$1" "$2"; }
miss() { printf '  \033[33mmissing\033[0m  %-14s %s\n' "$1" "$2"; }

check() {
  echo "Universal:"
  for t in 'python3:this repo scripts' 'jq:JSON inspection' 'sqlite3:local databases' 'curl:fetching' 'git:case files' 'file:type triage' 'strings:string triage' 'xxd:hex dump'; do
    bin="${t%%:*}"; use="${t##*:}"
    if have "$bin"; then ok "$bin" "$use"; else miss "$bin" "$use"; fi
  done
  have node   && ok node "web tooling / webcrack / bundle-breaker" || miss node "web tooling (install Node 22+)"
  have pipx   && ok pipx "python tool installs" || miss pipx "pipx install pipx"
  have pip3   && ok pip3 "python tool installs" || true

  echo "Android:"
  for t in 'jadx:DEX to Java' 'apktool:smali + resources' 'apksigner:signing' 'adb:device access'; do
    bin="${t%%:*}"; use="${t##*:}"
    if have "$bin"; then ok "$bin" "$use"; else miss "$bin" "$use"; fi
  done

  echo "iOS:"
  for t in 'ipsw:class-dump + swift-dump' 'otool:Mach-O inspection' 'class-dump:ObjC headers'; do
    bin="${t%%:*}"; use="${t##*:}"
    if have "$bin"; then ok "$bin" "$use"; else miss "$bin" "$use (macOS / brew install blacktop/tap/ipsw)"; fi
  done

  echo "Dynamic:"
  for t in 'frida:dynamic instrumentation' 'objection:runtime exploration' 'mitmproxy:traffic capture'; do
    bin="${t%%:*}"; use="${t##*:}"
    if have "$bin"; then ok "$bin" "$use"; else miss "$bin" "$use"; fi
  done

  echo "Native / desktop:"
  for t in 'r2:disassembly' 'ghidra:decompiler' 'gdb:debugger' 'ltrace:library tracing' 'strace:syscall tracing'; do
    bin="${t%%:*}"; use="${t##*:}"
    if have "$bin"; then ok "$bin" "$use"; else miss "$bin" "$use"; fi
  done

  echo
  echo "This repo's scripts (always available, stdlib only):"
  for s in identify stringscan har2fixtures; do
    [ -f "$ROOT/scripts/$s.py" ] && ok "$s.py" "python3 scripts/$s.py" || miss "$s.py" "-"
  done
  [ -f "$ROOT/scripts/rekit" ] && ok rekit "./scripts/rekit" || miss rekit "-"
}

fetch() { # url dest
  echo "  downloading $1"
  if have curl; then curl -fsSL -o "$2" "$1"; elif have wget; then wget -q -O "$2" "$1"; else
    echo "  ! need curl or wget"; return 1; fi
}

latest_release() { # owner/repo -> asset url by regex
  local repo="$1" pattern="$2"
  local api="https://api.github.com/repos/$repo/releases/latest"
  local json
  json="$(curl -fsSL "$api" 2>/dev/null)" || { echo "  ! could not query $api"; return 1; }
  echo "$json" | python3 -c "
import json,sys,re
d=json.load(sys.stdin)
pat=re.compile(r'''$pattern''')
for a in d.get('assets',[]):
    if pat.search(a['name']):
        print(a['browser_download_url']); break
"
}

install_android() {
  echo "Installing Android tools into $TOOLS"
  need_java="yes"
  if have java; then need_java="no"; fi
  [ "$need_java" = "yes" ] && echo "  ! jadx and apktool need a JRE (apt install default-jre)"

  url="$(latest_release skylot/jadx 'jadx-[0-9.]+\.zip')" || url=""
  if [ -n "$url" ]; then
    fetch "$url" "$TOOLS/jadx.zip" && (cd "$TOOLS" && unzip -qo jadx.zip -d jadx && rm jadx.zip \
      && chmod +x jadx/bin/* && echo "  jadx -> $TOOLS/jadx/bin/jadx")
  else
    echo "  ! jadx download failed - get it from https://github.com/skylot/jadx/releases"
  fi

  url="$(latest_release iBotPeaches/Apktool 'apktool_[\d.]+\.jar')" || url=""
  if [ -n "$url" ]; then
    fetch "$url" "$TOOLS/apktool.jar" && echo "  apktool -> $TOOLS/apktool.jar (run: java -jar $TOOLS/apktool.jar)"
  else
    echo "  ! apktool download failed - get it from https://github.com/iBotPeaches/Apktool/releases"
  fi
}

install_python() {
  echo "Installing python tools"
  if have pipx; then PM=pipx
  elif have pip3; then PM="pip3 install --user"
  else echo "  ! no pipx or pip3"; return 1; fi
  for pkg in mitmproxy frida-tools objection; do
    if have "${pkg%%-*}"; then echo "  $pkg already present"; else
      echo "  $PM $pkg"; $PM install "$pkg" || echo "  ! $pkg install failed"; fi
  done
}

case "${1:---check}" in
  --check)   check ;;
  --install) check; echo; install_python; echo; install_android ;;
  --android) install_android ;;
  --python)  install_python ;;
  *) echo "usage: $0 [--check|--install|--android|--python]" ; exit 2 ;;
esac

cat <<'EOF'

Add to PATH when needed:
  export PATH="$PWD/tools/jadx/bin:$PATH"
  alias apktool='java -jar /path/to/apktool.jar'
EOF
