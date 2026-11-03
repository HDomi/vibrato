# 로드맵

| 단계 | 내용 | 상태 |
|------|------|------|
| M0 뼈대 | Electron + Node 서버(11398) + React. 폴더 트리, 즐겨찾기, 프리뷰(md/이미지/영상/PDF/텍스트), CLI 감지·설치 버튼 | 완료 (2026-10-19) |
| M1 Claude | Agent SDK 어댑터(로컬 claude 바이너리), 스트리밍 채팅, 승인/질문 카드, 세션 resume, 권한 모드 토글, 드래그앤드롭 첨부, 사용량 헤더 | 완료 |
| M2 Codex | app-server JSON-RPC 어댑터, 통합 이벤트 스키마, Codex 스레드 목록/재개 | 완료 |
| M3 운영 | xterm.js PTY 탭, Terminal.app/Finder 열기, git pull 자동 업데이트 + 재시작, launchd 스크립트 | 완료 (launchd 설치는 미실행) |
| M4 확장 | 프로젝트별 멀티 세션 탭, git 패널(status/diff/stage/commit/log), 백그라운드 알림 | 완료 |
| M5 UX | 우클릭 컨텍스트 메뉴, 파일 브라우저 단축키/복사·붙여넣기/휴지통, 즐겨찾기 그룹, 패널 접기·드래그 분할, 모델 선택, 세션 이름 변경·삭제, 슬래시 커맨드 자동완성, 퀵오픈(⌘P), 코드 하이라이트·복사, 전역 단축키, 로그인 시 실행 토글 | 완료 |
| M6 IDE 모드 | 상단 모드 VIBE · IDE · 에이전트 분리, IDE 모드에 CodeMirror 6 편집기(지연 로드), 가상 스크롤 프로젝트 트리, 저장 충돌 감지(mtime 409), 재귀 FSEvents 감시로 자동 반영, 핫 엑싯 백업, Material Darker HC 테마 | 완료 (2026-10-26) |
| M7 도구 모드 | 상단 네 번째 모드 `도구`. 서버 없이 렌더러에서만 도는 유틸 10종: JSON 트리, JWT, AES·해시·HMAC, 인코딩, 시간, 정규식, Diff, UUID·난수, 텍스트, 색상. 순수 로직은 `web/src/lib/toolbox/`, 테스트 `tests/toolbox.test.ts` | 완료 (2026-10-26) |
| 다음 | mermaid, Gemini CLI 어댑터, 외부 접근(Tailscale + 인증), 세션 검색 | 미착수 |

## 첨부 파일 동작 규칙

- Finder에서 드롭: Electron `webUtils.getPathForFile` 로 절대 경로 획득 → 첨부 칩(이미지는 썸네일). 복사 없음.
- 앱 내 파일 트리에서 드롭: 경로 그대로 첨부.
- 브라우저(localhost) 모드 / 클립보드 붙여넣기: 경로를 읽을 수 없으므로 `/api/attach` 로 업로드 → `~/.vibrato/attachments/` 에 저장 후 그 경로 사용.
- Claude: 이미지는 base64 image 블록 + 경로 텍스트, 그 외 파일은 경로 텍스트. Codex: `localImage` / `mention` 입력 항목.

## 인증 원칙

- AI API 키는 사용하지 않는다. 설치된 `claude`(claude.ai 구독 로그인) 와 `codex`(ChatGPT 로그인) 바이너리만 쓴다.
- Claude: Agent SDK 를 쓰되 `pathToClaudeCodeExecutable` 로 로컬 `claude` 를 지정한다. `--bare` 는 OAuth 를 읽지 않으므로 쓰지 않는다. SDK 가 번들하는 바이너리(269MB)는 설치만 될 뿐 사용하지 않는다.
- Codex: `codex app-server` 가 현재 로그인 상태를 그대로 사용한다.
- 로그인/로그아웃은 앱 내 터미널 탭에서 `claude` → `/login`, `codex login` 으로 처리한다.

## 권한 모드 매핑

| UI | Claude (permissionMode) | Codex (approvalPolicy / sandbox) |
|----|------|------|
| 기본 | default | on-request / workspace-write |
| 편집 자동 | acceptEdits | on-request / workspace-write (동일) |
| 계획 | plan | on-request / read-only |
| 전부 허용 | bypassPermissions | never / danger-full-access |

## 업데이트 흐름

1. 서버가 시작 시 + 10분마다 `git fetch origin` 후 `HEAD...origin/<branch>` 카운트.
2. 뒤처진 커밋이 있으면 헤더 우측 배지 "업데이트 N".
3. 적용 → `git pull --ff-only && npm ci && npm run build` 를 SSE 로 스트리밍. 활성 세션이 있으면 보류(강제 옵션 있음).
4. 성공 시 서버가 종료 코드 75 로 나감. Electron 은 75 를 보면 `app.relaunch()`. launchd 는 KeepAlive 로 재시작. 브라우저 모드는 수동 재시작.
5. 로컬 변경이 있어 ff 불가하면 로그에 그대로 표시. 자동 stash 없음.

## 세션 수명주기 보장 (v0.3.7 전수조사 결과)

- 세션 닫기(탭 ✕, ⌘W, 서버 종료)는 항상 CLI 자식 프로세스를 끝낸다. Claude 는 AbortController, Codex 는 app-server kill.
- 서버 종료(SIGTERM/SIGINT, 업데이트 재시작)는 모든 세션과 PTY 셸을 닫고 나간다 (4초 상한).
- 아무 브라우저도 보고 있지 않고 6시간 동안 이벤트가 없는 세션은 10분 주기 리퍼가 닫는다.
- Codex app-server 요청은 120초(목록/모델 조회는 30초) 안에 응답이 없거나 프로세스가 죽으면 즉시 거부된다. 호출자가 영원히 기다리지 않는다.
- Codex 스레드 시작/재개 실패 시 반쯤 뜬 app-server 를 바로 죽인다. 30분 유휴로 app-server 가 스레드를 내리면 세션을 닫지 않고 다음 전송 때 `thread/resume` 한다.
- 전송 요청 자체가 실패하면 상태를 idle 로 되돌려 가짜 "작업 중" 이 남지 않는다.
- 업데이트 적용은 한 번에 하나만 실행된다.
- Electron 은 서버 자식이 죽으면 1.5초→30초 지수 백오프로 재시작한다. 다른 인스턴스가 포트를 쓰고 있으면 재시작 대신 그 서버에 붙는다.
- 부모가 강제 종료(SIGKILL)돼도 Claude CLI 는 stdin 종료로, Codex app-server(stdio) 는 연결 종료로, PTY 셸은 SIGHUP 으로 스스로 끝난다.

## 브라우저 탭 (v0.3.42 추가, v3.6.1 제거)

- 오른쪽 패널의 브라우저 탭(Electron `WebContentsView` · 일반 브라우저 모드의 headless Chrome CDP 대체)은 쓰이지 않아 제거했다. 실행 패널의 개발 서버 주소는 기본 브라우저로 연다. 실측은 전과 같이 앱 밖 `debugweb`(9222) Chrome 을 쓴다.
