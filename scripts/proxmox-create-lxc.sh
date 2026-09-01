#!/usr/bin/env bash
# Proxmox 호스트(노드) 쉘에서 직접 실행하는 스크립트입니다.
# Docker가 설치된 LXC 컨테이너를 새로 만들고 대시보드까지 자동으로 배포합니다.
#
# 사용 전 아래 변수들을 환경에 맞게 수정하세요 (스토리지 이름, 템플릿 등은
# Proxmox 설정마다 다릅니다). 실행: bash proxmox-create-lxc.sh
set -e

REPO_URL="https://github.com/YOUR_USERNAME/homelab-dashboard.git"  # <- 본인 저장소 주소로 변경
STORAGE="local-lvm"       # <- pvesm status 로 확인
TEMPLATE_STORAGE="local"  # 템플릿이 저장된 스토리지
BRIDGE="vmbr0"
CT_PASSWORD="ChangeMe123!"  # <- 반드시 변경하세요

echo "==> LXC 템플릿 목록 갱신"
pveam update

TEMPLATE=$(pveam available --section system | grep debian-12-standard | tail -1 | awk '{print $2}')
if [ -z "$TEMPLATE" ]; then
  echo "debian-12 템플릿을 찾지 못했습니다. 'pveam available' 결과를 확인해 TEMPLATE 변수를 직접 지정하세요."
  exit 1
fi
if [ ! -f "/var/lib/vz/template/cache/${TEMPLATE}" ]; then
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE"
fi

CTID=$(pvesh get /cluster/nextid)
echo "==> LXC #$CTID 생성 (템플릿: $TEMPLATE)"

pct create "$CTID" "${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}" \
  --hostname homelab-dashboard \
  --cores 2 --memory 1024 --swap 512 \
  --net0 "name=eth0,bridge=${BRIDGE},ip=dhcp" \
  --storage "$STORAGE" --rootfs "${STORAGE}:8" \
  --unprivileged 0 \
  --features nesting=1,keyctl=1 \
  --password "$CT_PASSWORD" \
  --onboot 1

echo "==> 컨테이너 시작"
pct start "$CTID"
sleep 6

echo "==> 컨테이너 안에 Docker + 대시보드 설치"
pct exec "$CTID" -- bash -c "apt-get update -qq && apt-get install -y -qq curl git ca-certificates"
pct exec "$CTID" -- bash -c "curl -fsSL https://get.docker.com | sh"
pct exec "$CTID" -- bash -c "git clone '${REPO_URL}' /opt/homelab-dashboard"
pct exec "$CTID" -- bash -c "cp /opt/homelab-dashboard/.env.example /opt/homelab-dashboard/.env"

IP=$(pct exec "$CTID" -- hostname -I | awk '{print $1}')

echo ""
echo "================================================================"
echo " LXC #$CTID 생성 완료 (IP: ${IP:-확인중})"
echo ""
echo " 다음 단계:"
echo " 1) pct exec $CTID -- vi /opt/homelab-dashboard/.env   # 접속 정보 입력"
echo " 2) pct exec $CTID -- bash -c 'cd /opt/homelab-dashboard && docker compose up -d --build'"
echo " 3) 브라우저에서 http://${IP:-<컨테이너IP>}:3000 접속"
echo "================================================================"
