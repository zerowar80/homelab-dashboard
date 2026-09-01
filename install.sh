#!/usr/bin/env bash
# 홈랩 대시보드 설치 스크립트
# 사용법: bash install.sh [GIT_REPO_URL] [설치경로]
# 예시:   bash install.sh https://github.com/USERNAME/homelab-dashboard.git
set -e

REPO_URL="${1:-https://github.com/YOUR_USERNAME/homelab-dashboard.git}"
INSTALL_DIR="${2:-/opt/homelab-dashboard}"

if [ "$EUID" -ne 0 ]; then
  echo "root 권한으로 실행해주세요: sudo bash install.sh"
  exit 1
fi

echo "==> [1/4] Docker 설치 확인"
if ! command -v docker &>/dev/null; then
  curl -fsSL https://get.docker.com | sh
else
  echo "    이미 설치되어 있습니다."
fi

echo "==> [2/4] 프로젝트 내려받기"
if [ -d "$INSTALL_DIR/.git" ]; then
  git -C "$INSTALL_DIR" pull
else
  command -v git &>/dev/null || (apt-get update -qq && apt-get install -y -qq git)
  git clone "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

echo "==> [3/4] 환경설정 파일 준비"
if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  echo "  아직 접속 정보가 없습니다. 아래 파일을 열어 채운 뒤"
  echo "  이 스크립트를 다시 실행하세요:"
  echo "    ${INSTALL_DIR}/.env"
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  exit 0
fi

echo "==> [4/4] 빌드 및 실행"
docker compose up -d --build

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo ""
echo "설치 완료! 브라우저에서 접속하세요: http://${IP:-<서버IP>}:3000"
