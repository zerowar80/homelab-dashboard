# 홈랩 대시보드

Proxmox VE와 Synology DSM 상태를 한 화면에서 보는 모니터링 페이지입니다.
VM/컨테이너, 스토리지 볼륨 정보는 한 번 클릭으로 펼치고 접을 수 있고, 각 서버의 실제
관리 화면은 우측 상단 "웹 UI 열기" 버튼으로 바로 이동합니다. 15초마다 자동 새로고침됩니다.

**포함 기능**
- Proxmox 노드 CPU/메모리/디스크, VM·LXC별 "실행 중 / 중지됨" 표시
- Synology CPU/메모리/스토리지 사용량
- **Synology Container Manager(Docker) 컨테이너별 실행 상태**
- **Proxmox 방화벽 로그 기반 최근 접속 시도(IP) 표시 + 원클릭 IP 차단**
- **Synology 현재 로그인 세션(계정/IP) 표시 + 원클릭 IP 차단**
- 두 서버 모두 차단 목록을 대시보드에서 바로 확인/해제

> ⚠️ Proxmox·Synology 모두 공식적으로 정식 문서화되지 않은 내부 API를 일부 사용합니다
> (특히 Synology의 로그인 세션/Docker 컨테이너 API). DSM 버전에 따라 응답 형식이 달라질
> 수 있고, 이 경우 해당 섹션에 에러 메시지가 표시됩니다 — `server.js`에서 필드명을
> 조정하면 됩니다.

## 설치 방법 (3가지 중 선택)

먼저 이 프로젝트를 GitHub 저장소에 올려두면 아래 방법들이 편해집니다. 저장소 주소를
`YOUR_USERNAME` 부분만 본인 것으로 바꿔서 사용하세요.

### A. Proxmox — LXC 자동 생성 (한 번에 설치)

**Proxmox 웹 UI의 노드 → Shell**에서 아래 실행 (Docker가 설치된 새 LXC 컨테이너를
만들고 대시보드까지 클론해줍니다):

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/YOUR_USERNAME/homelab-dashboard/main/scripts/proxmox-create-lxc.sh)
```

스크립트 안의 `STORAGE`, `CT_PASSWORD` 값은 본인 환경에 맞게 미리 열어서 수정해두는 걸
권장합니다 (`pvesm status`로 스토리지 이름 확인). 완료되면 안내에 따라 LXC 안에서
`.env`만 채우고 `docker compose up -d --build` 한 번 더 실행하면 끝입니다.

### B. 이미 있는 VM/LXC에 설치 (범용 1줄 설치)

Docker를 쓸 수 있는 Debian/Ubuntu 계열 VM이나 LXC 안에서:

```bash
sudo bash <(curl -fsSL https://raw.githubusercontent.com/YOUR_USERNAME/homelab-dashboard/main/install.sh) \
  https://github.com/YOUR_USERNAME/homelab-dashboard.git
```

Docker가 없으면 자동 설치하고, 프로젝트를 클론한 뒤 `.env`가 없으면 템플릿을 만들어주고
멈춥니다 — `.env`를 채운 뒤 같은 명령을 한 번 더 실행하면 빌드 및 실행까지 됩니다.

### C. Synology — Container Manager (GUI, 가장 안전)

Synology는 시스템 특성상 임의 스크립트로 패키지를 설치하는 게 권장되지 않으므로 GUI로
진행하는 걸 추천합니다.

1. GitHub 저장소 페이지에서 **Code → Download ZIP**으로 내려받기
2. DSM **File Station**에서 공유폴더(예: `docker`) 아래에 압축을 풀어 업로드
3. 패키지 센터에서 **Container Manager** 설치 (없다면)
4. Container Manager → **프로젝트 → 생성** → 경로를 방금 업로드한 폴더로 지정
   (`docker-compose.yml`을 자동으로 인식합니다)
5. 생성 전에 File Station에서 `.env.example`을 `.env`로 복사 + 이름 변경하고, 텍스트
   편집기로 열어 접속 정보를 채워두세요
6. **빌드** 실행 → 완료되면 `http://시놀로지IP:3000` 접속

---

## 1. Proxmox API 토큰 만들기

1. Proxmox 웹 UI 접속 → **Datacenter → Permissions → API Tokens → Add**
2. User: `root@pam` (또는 별도 모니터링 전용 계정), Token ID: `dashboard`
3. **Privilege Separation 체크 해제** (해제 안 하면 별도로 권한을 부여해야 합니다)
4. 생성된 Token ID(`root@pam!dashboard`)와 Secret을 `.env`에 기록

Proxmox 접속 시도 목록은 **노드 방화벽 로그**에서 가져옵니다. 기본적으로 꺼져 있으므로
보려면 **Datacenter → Firewall → Options**에서 방화벽을 켜고, 로그를 보고 싶은 노드의
**Firewall → Options**에서 `Log level in`을 `info` 이상으로 설정하세요. 켜지 않아도
차단 기능(수동 IP 입력) 자체는 그대로 작동합니다.

## 2. Synology 읽기 전용 계정 만들기

1. DSM → **제어판 → 사용자 및 그룹 → 사용자 → 생성**
2. `dashboard-readonly` 같은 이름으로 생성, 애플리케이션 권한은 최소한으로 제한
3. 계정/비밀번호를 `.env`에 기록
4. Docker 컨테이너 목록을 보려면 **Container Manager**(구 Docker) 패키지가 설치되어
   있어야 하고, 위 계정이 해당 패키지 접근 권한을 갖고 있어야 합니다
5. IP 차단은 DSM의 **제어판 → 보안 → 계정 → 자동 차단** 기능을 사용합니다. 이 계정으로
   보안 설정을 변경할 수 있어야 하므로, 관리자 권한이 필요할 수 있습니다

> 두 서비스 모두 자체 서명 인증서를 쓰는 경우가 많아 서버 쪽에서 인증서 검증을 끄고
> 요청합니다(사설 네트워크 내부용으로만 사용하세요).

## 3. 설정 파일 준비

```bash
cp .env.example .env
# .env 파일을 열어 위에서 만든 값들을 채워 넣으세요
```

## 4. 실행 (Docker Compose)

```bash
docker compose up -d --build
```

브라우저에서 `http://<서버IP>:3000` 접속.

> 위 "설치 방법" 섹션의 A/B/C 방법을 썼다면 이 3, 4단계는 이미 끝나 있는 상태입니다.

## 폴더 구조

```
homelab-dashboard/
├── server.js          # Express 백엔드 (Proxmox/Synology API 프록시)
├── package.json
├── public/
│   └── index.html      # 프론트엔드 (단일 파일, CSS/JS 인라인)
├── Dockerfile
├── docker-compose.yml
├── install.sh          # 범용 1줄 설치 스크립트 (VM/LXC 안에서 실행)
├── scripts/
│   └── proxmox-create-lxc.sh  # Proxmox 호스트에서 LXC 자동 생성 + 설치
├── .env.example
└── .gitignore
```

## IP 차단은 어떻게 동작하나요

- **Proxmox**: 대시보드 전용 방화벽 ipset(`dashboard_blocked`)을 자동으로 만들고, 이 ipset을
  차단(DROP)하는 클러스터 방화벽 규칙을 한 번만 추가합니다. 이후 "차단" 버튼을 누르면 이
  ipset에 IP만 추가/삭제하므로 기존 방화벽 설정은 건드리지 않습니다.
- **Synology**: DSM의 자동 차단(Auto Block) 목록에 IP를 추가/제거합니다.

## 커스터마이징 팁

- **새로고침 주기**: `public/index.html` 맨 아래 `setInterval(refresh, 15000)`의 숫자(ms)를 조정
- **VM 시작/중지 같은 제어 기능**: 현재는 조회 전용입니다. 필요하면 `server.js`에
  `POST /nodes/{node}/qemu/{vmid}/status/start` 같은 Proxmox API 엔드포인트를 추가하면 됩니다
  (실수로 서버를 끄는 걸 막기 위해 기본값에서는 제외했습니다)
- **색상/폰트**: `index.html` 상단 `:root` 안의 CSS 변수만 바꾸면 전체 톤이 바뀝니다
