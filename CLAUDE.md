# Vibrato

개인용 macOS 바이브코딩 앱. Electron 껍데기 + 로컬 Node 서버(Hono, 127.0.0.1:11398) + React(Vite, Tailwind v4).
에이전트는 사용자가 설치·로그인한 `claude` / `codex` CLI 만 쓴다. API 키 기반 설계는 하지 않는다.
Claude 는 Agent SDK 에 `pathToClaudeCodeExecutable` 로 설치된 `claude` 를 지정한다(SDK 번들 바이너리 · `--bare` 금지).

## 구조

```
electron/   메인 프로세스(CommonJS .cts) · preload · 잠금화면(lockScreen.cts)
            앱 안 브라우저(browser.cts, browserScripts.cts): `/?browser=1` 창, 페이지는 네이티브 WKWebView.
            에이전트 도구 실행 · 세션별 커서(네이티브 오버레이) · 자동 대기 · 구조화된 에러(agent-desktop 참고)
            원격 탭 클라이언트(remote.cts): 연결을 메인 프로세스에 유지(탭 전환 · 새로고침에도 살아 있음)
native/     네이티브 모듈(N-API, node-gyp). webview: Electron 창에 WKWebView 를 붙인다 → dist/native (scripts/build-native.cjs)
server/     Hono 서버 · 에이전트 어댑터 · PTY · git · 업데이트(updater.ts, releaseUpdate.ts) · 잠금 감시(lockWatch.ts)
            예약 실행(scheduler.ts, schedule.ts, schedulePower.ts: caffeinate · pmset 깨우기 helper)
            배경화면(wallpaper.ts: ~/.vibrato/wallpaper 에 원본 · 흐린 사본 저장)
            에이전트 브라우저 도구(browserMcp.ts): /mcp/browser MCP, 호출은 /browser-host 소켓으로 Electron 이 실행
            원격 세션(remote/): TLS 1.3 리스너(기본 포트 11399, 기본 꺼짐), 자체 서명 인증서 + 지문 고정,
            PBKDF2 · HMAC 채널 바인딩 로그인(접속 코드 + 호스트 비밀번호 2중, legato 방식), 세션 메서드 허용 목록만 노출.
            묶음 · deflate 는 hello 의 caps 로 협상(구버전과 호환). protocol/client 는 .cts 로 Electron 과 공유
web/        React 앱. 잠금화면 cover 는 `/?lock=main|sub`, IDE 창은 `/?ide=<root>` 로 같은 번들을 따로 로드(main.tsx)
            글래스 디자인: index.css 의 @theme 토큰 · .glass(미리 흐린 배경을 fixed 로 깐 카드) · .glass-pop(진짜 backdrop blur)
tests/      node:test (`npm test`)
.github/workflows/release.yml   버전 태그 push → DMG 릴리스
electron-builder.yml            독립 앱 번들 설정(asar 끔, node-pty prebuild, SDK 바이너리 제외)
```

실행 형태가 둘이다(맥 기준). Windows 빌드는 원격 전용 클라이언트다: 로컬 서버 없이 원격 탭만 뜬다
(`electron/main.cts` REMOTE_ONLY, 맥에서 확인할 때는 `VIBRATO_REMOTE_ONLY=1`). 릴리스 워크플로가 설치본 · zip 을 함께 올린다.

- **독립 앱**: DMG 로 설치한 `.app`. 코드는 `Contents/Resources/app`. 업데이트는 GitHub 릴리스 zip 을 받아 앱 종료 후 번들 교체(`server/releaseUpdate.ts`, `electron/main.cts` `startBundleSwap`).
- **체크아웃**: `npm run app`, 또는 `install.sh` 가 만든 런처 앱. 업데이트는 git(`scripts/apply-update.sh`).

## 명령

```bash
npm run typecheck
npm test
npm run build      # dist/ + web/dist/ + build-info
npm run dist       # build + electron-builder → release/ (DMG, zip)
```

## 커밋 · 버전 · 릴리스

- main 에 바로 커밋하고 push 한다(이 레포는 PR 없이 운영). force push 금지.
- 커밋 메시지는 한국어, 타입은 `feat:` `fix:` `hotfix:` `misc:` `ci:`. `Co-Authored-By` 같은 공동 작성자 줄은 넣지 않는다.
- **버전은 사용자가 명시적으로 올리라고 할 때만 올린다.** 버전 태그 push 가 곧 릴리스 빌드 트리거다(GitHub Actions 가 DMG · zip 을 만들고, 설치된 앱들이 그걸 업데이트로 받는다).
  - 평소 커밋: 제목에 `(vX.Y.Z)` 를 붙이지 않고, `package.json` 버전도 건드리지 않는다. main 만 push.
  - 버전을 올리라고 했을 때: `scripts/bump-version.sh [patch|minor|major]` → 커밋 제목 끝에 `(vX.Y.Z)` → `.githooks/post-commit` 이 annotated 태그를 단다 → main 과 태그를 push.
  - 올리기 직전에 `git log --oneline -5` 와 현재 `package.json` 버전을 다시 읽는다. 다른 세션이 같은 레포에 커밋하는 일이 있다.
  - 태그와 `package.json` 버전이 다르면 워크플로가 실패한다.

## 작업 시 주의

- 코드 주석 · 로그 문자열은 영어. UI 문자열은 `web/src/lib/i18n.ts` 에 en / ko 둘 다 넣는다.
- 사용자가 체크아웃 런처 앱을 띄워 둔 상태일 수 있다. 그 앱은 레포의 `dist/` · `web/dist/` 를 그대로 서빙하고, 빌드 정보가 바뀌면 재시작 루프에 빠진다. **레포 안에서 `npm run build` / `vite build` / `npm run dist` 를 하지 말고** `/tmp` 복사본에서 빌드 · 검증한다.
- 실행 중인 앱 옆에서 테스트 사본을 띄울 때 쓰는 환경 변수: `VIBRATO_PORT`, `VIBRATO_USER_DATA`, `VIBRATO_CONFIG_DIR`, `VIBRATO_UPDATE_DIR`, `VIBRATO_UPDATE_FEED`(가짜 릴리스 API). 자동 업데이트 재시작 때도 `open --env` 로 유지된다.
- 독립 앱은 Apple 개발자 서명이 없다(ad-hoc, `scripts/after-pack.cjs`). 공증 · 스토어 배포는 범위 밖.
- 앱 안 브라우저는 Chromium(Electron 뷰)이 아니라 WKWebView 다. Electron 안에서는 Google 로그인이 막힌다(2026-11 확인, 예전 브라우저 탭 코드도 막힘). Safari UA + 고정 WKWebsiteDataStore 로 로그인이 유지된다. CDP 가 없으니 에이전트 조작은 MCP 도구로만 한다.
