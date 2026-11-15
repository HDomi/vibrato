# Vibrato

개인용 macOS 바이브코딩 앱. Electron 껍데기 + 로컬 Node 서버(Hono, 127.0.0.1:11398) + React(Vite, Tailwind v4).
에이전트는 사용자가 설치·로그인한 `claude` / `codex` CLI 만 쓴다. API 키 기반 설계는 하지 않는다.
Claude 는 Agent SDK 에 `pathToClaudeCodeExecutable` 로 설치된 `claude` 를 지정한다(SDK 번들 바이너리 · `--bare` 금지).

## 구조

레포 루트는 모든 대상이 함께 쓰는 **base** 코드이고, 한 OS 에만 있는 코드는 `platforms/<target>/` 에 빌드될 때의 경로 그대로 둔다
(`platforms/mac/server/os/shell.ts` 는 맥 앱의 `server/os/shell.ts`). 대상은 `mac` · `windows`.

```
electron/   메인 프로세스(CommonJS .cts) · preload · 원격 탭 클라이언트(remote.cts: 연결을 메인 프로세스에 유지)
            OS 별 부분은 platform.cts(창 모양 · 잠금 · 앱 안 브라우저 · 업데이트 설치)로만 부른다
server/     Hono 서버 · 에이전트 어댑터 · PTY · git · 업데이트(updater.ts, releaseUpdate.ts) · 예약 실행(scheduler.ts, schedule.ts)
            배경화면(wallpaper.ts) · MCP(browserMcp.ts: 브라우저 도구 + 계획 체크리스트)
            원격 세션(remote/): TLS 1.3 리스너(기본 포트 11399, 기본 꺼짐), 자체 서명 인증서 + 지문 고정,
            PBKDF2 · HMAC 채널 바인딩 로그인(접속 코드 + 호스트 비밀번호 2중, legato 방식), 세션 메서드 허용 목록만 노출.
            OS 별 부분은 os/*(셸 · 클립보드 · 이미지 · 휴지통/zip/폴더 열기 · 전원 · 포트 목록 · 권한 · 업데이트 패키지 · 설치 명령)로만 부른다
web/        React 앱. IDE 창은 `/?ide=<root>` 로 같은 번들을 따로 로드(main.tsx)
            글래스 디자인: index.css 의 @theme 토큰 · .glass · .glass-pop
            OS 별 부분은 src/platform/*(탭 목록 · 자체 창 · 설정 섹션 · 문구/단축키 표기)로만 부른다. 경로 처리는 lib/paths.ts
platforms/mac/      electron/(platform.cts, lockScreen.cts, browser.cts: 네이티브 WKWebView) · native/webview(N-API) ·
                    server/os/* · server/lockWatch.ts · web/src/platform/* · 잠금화면 · 브라우저 창 · intro · 권한 화면 · tests/
platforms/windows/  electron/platform.cts · server/os/*(cmd.exe · PowerShell 기반) · web/src/platform/* · 권한 화면 · tests/
tests/      공통 node:test. OS 에 묶인 테스트는 platforms/<target>/tests/
scripts/platform.cjs   stage 조립 · 빌드 · 테스트 · dev (아래 「플랫폼 구조」)
.github/workflows/     release.yml(버전 태그 → DMG · 윈도우 설치본 릴리스) · ci.yml(main · ci/** push: 두 대상 타입 검사 + 테스트)
electron-builder.yml   독립 앱 번들 설정(asar 끔, node-pty prebuild, SDK 바이너리 제외)
```

실행 형태가 둘이다(맥 기준).

- **독립 앱**: DMG 로 설치한 `.app`. 코드는 `Contents/Resources/app`. 업데이트는 GitHub 릴리스 zip 을 받아 앱 종료 후 번들 교체(`server/releaseUpdate.ts`, `platforms/mac/electron/platform.cts` `installStagedUpdate`).
- **체크아웃**: `npm run app`, 또는 `install.sh` 가 만든 런처 앱. 업데이트는 git(`scripts/apply-update.sh`).

Windows 앱은 로컬 서버 + VIBE · 에이전트 · 도구 · 원격 탭이다. 잠금화면 · 앱 안 브라우저 · 스케줄러 탭은 없다.
업데이트는 릴리스의 NSIS 설치본을 받아 조용히 실행한다(zip 으로 푼 사본은 업데이트 안 됨). `VIBRATO_REMOTE_ONLY=1` 이면 어느 대상이든 원격 탭만 뜬다.

## 플랫폼 구조

- **레포 트리에서 바로 실행되는 것은 없다.** 모든 명령은 `scripts/platform.cjs` 가 레포 밖 임시 폴더(stage)에 base + `platforms/<target>` 을 합친 뒤 거기서 돈다. 빌드 결과만 `dist/` · `web/dist/` 로 복사한다.
  대상 선택: `--target=mac|windows` > `VIBRATO_TARGET` > 실행 중인 OS(윈도우면 windows, 아니면 mac).
- **base 에는 OS 를 가르는 코드를 넣지 않는다**(`process.platform` 분기, `/bin/zsh` · `osascript` · `powershell` 호출 등). 차이는 계약 모듈로 뺀다:
  `server/os/*.ts`, `electron/platform.cts`, `web/src/platform/*`. 두 대상이 같은 경로에 같은 export 를 내고, base 는 그것만 import 한다.
  계약이 어긋나면 그 대상의 타입 검사가 실패한다(`npm run typecheck`, `npm run typecheck:win`).
- 한 OS 에만 있는 기능(잠금화면, 앱 안 브라우저 등)은 파일째 `platforms/<target>/` 에 두고 그 대상의 계약 모듈에서만 import 한다.
- base 파일을 같은 경로로 덮어쓰는 것도 되지만 쓰지 않는다. 꼭 필요하면 `node scripts/platform.cjs accept --target=<t>` 로 base 해시를 기록해야 하고,
  이후 base 가 바뀌면 `npm run check:platforms` 가 실패한다.
- 서버가 내보내는 경로: 절대 경로는 그 OS 형식 그대로, 폴더 기준 상대 경로는 항상 `/`. 웹은 `lib/paths.ts` 로만 자르고 붙인다(경로 모양으로 OS 를 판별하므로 원격 호스트가 다른 OS 여도 맞다).
- 문구 · 단축키: `lib/i18n.ts` 사전은 맥 기준이다. 다른 대상은 `web/src/platform/strings.ts` 의 `STRINGS`(키 덮어쓰기)와 `keyLabel`(⌘ → Ctrl+)로 바꾼다. 화면에 박는 단축키 글자는 `keyLabel()` 을 거친다.
- 에디터(IDE)는 tsconfig 의 `rootDirs` 덕에 레포를 맥 대상으로 본다. 윈도우 쪽 타입은 `npm run typecheck:win` 으로 확인한다.
- 윈도우 코드는 맥에서 실행할 수 없다. `npm run test:win` 은 맥에서 파서류만 돌고(실제 OS 가 필요한 테스트는 skip, 원격 호스트 테스트는 openssl 탐색 때문에 실패),
  실제 검증은 CI 의 windows-latest 다. main 에 올리기 전에 보려면 `ci/<이름>` 브랜치로 push 한다.

## 명령

```bash
npm run typecheck        # 맥 대상 (윈도우: npm run typecheck:win)
npm run check:platforms  # 구조 규칙
npm test                 # 이 OS 의 대상 (맥에서 윈도우 대상: npm run test:win)
npm run test:ui          # Electron 렌더러 스모크
npm run dev              # stage 에서 Vite + 서버, 레포 수정이 따라간다
npm run build            # dist/ + web/dist/ + build-info
npm run dist             # build + electron-builder → release/ (DMG, zip). 윈도우: npm run dist:win
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
