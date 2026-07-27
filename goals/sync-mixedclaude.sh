#!/usr/bin/env bash
# 同步 mixedClaude 上游仓库 → 当前工作区
#
# 行为：
#  - 用 git clone --depth 1 临时下载 upstream（不保留 .git 信息）
#  - rsync 复制 src/ web/ scripts/ docs/ tests/ 等除 goals/ 外的所有目录
#  - 保留当前 mrp/ 的 goals/ 目录（MRP 业务专属，不应被覆盖）
#  - 同步 .env.example package.json package-lock.json tsconfig.json readme.md
#  - 报告变更（增加/修改/删除）
#  - 清理临时目录
#
# 运行（必须在项目根目录）：
#   bash goals/sync-mixedclaude.sh
#
# 选项：
#   --dry-run    只打印将要做什么,不实际复制
#   --no-cleanup  保留临时 clone 目录(便于排查)
#
# 适用于：当前 mrp/ 仓库同步自 https://github.com/BinSunnikao12/mixedClaude

set -euo pipefail

# ---------- 参数 ----------
DRY_RUN=false
KEEP_TEMP=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --no-cleanup) KEEP_TEMP=true ;;
    -h|--help)
      echo "用法: bash goals/sync-mixedclaude.sh [--dry-run] [--no-cleanup]"
      exit 0
      ;;
  esac
done

# ---------- 路径 ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
UPSTREAM_REPO="https://github.com/BinSunnikao12/mixedClaude.git"
UPSTREAM_BRANCH="main"
TMP_DIR="$(mktemp -d -t mixedclaude-sync-XXXXXX)"
SRC_DIR="$TMP_DIR/src"

# 不同步的目录(项目里 MRP 业务专属,不能被 upstream 覆盖)
PROTECTED_DIRS=("goals")

# 永远排除的项(无论谁都不能动)
# - .git/ 重要: 保留当前 mrp/ 仓库的 git 历史
# - node_modules/ 重要: 依赖应该 npm install,不通过 rsync 复制
# - package-lock.json 重要: 同样应该 npm install 重新生成
# - .env 用户的环境,不覆盖
# - .cache 临时的,不覆盖
# - workspace/ 重要: mrp/ 自己的产物目录,常驻
# - logs/ 重要: mrp/ 自己的工作日志,常驻
HARD_EXCLUDES=(
  ".git/"
  "node_modules/"
  "package-lock.json"
  ".env"
  ".env.local"
  ".cache/"
  ".DS_Store"
  "workspace/"
  "logs/"
)

# ---------- 配色 ----------
if [[ -t 1 ]]; then
  RESET=$'\033[0m'
  BOLD=$'\033[1m'
  RED=$'\033[31m'
  GREEN=$'\033[32m'
  YELLOW=$'\033[33m'
  BLUE=$'\033[34m'
  CYAN=$'\033[36m'
  DIM=$'\033[2m'
else
  RESET="" BOLD="" RED="" GREEN="" YELLOW="" BLUE="" CYAN="" DIM=""
fi

info()  { echo "${CYAN}${BOLD}[INFO]${RESET} $*" >&2; }
ok()    { echo "${GREEN}${BOLD}[OK]${RESET}   $*" >&2; }
warn()  { echo "${YELLOW}${BOLD}[WARN]${RESET} $*" >&2; }
err()   { echo "${RED}${BOLD}[ERR]${RESET}  $*" >&2; }

# ---------- 准备 ----------
info "项目根: $PROJECT_ROOT"
info "Upstream: $UPSTREAM_REPO @ $UPSTREAM_BRANCH"
info "临时目录: $TMP_DIR"

cd "$PROJECT_ROOT"

# 确认 git 可用
if ! command -v git >/dev/null 2>&1; then
  err "需要 git"
  exit 1
fi
# 确认 rsync 可用
if ! command -v rsync >/dev/null 2>&1; then
  err "需要 rsync (macOS: brew install rsync 或 xcode-select --install)"
  exit 1
fi

# ---------- 1. clone upstream ----------
info "Cloning upstream (depth=1) ..."
if ! git clone --depth 1 --branch "$UPSTREAM_BRANCH" "$UPSTREAM_REPO" "$SRC_DIR" >&2; then
  err "克隆失败"
  rm -rf "$TMP_DIR"
  exit 1
fi
ok "克隆成功"

# ---------- 2. 准备 rsync 命令 ----------
# 排除列表: 业务专属目录 + 永远排除的(保护 .git/ 等)
EXCLUDE_ARGS=()
for d in "${PROTECTED_DIRS[@]}"; do
  EXCLUDE_ARGS+=(--exclude="$d/")
done
for d in "${HARD_EXCLUDES[@]}"; do
  EXCLUDE_ARGS+=(--exclude="$d")
done

# rsync 标志:
#   -a 归档模式 (保留权限/时间)
#   -v 输出变化的文件
#   --delete 删除目标中存在但源中不存在的文件
#   --exclude 排除 protected
#   -n 干运行
#   --itemize-changes 打印每项的变化( i/C/H/./d 等)
RSYNC_OPTS=(-a --delete --itemize-changes)
if [[ "$DRY_RUN" == true ]]; then
  RSYNC_OPTS+=(-n)
  info "DRY-RUN: 只打印,不做实际改动"
fi

# ---------- 3. 计算变更并同步 ----------
info "开始同步 ..."
echo "${BOLD}=== 变更报告 ===${RESET}"

# 收集变化的文件(added/changed/deleted)
CHANGED_LINES=$(
  rsync "${RSYNC_OPTS[@]}" "${EXCLUDE_ARGS[@]}" "$SRC_DIR/" "$PROJECT_ROOT/" 2>&1 || true
)

# 解析 rsync --itemize-changes 输出
# 格式: YXcstpoguax  filename
#   X = >f (文件) >d (目录) ...
#   c = checksum 不同
#   s = size 不同
#   t = mtime 不同
# 简化: 第 11 列起是文件名
ADDED=0
MODIFIED=0
DELETED=0
DELETED_DIR=0
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  marker="${line:0:11}"
  fname="${line:11}"
  fname="${fname# }"
  # 跳过 hiding 文件保护
  skip=false
  for d in "${PROTECTED_DIRS[@]}"; do
    if [[ "$fname" == "$d" || "$fname" == "$d/"* ]]; then
      skip=true
      break
    fi
  done
  $skip && continue

  # 第一个字母表示类型,第二个字母表示动作
  type_char="${marker:0:1}"
  action_char="${marker:1:1}"

  case "$type_char" in
    ">")
      # 文件
      case "$action_char" in
        "+") echo "${GREEN}+ 新增 $fname${RESET}"; ADDED=$((ADDED+1)) ;;
        "c") echo "${YELLOW}~ 修改 $fname${RESET}"; MODIFIED=$((MODIFIED+1)) ;;
        "*") echo "${DIM}. 不变 $fname${RESET}" ;;
      esac
      ;;
    "d")
      # 目录
      case "$action_char" in
        "+") echo "${GREEN}+ 新增目录 $fname${RESET}"; ADDED=$((ADDED+1)) ;;
        "*") echo "${DIM}. 不变 $fname${RESET}" ;;
      esac
      ;;
    "*")
      case "$action_char" in
        "deleting") echo "${RED}- 删除 $fname${RESET}"; DELETED=$((DELETED+1)) ;;
      esac
      ;;
  esac
done <<< "$CHANGED_LINES"

# rsync --delete 在 --itemize-changes 模式下输出格式可能不同:
# 还会输出 "*deleting   path" 形式
# 上面 case "*"+action_char=="deleting" 已经覆盖;但保险起见再扫一遍
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  if [[ "$line" == *"deleting"* ]]; then
    fname="${line##*deleting }"
    fname="${fname#"${SRC_DIR}/"}"
    # 去重: 已经在统计里就不重复
    echo "${RED}- 删除 $fname${RESET}"
  fi
done <<< "$CHANGED_LINES"

# ---------- 4. 收尾 ----------
echo ""
echo "${BOLD}=== 总结 ===${RESET}"
echo "  新增:  $ADDED"
echo "  修改:  $MODIFIED"
echo "  删除:  $DELETED"

# 清理临时目录
if [[ "$KEEP_TEMP" == true ]]; then
  warn "保留临时目录: $TMP_DIR (--no-cleanup)"
else
  rm -rf "$TMP_DIR"
  ok "临时目录已清理"
fi

if [[ "$DRY_RUN" == true ]]; then
  warn "DRY-RUN 模式: 上面所有动作都未执行"
fi

ok "同步完成"
