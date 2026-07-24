#!/usr/bin/env bash
# pi-git-sync Bootstrap Script
#
# 在新机器上自动完成首次安装。
# 用法：
#   bash <(curl -s https://raw.githubusercontent.com/<user>/<repo>/main/scripts/bootstrap.sh)
#   或
#   ./scripts/bootstrap.sh <config-repo-url>
#
set -euo pipefail

REPO_URL="${1:-}"

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; }

echo ""
echo "============================================"
echo "  pi-git-sync Bootstrap"
echo "============================================"
echo ""

# 1. 检查 git
if ! command -v git &>/dev/null; then
  error "git is not installed. Please install git first."
  exit 1
fi
info "git: $(git --version)"

# 2. 检查 pi
if ! command -v pi &>/dev/null; then
  error "pi is not installed. Please install pi first."
  error "Visit: https://pi.dev"
  exit 1
fi
info "pi: $(pi --version 2>/dev/null || echo 'installed')"

# 3. 检查 SSH（如果使用 SSH URL）
if [[ "${REPO_URL}" == git@* ]] || [[ "${REPO_URL}" == ssh://* ]]; then
  if ! ssh -T git@github.com 2>&1 | grep -q "successfully authenticated"; then
    warn "SSH connection to GitHub could not be verified."
    warn "Please ensure your SSH key is configured: https://docs.github.com/en/authentication/connecting-to-github-with-ssh"
  else
    info "SSH: connected to GitHub"
  fi
fi

# 4. 确定配置仓库 URL
if [[ -z "${REPO_URL}" ]]; then
  warn "No config repo URL provided."
  warn "Usage: ./bootstrap.sh git@github.com:<user>/pi-config.git"
  echo ""
  read -r -p "Enter your config repo URL: " REPO_URL
  if [[ -z "${REPO_URL}" ]]; then
    error "No URL provided. Exiting."
    exit 1
  fi
fi

# 5. 确定克隆路径
CONFIG_DIR="${HOME}/.pi/config-repo"

info "Config repository: ${REPO_URL}"
info "Clone path: ${CONFIG_DIR}"

# 6. 克隆或更新配置仓库
if [[ -d "${CONFIG_DIR}/.git" ]]; then
  info "Config repo already exists, updating..."
  git -C "${CONFIG_DIR}" fetch origin
  git -C "${CONFIG_DIR}" pull --ff-only origin main 2>/dev/null || true
else
  info "Cloning config repository..."
  mkdir -p "$(dirname "${CONFIG_DIR}")"
  git clone "${REPO_URL}" "${CONFIG_DIR}"
fi

# 7. 安装 pi package
info "Installing as Pi package..."
pi install "${CONFIG_DIR}" || {
  warn "pi install failed. The path may already be in settings.json, or you can add it manually:"
  warn "  pi install ${CONFIG_DIR}"
}

# 8. 提示下一步
echo ""
info "============================================"
info "  Bootstrap complete!"
info "============================================"
info ""
info "Next steps:"
info "  1. Start pi"
info "  2. Run /pisync apply to apply config"
info "  3. Run /pisync doctor to verify setup"
info ""
