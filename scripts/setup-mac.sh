#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
task_service="$task_root/services/rmtcdx"
task_commit="82433524e8fb431185fbc7556d1e8a1cf2f2976d"
for task_command in node npm git codex; do command -v "$task_command" >/dev/null || { echo "Missing: $task_command"; exit 1; }; done
node -e 'if(Number(process.versions.node.split(".")[0])<22)throw Error("Node.js 22 or newer is required")'
if [[ ! -d "$task_service/.git" ]]; then
  mkdir -p "$task_root/services"
  git clone https://github.com/tianwei-upup/rmtcdx.git "$task_service"
  git -C "$task_service" checkout --detach "$task_commit"
fi
[[ "$(git -C "$task_service" rev-parse HEAD)" == "$task_commit" ]] || { echo 'Unexpected upstream revision'; exit 1; }
task_patch="$task_root/patches/remote-control.patch"
if git -C "$task_service" apply --check "$task_patch" 2>/dev/null; then
  git -C "$task_service" apply "$task_patch"
elif ! git -C "$task_service" apply --reverse --check "$task_patch" 2>/dev/null; then
  echo 'Patch does not match current changes; refusing to overwrite.'; exit 1
fi
(cd "$task_service" && PUPPETEER_SKIP_DOWNLOAD=true npm ci && npm run build)
(cd "$task_root/control" && npm ci)
echo 'Ready. Run: bash scripts/start-mac.sh'
