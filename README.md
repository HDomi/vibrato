<p align="center">
  <img src="web/public/icon.png" width="128" alt="Vibrato" />
</p>

<h1 align="center">Vibrato</h1>

<p align="center">
  Claude Code · Codex CLI 를 한 화면에서 쓰는 macOS 전용 바이브코딩 앱.<br/>
  IDE 없이, 구독 로그인된 로컬 CLI 그대로, 내 입맛대로 만든 UI로.
</p>

<p align="center">
  <a href="https://github.com/HDomi/vibrato/releases/latest"><img src="https://img.shields.io/github/v/release/HDomi/vibrato?label=release&color=f59e0b" alt="Latest release" /></a>
  <a href="https://github.com/HDomi/vibrato/actions/workflows/release.yml"><img src="https://img.shields.io/github/actions/workflow/status/HDomi/vibrato/release.yml?label=build" alt="Release build" /></a>
  <a href="https://github.com/HDomi/vibrato/releases"><img src="https://img.shields.io/github/downloads/HDomi/vibrato/total?color=22c55e" alt="Downloads" /></a>
  <img src="https://img.shields.io/badge/macOS-14%2B%20·%20Apple%20Silicon-111?logo=apple" alt="macOS 14+ Apple Silicon" />
  <img src="https://img.shields.io/github/last-commit/HDomi/vibrato/main?label=last%20commit" alt="Last commit" />
</p>

<p align="center">
  <a href="https://github.com/HDomi/vibrato/releases/latest"><b>⬇ 최신 버전 다운로드 (DMG)</b></a>
  &nbsp;·&nbsp;
  <a href="#설치">설치</a>
  &nbsp;·&nbsp;
  <a href="#주요-기능">기능</a>
  &nbsp;·&nbsp;
  <a href="#릴리스--버전">릴리스</a>
  &nbsp;·&nbsp;
  <a href="#문제-해결">문제 해결</a>
</p>

<p align="center">
  <code>Electron</code> · <code>React</code> · <code>Hono</code> · <code>TypeScript</code> · 개인용 · API 키 없음
</p>

---

## 목차

- [왜 만들었나](#왜-만들었나)
- [하이라이트](#하이라이트)
- [주요 기능](#주요-기능)
- [설치](#설치)
- [사용법](#사용법)
- [업데이트](#업데이트)
- [릴리스 · 버전](#릴리스--버전)
- [동작 원리](#동작-원리)
- [파일 위치](#파일-위치)
- [개인정보 · 보안](#개인정보--보안)
- [문제 해결](#문제-해결)
- [개발](#개발)
- [문서](#문서)
- [참고](#참고)

## 왜 만들었나

바이브코딩을 하다 보면 코드를 직접 보는 시간보다 에이전트와 대화하는 시간이 길다. 그런데 Claude Code 는 이 터미널, Codex 는 저 터미널, 결과물 확인은 Finder 와 브라우저… 전부 흩어져 있다.
Vibrato 는 그걸 한 창에 모은다. 폴더를 고르면 그 폴더를 루트로 에이전트 세션이 열리고, 옆에서 파일을 보고, 터미널을 띄우고, 커밋까지 한다.

- **API 키를 쓰지 않는다.** 이미 설치·로그인된 `claude`(claude.ai 구독) 와 `codex`(ChatGPT) 바이너리를 그대로 쓴다. CLI 로 쓰는 것과 요금·한도가 똑같다.
- **코드는 안 숨긴다.** 전부 TypeScript. 마음에 안 드는 UI 는 고쳐 쓰면 된다.
- **설치 한 번, 업데이트는 클릭 한 번.** DMG 로 깔고, 새 릴리스가 나오면 헤더 배지에서 바로 받는다. 체크섬 · 번들 id · 서명을 확인하고 교체한다.

## 하이라이트

| | |
|---|---|
| 🤖 **두 에이전트, 한 UI** | Claude Code 와 Codex 이벤트를 공통 스키마로 맞춰 같은 채팅 · 승인 카드 · 도구 카드로 그린다. 같은 프롬프트를 둘에게 worktree 로 나눠 돌리고 나은 쪽을 고를 수도 있다 |
| 🗂 **계획표 보기** | 도구 실행 기록을 에이전트 체크리스트 단계 아래로 묶어 단계별 진행률 · 작업량 · 실패를 한눈에 |
| ⏰ **스케줄러** | 스킬 · 프롬프트를 cron 으로 예약 실행. 창이 닫혀 있어도 서버가 돌리고, 잠든 Mac 을 깨우는 옵션까지 |
| 🔒 **잠금화면** | ⌥L 로 모든 모니터를 덮는 PIN 잠금. 자리를 비워도 세션은 계속 돈다 |
| 🧰 **도구 모드** | JSON · JWT · 정규식 · Diff · cURL · HTTP 요청 · 네트워크 포트 등 개발 유틸 30여 종을 앱 안에서 |
| 🔁 **턴 단위 되돌리기** | 턴마다 바뀐 파일만 모아 hunk · 파일 · 턴 단위로 되돌리고, 검증 명령을 자동 실행 |

## 주요 기능

상단 모드 탭은 **VIBE · 에이전트 · 도구 · 스케줄러** 네 가지다. VIBE 는 프로젝트 폴더 기준 작업 화면, 에이전트는 프로젝트 없이 홈 폴더에서 바로 여는 세션, 도구는 개발 유틸, 스케줄러는 예약 실행이다.

| 영역 | 내용 |
|------|------|
| **에이전트 채팅** | Claude Code / Codex 선택, 토큰 스트리밍, 도구 실행 카드, 승인 카드(허용 · 항상 허용 · 거부+사유), 질문 카드, 권한 모드 · 모델 즉시 전환, 중단, 실행 중 큐잉/steer, 입력창 위 할 일 체크리스트, ⌘F 대화 검색, 메시지 단위 파일 되돌리기(Claude), 도구가 돌려준 이미지(Read 로 연 그림 · 스크린샷 · Codex 이미지 보기/생성) 썸네일 미리보기, 메시지 우클릭·손잡이로 다른 세션 입력창에 보내기(선택한 부분만도 가능), 답변 블록마다 완료 시각(HH:MM:SS), 대화를 블록 골라 Markdown 으로 내보내기 |
| **대화형 명령** | SDK 로는 화면이 안 뜨는 Claude 명령을 앱 안에서 처리. `/mcp` 는 세션 프로세스에 직접 묻는 관리 창(상태 · 도구 · 재연결 · 켜기/끄기 · 브라우저 인증), `/model` · `/effort` 는 선택 창, `/plugin` · `/hooks` 같은 설정 계열은 오른쪽 터미널 탭에서 `claude '/<명령>'` 으로 연다 |
| **계획표** | 채팅 헤더 **채팅 \| 계획** 토글. 에이전트 체크리스트(Claude TodoWrite, Codex 계획 업데이트, 답변에 쓴 계획)를 기준으로 각 작업을 그때 진행 중이던 단계 아래로 묶는다. 턴마다 진행률, 단계별 카드(상태 · 마지막 설명 · 명령/실패/거절/에러/파일 수 · 걸린 시간), 진행 중 단계의 실시간 활동 줄, 회차마다 반복된 단계는 a. b. c. 로 쌓고 결과에 진행 내역, 만든 파일 · 커밋 · 세션 요약. 승인 · 질문은 카드에서 바로 답한다. 설정에서 모든 요청을 계획부터 진행하도록 강제할 수 있다(Claude 는 훅으로 응답 검사) |
| **세션** | 프로젝트별 멀티 세션 탭(고정 · 최근 활동순 정렬 · 승인/질문 대기 뱃지 · 우클릭으로 이름 변경 · 세션 ID 복사 · 영구 삭제), 입력창 옆 백그라운드 세션 표시, 이전 세션 이어하기(두 에이전트 모두), 전체 프로젝트 최근 세션 목록, **지난 대화 전체 검색**(claude · codex 가 저장한 모든 대화를 내용으로 찾고 검색어 주변 문맥 강조, 누르면 이어서 열기), 이전 세션을 이어서 열면 요청 수 · 수정한 파일 · 만든 커밋 · 남은 할 일 · 마지막 답변 브리핑을 맨 위에 고정 |
| **입력** | `/` 슬래시 커맨드 · 스킬 자동완성, `@` 파일 멘션(프로젝트 루트 기준 퍼지 검색 + 자동 첨부), Finder 드롭 · 파일 트리 드롭 · 클립보드 이미지 붙여넣기, 저장한 프롬프트 넣기, 보내기 전 초안은 탭 전환·재시작 뒤에도 세션별로 유지. **Form 전송**: 목표 · 배경 · 대상 파일 · 재현 방법 · 요구사항 · 제약 · 완료 조건 칸을 채우면 Markdown 섹션으로 조립해 보내기(유형 칩 = 템플릿, 설정에서 편집, Claude 는 쓸 스킬까지 선택) |
| **파일** | 탐색기(싱글클릭 선택 · 더블클릭 열기, 확장자·파일명·폴더명별 [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme) 아이콘), ⌘C/⌘X/⌘V 복사·이동, 복제, 이름 변경, 새 폴더, 휴지통(Finder 경유 · 복원 가능), 우클릭 메뉴, 현재 폴더 안 파일 이름 검색, 퀵오픈 ⌘P |
| **미리보기** | Markdown(상대 경로 이미지 · 로컬 링크 해석 · 코드 하이라이트, 원문 복사, 내부 링크는 미리보기 안 레이어로, 답변 속 파일 경로도 눌러서 미리보기), 이미지(HEIC · TIFF · PSD · 카메라 RAW 등 브라우저가 못 여는 형식은 macOS ImageIO 로 렌더), 영상(탐색 가능), 오디오, PDF, 텍스트, 디스크가 바뀌면 자동 갱신. 이미지 우측 상단 **확장자/크기 변경**: PNG · JPEG · WebP · AVIF · HEIC · GIF · TIFF · BMP · JPEG 2000 · PSD · PDF · TGA · OpenEXR · PBM · ICO · ICNS · ASTC · KTX · PVR 로 변환, 크기 변경(비율 유지 · 25~100% 단축), 손실 형식 품질 조절. 저장은 같은 폴더 같은 이름에 확장자만 바꿔서, 다른 이름으로 저장도 가능. Markdown 은 **표 편집** 모드로 파일 안 표를 칸 단위로 고침(행 · 열 추가/삭제, 열 정렬, 스프레드시트 블록 붙여넣기, Enter 로 다음 행, 새 표 추가, MD · CSV · HTML 복사). 저장하면 고친 표만 한글 폭까지 맞춰 정렬해 다시 쓰고 나머지는 그대로, 줄바꿈(LF/CRLF) 유지, 디스크에서 바뀌었으면 덮어쓰지 않음 |
| **IDE 창** | 파일 탭의 IDE 버튼 · 파일 우클릭 › IDE에서 열기로 별도 창. 현재 프로젝트를 CodeMirror 6 로 편집(js/ts/json/yaml/css/html/md/py/sh 등 하이라이트, ⌘F 찾기·바꾸기, 다중 커서, 접기), 탭(한 번 클릭은 미리보기 탭 · 편집하면 고정), 접히는 프로젝트 트리(가상 스크롤 · 새 파일/폴더 · 이름 변경 · 휴지통), 저장 ⌘S · 전체 저장 ⌥⌘S, 디스크 변경 자동 반영(편집 중이면 충돌 배너), 저장 안 한 내용은 재시작 뒤에도 복원, 줄바꿈(LF/CRLF)·BOM 유지, 2 MB 초과·UTF-8 아닌 파일은 읽기 전용. 테마는 Community Material Theme Darker High Contrast. Markdown 렌더 보기 · 이미지 · 영상 · 오디오 · PDF 도 같은 탭에서 |
| **도구 모드** | 데이터 · 웹/API · 보안 · 시간 · 이미지/색상 · 시스템 그룹으로 나뉜 개발 유틸, 왼쪽 위 검색(⌘K). **JSON**(느슨한 파싱 · 트리 보기 · 키/값 검색 · 경로 복사 · 정렬/압축/키 정렬 · TypeScript 타입 생성), **JWT**(디코드 · 만료 표시 · HS/RS/PS/ES 서명 검증 · 수정 후 HS 재서명), **암호화**(AES-GCM/CBC/CTR 암복호화 — 키 직접 또는 PBKDF2 패스프레이즈, MD5/SHA 해시 · 파일 해시, HMAC), **인코딩**(Base64 · URL · HTML · Unicode · Hex · Binary 양방향, 쿼리 문자열 분해, 진법 변환), **시간**(Unix s/ms/µs/ns 자동 판별 · ISO · 시간대별 · 기간 계산), **정규식**(실시간 매치 하이라이트 · 그룹 · 치환 · 프리셋), **Diff**(Myers 줄 비교 · 나란히 · unified diff 복사), **UUID · 난수**(v4/v7 · 비밀번호 · 바이트 · 숫자), **텍스트**(케이스 변환 · 글자 수 · 정렬/중복 제거 등 줄 정리 · Lorem), **색상**(HEX/RGB/HSL/HSV/CMYK · 명도 단계 · WCAG 대비), **YAML · JSON · TOML** 상호 변환(형식 자동 감지), **SQL** 정렬 · 한 줄로(방언 12종 · 키워드 대소문자), **cURL** ↔ fetch · axios · Python requests(브라우저 "Copy as cURL/fetch" 붙여넣기), **이스케이프**(JSON · JS · 템플릿 · 셸 '…'/"…" · 정규식 · SQL · CSV · C/Java · XML 양방향), **Cron**(식 해석 · 필드별 값 · 다음 실행 10회 로컬/UTC · 프리셋), **Chmod**(755 ↔ rwxr-xr-x ↔ 체크박스, ls -l 줄 붙여넣기, u+x 같은 식 적용), **계산기**(줄마다 식 · 변수 · 0x/0b · 비트 연산 · 함수, CSS px/rem/pt/vw 변환, 용량 B/KB/KiB 와 전송 시간). **HTTP 요청**(메서드 · 파라미터/헤더/바디(JSON · 텍스트 · form) 표 편집 · Bearer/Basic 인증 · 리다이렉트 · TLS 검사 끄기 · 제한 시간, URL 칸에 curl 붙여넣으면 가져오기, 응답 상태 · 시간 · 크기 · 헤더 · JSON 하이라이트 · 이미지 미리보기, cURL 로 복사, 최근 30개 기록. 요청은 앱 로컬 서버가 보내서 CORS 없음), **네트워크**(호스트 이름 · LAN IP · 공인 IP 조회, 열린 TCP 포트와 프로세스 · 작업 폴더 · 접근 범위, 그 포트로 요청 · 종료/강제 종료, IPv4 서브넷 계산). **SVG**(Figma · Illustrator · Inkscape 내보내기 정리: 편집기 메타데이터 · 안 쓰는 id · 빈 그룹 제거, 소수점 반올림, width/height 제거, currentColor 치환, 미리보기, React 컴포넌트 · URL-encoded/Base64 data URI · CSS mask), **QR 코드**(텍스트/URL · Wi-Fi, 이 Mac LAN 주소로 개발 서버 QR, 오류 정정 · 여백 · 색, PNG/SVG 복사 · 저장, 네트워크 도구의 포트 행에서 바로 생성), **Data URI**(파일 · 붙여넣은 이미지 → data URI · CSS · HTML · Markdown, 반대로 data URI → 파일 저장), **파비콘 · 앱 아이콘**(이미지 하나로 favicon.ico · PNG 크기별 · apple-touch-icon · 안드로이드 · macOS icon.icns · site.webmanifest 생성, 여백 · 배경 · 모서리, 폴더에 한 번에 저장). **.env 비교**(현재 프로젝트의 .env* 파일을 하위 폴더까지 찾아 두 개 비교, 빠진 키 · 값 다름 · 빈 값 · 중복 · 읽을 수 없는 줄, 값은 기본으로 가림, .env.example 생성 · 빠진 키 덧붙일 줄 만들기. 파일 내용은 저장하지 않음). 입력은 기억되고 키 · 시크릿 · 평문은 저장 안 함. ⌘1~⌘0 으로 목록 앞 10개 전환 |
| **스케줄러** | 상단 `스케줄러` 탭. 스킬(켜 둔 Claude 플러그인 스킬 포함) · 프롬프트를 cron 으로 정해 둔 시각에 새 세션으로 실행, `@` 로 지난 세션을 골라 그 세션에 이어 보내기. 실행은 서버가 맡아 창이 닫혀 있어도 돌고, 결과는 실행 기록에서 열어 이어 본다. 잠자기 대응 3단계: 깨어난 뒤 허용 시간 안이면 한 번 실행, 실행 30분 전부터 `caffeinate` 로 자동 잠자기 차단, 선택 옵션으로 `pmset` 이 잠든 Mac 을 깨움(관리자 암호로 epoch 인자만 받는 helper 를 한 번 설치) |
| **터미널** | xterm.js + node-pty 로그인 셸, `claude` / `codex` TUI 원클릭, 선택 영역 · 최근 출력 채팅으로 보내기, Terminal.app · Finder · VS Code · Cursor 로 열기 |
| **Git** | 브랜치 전환 · 생성, fetch / pull / push, 상태 · diff · 스테이지 · 커밋 · Commit & Push, 커밋 그래프(커밋을 누르면 바뀐 파일 · diff, 무한 스크롤), **AI 메시지**(스테이지된 diff 로 설치된 claude/codex 가 레포 CLAUDE.md · AGENTS.md 와 최근 커밋 스타일에 맞춰 커밋 메시지 작성) |
| **턴 검증 · 변경** | 턴이 끝나면 그 턴에 바뀐 파일만 카드로(턴 전후 작업 트리를 임시 인덱스로 git tree 에 찍어 비교 — 이전부터 있던 수정과 안 섞이고 Codex 도 됨). 파일별 diff 를 펼쳐 hunk · 파일 · 턴 전체 단위로 되돌리기(턴 이후 다시 바뀐 파일은 확인 후에만, 세션이 직접 고치지 않은 파일은 '외부' 표시 후 턴 되돌리기에서 제외). 채팅 헤더 **검증**에 프로젝트 명령(typecheck · test 등, package.json · Cargo · Go · pytest 에서 추천)을 정해 두면 파일을 바꾼 턴마다 자동 실행, 실패 출력 끝부분과 **에러 넘기기** 버튼 |
| **실행** | 우측 `실행` 탭. package.json 스크립트(개발 서버 먼저) · 임의 명령을 서버가 띄워 관리(새로고침해도 유지, 앱 종료 시 프로세스 그룹째 종료). 출력에서 개발 서버 주소를 찾아 기본 브라우저로 열기, 에러 블록 감지 → **세션으로 보내기**, 탭에 실행 · 에러 점 |
| **worktree · 비교** | 시작 화면에서 **별도 git worktree** 로 세션 시작(`<repo>-wt/<브랜치>`, node_modules 는 원래 폴더 링크). 세션 탭 · 헤더에 브랜치 배지, 파일 · 터미널 · Git · 실행 탭이 그 폴더를 따름. **머지하고 정리**(merge 커밋 후 worktree · 브랜치 삭제, 남은 변경은 커밋하고 머지, 충돌이면 중단). **둘 다 비교**: 같은 프롬프트를 Claude · Codex 가 각자 worktree 에서 실행 → **이쪽 채택**으로 한쪽 머지, 다른 쪽 정리. 세션 없이 남은 worktree 는 시작 화면에서 다시 열기 · 머지 · 버리기. **교차 리뷰**: 변경 카드 · 헤더에서 다른 에이전트를 plan 모드로 열어 diff 리뷰 |
| **작업 백로그** | 프로젝트별 할 일 큐(세션 탭 줄 목록 버튼 · 시작 화면). 큐를 켜면 새 세션에서 하나씩 차례로 실행하고 보던 화면은 안 건드림. 에이전트 · 권한 모드 · 항목별 worktree 선택, 실패 항목 다시 대기열에, 설정에 저장 |
| **한도 이어가기** | 5시간 한도가 90% 를 넘거나 20분 안에 소진될 것 같으면 입력창 위 배너 → **다른 에이전트로 이어가기**: 같은 폴더에 세션을 열고 요청 · 마지막 답변 · 바뀐 파일 · 남은 할 일을 정리한 인수인계 글을 입력창에 넣어 둠 |
| **에이전트 지침** | 시작 화면 · 열기 메뉴의 **에이전트 지침…**: 프로젝트 · 전역 CLAUDE.md 와 AGENTS.md 를 나란히 편집, 같은지 표시, 한쪽으로 복사하거나 CLAUDE.md 가 `@AGENTS.md` 를 불러오게 해 파일 하나로 합치기. 스킬 · 훅 · MCP 서버(.mcp.json · ~/.claude.json · ~/.codex/config.toml)를 출처와 함께 모아 보기, 누르면 IDE 에서 열기 |
| **잠금화면** | ⌥L(메뉴 › 지금 잠그기)로 모든 모니터를 덮는다. 배경화면을 흐리게 깐 위에 메인 모니터엔 디지털 시계 · 숫자 4자리 PIN · 에이전트별 세션 요약 유리 카드, 복구 코드(20자)로도 열기. kiosk 옵션으로 ⌘Tab · 강제 종료 · 앱 숨기기를 막고, 전원 연결 중엔 화면 꺼짐을 막아 macOS 자동 잠금이 안 걸린다. 그동안 세션은 계속 돈다. 설정 › 잠금화면에서 PIN · 메인 모니터(배치 미니맵) 지정 |
| **독 · 즐겨찾기** | 왼쪽 독에 폴더 즐겨찾기, 그룹(폴더)으로 묶기 · 접기, 드래그로 이동, 최근 폴더, 프로젝트 아이콘 자동 감지(public/favicon, Next app/icon, Godot project.godot, Tauri, Xcode AppIcon, .icns 등). 실행 중인 프로젝트는 노란 점, 끝났는데 아직 안 연 프로젝트는 초록 점 |
| **헤더** | Claude 5시간 · 주간 · 모델별, Codex 5시간 · 주간 남은 % 바(마우스를 올리면 초기화까지 남은 시간, 최근 소진 속도로 리셋 전에 다 쓸 것 같으면 남은 시간 예측과 경고 점), 현재 버전 · 업데이트 배지 |
| **설정** | 좌측 탭 구성: 일반 · AI 동작 방식(에이전트별 기본 모델 · 권한 모드) · 배경화면 · 커스텀 프롬프트(모든 에이전트 세션에 한 번만 주입) · Form 유형 · 잠금화면 · 에이전트 CLI(감지 + 설치/업데이트 버튼(공식 스크립트 · Homebrew · npm), 스킬 · 플러그인 목록과 사용 설정) · 권한(macOS 개인정보 권한 상태와 요청) |
| **디자인** | 글래스 디자인: 배경화면(원본 · 흐린 사본을 미리 만들어 둠) 위 유리 카드, 독, 원형 헤더 버튼. 에이전트 · 도구 · 스케줄러 탭 패널 크기 조절 핸들, 사이드 · 우측 패널 접기(애니메이션), 구분선 드래그로 폭 조절, 전부 기억됨, 2.5px 얇은 스크롤바 |
| **운영** | 로그인 시 자동 실행, macOS 알림(다른 앱이나 다른 세션을 보고 있을 때 세션 이름과 함께 완료/실패/승인/질문 알림, 클릭하면 해당 세션으로 이동, 승인 알림은 허용 · 항상 허용 · 거부 버튼으로 앱을 열지 않고 바로 답하고 앱에서 처리되면 알림이 사라짐), 에이전트가 일하거나 터미널이 바쁜 동안 Mac 자동 절전 방지(설정에서 끌 수 있음), 절전에서 깨어나면 세션·셸 즉시 재연결, 연결이 끊긴 셸은 서버가 10분간 살려 두고 같은 탭에 다시 붙여 그동안의 출력까지 보여 줌 |

## 설치

### 요구 사항

| 항목 | 내용 |
|------|------|
| OS | macOS 14 이상, Apple Silicon(arm64). Intel 빌드는 배포하지 않는다 |
| 에이전트 CLI | Claude Code CLI(`claude`) 와/또는 Codex CLI(`codex`). 없으면 앱 안 설정 › 에이전트 CLI 에서 설치 |
| 로그인 | 앱 안 터미널 탭에서 `claude` → `/login`, `codex login` |
| Node.js | 없어도 된다. 서버는 시스템 node(20 이상)가 있으면 그걸, 없으면 Electron 에 내장된 Node 로 뜬다 |

### DMG (권장)

1. [최신 릴리스](https://github.com/HDomi/vibrato/releases/latest) 에서 `Vibrato-<버전>-arm64.dmg` 를 받는다.
2. 앱을 `응용 프로그램` 폴더로 끌어 놓는다. 레포 · git · Node 없이 혼자 돈다.
3. Apple 개발자 서명이 없는(ad-hoc) 앱이라 처음 한 번은 macOS 가 막는다. 시스템 설정 › 개인정보 보호 및 보안 › "그래도 열기" 를 누르거나, 터미널에서 격리 표시를 지운다.

```bash
xattr -dr com.apple.quarantine "/Applications/Vibrato.app"
```

첫 실행 때 macOS 가 "Vibrato 가 데스크탑 폴더에 접근하려 합니다" 를 물으면 허용한다. 이후 업데이트는 앱이 알아서 받는다(아래 [업데이트](#업데이트)). 예전 `install.sh` 런처를 쓰고 있었다면 DMG 의 앱으로 덮어쓰면 된다. 설정 · 세션은 그대로 남는다.

<details>
<summary><b>받은 파일 체크섬 확인</b></summary>

릴리스마다 `SHA256SUMS.txt` 가 함께 올라간다. 앱 안 업데이트는 이걸 자동으로 대조하고, 직접 받은 DMG 는 이렇게 확인한다.

```bash
cd ~/Downloads
curl -LO https://github.com/HDomi/vibrato/releases/latest/download/SHA256SUMS.txt
shasum -a 256 -c SHA256SUMS.txt --ignore-missing
```

</details>

### 소스에서 설치 (개발용)

```bash
git clone https://github.com/HDomi/vibrato.git
cd vibrato
./install.sh
```

`install.sh` 가 하는 일: Node 확인(없으면 `runtime/` 에 내려받음) → 의존성 설치 → 빌드 → Electron 런타임에 이름·아이콘·번들 id 입히기 → `/Applications/Vibrato.app` 생성 → 실행.
이 앱 번들은 체크아웃을 가리키는 작은 런처라서, 업데이트는 재설치 없이 `git pull` + 빌드로 끝난다.

| 옵션 | 설명 |
|------|------|
| `./install.sh --login` | 로그인 시 자동 실행(LaunchAgent)까지 등록 |
| `./install.sh --no-launch` | 설치만 하고 실행은 안 함 |
| `scripts/update.sh` | 수동 업데이트(pull · install · build · 재실행) |
| `scripts/uninstall.sh [--purge]` | 앱 · 로그인 항목 제거. `--purge` 는 `~/.vibrato` 까지 |

### 삭제

DMG 로 설치했다면 `/Applications/Vibrato.app` 을 휴지통에 넣는다. 설정 · 첨부까지 지우려면 `~/.vibrato` 도 지운다. 스케줄러의 Mac 깨우기 helper 를 설치했다면 `/etc/sudoers.d/vibrato` 가 남으니 스케줄러에서 먼저 해제한다. 소스 설치는 `scripts/uninstall.sh --purge`.

## 사용법

1. 왼쪽 독의 **Open Folder…** 로 프로젝트 폴더를 연다. 자주 쓰면 ☆ 로 즐겨찾기.
2. 가운데 시작 화면에서 **Claude Code / Codex**, 권한 모드, 모델을 고르고 **New session**. 아래엔 이 폴더에서 했던 이전 세션들이 두 에이전트 모두 뜬다. 클릭하면 이어서.
3. 입력창에 메시지. `/` 로 커맨드, `@` 로 파일 첨부, 이미지는 드롭하거나 붙여넣기. 구조가 필요한 요청은 입력창 옆 **Form**.
4. 에이전트가 승인을 원하면 카드가 뜬다. 허용 / 항상 허용 / 거부(사유 적으면 에이전트가 읽음).
5. 오른쪽 패널에서 파일 · 미리보기 · 터미널 · Git · 실행. 파일을 고치려면 파일 탭의 **IDE** 버튼으로 IDE 창을 연다. 상단 **Open ▾** 로 Terminal.app · Finder · VS Code · Cursor 에서 열기.
6. 긴 작업은 채팅 헤더의 **계획** 으로 단계별 진행을 보고, 반복 작업은 **스케줄러** 에 걸어 둔다.

### 권한 모드

| 모드 | Claude | Codex |
|------|--------|-------|
| Default | 도구마다 승인 | workspace-write 샌드박스 + 요청 시 승인 |
| Auto-edit | 파일 편집 자동 승인 | Default 와 동일 |
| Plan | 읽기 전용, 계획 먼저 | read-only 샌드박스 |
| Allow all | 승인 없음 | 샌드박스 해제, 승인 없음 |

### 단축키

| 키 | 동작 |
|----|------|
| ⌘N | 새 세션 |
| ⌘W | 세션 닫기 |
| ⌘K | 입력창 포커스 |
| ⌘P | 퀵오픈(프로젝트 파일 검색) |
| ⌘J | 우측 패널 접기 |
| ⌘1 ~ ⌘5 | 파일 · 미리보기 · 터미널 · Git · 실행 탭 |
| ⌘F | 대화 검색 (파일 탭 안에서는 파일 검색) |
| ⌘/ | 설정 · 단축키 안내 (Esc 로 닫기) |
| ⌥L | 잠금화면 |
| Enter / Shift+Enter | 전송 / 줄바꿈 |
| 파일 목록 | ⌘C ⌘X ⌘V, ⌘D 복제, ⏎ 이름 변경, ⌘⌫ 휴지통, ⇧⌘N 새 폴더, ⌫ 상위 폴더, Space 미리보기 |
| 도구 모드 | ⌘K 도구 검색(↑↓ · ⏎), ⌘1 ~ ⌘0 목록 앞 10개 (JSON · YAML · SQL · 정규식 · 비교 · 텍스트 · cURL · JWT · 인코딩 · 이스케이프) |
| IDE 창 | ⌘S 저장, ⌥⌘S 전체 저장, ⌘W 탭 닫기, ⌘B 탐색기, ⇧⌘[ ⇧⌘] 탭 이동, ⌘F 찾기, ⌘/ 주석, ⌘D 다음 일치 선택. 트리: ↑↓ 이동, ←→ 접기·펼치기, ⏎ 이름 변경, Space 열기, ⌘⌫ 휴지통 |

## 업데이트

새 릴리스가 나오면 헤더의 버전 배지에 표시된다.

**DMG 로 설치한 앱**: 버전 배지 → 커밋 목록 확인 → 업데이트 적용.

1. GitHub 최신 릴리스의 zip 을 받아 `SHA256SUMS.txt` 와 대조한다.
2. 번들 id · 버전 · 서명을 확인한 뒤 `~/Library/Caches/com.hdomi.vibrato/update/` 에 풀어 둔다.
3. 앱이 종료되면 보조 스크립트가 `/Applications` 의 앱을 새 것으로 바꾸고(실패하면 원래 앱 복구) 다시 연다. 결과는 같은 폴더의 `install.log`.

활성 세션이 있으면 보류한다. `응용 프로그램` 폴더 밖(DMG 안, 다운로드 폴더에서 바로 실행)에서는 자기 교체가 안 돼서 옮기라고 안내한다. 업데이트 창의 **최근 릴리스**에 이 기기용 zip 이 있는 릴리스 세 개가 노트와 함께 나오고, 그중 아무 버전이나 같은 검증 절차로 설치할 수 있다(설치된 것보다 낮으면 **이 버전으로 내리기**).

**소스 설치(런처)**:

- **앱 안에서**: 버전 배지 → 커밋 목록 확인 → Apply. 임시 폴더에서 clone → `npm ci` → build 후, 빌드한 커밋으로 체크아웃을 fast-forward 한다. 교체 또는 fast-forward 실패 시 기존 빌드 폴더를 복원한다. 활성 세션이 있으면 보류하며 강제 옵션을 제공한다. Electron 런타임 자체가 바뀌거나 `npm run app`으로 실행 중이면 터미널 업데이트를 안내한다.
- **터미널에서**: `scripts/update.sh`. 앱과 서버가 끝난 뒤 임시 폴더에서 빌드·교체하고 설치된 앱 번들도 다시 만든다. 설치 경로는 `runtime/install-location`에 보관한다.

## 릴리스 · 버전

### 받을 수 있는 파일

릴리스마다 아래 세 파일이 [GitHub Releases](https://github.com/HDomi/vibrato/releases) 에 올라간다.

| 파일 | 용도 |
|------|------|
| `Vibrato-<버전>-arm64.dmg` | 처음 설치 |
| `Vibrato-<버전>-arm64-mac.zip` | 앱 안 업데이트가 받는 번들 |
| `SHA256SUMS.txt` | 위 두 파일의 SHA-256. 업데이트가 대조한다 |

### 버전 규칙

[Semantic Versioning](https://semver.org/lang/ko/) 을 따른다. 태그는 `vX.Y.Z`.

| 올리는 자리 | 언제 |
|------|------|
| major | 호환이 깨질 때. 커밋 본문에 `BREAKING CHANGE:` 로 바뀐 점과 할 일을 적는다(예: v4.0.0 잠금 비밀번호 → 4자리 PIN) |
| minor | 기능 추가 |
| patch | 버그 수정 · 작은 개선 |

### 변경 이력

릴리스 노트는 버전 커밋의 annotated 태그 메시지 그대로다. 전체 목록은 [Releases](https://github.com/HDomi/vibrato/releases), 커밋 단위는 [커밋 기록](https://github.com/HDomi/vibrato/commits/main).

| 버전 | 날짜 | 주요 변화 |
|------|------|------|
| **v4.3** | 2026-11-05 | Claude 대화형 명령(`/mcp` · `/model` · `/plugin` 등) 앱 안 처리, 패널 크기 조절 핸들 |
| **v4.2** | 2026-11-04 | 계획표 보기, 지난 대화 전체 검색, AI 동작 방식 · 권한 · 스킬 설정, 계획 강제 |
| **v4.1** | 2026-11-04 | 탭 전환 · 헤더 정리, 헤더에 현재 버전 |
| **v4.0** | 2026-11-04 | 글래스 디자인 전면 개편, IDE 별도 창, PIN 잠금화면 (**호환 깨짐**: 잠금 PIN 다시 설정) |
| **v3.x** | 2026-10-27 ~ 11-03 | worktree · 둘 다 비교, 턴 검증, 작업 백로그, 커스텀 프롬프트, Markdown 내보내기, 스케줄러, Form 전송, Vibrato 로 개명 |
| **v2.0** | 2026-10-27 | 독립 앱 DMG 첫 릴리스, 릴리스 zip 자동 업데이트 |
| **v1.0** | 2026-10-21 | 첫 정식 버전, 이후 잠금화면(v1.0.9) |

### 릴리스 만드는 법 (메인테이너)

```bash
git log --oneline -5                      # 다른 작업과 섞이지 않았는지 확인
scripts/bump-version.sh patch             # patch | minor | major, package.json 버전 올림
git commit -am "feat: <요약> 릴리스 (vX.Y.Z)"   # 제목 끝 (vX.Y.Z) → .githooks/post-commit 이 annotated 태그를 단다
git push origin main --follow-tags
```

`vX.Y.Z` 태그가 push 되면 [`.github/workflows/release.yml`](.github/workflows/release.yml) 이 macOS 러너에서 다음을 한다.

1. 태그와 `package.json` 버전이 같은지 확인(다르면 실패)
2. `npm ci`(GitHub 다운로드 502 대비 3회 재시도) → `npm run typecheck` → `npm test`
3. `npm run dist`(electron-builder) → DMG · zip
4. `SHA256SUMS.txt` 생성 → 태그 메시지를 노트로 GitHub 릴리스 게시

로컬 빌드는 `npm run dist` → `release/`. 앱 번들에는 SDK 가 딸려 보내는 Claude Code 바이너리(~250 MB)를 넣지 않는다(설치된 `claude` 를 쓴다). 서명은 `scripts/after-pack.cjs` 의 ad-hoc 서명이고 공증은 하지 않는다.

## 동작 원리

```
┌─ Vibrato.app (Electron) ─────────────────────────────┐
│  renderer: React SPA  ──HTTP/WS──▶  server (Node, 127.0.0.1:11398)
│                                        ├─ agents/claude.ts  → @anthropic-ai/claude-agent-sdk → 로컬 claude 바이너리
│                                        ├─ agents/codex.ts   → codex app-server (JSON-RPC/stdio)
│                                        ├─ pty.ts            → node-pty 로그인 셸
│                                        ├─ scheduler.ts      → cron 예약 실행 · caffeinate · pmset 깨우기
│                                        ├─ fs · git · worktree · turns · usage · updater
│                                        └─ 통합 이벤트 스키마 (agents/types.ts)
└──────────────────────────────────────────────────────────────┘
```

- **서버는 Electron 안이 아니라 시스템 Node 자식 프로세스**로 돈다. 네이티브 모듈(node-pty)을 Electron ABI 로 다시 빌드할 필요가 없고, 브라우저에서 `http://127.0.0.1:11398` 로 열어도 똑같이 동작한다. macOS 는 자식의 파일 접근을 부모 앱 권한으로 보므로 권한 팝업엔 앱 이름이 뜬다.
- **Claude** 는 Agent SDK 를 쓰되 `pathToClaudeCodeExecutable` 로 설치된 `claude` 를 지정한다. SDK 가 번들하는 바이너리와 `--bare` 모드는 OAuth 를 읽지 않으므로 쓰지 않는다.
- **Codex** 는 `codex app-server` 를 세션마다 띄워 `thread/start`, `turn/start`, 승인 요청(`item/*/requestApproval`), `turn/steer` 로 대화한다. 프로토콜 타입은 `codex app-server generate-ts` 결과를 기준으로 맞췄다.
- 두 에이전트의 이벤트를 `text.delta / tool.start / approval.request / question.request / result` 같은 공통 스키마로 정규화해서 같은 UI 로 그린다.
- 잠금화면 cover(`/?lock=main|sub`) 와 IDE 창(`/?ide=<root>`) 은 같은 웹 번들을 따로 로드한다.

## 파일 위치

| 경로 | 내용 |
|------|------|
| `~/.vibrato/config.json` | 즐겨찾기 · 그룹 · 최근 폴더 · 저장한 프롬프트 · 프로젝트별 검증 명령과 작업 백로그 · 예약 실행 |
| `~/.vibrato/schedule-runs.json` | 예약 실행 기록 |
| `~/.vibrato/wallpaper/` | 배경화면 원본 · 흐린 사본 |
| `~/.vibrato/attachments/` | 붙여넣기 첨부 사본, `tool-images/` 에 도구가 돌려준 이미지(내용 해시 이름) |
| `~/.claude/projects/` | Claude 세션(CLI 와 공유, 이름 변경·삭제도 반영) |
| `~/.codex/` | Codex 세션 · 로그인(앱이 읽기만 함) |
| `~/Library/Caches/com.hdomi.vibrato/update/` | 받아 둔 업데이트 · `install.log` |
| `~/Library/LaunchAgents/com.hdomi.vibrato.plist` | `--login` 으로 등록한 자동 실행 |
| `/etc/sudoers.d/vibrato` | 스케줄러의 Mac 깨우기 helper 를 설치했을 때만 |

## 개인정보 · 보안

- 서버는 `127.0.0.1` 에만 바인드한다. 외부 네트워크엔 노출되지 않고, 요청 출처(Origin)를 검증한다.
- 앱이 스스로 보내는 외부 요청은 업데이트 확인 · 다운로드(GitHub)와 사용량 조회(claude.ai · chatgpt.com)뿐이고, 그 밖엔 도구 모드에서 직접 누른 요청(HTTP 요청, 공인 IP 조회)이다. 분석 · 텔레메트리 코드는 없다. 대화 내용은 각 CLI 가 원래 보내는 곳(Anthropic · OpenAI)으로만 간다.
- API 키를 받거나 저장하지 않는다. 인증은 각 CLI 의 로그인을 그대로 쓴다.
- 도구 모드의 키 · 시크릿 · 평문 입력과 `.env` 내용은 저장하지 않는다.
- 스케줄러의 깨우기 helper 는 root 소유, sudoers 는 그 helper 만 허용하고 helper 는 epoch 인자만 받는다(`pmset` 의 다른 기능에 못 쓴다).

## 문제 해결

| 증상 | 원인 · 해결 |
|------|------------|
| "손상되었기 때문에 열 수 없습니다" / "확인되지 않은 개발자" | ad-hoc 서명 앱이라 그렇다. `xattr -dr com.apple.quarantine "/Applications/Vibrato.app"` 후 다시 연다 |
| 업데이트가 "응용 프로그램 폴더로 옮기라" 고 함 | DMG 안이나 다운로드 폴더에서 바로 실행한 것. `/Applications` 로 옮긴 뒤 실행 |
| 업데이트 후 앱이 안 바뀜 | `~/Library/Caches/com.hdomi.vibrato/update/install.log` 확인. 교체 실패 시 원래 앱으로 복구된다 |
| 파일 목록이 `EACCES` | Desktop/Documents/Downloads 는 macOS 보호 폴더. 권한 팝업을 허용하거나 설정 › 권한 탭, 또는 시스템 설정 › 개인정보 보호 및 보안 › 전체 디스크 접근 권한에 Vibrato 추가. 오류 카드에 바로가기 있음 |
| 잠금 PIN 을 잊음 | 잠금화면에서 **복구 코드로 열기**(20자). v4.0.0 이전 비밀번호는 쓸 수 없으니 설정 › 잠금화면에서 PIN 을 새로 정한다 |
| 예약 실행이 잠자기 중에 안 돎 | 기본은 깨어난 뒤 허용 시간 안에 한 번 실행. 정시 실행이 필요하면 스케줄러에서 Mac 깨우기 helper 를 설치 |
| "Node.js 를 찾을 수 없음" 대화상자 | 구버전. 지금은 `runtime/node` → 시스템 node(인터랙티브 셸에서 nvm 포함 탐색) → Electron 내장 Node 순으로 자동 선택한다 |
| `npm run app` 했는데 Electron 이 Node 로 실행됨 | VS Code 통합 터미널이 `ELECTRON_RUN_AS_NODE=1` 을 심는다. npm 스크립트와 `install.sh` 는 이 변수를 지우니 그걸로 실행 |
| 메뉴바 · Dock 에 "Electron" 으로 표시 | `npm run brand` 한 번 실행 후 재시작. `npm install` 뒤엔 자동 적용 |
| Codex 세션이 시작 화면에 안 보임 | 그 폴더에서 Codex 로 작업한 적이 없는 것. 목록은 폴더(cwd) 기준으로 필터된다 |
| "Open in Cursor" 가 안 됨 | Cursor 미설치. `open -a Cursor` 를 그대로 쓴다 |
| 로그인 필요 표시 | 터미널 탭에서 `claude` 실행 후 `/login`, 또는 `codex login` |

버그 · 제안은 [Issues](https://github.com/HDomi/vibrato/issues) 로.

## 개발

```bash
npm install
npm run dev        # vite(5173) + 서버(11398) 핫리로드, 브라우저에서 http://localhost:5173
npm run dev:app    # 위 dev 를 띄운 채로 Electron 창 붙이기
npm run serve      # 서버만. 브라우저에서 http://127.0.0.1:11398
npm run typecheck
npm test           # node:test
npm run build      # dist/ + web/dist/ + build-info
npm run app        # 빌드된 결과로 Electron 실행 (node_modules 런타임)
npm run dist       # build + electron-builder → release/ (DMG, zip)
```

실행 중인 앱 옆에서 테스트 사본을 띄울 땐 `VIBRATO_PORT` · `VIBRATO_USER_DATA` · `VIBRATO_CONFIG_DIR` · `VIBRATO_UPDATE_DIR` · `VIBRATO_UPDATE_FEED`(가짜 릴리스 API) 로 포트 · 프로필 · 설정 · 업데이트 경로를 분리한다.

```
server/            Hono 서버 · 에이전트 어댑터 · PTY · git · worktree · 사용량 · 업데이트 · 스케줄러 · 잠금 감시
  agents/types.ts  통합 이벤트 스키마 (web/src/lib/agent.ts 와 수동 동기화)
web/               React + Vite + Tailwind v4 (UI 문자열은 web/src/lib/i18n.ts 에 en / ko)
electron/          메인 프로세스(CommonJS) · preload · 잠금화면
scripts/           brand-electron · launchd · update · uninstall · bump-version · 아이콘 생성 · after-pack(ad-hoc 서명)
tests/             node:test
.github/workflows/ 태그 push → DMG 릴리스
docs/              가능성 조사 보고서 · 로드맵 · 점검 기록
```

### 안정성 검증

- `npm test`: 요청 출처 검증, 설정 동시 저장, Git·파일 처리, 세션 오류, Markdown HTML 필터, 업데이트 실패 복원 테스트. 릴리스 워크플로도 이걸 통과해야 게시한다.
- `npm run build && npm run test:ui`: 임시 프로필과 가짜 API를 사용하는 숨겨진 Electron 창에서 Git 응답 순서·브랜치 생성·중복 커밋·업데이트 오류 복구 검증. 실제 CLI 세션이나 설치된 앱은 사용하지 않는다.
- [v0.3.16 점검 기록](docs/stability-audit.md)

### 커밋 규칙

한국어 메시지, 타입은 `feat:` `fix:` `hotfix:` `misc:` `ci:`. 버전 커밋만 제목 끝에 `(vX.Y.Z)` 를 붙인다. 자세한 건 [CLAUDE.md](CLAUDE.md).

## 문서

- [가능성 조사 보고서](docs/feasibility-report.md) — 왜 이 구조인지, 검증한 것, 정책 리스크
- [로드맵 · 동작 규칙](docs/roadmap.md) — 단계별 진행 상황, 첨부 · 권한 · 업데이트 규칙
- [Claude 사용량 조회 경로](docs/claude-usage.md) — 헤더 사용량 바가 어디서 값을 읽는지
- [안정성 점검 기록](docs/stability-audit.md)

## 참고

- 개인용으로 만든 프로젝트다. Anthropic 은 서드파티 제품이 claude.ai 로그인을 **제공**하는 것을 허용하지 않는다. 이 앱은 본인 Mac 에 본인이 설치한 CLI 를 띄울 뿐이지만, 남에게 배포할 생각이면 API 키 기반으로 바꿔야 한다.
- Apple Developer 계정 · 공증 없이 ad-hoc 서명으로 동작한다. 스토어 배포 목적이 아니다.
- Claude 는 Anthropic, Codex · ChatGPT 는 OpenAI 의 상표다. 이 프로젝트는 두 회사와 관계없다.
- 라이선스 파일은 아직 없다. 별도 표기가 없으면 저작권은 작성자(HDomi)에게 있다.
