# 계획 체크리스트 고도화 계획 (역할 표시 · 계획 변경 · 검증)

작성: 2026-11-24 · 개정: 2026-11-24 (하위 에이전트 분업 폐기 후 다시 수립) · 상태: 계획 (미착수)

계획 탭에서 다음 세 가지가 보이게 한다.

1. 단계마다 어떤 역할의 일인지, **실제 작업 기록을 근거로** 보인다.
2. 계획이 바뀌어도 단계를 **id 로 정확히** 이어 붙인다.
3. 코드를 고친 턴은 **검증으로 끝난다**.

에이전트는 지금처럼 메인 세션 하나가 모든 일을 한다. 하위 에이전트로 일을 나누지 않는다.

## 0. 배경

2026-11-24 에 하위 에이전트 분업(총괄+코더는 메인 세션, 기획 · 디자인 · 검증은 하위 에이전트)을 시험 구현하고 실제 세션 26회로 실험했다. 그 결과 폐기했다. 시험 코드, 브랜치, 실험 자료는 모두 지웠다.

| 확인한 것 | 수치 |
|----------|------|
| 품질 | 분업을 켜든 끄든 숨긴 채점 100%. 차이 없음 |
| 모델에게 판단을 맡기면 | 하위 에이전트를 한 번도 부르지 않음. 비용만 +7% |
| 맡기라고 지시하면 (로컬 자료) | 자료에 따라 비용 −21%~+6%, 시간 +55~60% |
| 실제 Figma 페이지 | 분업 쪽은 미완료. Figma 호출 2.6배, 하위 에이전트 토큰 78만. 메인 혼자서는 107초에 시안과 같게 완성 |

실험에서 얻어 이 계획에 그대로 쓰는 것:

- 고정 id 가 있는 계획(`plan_set`)이면 계획 변경을 정확히 맞출 수 있다.
- 역할을 강제하면 질문 하나에도 왕복이 한 번 늘었다. 그래서 역할은 선택 항목으로 둔다.
- 분업을 하지 않아도 모델은 단계마다 역할을 자연스럽게 붙였다.
- 큰 문서나 Figma 는 메인이 Bash(jq · grep)로 직접 다루는 것이 가장 효율적이었다.
- SDK 에이전트 정의는 CLI 가 받지 않는 값(예: `autoCompactWindow` 를 100k~1M 범위 밖으로 주는 것)이 있으면 오류 없이 무시된다. 나중에 에이전트 정의를 쓴다면 등록을 확인해야 한다.

## 1. 결정

| # | 결정 | 이유 |
|---|------|------|
| D1 | 하위 에이전트 분업을 하지 않는다. 메인 세션이 모든 역할을 맡는다 | §0 실험 |
| D2 | 역할은 **표시용** 분류다. A 총괄(파악 · 질문 · 정리), B 기획 확인, C 디자인 확인, D 코드 수정, E 검증 | 사용자가 단계의 성격을 한눈에 보게 하는 것이 목적 |
| D3 | 역할의 근거는 두 가지다. 계획의 **선언**(`plan_set` 의 role, 글 계획의 `[B]` 태그)과 **실제 작업 기록**(도구 호출). 선언이 없으면 작업 기록으로 정하고 "추정"으로 표시한다 | 근거 없는 표시를 막는다 |
| D4 | `plan_set`: 단계마다 고정 id, role 은 선택. 두 번째 호출부터 이유 필수, 완료된 단계는 뺄 수 없음, 지운 id 는 다시 쓸 수 없음 | 계획 변경 대조를 추정이 아니라 데이터로 한다 |
| D5 | 따로 토글을 두지 않는다. "항상 계획 세우기"가 켜져 있으면 같이 동작한다 | 추가 비용이 턴마다 도구 호출 한 번 정도다 |
| D6 | 코드를 고친 턴은 E 단계(완료, 또는 생략 이유)나 실제 검증 명령이 있어야 끝난다. 없으면 `Stop` 훅이 한 번 되돌려 보낸다 | 검증 없이 끝나는 수정을 막는다 |
| D7 | 역할 칩 막대는 A 말고 다른 역할이 선언됐거나 B~E 의 작업 근거가 있을 때만 보인다 | 질문 턴에 칩 5개가 뜨는 것은 소음이다 |
| D8 | 모든 표시를 도구 호출에서 계산한다. 서버 전용 이벤트나 사이드카 파일을 두지 않는다 | 기록을 다시 불러와도 그대로 나온다 |
| D9 | Codex 도 같은 MCP 로 `plan_set` · `plan_step` 을 받는다. 훅이 없으므로 검증 강제는 지시문으로만 한다 | 두 CLI 가 같은 화면을 쓴다 |

## 2. 역할 근거 규칙

한 곳(`web/src/lib/roles.ts`)에 두고 단위 테스트로 고정한다. 하위 에이전트 안의 도구 호출(`parent` 있음)은 세지 않는다.

| 역할 | 실제 작업 근거 |
|------|--------------|
| A 총괄 | Read · Grep · Glob · 일반 Bash · WebSearch · AskUserQuestion |
| B 기획 확인 | 기획 자료 MCP 도구(이름에 notion · confluence · google_docs · gdrive) |
| C 디자인 확인 | Figma MCP 도구(이름에 figma) |
| D 코드 수정 | Edit · Write · MultiEdit · NotebookEdit · Codex `FileChange` |
| E 검증 | 검증 명령(`npm test` · `npm run typecheck` · `tsc` · `node --test` · `vitest` · `jest` · `pytest` · `go test` · `cargo test` 등), Vibrato 브라우저 도구(`browser_*`) |

- 표시 역할: 선언이 있으면 선언을 쓴다. 없으면 작업 근거 중 D > E > C > B > A 순서로 고르고 "추정"으로 표시한다.
- 선언과 실제가 다르면(선언 B 인데 수정이 있음) 단계 태그는 선언을 쓰고, 근거 줄에 실제 역할이 함께 보인다. 칩은 실제 역할도 켠다.
- 로컬 파일(docs/*.md, 시안 캡처)을 읽은 것은 기획 · 디자인인지 알 수 없으므로 A 로 센다. 이런 단계는 선언으로 정한다.

## 3. `plan_set`

`server/browserMcp.ts` 의 `PLAN_TOOLS` 에 추가한다.

```jsonc
plan_set({
  "steps": [
    { "id": "s1", "role": "C", "title": "Figma 첫 화면 수치 확인" },
    { "id": "s2", "role": "D", "title": "index.html · style.css 작성" },
    { "id": "s3", "role": "E", "title": "렌더 결과를 시안과 대조" }
  ],
  "reason": "..."   // 두 번째 호출부터 필수
})
plan_step({ "id": "s2", "note": "..." })   // 번호(step)도 계속 받는다
```

- 서버가 세션 토큰별로 한 턴의 계획(쓴 id, 완료된 id, 호출 횟수)을 기억한다. 새 턴이 시작되면 비운다. 토큰은 MCP 를 붙이는 모든 세션에 발급한다(지금은 브라우저 도구가 켜진 세션에만 발급된다).
- 거절 규칙: id 형식(`s` + 숫자) · 중복, 단계 1~12개, 알 수 없는 role, 두 번째 호출의 이유 누락, 완료 단계 제외, 지운 id 재사용. 거절하면 `isError` 와 이유를 돌려주고, 모델이 고쳐서 다시 부른다.
- 지시문(`server/planInstructions.ts`): 글 계획을 쓴 직후 같은 단계로 `plan_set` 을 부른다. 코드를 바꾸는 요청이면 단계마다 role 을 붙이고 글 계획에도 `[D]` 처럼 태그를 단다. 질문에는 role 이 필요 없다. 계획이 바뀌면 모든 단계를 다시 보낸다.
- `planGuard`: `plan_set` 호출을 그 계획의 글("진행 계획 / 1. …")로 바꿔 기존 검사를 그대로 쓴다. id 로 부른 `plan_step` 은 현재 순서의 번호로 바꾼다.

## 4. 계획 변경 대조

`plan_set` 경로 (정확): 직전 계획과 id 로 비교한다.

| 변화 | 표시 |
|------|------|
| 새 id | 추가 |
| 사라진 id (미완료) | 취소선 + 이유 |
| 같은 id, 제목 다름 | 이름 변경 (단계 행 · 메모 · 회차 유지) |
| 같은 id, 역할 다름 | 역할 변경 |
| 순서만 다름 | 표시 없음 |

- 변경은 "계획 변경 n차" 줄로, 그 `plan_set` 이 불린 시점에 진행 중이던 단계 아래 들어간다.

글 계획 경로 (도구가 없을 때, 추정):

1. 역할 태그와 정규화한 제목(공백 · 기호 · 끝 조사 제거)이 같으면 같은 단계로 본다.
2. 남은 것끼리 제목 단어 Jaccard ≥ 0.6 이면 같은 단계로 본다(점수 높은 쌍부터 1:1).
3. 완료된 단계가 새 계획에서 사라지면 "완료(계획에서 빠짐)"으로 남긴다.
4. 단계 자체는 지금처럼 번호로 합친다. 대조 결과는 "계획 변경(추정)" 표시에만 쓴다.

## 5. 검증 강제

- `PostToolUse`(메인만)로 이번 턴의 실제 역할(§2)을 모은다.
- `Stop`: 기존 계획 검사를 통과한 뒤, D 가 있는데 E 근거도 없고 계획에 E 단계도 없으면 한 번 되돌린다. 안내 문구: "E 단계를 `plan_set` 으로 추가하고 검증하거나, `plan_step` skipped 로 이유를 적어라".
- E 단계가 "Not done: 이유"로 닫혔으면 통과한다. 이미 되돌린 뒤(`stop_hook_active`)에는 검사하지 않는다.

## 6. 계획 탭 UI

**역할 칩 막대**: 턴 카드의 체크리스트 위에 둔다. 진행 중인 턴에서는 탭 위쪽에 고정(sticky)한다.

- `grid grid-cols-5 gap-2` 로 너비를 꽉 채우고 간격만 같게 둔다. `rounded-md` 직사각형 버튼 모양이다. 다섯 개를 항상 그린다.
- 상태: 미사용(흐림, 비활성) · 예정 · 진행 중 · 사용자 응답 대기(A) · 완료 · 실패 · 중단.
  - 실패: 그 역할 단계가 "Not done"으로 닫혔거나, E 의 마지막 검증 명령이 실패했을 때.
  - 중단: 턴이 끝났는데 진행 중으로 남은 단계가 있을 때.
- 칩 아래 줄: "단계 1/2", 같은 단계를 여러 회차 했으면 `×n`.
- 누르면 그 역할의 첫 단계로 스크롤하고 그 역할 단계만 강조한다. 다시 누르면 해제한다.

**단계 행**:

- 번호 뒤에 역할 태그를 단다. 추정이면 점선 테두리이고, 툴팁에 "작업 내용으로 추정"을 띄운다.
- **근거 줄**: 그 단계의 실제 작업을 역할별로 요약한다. 예: "Figma 3 · 수정 2파일 · 테스트 1(실패 0)". 표시의 근거가 된다.
- 단계 안 흐름: 사용자 추가 요청(들어온 위치), 계획 변경 n차(바뀐 내용 · 이유).

**턴 아래쪽**: 계획에서 빠진 단계(취소선 · 이유), 글 계획의 추정 변경 표시.

**요약**(`SessionSummary`): 계획 변경 수, 검증 실패 · 재시도 수를 더한다.

**문구**: `web/src/lib/i18n.ts` 에 en / ko 둘 다 넣는다(역할 이름, 상태, 근거 줄, 계획 변경).

## 7. 구현 단계

단계마다 따로 커밋한다. 끝날 때마다 `npm run typecheck` · `npm run typecheck:win` · `npm run check:platforms` · `npm test` 가 통과해야 한다.

| 단계 | 내용 | 주요 파일 | 완료 조건 |
|------|------|----------|----------|
| P1 `plan_set` | 도구 · 서버 턴 기록 · 거절 규칙, 토큰 발급 범위, 새 턴 초기화, `planGuard` 인식, 지시문 | `server/browserMcp.ts`, `server/sessions.ts`, `server/planGuard.ts`, `server/agents/claude.ts`, `server/planInstructions.ts`, 새 `web/src/lib/planSet.ts` | TC-PS |
| P2 계획 대조 | `buildPlan` 이 `plan_set` 으로 단계를 만들고 변경 이력 · 빠진 단계 · 추가 요청 위치를 남김, 글 계획 추정 대조 | `web/src/lib/planView.ts`, 새 `web/src/lib/planDiff.ts` | TC-PD, 기존 `tests/plan-view.test.ts` 그대로 통과 |
| P3 역할 근거 | 역할 규칙, 단계 역할 · 근거 요약 · 칩 상태 계산 | 새 `web/src/lib/roles.ts`, `web/src/lib/planView.ts` | TC-RL |
| P4 화면 | 칩 막대, 역할 태그, 근거 줄, 계획 변경 · 빠진 단계 · 추가 요청 표시, 요약, i18n | 새 `web/src/components/RoleBar.tsx`, `web/src/components/PlanView.tsx`, `web/src/lib/i18n.ts` | TC-UI, TC-ED, `npm run test:ui` |
| P5 검증 강제 · Codex | `Stop` 검사, Codex 지시문 | `server/agents/claude.ts`, `server/planInstructions.ts` | TC-HK, TC-CX |
| P6 실측 | 실제 세션으로 E2E · 비용 확인. 체크아웃 앱이 아니라 `/tmp` 사본 서버에서 한다 | - | TC-E2E, TC-CO |

## 8. 테스트 케이스

### TC-PS `plan_set` (`tests/browserMcp.test.ts`, 새 `tests/plan-set.test.ts`)

| ID | 입력 | 기대 결과 |
|----|------|----------|
| PS-1 | 정상 3단계, 첫 호출 | 성공, 단계 수 응답 |
| PS-2 | id 중복 | `isError` "duplicate id" |
| PS-3 | `role: "X"` | `isError`, 허용 값 안내 |
| PS-4 | role 없는 단계 | 성공(질문 턴) |
| PS-5 | 단계 0개 / 13개 | `isError` |
| PS-6 | 두 번째 호출에 이유 없음 | `isError` "reason required" |
| PS-7 | 완료된 단계를 뺀 재호출 | `isError` "s2 is done; keep it" |
| PS-8 | 지운 id 재사용 | `isError` |
| PS-9 | `plan_step` 에 없는 id | `isError` |
| PS-10 | `plan_step` 번호만 | 현재 순서의 단계로 처리 |
| PS-11 | 새 턴 시작 후 첫 `plan_set` | 이전 턴 기록 없이 성공 |
| PS-12 | 브라우저 도구 끈 세션 | 토큰이 발급되고 `plan_set` 이 동작 |

### TC-PD 계획 변경 대조 (새 `tests/plan-diff.test.ts`)

| ID | 상황 | 기대 결과 |
|----|------|----------|
| PD-1 | s1~s3 → s1,s2,s4,s3 | s4 추가, 새 순서 |
| PD-2 | 미완료 s2 제외 | 취소선, 이유 표시 |
| PD-3 | s1 제목만 변경 | 같은 행, 메모 · 회차 유지 |
| PD-4 | s1 역할 B → D | 역할 변경 표시, 칩 이동 |
| PD-5 | 한 턴에 세 번 계획 | "1차 · 2차" 두 줄, 각각 호출 시점의 단계 아래 |
| PD-6 | 변경 전 s1 에 쌓인 작업 | 변경 후에도 s1 아래 |
| PD-7 | 순서만 변경 | 표시 없음 |
| PD-8 | 글 계획에 단계 하나 끼워 넣음 | 나머지는 제목으로 맞고 새 단계만 추가(추정) |
| PD-9 | "로그인 버그 수정" → "로그인 토큰 만료 버그 수정" | 같은 단계 |
| PD-10 | 완료한 1번이 새 글 계획에서 사라짐 | "완료(계획에서 빠짐)" |
| PD-11 | 같은 번호, 무관한 제목 | 삭제 + 추가 |
| PD-12 | TodoWrite · TaskCreate 경로 | 기존 테스트 전부 통과 |

### TC-RL 역할 근거 (새 `tests/roles.test.ts`)

| ID | 입력 | 기대 결과 |
|----|------|----------|
| RL-1 | `plan_set` role C | 선언 C, 추정 아님 |
| RL-2 | 글 계획 `2. [E] 실측` | 선언 E, 제목에서 태그 제거 |
| RL-3 | Figma MCP 호출만 있는 미선언 단계 | C, 추정 |
| RL-4 | Notion MCP 호출만 있는 미선언 단계 | B, 추정 |
| RL-5 | Edit | D |
| RL-6 | `npm run typecheck`, `browser_measure` | E |
| RL-7 | Read · Grep · `rg` 만 | A |
| RL-8 | Figma 읽기와 Edit 가 함께 있는 미선언 단계 | D (근거 줄에는 C · D 둘 다) |
| RL-9 | 선언 B 인데 Edit 발생 | 태그 B, 근거 줄에 D, 칩 B · D 활성 |
| RL-10 | 하위 에이전트 안의 Edit | 세지 않음 |
| RL-11 | Codex `FileChange` | D |
| RL-12 | 질문 턴(A 한 단계) | 칩 막대 없음 |

### TC-HK 검증 강제 (`tests/plan-guard.test.ts`)

| ID | 상황 | 기대 결과 |
|----|------|----------|
| HK-1 | 수정 + E 단계 완료 | 통과 |
| HK-2 | 수정 + E 단계 없음 + 검증 명령 없음 | 한 번 되돌림 |
| HK-3 | 수정 + E 단계 "Not done: 문서만 수정" | 통과 |
| HK-4 | 수정 + 계획에 E 없음 + `npm test` 실행 | 통과 |
| HK-5 | 수정 없는 턴 | 검사 안 함 |
| HK-6 | 되돌린 뒤 다시 멈춤(`stop_hook_active`) | 통과 |
| HK-7 | `plan_set` 만 있고 글 계획 없음 | 계획 있음으로 인정 |

### TC-UI 화면 (`tests/smoke-ui.cjs` + 오프스크린 캡처)

| ID | 확인 | 기대 결과 |
|----|------|----------|
| UI-1 | 칩 막대 | 좌우 꽉 참, 간격 동일, 5개 항상 |
| UI-2 | 창 너비 360px | 줄바꿈 없이 줄어들고 글자는 말줄임 |
| UI-3 | 미사용 칩 | 흐림, 누를 수 없음 |
| UI-4 | 칩 누름 / 다시 누름 | 해당 단계 스크롤 · 강조 / 해제 |
| UI-5 | 진행 중 턴 스크롤 | 막대 고정 |
| UI-6 | 추정 역할 | 점선 태그, 툴팁 |
| UI-7 | 근거 줄 | 단계의 실제 작업 수와 일치 |
| UI-8 | ko / en | 새 문구 모두 번역 |
| UI-9 | windows 대상 | `typecheck:win` 통과, 단축키 표기는 `keyLabel` |

### TC-ED 예외 (`tests/plan-diff.test.ts` + 수동)

| ID | 상황 | 기대 결과 |
|----|------|----------|
| ED-1 | 진행 중 사용자 추가 요청 | 그 위치에 "추가 요청" 줄 |
| ED-2 | 추가 요청 뒤 `plan_set` 재호출 | 추가 요청 줄 아래 "계획 변경" |
| ED-3 | 검증 실패 → 수정 → 재검증 | E 단계 a · b 회차, 칩 `×2` |
| ED-4 | 단계가 "Not done"으로 닫힘 | 칩 실패 |
| ED-5 | 사용자 중단 | 진행 중 단계 · 칩 "중단" |
| ED-6 | 질문 · 승인 대기 | A 칩 "사용자 응답 대기" |
| ED-7 | `plan_set` 없이 바로 수정 시작 | 기존 "계획 먼저" 넛지 |
| ED-8 | 기록 다시 불러오기 | 칩 · 태그 · 근거 · 계획 변경이 실시간과 같음 |

### TC-CX Codex

| ID | 상황 | 기대 결과 |
|----|------|----------|
| CX-1 | Codex 세션 도구 목록 | `plan_set` · `plan_step` 있음 |
| CX-2 | `mcp:vibrato/plan_set` 이름 | 체크리스트가 Claude 와 같게 그려짐 |
| CX-3 | Codex 수정 턴 | `FileChange` 가 D 로 표시 |

### TC-E2E 실제 세션 (P6, `/tmp` 사본 서버)

| ID | 요청 | 기대 결과 |
|----|------|----------|
| E2E-1 | 함수 설명 질문 | 칩 막대 없음, 추가 왕복 없음 |
| E2E-2 | 오타 수정 | D · E 표시, 검증으로 끝남 |
| E2E-3 | Figma 링크로 화면 한 장 | C · D · E 표시, 근거 줄에 Figma 호출 수 |
| E2E-4 | Notion 기획 링크로 기능 구현 | B · D · E 표시 |
| E2E-5 | 진행 중 요구 추가 | 추가 요청 줄과 계획 변경 1차 |

### TC-CO 비용 (P6)

| ID | 비교 | 기준 |
|----|------|------|
| CO-1 | E2E-1 ~ E2E-3 을 도입 전/후 각 2회 | 턴 비용 차이 3% 이하 |
| CO-2 | 같은 비교의 Stop 되돌림 횟수 | 검증을 한 턴에서는 0 |

## 9. 남은 위험

- 역할 근거 규칙은 도구 이름에 기대고 있다. 사용자가 붙인 MCP 이름이 다르면 B · C 가 A 로 보인다. 선언(role)이 우선이므로 표시는 맞지만 근거 줄이 비어 보일 수 있다.
- 검증 강제는 문서만 고친 턴에도 E 단계나 이유를 요구한다. 되돌림은 한 번뿐이지만, 너무 잦으면 "문서 파일만 바꾼 턴은 제외" 규칙을 더한다.
- 글 계획 대조는 추정이다. `plan_set` 을 쓰는 한 표시에는 쓰이지 않는다.

## 10. 하위 에이전트 조작 · 표시 고도화

분업은 하지 않지만(§0), 메인은 필요할 때 스스로 하위 에이전트(Explore, general-purpose 등)를 부른다. 그 하위 에이전트를 보고 다루는 기능을 고도화한다.

### 10.1 지금 상태 (2026-11-24 코드 기준)

| 항목 | 지금 | 근거 |
|------|------|------|
| 중지 | 그래프 팝오버에서만 된다. 채팅 카드 · 계획 탭에는 버튼이 없다 | `TaskChips.tsx`, `ChatItems.tsx` `ToolItem`, `PlanView` 에 `onStopTask` 없음 |
| 진행 요약 | `summary` 필드는 있지만 `agentProgressSummaries` 를 켜지 않아 하위 에이전트에서는 비어 있다 | `server/agents/claude.ts` options |
| 기다림 해제 | 메인이 기다리는 하위 에이전트를 백그라운드로 돌리는 SDK `backgroundTasks(toolUseId)` 를 쓰지 않는다 | - |
| 기록 보기 | 부모 카드 안에 중첩 목록으로만 보인다. SDK `getSubagentMessages` · `listSubagents` 를 쓰지 않는다 | - |
| 계획 탭 | 돌고 있는 것만, 4개까지 보인다(나머지는 "+n" 글자). 스피너 · 종류 · 설명 · 경과 시간만 있다 | `PlanView.tsx` `TaskLines` |
| 끝난 작업 | 그래프에서 숨겨진다. 모두 끝나면 칩이 사라져 그래프를 열 수 없다 | `taskGraph.ts` `visibleTasks`, `TaskChips.tsx` |
| 토큰 · 도구 수 | 그래프 상세에만 보인다. 작업별 USD 는 데이터가 없다 | `TaskInfo.usage` |
| 기록 다시 불러오기 | `tasks` 가 다시 만들어지지 않는다(대화 항목만 복원) | `itemsFromHistory` |
| Codex | `SubAgent` 도구 항목만 있고 `TaskInfo` 가 없다. 칩 · 그래프 · 중지가 없고, 결과는 4000자로 잘린다 | `server/agents/codex.ts` |
| 테스트 | `handleTask` · `stopTask` · Codex 매핑 · `TaskChips` 를 직접 다루는 테스트가 없다 | `tests/` |

### 10.2 조작

| # | 기능 | 방법 |
|---|------|------|
| S1 | **어디서나 중지** | 채팅 카드 머리, 계획 탭 하위 에이전트 줄, 그래프 상세에 같은 중지 버튼을 둔다. 확인은 한 번만 받는다. `session.stopTask` 를 그대로 쓴다 |
| S2 | **기다리지 않고 계속** | 메인이 결과를 기다리는(foreground) 하위 에이전트에 버튼을 둔다. 누르면 `q.backgroundTasks(toolUseId)` 를 부른다. 메인은 다음 일을 하고, 결과는 끝날 때 알림으로 들어온다. 새 명령 `session.backgroundTask { toolUseId }` 를 만든다(Claude 만) |
| S3 | **진행 요약** | `agentProgressSummaries: true`. 약 30초마다 "인증 모듈 분석 중" 같은 한 줄이 `task_progress.summary` 로 온다. 하위 에이전트의 프롬프트 캐시를 쓰므로 비용이 작다(SDK 설명). 실측(CO-3)에서 비용이 2% 를 넘으면 설정으로 끌 수 있게 한다 |
| S4 | **기록 보기** | 서버 `GET /api/subagent/:sessionId/:agentId` 가 `getSubagentMessages` 를 돌려준다. 웹은 오른쪽 서랍(drawer)에 하위 에이전트 대화를 메인 채팅과 같은 카드로 보여 준다. 돌고 있는 동안에는 지금처럼 실시간 중첩 항목을 쓴다 |
| S5 | **기록 복원** | 기록을 다시 불러올 때 `listSubagents` 와 Agent 도구 항목으로 끝난 작업을 `TaskInfo`(status, 종류, 설명, 토큰, 도구 수)로 다시 만든다 |

- task id 와 agent id 가 같은지는 P7 첫 작업에서 실제 세션으로 확인한다. 다르면 `SubagentStart` 훅 입력(`agent_id`)과 `task_started.tool_use_id` 로 짝을 맞춘다.

### 10.3 화면

**V1 계획 탭 하위 에이전트 줄**: 하위 에이전트를 부른 단계 아래에 하위 에이전트마다 한 줄씩 보인다.

```
2. [A] 원인 찾기                                              진행 중
   ◐ Explore  로그인 토큰 검사 위치 찾기                1:12 · 18k 토큰 · 도구 9
     "auth/middleware.ts 의 만료 비교 확인 중"                  ← 진행 요약(S3)
     [중지] [기다리지 않고 계속] [기록 보기] [채팅에서 보기]
   ✓ general-purpose  테스트 실패 원인 정리             0:41 · 32k 토큰 · 결과 첫 줄 …
```

- 끝난 것도 남긴다. 상태 아이콘(진행 · 완료 · 실패 · 중지)과 결과 첫 줄을 보인다.
- 4개 제한을 없애고, 5개 이상이면 "끝난 n개 더 보기"로 접는다.
- 백그라운드로 돌고 있는 것은 "백그라운드" 표시를 단다. 턴이 끝난 뒤에도 그 단계 아래에서 계속 진행이 보인다.

**V2 채팅 카드 머리**: 보라색 하위 에이전트 카드 머리에 진행 요약 한 줄, 토큰 · 도구 수, 버튼(중지 · 기다리지 않고 계속 · 기록 보기)을 둔다.

**V3 끝난 작업 보기**: 그래프 팝오버에 "끝난 작업도 보기" 토글을 둔다. 돌고 있는 작업이 없어도 계획 탭 턴 머리의 "하위 에이전트 n" 칩으로 그래프를 연다.

**V4 근거 줄 연동(§6)**: 단계 근거 줄에 "하위 에이전트 2(Explore 1 · general-purpose 1) · 50k 토큰"을 더한다. 하위 에이전트 안의 도구 호출은 역할 근거(§2)에 넣지 않는다(지금 규칙 유지).

**V5 Codex 동일화**: `collabAgentToolCall` 의 시작 · 끝을 `TaskInfo` 로 만들고, `subAgentActivity` 를 그 작업의 `lastTool` · 진행으로 반영한다. 그러면 칩 · 그래프 · 계획 탭 줄이 Claude 와 같게 나온다. 중지 · 기다림 해제는 Codex app-server 에 해당 요청이 있을 때만 붙이고, 없으면 버튼을 숨긴다. 결과 4000자 자르기는 "결과 전체 보기"로 펼칠 수 있게 한다.

**문구**: en / ko 모두 넣는다. 버튼 단축키를 둔다면 `keyLabel()` 을 거친다.

### 10.4 구현 단계 (P1~P6 다음)

| 단계 | 내용 | 주요 파일 | 완료 조건 |
|------|------|----------|----------|
| P7 서버 조작 | task id ↔ agent id 확인, `agentProgressSummaries`, `session.backgroundTask`, `/api/subagent/...`, 기록 복원용 `listSubagents` | `server/agents/claude.ts`, `server/agents/types.ts`, `server/sessions.ts`, `server/app.ts` | TC-SA 서버 항목 |
| P8 계획 탭 · 카드 | V1 · V2 · V4, 공통 버튼 컴포넌트, 서랍(S4) | `web/src/components/PlanView.tsx`, `ChatItems.tsx`, `TaskChips.tsx`, 새 `SubagentDrawer.tsx`, `web/src/lib/planView.ts`, `i18n.ts` | TC-SA 화면 항목, `npm run test:ui` |
| P9 끝난 작업 · 복원 | V3, S5 | `web/src/lib/taskGraph.ts`, `chatStore.ts`, `useSessions.ts` | TC-SA 복원 항목 |
| P10 Codex | V5 | `server/agents/codex.ts` | TC-SA Codex 항목 |

### 10.5 TC-SA 하위 에이전트

| ID | 상황 | 기대 결과 | 위치 |
|----|------|----------|------|
| SA-1 | `task_started` → `task_progress`(summary) → `task_notification` | `TaskInfo` 의 summary · usage · status · endedAt 이 순서대로 갱신 | 새 `tests/claude-tasks.test.ts` (`handleTask` 직접 호출) |
| SA-2 | `background_tasks_changed` 에서 빠진 백그라운드 작업 | completed 처리 | 같음 |
| SA-3 | `session.stopTask` | `q.stopTask` 호출, 이후 status stopped | 같음 (가짜 query) |
| SA-4 | `session.backgroundTask` 에 foreground 작업의 toolUseId | `q.backgroundTasks(toolUseId)` 호출, 작업 background=true | 같음 |
| SA-5 | 같은 명령, 없는 toolUseId | 오류 응답, 상태 변화 없음 | 같음 |
| SA-6 | Codex 세션의 `session.backgroundTask` | 지원 안 함 오류, 버튼 숨김 | 같음 |
| SA-7 | `agentProgressSummaries` 옵션 | 세션 시작 옵션에 true | 같음 |
| SA-8 | `/api/subagent/:sid/:aid` | `getSubagentMessages` 결과를 메시지 배열로, 없으면 빈 배열 | `tests/` 서버 라우트 테스트 |
| SA-9 | 하위 에이전트 6개를 부른 단계 | 계획 탭에 돌고 있는 것 전부 + "끝난 n개 더 보기" | `tests/plan-view.test.ts` |
| SA-10 | 끝난 하위 에이전트 | 계획 탭 줄에 완료 아이콘과 결과 첫 줄 | 같음 |
| SA-11 | 턴이 끝난 뒤에도 도는 백그라운드 작업 | 원래 단계 아래에 "백그라운드 · 진행 중" | 같음 |
| SA-12 | 모든 작업이 끝난 세션 | 턴 머리 칩으로 그래프를 열 수 있고, "끝난 작업도 보기"로 전부 보임 | `tests/task-graph.test.ts` |
| SA-13 | 기록 다시 불러오기 | `listSubagents` · Agent 항목으로 끝난 작업이 다시 생김(종류 · 설명 · 토큰) | 새 테스트 |
| SA-14 | 단계 근거 줄 | "하위 에이전트 n · 토큰" 이 실제 작업과 일치, 역할 근거에는 하위 에이전트 내부 호출이 안 들어감 | `tests/roles.test.ts` |
| SA-15 | Codex `collabAgentToolCall` 시작 · 끝 | `task` 이벤트 2회(running → completed), 칩 · 그래프에 보임 | 새 `tests/codex-tasks.test.ts` |
| SA-16 | Codex 결과 4000자 초과 | 잘린 표시 + "결과 전체 보기"로 원문 | 같음 |
| SA-17 | 버튼 세 곳(카드 · 계획 탭 · 그래프)의 중지 | 같은 확인 대화, 같은 명령 | `tests/smoke-ui.cjs` |
| SA-18 | 기록 서랍 | 하위 에이전트 대화를 카드로, 닫으면 원래 스크롤 유지 | 같음 |
| SA-19 | ko / en, windows 대상 | 새 문구 번역, `typecheck:win` 통과 | - |
| SA-20 | 실제 세션: Explore 를 부르는 질문 | 진행 요약이 30초 안팎에 한 번 이상 보이고, 중지 · 기다리지 않고 계속이 동작 | P6 실측 |

비용 TC 추가:

| ID | 비교 | 기준 |
|----|------|------|
| CO-3 | 하위 에이전트를 부르는 같은 요청, 진행 요약 켬 / 끔 각 2회 | 턴 비용 차이 2% 이하. 넘으면 설정으로 끌 수 있게 한다 |
