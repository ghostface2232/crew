# 02. 구현 계획

작성일 2026-11-11. 요구사항 번호(R1-R8)는 [01-requirements.md](01-requirements.md)를 따른다. 외부 도구에 관한 사실은 모두 2026-11-11에 확인한 것이며 근거는 12절에 있다.

## 1. 결정 요약

1. 조종석은 Claude Code Desktop이다. 리드 세션은 대화형 Desktop 세션으로 돌린다.
2. Codex와 Antigravity는 각자의 공식 런타임으로 뒤에서 돌린다. Codex는 `codex app-server`, Antigravity는 `agy acp` 또는 `agy -p`.
3. 두 워커의 호출과 이벤트는 Crew 브리지(로컬 MCP 서버) 하나로 모은다. Anthropic 문서가 Claude Code의 병렬 기능에서 워커는 전부 Claude 세션이고 다른 도구는 MCP 서버로 붙이라고 안내하는 것과 같은 방향이다.
4. 세션 상태는 브리지가 먹이는 얇은 상태 보드에 표시한다. 사용량 실측과 배분 판단은 AgentGauge가 맡는다([03-agentgauge-integration.md](03-agentgauge-integration.md)).
5. 프론트 전체를 감싸는 자체 래퍼는 만들지 않는다(8절).

## 2. 구성

```
사용자
  │
Claude Code Desktop ── 리드, 셀프 리뷰 (대화형 세션)
  │ MCP
Crew 브리지 ───── 이벤트 ────▶ 상태 보드 (세 레인)
  │   ▲
  │   └──── 사용량, 배분 판단 ── AgentGauge (03 문서)
  │
  ├─ codex app-server ── Codex: 구현 보조, 리뷰
  └─ agy acp / agy -p ── Antigravity: UX 문구, 주석·문서 정리
```

## 3. 구성 요소별 연결 방식

### 3.1 Claude (리드)

- Claude Code Desktop의 로컬 세션을 그대로 쓴다. 서브에이전트, 세션 간 메시지, Remote Control, computer use, 브라우저 패널, Claude in Chrome, side chat(`/btw`), MCP, compact가 전부 이 세션에서 동작한다.
- 셀프 리뷰는 작업 맥락을 공유하지 않는 리뷰 전용 서브에이전트에게 맡긴다. 같은 맥락에서 자기 diff를 다시 읽는 것은 리뷰로 치지 않는다.
- 백그라운드 세션을 띄울 때는 `claude --bg`를 쓰고, 상태는 `claude agents --json`으로 읽는다. `$HOME/.claude/jobs/` 아래 파일은 안정된 인터페이스가 아니라고 문서에 적혀 있으므로 직접 읽지 않는다.

### 3.2 Codex (보조 엔지니어, 리뷰어)

- Phase 0에서는 OpenAI 공식 플러그인 `openai/codex-plugin-cc`를 쓴다.

  | 명령 | 용도 |
  | --- | --- |
  | `/codex:rescue` | 구현 조각 위임. `--background`, `--resume`, `--model`, `--effort` 지원 |
  | `/codex:adversarial-review` | 설계 판단과 가정을 따지는 리뷰. 초점 문구를 줄 수 있음 |
  | `/codex:review` | 미커밋 변경 또는 브랜치(`--base`)의 읽기 전용 리뷰 |
  | `/codex:status`, `/codex:result`, `/codex:cancel` | 백그라운드 작업 관리 |
  | `/codex:transfer` | 현재 Claude 세션을 Codex 스레드로 넘김. `codex resume <id>` 출력 |

- 플러그인은 전역 `codex` 바이너리와 app-server를 감싸며 `$HOME/.codex/config.toml`과 프로젝트의 `.codex/config.toml`을 그대로 적용한다.
- 리뷰 게이트(Stop 훅 방식의 자동 리뷰)는 켜지 않는다. Claude와 Codex가 루프를 돌며 한도를 빠르게 소진할 수 있다는 경고가 README에 있다. 리뷰는 리드가 단계마다 명시적으로 호출한다.
- Phase 1부터는 브리지가 `codex app-server`를 직접 붙잡는다. app-server는 스레드 상태를 소유하고 에이전트 이벤트를 스트리밍하며 승인 요청을 양방향으로 주고받는 JSON-RPC 2.0 프로세스다. `codex mcp-server`는 2026-08-24에 폐기 예고됐고 현재 CLI 레퍼런스에는 제거됐다고 적혀 있으므로 쓰지 않는다.

### 3.3 Antigravity (UX 문구, 주석·문서 정리)

- 단발 작업은 `agy -p "<지시>" --output-format stream-json`으로 돌린다. 스트리밍 JSON에 도구 호출이 전부 기록된다.
- 세션을 유지하며 지시를 이어가야 하면 `agy acp`(CLI 1.5.0에서 추가된 공식 ACP 서버, stdio)를 쓴다. ACP 모드에서도 에이전트, 도구, 설정은 CLI 것 그대로다.
- 역할 제한은 `--agent`로 지정하는 커스텀 에이전트와 `--mode`로 건다. 인증은 대화형 `agy` 세션에서 한 번 로그인해 둔 캐시를 쓴다.
- MCP 서버 등록 위치는 `.agents/mcp_config.json` 또는 `$HOME/.gemini/config/mcp_config.json`이다.

### 3.4 Crew 브리지

로컬 MCP 서버 하나다. 리드가 호출하는 도구는 다음 다섯 개로 시작한다.

| 도구 | 동작 |
| --- | --- |
| `delegate` | Codex에 구현 조각을 맡긴다. worktree 경로와 완료 조건을 함께 넘긴다 |
| `review` | Codex에 리뷰를 맡긴다. 대상 diff와 초점을 넘긴다 |
| `polish` | Antigravity에 문구·주석·문서 정리를 맡긴다. 대상 파일 목록을 넘긴다 |
| `status` | 진행 중인 위임의 상태를 돌려준다 |
| `cancel` | 위임을 취소한다 |

- 브리지는 app-server 프로세스와 agy 세션을 붙잡고, 받은 이벤트를 전부 로컬 이벤트 로그(JSONL 또는 SQLite)에 쓰고 WebSocket으로 내보낸다.
- 이벤트 한 건의 형태(제안): `{ts, agent, session_id, kind, detail}`. `kind`는 `started`, `progress`, `waiting`, `error`, `limit`, `done`.
- 브리지는 `codex`와 `agy` 공식 바이너리만 실행한다. 각 서비스의 인증 파일과 토큰은 읽지 않는다.

## 4. 역할과 작업 순서

| 에이전트 | 맡는 일 | 맡지 않는 일 |
| --- | --- | --- |
| Claude | 계획, 주 구현, 셀프 리뷰, 병합 판단, 배분 호출 | |
| Codex | 분리 가능한 구현 조각(별도 worktree), 구현 후 adversarial review | 병합, 계획 변경 |
| Antigravity | UI 문자열, 주석, 문서 파일의 가독성 정리 | 로직 변경, 구조 변경 |

작업 순서:

1. 계획 (Claude)
2. 구현 (Claude와 Codex 병렬, 조각마다 worktree 분리)
3. 셀프 리뷰 (Claude의 리뷰 전용 서브에이전트)
4. 교차 리뷰 (Codex adversarial review)
5. 수정 (Claude)
6. 문구·주석·문서 정리 (Antigravity, 별도 worktree에서 diff로 제출)
7. 최종 확인과 병합 (Claude). Antigravity의 diff가 범위를 벗어나면 반려한다

역할 규칙을 적는 곳:

- `CLAUDE.md`: 작업 순서, 단계 경계에서 `route`를 호출한다는 규칙, 반려 기준
- `AGENTS.md`: Codex의 역할과 금지 사항, 결과 보고 형식
- Antigravity 커스텀 에이전트 정의: 손댈 수 있는 파일 종류, 금지 사항

## 5. 상태 표시와 중단 감지 (R5)

데이터 원천:

| 에이전트 | 원천 | 얻는 것 |
| --- | --- | --- |
| Claude | `claude agents --json` | 세션별 `state`(`working`, `blocked`, `done`, `failed`, `stopped`), `status`(`busy`, `waiting`, `idle`), `waitingFor` |
| Claude | Notification 훅 | `agent_needs_input`, `agent_completed` |
| Codex | app-server 이벤트 스트림 | 스레드 상태, 도구 호출, 승인 요청 |
| Antigravity | 스트리밍 JSON 또는 ACP 세션 업데이트 | 도구 호출, 메시지 조각 |

중단 감지 규칙:

- agent view의 상태는 Working, Needs input, Idle, Completed, Failed, Stopped 여섯 가지이고 사용량 한도 상태가 따로 없다. 한도 소진은 Failed나 무응답으로 나타나므로, 브리지가 오류 문구를 분류해 `limit` 이벤트로 바꾼다.
- 마지막 이벤트 이후 일정 시간(초기값 5분, 조정 대상) 무응답이면 정지 의심으로 표시하고 알린다.
- 한도에 관한 실측값은 AgentGauge에서 받는다(03 문서).

상태 보드:

- 레인 세 개에 현재 단계, 마지막 이벤트, 대기 사유, 경과 시간을 보여준다. 조작은 취소와 재개만 둔다.
- 형태는 Tauri v2 + React 트레이 앱을 1안으로 둔다(Noten과 같은 스택). 로컬 웹 페이지로 시작해도 된다.
- AgentGauge 팝오버에 합치지 않는다(03 문서 10절).

## 6. 데스크톱 앱 노출 (R6)

| 서비스 | 현황 |
| --- | --- |
| Claude | 리드가 Desktop 세션이라 그대로 보인다. Remote Control을 켜면 모바일 앱과 claude.ai/code에도 나타난다(Desktop 세션의 Remote Control 지원은 2026-08-17 메인테이너 코멘트로 확인) |
| Codex | 플러그인이 돌린 작업은 `codex resume`으로 이어받을 수 있다. ChatGPT 데스크톱 앱 노출은 불안정하다. CLI로 만든 세션이 앱 재시작 후에야 보이거나(openai/codex #56089), Codex 대신 ChatGPT 목록에 섞이는(#33910) 이슈가 열려 있다 |
| Antigravity | 터미널에서 시작한 대화는 Antigravity 2.0 앱에서 열린다(2차 자료 기준). `agy acp`로 만든 세션도 같은지는 확인하지 못했다 |

## 7. 기능 범위 (R4)

- 리드: Desktop 세션이므로 R4에 열거된 기능 전부.
- Codex: 자기 설정의 MCP, 서브에이전트, 컴팩션이 app-server 아래에서 그대로 동작한다.
- Antigravity: CLI 설정의 도구와 MCP가 그대로 동작한다. Remote Control(2026-08-21 출시)로 CLI 세션을 다른 기기 브라우저에서 열 수 있다.
- 한계: Antigravity 앱의 내장 브라우저 같은 워커 쪽 데스크톱 전용 기능은 백그라운드 실행에서 쓰지 못한다.
- 미확인: Codex 쪽 리모트 컨트롤에 해당하는 기능의 현재 상태는 조사하지 않았다.

## 8. 배제한 대안

### 8.1 프론트 전체를 감싸는 자체 래퍼

Tauri 앱이 Claude Agent SDK, Codex app-server, `agy acp`를 직접 말하는 방식이다. 세 에이전트의 이벤트를 가장 고르게 받을 수 있지만 다음 이유로 배제했다.

- side chat, computer use, 내장 브라우저 패널은 Claude Desktop 앱의 기능이라 SDK 세션에는 없다. R4를 잃는다.
- 프로토콜이 자주 바뀐다. `codex mcp-server` 폐기가 그 예이고, app-server는 CLI 레퍼런스에 실험 단계로 표시돼 있다.
- Agent SDK와 `claude -p` 과금 분리가 2026-06-15로 예고됐다가 보류됐다. 지금은 플랜 로그인 상태면 구독 한도에서 차감되지만 다시 바뀔 수 있다. 리드가 대화형 세션이면 영향이 없다.
- Google이 2026년 2월에 서드파티 에이전트를 연결한 사용자를 차단한 전례가 있다. 래퍼가 인증을 다루기 시작하면 같은 위험에 들어간다.

### 8.2 기존 멀티 에이전트 워크벤치 (Orca 등)

Orca(stablyai/orca)는 MIT 라이선스 오픈소스로, 각 CLI 에이전트를 자기 구독으로 별도 worktree에서 병렬 실행하고 Claude와 Codex의 사용량과 리셋 시점을 추적한다. Antigravity도 지원 목록에 있다. 다음 이유로 주 구성에서는 배제했다.

- 에이전트를 터미널로 띄우는 방식이라 R1에 못 미친다.
- 오케스트레이션 계층이 실험 기능이고, 역할 고정 파이프라인(R3)은 직접 구성해야 한다.
- 사용량 추적에 Antigravity가 포함된다는 근거를 찾지 못했다.

worktree 운용과 사용량 표시 방식은 참고할 만하다. ACP 기반 클라이언트(Codeg, Jockey, acp-ui 등)도 같은 이유로 참고 대상에 둔다.

## 9. 위험과 제약

| 위험 | 대응 |
| --- | --- |
| 프로토콜 변경(app-server 실험 단계, ACP 버전 변동) | 브리지의 어댑터를 서비스별로 분리한다. Phase 0은 공식 플러그인에만 의존한다 |
| 과금 정책 재변경 | 리드를 대화형 세션으로 유지한다. `claude -p`와 Agent SDK에 의존하는 경로를 만들지 않는다 |
| 계정 제재 | 공식 바이너리만 실행하고 토큰을 다루지 않는다 |
| 리뷰 루프로 인한 한도 소진 | 리뷰 게이트를 끄고, 리뷰 왕복 횟수에 상한을 둔다 |
| 워커가 범위를 벗어난 변경을 함 | worktree 분리, diff 제출, 리드 반려 |
| 재위임 순환(A가 B에게, B가 다시 A에게) | 배분 판단은 리드 한 곳에서만 한다. 워커는 사용량을 보고만 한다 |
| 한도가 바닥난 리드는 재배분을 못 함 | 감시 주체를 리드 밖(AgentGauge 임계 이벤트)에 둔다 |

## 10. 구축 단계

| 단계 | 내용 | 완료 기준 |
| --- | --- | --- |
| Phase 0 | `codex-plugin-cc` 설치, 역할 파일 3종 작성, `agy -p` 호출을 Claude Code 스킬로 감싸기, worktree 규칙 정리. 새 코드 거의 없음 | 작은 기능 하나를 4절의 일곱 단계로 한 번 완주 |
| Phase 1 | Crew 브리지 MCP(도구 다섯 개)와 이벤트 로그. Codex와 Antigravity 호출을 브리지로 이관 | 리드가 브리지 도구만으로 위임, 리뷰, 정리를 수행. 이벤트 로그에 세 에이전트의 이벤트가 쌓임 |
| Phase 2 | 상태 보드. 정지 의심과 `limit` 이벤트 알림 | 워커를 강제로 멈췄을 때 정해진 시간 안에 알림이 옴 |
| Phase 3 | AgentGauge 연동(03 문서의 G1-G3). G1은 앱을 고치지 않으므로 Phase 1과 병행할 수 있다 | 리드가 `route` 결과대로 위임. 리드 소진 전 인계가 한 번 재현됨 |

## 11. 미결 사항

- 실행 기기: MacBook과 Windows 데스크톱 중 어디서 돌릴지. AgentGauge는 양쪽 모두 지원하므로 제약은 없다.
- 상태 보드의 형태: Tauri 트레이 앱과 로컬 웹 페이지 중 선택.
- 브리지 구현 언어와 이벤트 로그 저장소(JSONL과 SQLite 중 선택).
- 정지 의심 시간, 리뷰 왕복 상한의 값.
- `agy acp` 세션의 Antigravity 앱 노출 여부(확인 필요).
- Codex 데스크톱 앱 노출 이슈의 진행 상황(확인 필요).

## 12. 확인 근거 (2026-11-11)

공식 문서와 저장소:

- Claude Code 병렬 실행 개요: https://code.claude.com/docs/en/agents
- agent view(상태, `--bg`, `claude agents --json`, 알림): https://code.claude.com/docs/en/agent-view
- Claude Desktop(side chat, computer use, 브라우저 패널, Dispatch): https://code.claude.com/docs/en/desktop
- Desktop 세션 Remote Control 지원: https://github.com/anthropics/claude-code/issues/29006
- Agent SDK와 플랜 과금: https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
- Codex 플러그인: https://github.com/openai/codex-plugin-cc
- Codex CLI 레퍼런스(`app-server`, `exec`, `mcp-server` 제거): https://developers.openai.com/codex/cli/reference
- Codex app-server: https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- Codex 데스크톱 노출 이슈: https://github.com/openai/codex/issues/56089 , https://github.com/openai/codex/issues/33910
- Antigravity 헤드리스 모드: https://antigravity.google/docs/cli/headless/
- Antigravity ACP: https://antigravity.google/docs/ide/extensions/acp/
- Antigravity Remote Control: https://antigravity.google/docs/remote-control/
- Antigravity 변경 이력: https://antigravity.google/docs/changelog/
- Orca: https://github.com/stablyai/orca
- ACP 클라이언트 목록: https://agentclientprotocol.com/get-started/clients

2차 자료에만 근거한 항목(구현 전 1차 자료로 재확인):

- `codex mcp-server` 폐기 예고 날짜(2026-08-24)
- Antigravity CLI 대화가 Antigravity 2.0 앱에서 열린다는 점
- Google의 2026년 2월 서드파티 에이전트 차단(Wikipedia 기재)
- Orca의 사용량 추적 범위와 오케스트레이션 계층의 실험 단계 표기

## 13. 번복 기록

- 2026-11-11: 구현하면서 다음을 바꿨다. 사유와 세부는 [04-implementation.md](04-implementation.md) 3절에 있다.
  - Antigravity 연결에서 `agy -p`를 뺐다. 공식 FAQ가 서드파티 코딩 에이전트 안에서 `agy -p`를 감싸 쓰는 것을 소비자 플랜에서 지원하지 않는다고 적고 있어서, ACP(`agy acp`)만 쓴다.
  - Phase 0(공식 플러그인으로 먼저 완주)을 건너뛰고 Phase 1로 바로 갔다.
  - 역할 파일을 프로젝트의 `CLAUDE.md`, `AGENTS.md`, 커스텀 에이전트 대신 플러그인 안에 두고 잡마다 주입한다.
  - 이벤트 전송을 WebSocket 대신 SSE로, Claude 상태 원천을 `claude agents --json` 폴링 대신 훅으로 했다.
  - 브리지 도구에 `wait`와 `reply`를 더했다.
- 2026-11-11: 상태 보드를 AgentGauge 팝오버에 합치는 안을 냈다가 철회했다. AgentGauge 레포의 기록된 방향(폭보다 깊이, 에이전트 프로세스 스캔 거절)과 맞지 않는다. 상태 보드는 브리지 쪽 별도 표시로 되돌렸다.
