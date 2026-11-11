# Crew

Claude, Codex, Antigravity 세 에이전트에 역할을 나눠 협업시키는 Claude Code 플러그인이다. Claude가 리드와 셀프 리뷰를, Codex가 구현 보조와 교차 리뷰를, Antigravity가 UX 문구와 주석·문서 정리를 맡는다. 세 에이전트가 지금 무엇을 하는지는 상태 보드에서 실시간으로 본다.

## 시작하기

필요한 것: Node.js 22.18 이상, git, 로그인된 `claude`, `codex`, `agy` CLI.

```bash
node plugin/bridge/cli.ts install
```

```bash
crew doctor
```

`install`은 이 폴더를 Claude Code 마켓플레이스로 등록하고 `crew` 플러그인을 설치한 뒤 `crew` 명령을 `~/.local/bin`에 건다. 설치 후 Claude Code 세션을 새로 열면(Desktop 포함) 적용된다.

## 쓰는 법

Claude Code 세션에서:

| 입력 | 동작 |
| --- | --- |
| `/crew:run <작업>` | 계획, 병렬 구현, 셀프 리뷰, 교차 리뷰, 수정, 문구 정리, 최종 확인을 순서대로 진행 |
| `/crew:board` | 상태 보드 열기. Desktop에서는 브라우저 패널에 뜬다 |
| "이 부분은 Codex한테 맡겨줘", "Codex 리뷰 받아줘" 같은 평소 말 | 리드가 `delegate`, `review`, `polish` 도구를 직접 호출 |

터미널에서:

```bash
crew status
```

```bash
crew board
```

상태 보드 주소는 http://127.0.0.1:47615 이다. 승인 대기 중인 잡은 보드에서 바로 승인하거나 거절할 수 있다.

## 동작 방식

- 구현과 문구 정리 잡은 각각 전용 git worktree와 `crew/<잡 id>` 브랜치에서 돈다. 리드가 diff를 보고 병합하기 전에는 작업 브랜치에 아무것도 들어오지 않는다.
- Codex는 `codex app-server`로, Antigravity는 `agy acp`로 실행한다. 공식 바이너리만 실행하고 인증 정보는 읽지 않는다.
- 백그라운드로 맡긴 잡이 끝나거나 결정을 요구하면 리드 세션이 자동으로 깨어난다.
- 설정은 `~/.crew/config.json`에 둔다(무응답 판정 시간, 알림, Codex 승인 정책, Antigravity 사용 여부).

Antigravity 연동에는 약관상 위험이 있다. 쓰기 전에 [docs/04-implementation.md](docs/04-implementation.md) 6절을 읽는다.

## 폴더

| 경로 | 내용 |
| --- | --- |
| `plugin/bridge/` | 데몬, MCP 서버, 에이전트 어댑터, CLI (TypeScript, 빌드 없음) |
| `plugin/board/` | 상태 보드 (정적 HTML/CSS/JS) |
| `plugin/roles/` | Codex와 Antigravity에 매 잡마다 주입하는 역할 지침 |
| `plugin/skills/`, `plugin/agents/`, `plugin/hooks/` | `/crew:run`, `/crew:board`, 셀프 리뷰 서브에이전트, 훅 |
| `test/` | 단위 테스트 (`npm test`) |

## 문서

| 문서 | 내용 |
| --- | --- |
| [docs/01-requirements.md](docs/01-requirements.md) | 최초 요구사항 원문, 요구사항 번호(R1-R8), 요구 간 충돌과 해석, 충족 기준 |
| [docs/02-implementation-plan.md](docs/02-implementation-plan.md) | 구성 결정, 연결 방식, 역할과 작업 순서, 상태 표시, 배제한 대안, 위험, 구축 단계 |
| [docs/03-agentgauge-integration.md](docs/03-agentgauge-integration.md) | AgentGauge 현황, 연동에 빠진 것, 단계별 연동 계획, MCP 도구 명세, 배분 정책 |
| [docs/04-implementation.md](docs/04-implementation.md) | 구현된 구성, 계획에서 달라진 점과 이유, 데스크톱 앱 노출 확인 결과, 검증 내역 |

## 현재 단계

브리지(Phase 1)와 상태 보드(Phase 2)가 구현돼 있다. AgentGauge 연동(Phase 3)은 아직이다.

## 문서를 고칠 때

- 외부 도구에 관한 사실에는 확인 날짜를 붙인다. 세 서비스 모두 프로토콜과 정책이 몇 달 단위로 바뀌었으므로, 구현 전에 02 문서 말미의 확인 근거를 다시 확인한다.
- 결정을 뒤집으면 지우지 말고 해당 문서의 번복 기록에 사유와 날짜를 남긴다.
