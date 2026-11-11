# 04. 구현 기록

작성일 2026-11-11. [02-implementation-plan.md](02-implementation-plan.md)의 Phase 1(브리지)과 Phase 2(상태 보드)를 구현한 결과와, 계획에서 달라진 점을 적는다. AgentGauge 연동(Phase 3, [03 문서](03-agentgauge-integration.md))은 이번 범위에서 뺐다.

외부 도구에 관한 사실은 모두 2026-11-11에 이 기기에서 직접 확인했다. 확인한 버전은 Claude Code 2.1.321, Codex CLI 0.167.0, Antigravity CLI 1.5.5, Node.js 24.22.1이다.

## 1. 구성

```
Claude Code (Desktop 또는 CLI) ── 리드
  │ stdio MCP                        │ 훅(HTTP)
  ▼                                  ▼
plugin/bridge/mcp.ts ──HTTP──▶ Crew 데몬 (127.0.0.1:47615)
                                 ├─ codex app-server   (Codex: 구현, 리뷰)
                                 ├─ agy acp            (Antigravity: 문구·문서 정리)
                                 ├─ 이벤트 로그 ~/.crew/events.jsonl
                                 └─ 상태 보드 (SSE)  http://127.0.0.1:47615
```

- 데몬 하나가 워커 프로세스, 잡 상태, 이벤트 로그, 상태 보드를 소유한다. MCP 서버는 상태가 없는 얇은 클라이언트다. 그래서 Claude 세션이 재시작되거나 컴팩트돼도 잡이 유지되고, 세션이 여러 개여도 같은 보드를 본다.
- 데몬은 MCP 서버가 뜰 때 자동으로 시작된다. 더 새 버전의 플러그인이 호출하면 교체되는데, 실행 중인 잡이 있으면 잡이 끝날 때까지 미룬다. 낮은 버전이 높은 버전의 데몬을 내리는 일은 없다.
- 전체가 Claude Code 플러그인 하나(`plugin/`)다. MCP 서버, 훅, 스킬 2개, 서브에이전트 1개, 역할 파일 3개가 들어 있다.

## 2. 리드가 쓰는 도구

| 도구 | 동작 |
| --- | --- |
| `delegate` | Codex에 구현 조각을 맡긴다. 전용 worktree(`~/.crew/worktrees/<저장소>/<잡 id>`)와 `crew/<잡 id>` 브랜치에서 작업한다 |
| `review` | Codex에 읽기 전용 리뷰를 맡긴다. 기본은 adversarial, `mode: "standard"`는 Codex 내장 리뷰 |
| `polish` | Antigravity에 문구·주석·문서 정리를 맡긴다. `targets` 밖을 고치면 범위 이탈로 보고한다 |
| `status` | 잡 하나의 전체 결과, 또는 진행 중·최근 잡 목록과 Codex 사용량 |
| `wait` | 잡이 끝날 때까지 기다린다. 도중에 승인 요청이나 질문이 오면 앱에서 사용자에게 묻고 계속 기다린다 |
| `reply` | 같은 워커 세션에 후속 지시를 보낸다. 사용자가 대화로 알려준 승인·거절을 전달하는 데도 쓴다 |
| `cancel` | 잡을 취소한다. `discard: true`면 끝난 잡의 worktree와 브랜치를 지운다 |

- 02 문서 3.4절의 다섯 개에 `wait`와 `reply`를 더했다. 병렬 구현(리드와 Codex가 동시에 작업)과 수정 요청 왕복에 필요하다.
- 호출은 기본적으로 워커가 끝날 때까지 기다린다. `background: true`를 주면 잡 id만 받고 바로 돌아온다.
- worktree는 `HEAD`에서 만들므로 git이 추적하지 않는 파일이 없다. 저장소 루트의 `.worktreeinclude`(Claude Code가 자기 worktree에 쓰는 것과 같은 파일, `.gitignore` 문법)에 적힌 경로 중 gitignore된 것만 worktree로 복사한다. `node_modules`와 `.env`를 적어두면 워커가 설치 없이 테스트를 돌릴 수 있다. APFS에서는 copy-on-write 복제라 큰 폴더도 싸다.
- 데몬은 모든 세션이 공유하지만 잡은 시작한 세션의 프로젝트에 속한다. 인자 없는 `wait`와 `status` 목록은 자기 프로젝트의 잡만 다룬다. 보드와 `crew status`는 전부 보여준다.
- 워커는 커밋하지 않는다. worktree의 git 메타데이터가 샌드박스 밖에 있어서 할 수도 없다. 잡이 끝나면 브리지가 잡 브랜치에 커밋하고, 리드가 diff를 보고 병합하거나 반려한다.

## 3. 계획에서 달라진 점

| 항목 | 02 문서 | 구현 | 이유 |
| --- | --- | --- | --- |
| Antigravity 연결 | `agy acp` 또는 `agy -p` | `agy acp`만 | 공식 FAQ가 `agy -p`를 서드파티 코딩 에이전트 안에서 감싸 쓰는 것은 소비자 플랜에서 지원하지 않는다고 적고 있다. ACP 문서는 "Any ACP client can launch Antigravity CLI"라고 적는다(6절) |
| Phase 0 | `codex-plugin-cc`와 스킬로 먼저 완주 | 건너뜀 | app-server가 이 기기에서 바로 동작했다. 중간 단계를 거칠 이유가 없었다 |
| 역할 파일 | `CLAUDE.md`, `AGENTS.md`, Antigravity 커스텀 에이전트 | 플러그인 안의 `roles/*.md`, 스킬, MCP 서버 지침 | 프로젝트마다 파일을 깔 필요가 없다. Codex에는 `developerInstructions`로, Antigravity에는 프롬프트 앞부분으로 매 잡마다 주입한다 |
| Antigravity 역할 강제 | `--agent`와 `--mode` | ACP 권한 요청을 브리지가 판정 | 기본 모드에서는 편집마다 권한 요청이 온다. 브리지가 읽기는 어디든 허용하고, 편집은 경로가 worktree 안일 때만 허용하며, 명령 실행·삭제·이동·네트워크 요청은 거절한다. 거절한 내용은 잡 결과에 남는다. 사용자 설정 디렉터리에 파일을 쓰지 않아도 된다 |
| 이벤트 전송 | WebSocket | SSE | 단방향 스트림이면 충분하고 브라우저가 재연결을 알아서 한다. 조작은 POST로 한다 |
| Claude 상태 원천 | `claude agents --json` 폴링과 Notification 훅 | 훅만 사용 | 훅은 푸시 방식이고 Desktop 세션도 포함한다. HTTP 훅이라 프로세스를 띄우지 않는다 |
| 리드 깨우기 | 정해두지 않음 | `asyncRewake` 훅 | 백그라운드 잡이 끝나거나 결정을 요구하면 리드 세션이 쉬고 있어도 깨어난다. Channels는 연구 미리보기이고 플래그가 필요해서 쓰지 않았다 |

## 4. 미결 사항 중 정한 것

| 항목 | 결정 |
| --- | --- |
| 구현 언어 | TypeScript. Node.js 22.18 이상의 타입 제거 실행으로 바로 돌린다. 런타임 의존성과 빌드 단계가 없다 |
| MCP 구현 | 공식 SDK 없이 직접 구현했다. 필요한 범위가 수명 주기, 도구, 진행 알림, 취소뿐이다 |
| 이벤트 로그 | JSONL(`~/.crew/events.jsonl`). 잡 상태는 `~/.crew/jobs.json` |
| 상태 보드 형태 | 데몬이 서빙하는 로컬 웹 페이지. Claude Desktop의 브라우저 패널에 띄울 수 있다. 독립 앱은 아래 7절 |
| 정지 의심 시간 | 5분(`~/.crew/config.json`의 `stallSeconds`) |
| 리뷰 왕복 상한 | 기본 1회, 최대 2회. `/crew:run` 스킬에 규칙으로 적었다. 브리지가 강제하지는 않는다 |
| Codex 승인 정책 | 구현은 `on-request`, 리뷰는 `never`. 승인 요청을 누가 받는지는 아래 5.1절 |

## 5. 상태 표시와 중단 감지 (R5)

- 이벤트 형태는 02 문서의 제안에 `job_id`와 일련번호를 더한 `{seq, ts, agent, session_id, job_id, kind, detail}`이다. `kind`는 `started`, `progress`, `waiting`, `error`, `limit`, `stalled`, `done`, `cancelled`.
- 한도 소진: Codex는 턴 오류의 `codexErrorInfo`(`usageLimitExceeded`, `rateLimitExceeded`, `sessionBudgetExceeded`)로, Antigravity는 오류 문구로, Claude는 `StopFailure` 훅의 `error: rate_limit`으로 판정해 `limit` 이벤트를 낸다.
- 무응답: 실행 중인 잡이 5분간 아무 이벤트도 내지 않으면 `stalled`. Claude 세션은 도구 실행 중이 아닐 때만 같은 기준을 적용한다.
- `waiting`, `error`, `limit`, `stalled`는 macOS 알림으로도 나간다.
- Codex 사용량은 app-server의 `account/rateLimits/read`와 `account/rateLimits/updated`로 받아 보드와 `status`에 표시한다(03 문서 9절의 보완 경로). 배분 판단에는 아직 쓰지 않는다.

### 5.1 승인 요청과 질문

워커의 승인 요청과 질문은 리드가 아니라 사용자가 답한다.

- 리드가 그 잡을 기다리는 도구 호출(`delegate`, `wait` 등) 중이면, MCP 서버가 elicitation 요청을 보내 Claude 앱이 자체 입력 창을 띄운다. 사용자의 답은 리드를 거치지 않고 워커로 전달되고, 도구 호출은 끊기지 않고 이어진다.
- 백그라운드 잡이면 깨우기 훅이 리드를 깨우고, 리드가 `wait`를 부르면 그때 창이 뜬다.
- 같은 요청을 보드 버튼으로 먼저 답하면 앱의 창은 철회된다.
- 사용자가 창을 답 없이 닫으면 리드에게 대기 상태가 돌아간다. 리드는 대신 결정하지 않고 대화로 묻는다. elicitation을 지원하지 않는 클라이언트에서도 같은 경로로 간다.
- Antigravity는 묻지 않는다. 브리지의 역할 정책이 판정한다.

Codex 쪽 설정에 따라 요청이 아예 오지 않을 수 있다. `~/.codex/config.toml`의 `approvals_reviewer`가 `guardian_subagent`나 `auto_review`면 Codex의 자동 리뷰어가 승인 요청을 직접 처리한다. 브리지는 기본으로 이 설정을 따른다. 요청을 항상 사용자에게 받으려면 `~/.crew/config.json`에 `{"codex": {"approvalsReviewer": "user"}}`를 넣는다.

## 6. 데스크톱 앱 노출 (R6) 확인 결과

| 서비스 | 확인한 것 |
| --- | --- |
| Claude | 리드가 Desktop 세션이면 그대로 보인다. 플러그인은 Desktop의 로컬 세션에서 동작한다 |
| Codex | 브리지가 만든 스레드는 Codex 데스크톱 앱이 쓰는 것과 같은 저장소에 `Crew · <제목>` 이름으로 들어간다(`thread/list`로 확인, 앱이 만든 스레드와 `source` 값이 같다). 다만 ChatGPT 앱은 자기 전용 app-server를 stdio로 띄우므로 실행 중인 앱에 실시간으로 붙을 수는 없다. 목록 갱신 시점은 앱에 달려 있다(02 문서 6절의 이슈). CLI에서는 `codex resume <id>`로 이어받는다 |
| Antigravity | ACP 세션은 CLI 전용 저장소(`~/.gemini/antigravity-cli/`)에 `default-cli-project`로 저장된다. 앱 저장소(`~/.gemini/antigravity/`)에는 들어가지 않으므로 Antigravity 앱 목록에는 보이지 않는다. `agy --conversation <id>`로 CLI에서 이어받는다. 앱 안에서 대화를 만드는 `agentapi`는 사이드카 전용으로 문서화돼 있고 응답을 읽는 수단이 없어 쓰지 않았다 |

잡 결과와 보드 카드에 이어받기 명령을 함께 보여준다.

### Antigravity 정책 위험

공식 FAQ(https://antigravity.google/docs/faq/ )에 다음 문장이 있다.

- "Wrapping `agy` inside third-party coding agents or applications, or automating account rotation, is not supported under consumer plans."
- "Using third-party software, tools, or services to access Antigravity is a violation of our Terms of Service" / "Such actions can result in suspension or termination of your account."

브리지는 공식 `agy` 바이너리를, Google이 서드파티 클라이언트용으로 문서화한 ACP로만 실행하고 인증 정보는 건드리지 않는다. 그래도 Claude Code가 ACP 클라이언트를 통해 Antigravity를 부리는 구성이 위 문장의 범위에 드는지는 Google의 해석에 달려 있다. 꺼두려면 `~/.crew/config.json`에 `{"antigravity": {"enabled": false}}`를 넣는다.

## 7. 독립 상태 보드 앱

지금은 웹 보드 하나다. 독립 앱을 만든다면 Tauri보다 macOS 네이티브(SwiftUI 메뉴 막대 앱)를 먼저 권한다.

- 독립 앱이 웹 페이지보다 더 주는 것은 OS 통합(메뉴 막대 상태, 승인·거절 버튼이 달린 알림, 로그인 시 실행)이고, 이 부분은 네이티브가 낫다.
- 로직은 전부 데몬에 있다. 클라이언트는 `/api/state`, `/api/stream`(SSE), POST 몇 개만 쓰면 되므로 플랫폼별로 얇게 만들 수 있다.
- 웹 보드는 Claude Desktop 브라우저 패널용으로 계속 둔다.

## 8. 검증한 것 (2026-11-11)

실제 계정으로 임시 저장소에서 돌려 확인했다.

- `delegate`: worktree 생성, Codex 구현과 테스트 실행, 브리지 커밋, 보고까지 약 30초.
- `review`: adversarial과 standard 모두 판정과 근거를 반환.
- `polish`: Antigravity가 README와 주석만 고침. diff로 확인.
- 작업 공간 밖 편집: worktree 밖 파일을 고치라고 지시했을 때 브리지가 거절하고 파일이 그대로인 것을 확인.
- `.worktreeinclude`: `node_modules/`와 `.env`가 worktree로 복사되고 워커 커밋에는 들어가지 않는 것을 확인.
- 프로젝트 구분: 다른 프로젝트에서 부른 인자 없는 `wait`가 남의 잡을 가져가지 않는 것을 확인.
- 승인 대기: 승인 정책을 `untrusted`로 두고 `waiting` 전환, `reply` 승인·거절, 재개를 확인.
- 승인 창: elicitation에 응답하는 테스트 클라이언트로 승인, 거절, 닫기, 보드에서 먼저 답한 경우를 확인. Claude Code 2.1.321은 초기화 때 `elicitation: {form, url}`을 선언하고, 헤드리스 세션에서는 요청이 답 없이 닫혀 리드에게 돌아갔으며 리드는 사용자에게 되물었다.
- `cancel`과 `discard`: worktree와 브랜치 제거.
- 깨우기 훅: 백그라운드 잡 종료 시 종료 코드 2와 결과 출력. 이미 전달된 잡에는 조용히 종료.
- 훅: 실제 Claude Code 세션의 프롬프트 제출과 종료가 이벤트 로그에 기록됨.
- 요청 가드: 다른 Origin의 POST와 다른 Host 요청은 403.
- 단위 테스트 15개(`npm test`).
- 전체 파이프라인: 헤드리스 Claude Code 세션에서 `/crew:run`으로 작은 기능 하나를 일곱 단계로 완주했다. Codex가 테스트를 병렬로 작성했고, 셀프 리뷰 서브에이전트와 Codex 교차 리뷰가 통과했으며, Antigravity의 정리 결과 중 작업과 무관한 주석 변경은 리드가 반려했다. 세 레인이 보드에 동시에 표시됐다.
- Claude Desktop: 플러그인 설치 후 열려 있던 Desktop 세션에 `crew` 도구, 스킬, 서브에이전트가 로드됐다.

확인하지 못한 것:

- 대화형 세션에서 `asyncRewake`가 실제로 리드를 깨우는 동작(스크립트 단독 실행으로만 확인).
- Claude Desktop에서 승인 창이 실제로 어떻게 보이는지(프로토콜 왕복만 확인).
- Codex 데스크톱 앱 화면에 스레드가 나타나는 시점.
- Windows.

## 9. 다음 단계

1. AgentGauge 연동(03 문서 G1): `route`를 붙여 `/crew:run`의 고정 대체 규칙을 실측 기반 배분으로 바꾼다.
2. macOS 메뉴 막대 앱(7절).
3. Claude 사용량: statusline의 `rate_limits`를 데몬으로 보내 Claude 레인에 표시한다.

## 10. 번복 기록

- 2026-11-11: 코드 리뷰를 받고 다음을 바꿨다.
  - Antigravity 세션을 `accept-edits` 모드로 두던 것을 기본 모드로 되돌렸다. 실측해 보니 `accept-edits`에서는 작업 공간 밖 파일 편집이 권한 요청 없이 실행됐다. 모드 설명("Approve file edits in the workspace without asking")과 다른 동작이다. 지금은 편집마다 오는 권한 요청의 경로를 브리지가 확인한다.
  - worktree 위치를 저장소 안 `.crew/worktrees/`에서 저장소 밖 `~/.crew/worktrees/`로 옮겼다. 저장소 안에 두면 테스트 탐색, tsc, 린터, 파일 감시가 worktree 사본까지 읽는다. `info/exclude`를 건드릴 필요도 없어졌다.
  - worktree에 gitignore된 파일을 넣는 수단이 없던 것을 `.worktreeinclude` 복사로 채웠다. 8절의 초기 검증은 의존성이 없는 임시 저장소에서 했기 때문에 이 문제가 드러나지 않았다.
  - 잡에 소유 프로젝트를 기록하고, 인자 없는 `wait`와 `status` 목록을 그 기준으로 거른다. 전에는 다른 프로젝트 세션의 잡까지 기다리고 읽음 처리해서, 원래 세션의 깨우기 훅이 결과를 전달하지 못할 수 있었다.
  - 승인 요청의 주체를 리드에서 사용자로 바꿨다. 전에는 대기 상태가 리드에게 돌아가 리드가 안전하다고 보면 직접 승인할 수 있었다. 지금은 앱의 입력 창으로 사용자에게 묻는다(5.1절).
  - 데몬 교체 조건을 "버전이 다르면"에서 "호출한 쪽이 더 새 버전이고 실행 중인 잡이 없으면"으로 바꿨다. 버전이 다른 두 설치본이 서로의 데몬을 번갈아 내리는 일과, 교체 때문에 실행 중인 잡이 실패하는 일을 막는다. 참고로 로컬 경로 마켓플레이스의 플러그인은 캐시 복사본이 아니라 원본 폴더에서 실행된다(프로세스 경로로 확인).
