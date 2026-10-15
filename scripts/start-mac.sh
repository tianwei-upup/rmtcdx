#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$task_root/.runtime/compat-workspace"
git -C "$task_root/.runtime/compat-workspace" init --quiet
if [[ ! -f "$task_root/.runtime/compat-workspace/README.md" ]]; then
  echo 'Safe compatibility fixture. Tests only send text with read-only sandbox.' > "$task_root/.runtime/compat-workspace/README.md"
fi
node --input-type=module - "$task_root" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const root = process.argv[2];
fs.writeFileSync(path.join(root, '.runtime/compat-repos.json'), JSON.stringify([
  {id:'remoteControlGPT',name:'Codex Remote',path:root,pinned:true},
  {id:'rmtagt-compat',name:'rmtagt-compat',path:path.join(root,'.runtime/compat-workspace'),pinned:true}
]));
NODE
cd "$task_root/services/rmtcdx"
exec env HOST=127.0.0.1 PORT=3210 CODEX_MODE=real \
  DATA_DIR="$task_root/.runtime/mac-data" REPO_CONFIG_PATH="$task_root/.runtime/compat-repos.json" \
  node apps/bridge/dist/main.js serve
