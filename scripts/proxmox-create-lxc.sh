#!/usr/bin/env bash
# Proxmox 호스트(노드) 쉘에서 직접 실행하는 스크립트입니다.
# Docker가 설치된 LXC 컨테이너를 새로 만들고 대시보드까지 자동으로 배포합니다.
# 스토리지/네트워크 브리지는 실행 중에 목록에서 골라서 선택합니다.
#
# 실행: bash proxmox-create-lxc.sh
set -e

REPO_URL="https://github.com/zerowar80/homelab-dashboard.git"

pick_one() {
  # 옵션이 하나뿐이면 자동 선택, 여러 개면 번호로 고르게 함
  local prompt="$1"; shift
  local options=("$@")
  if [ ${#options[@]} -eq 0 ]; then
    echo ""
    return 1
  fi
  if [ ${#options[@]} -eq 1 ]; then
    echo "${options[0]}"
    return 0
  fi
  echo "$prompt" >&2
  local PS3="번호 선택: "
  select opt in "${options[@]}"; do
    if [ -n "$opt" ]; then echo "$opt"; return 0; fi
  done
}

echo "==> [1/6] 컨테이너 루트 디스크용 스토리지 확인"
mapfile -t ROOTFS_STORAGES < <(pvesm status -content rootdir 2>/dev/null | awk 'NR>1{print $1}')
STORAGE=$(pick_one "루트 디스크에 쓸 스토리지를 선택하세요:" "${ROOTFS_STORAGES[@]}")
if [ -z "$STORAGE" ]; then
  echo "컨테이너 루트 디스크(rootdir)를 지원하는 스토리지가 없습니다. 'pvesm status' 로 직접 확인해주세요."
  exit 1
fi
echo "    선택됨: $STORAGE"

echo "==> [2/6] 템플릿 저장용 스토리지 확인"
mapfile -t TMPL_STORAGES < <(pvesm status -content vztmpl 2>/dev/null | awk 'NR>1{print $1}')
TEMPLATE_STORAGE=$(pick_one "LXC 템플릿을 저장할 스토리지를 선택하세요:" "${TMPL_STORAGES[@]}")
if [ -z "$TEMPLATE_STORAGE" ]; then
  echo "템플릿(vztmpl)을 지원하는 스토리지가 없습니다. 'pvesm status' 로 직접 확인해주세요."
  exit 1
fi
echo "    선택됨: $TEMPLATE_STORAGE"

echo "==> [3/6] 네트워크 브리지 확인"
mapfile -t BRIDGES < <(ip -o link show type bridge 2>/dev/null | awk -F': ' '{print $2}')
BRIDGE=$(pick_one "사용할 네트워크 브리지를 선택하세요:" "${BRIDGES[@]}")
BRIDGE="${BRIDGE:-vmbr0}"
echo "    선택됨: $BRIDGE"

echo "==> [4/6] 컨테이너 root 비밀번호 설정"
while true; do
  read -rsp "새 LXC의 root 비밀번호 입력: " CT_PASSWORD; echo
  read -rsp "비밀번호 확인: " CT_PASSWORD2; echo
  [ "$CT_PASSWORD" = "$CT_PASSWORD2" ] && [ -n "$CT_PASSWORD" ] && break
  echo "비밀번호가 비어있거나 서로 다릅니다. 다시 입력해주세요."
done

echo "==> [5/6] LXC 템플릿 목록 갱신"
pveam update

TEMPLATE=$(pveam available --section system | grep debian-12-standard | tail -1 | awk '{print $2}')
if [ -z "$TEMPLATE" ]; then
  echo "debian-12 템플릿을 찾지 못했습니다. 'pveam available' 결과를 확인해 TEMPLATE 변수를 직접 지정하세요."
  exit 1
fi
if ! pvesm list "$TEMPLATE_STORAGE" 2>/dev/null | grep -q "$TEMPLATE"; then
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE"
fi

CTID=$(pvesh get /cluster/nextid)
echo "==> [6/6] LXC #$CTID 생성 (템플릿: $TEMPLATE)"

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
pct exec "$CTID" -- bash -c "cd /opt/homelab-dashboard && docker compose up -d --build"

IP=$(pct exec "$CTID" -- hostname -I | awk '{print $1}')

echo ""
echo "================================================================"
echo " LXC #$CTID 생성 및 대시보드 실행 완료 (IP: ${IP:-확인중})"
echo ""
echo " 브라우저에서 접속한 뒤 우측 상단 '⚙ 설정' 버튼으로"
echo " Proxmox/Synology 접속 정보를 입력하세요:"
echo "   http://${IP:-<컨테이너IP>}:3000"
echo "================================================================"
