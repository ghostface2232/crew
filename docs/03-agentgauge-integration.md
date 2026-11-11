# 03. AgentGauge 연동 계획

작성일 2026-11-11. 요구사항 R8([01-requirements.md](01-requirements.md))을 다룬다. AgentGauge 현황은 `ghostface2232/AgentGauge` main 브랜치 커밋 `a52141f`(2026-11-11)의 코드와 문서를 읽어 확인했다. 빌드와 테스트 실행은 하지 않았다.

## 1. 목적

에이전트가 자신과 다른 서비스의 남은 한도를 확인하고, 그 결과에 따라 작업을 배분한다. 모두 여유 있으면 원래 역할([02-implementation-plan.md](02-implementation-plan.md) 4절)대로 간다. AgentGauge는 이 구성에서 두 가지를 맡는다.

- 사용량 실측: 02 문서 5절에서 오류 문구로 추정하던 한도 소진을 실측값으로 대체한다.
- 배분 판단: 고정 정책 함수(`route`)의 입력을 제공한다.

세션 상태 표시(누가 지금 무엇을 하는지)는 맡지 않는다.

## 2. AgentGauge 현황

| 항목 | 상태 |
| --- | --- |
| 버전 | 0.7.7 태그(2026-11-10). 이후 PR #53(주간 막대의 일별 분해), #54(수동 새로고침 수정)가 main에 병합됨 |
| 플랫폼 | Windows(WinUI 3, .NET 10)와 macOS(SwiftUI, macOS 14 이상)가 같은 버전으로 출시됨 |
| provider | Claude, Codex, Antigravity, GitHub Copilot은 양쪽 지원. Cursor는 macOS 전용 |
| Claude | 5시간, 주간, 모델별 주간 한도(Fable 등)를 읽음 |
| Codex | 5시간, 주간, 이름 붙은 추가 한도, 리셋 크레딧 잔량을 읽음 |
| Antigravity | 실행 중인 엔진에 붙거나(attach) 엔진을 잠깐 띄워(delegate) Gemini와 Claude/GPT 버킷을 읽음 |
| 다중 계정 | Claude, Codex, Copilot에서 계정별 카드와 히스토리 분리 |
| 규모 | Windows 앱 약 18,600줄에 테스트 메서드 649개, macOS 약 12,200줄에 테스트 메서드 346개(소스에서 센 값) |
| 외부 표면 | 없음. CLI JSON 출력, IPC, HTTP, MCP 모두 없음 |

## 3. 연동에 쓸 수 있는 기존 자산

### 3.1 정규화된 스냅샷

모든 provider가 하나의 `UsageSnapshot`으로 정규화된다. 도구 하나의 한 시점이며 다음을 담는다.

- 스냅샷: 도구 이름, 플랜, 창 목록, 리셋 크레딧, 측정 시각(`CapturedAt`)
- 창(`UsageWindow`): 종류(5시간, 주간, 결제 주기), 안정 식별자(`Id`), 그룹(`GroupLabel`, 모델이나 계열), 사용 비율(`UsedRatio`, 0-1), 리셋 시각, 기간, 선택적 토큰 수

### 3.2 디스크에 남는 파일

| 파일 | Windows | macOS | 비고 |
| --- | --- | --- | --- |
| 마지막 스냅샷 캐시 | `%APPDATA%\Gauge\usage-cache.json` | `$HOME/Library/Application Support/AgentGauge/usage-cache.json` | 두 플랫폼의 문서 형태가 다르다. Windows는 버전 4에 `Tools` 배열, macOS는 버전 1에 `snapshots` 배열 |
| 히스토리 | `%APPDATA%\Gauge\usage-history.db` | `$HOME/Library/Application Support/AgentGauge/usage-history.db` | SQLite WAL, 90일 보관. `samples` 테이블 정의가 양쪽 동일 |

`samples` 테이블 열: `tool`, `window_key`, `group_label`, `captured_at`, `used_ratio`, `reset_time`, `used_tokens`, `limit_tokens`, `reset_credits`, `reset_credit_expiry`. 실측으로 갱신된 읽기만 기록되며 토큰이나 인증 정보는 들어가지 않는다.

### 3.3 이미 구현된 계산

- 소진 예상 시각(`UsageEtaClassifier`): 최근 약 90분의 표본으로 최소제곱 기울기를 구한다. 실측 3회 이상이 30분 이상에 걸쳐 있고, 기울기가 양수이며, 예상 소진이 리셋 전일 때만 값을 낸다. macOS는 `GaugeCore`의 `projectExhaustion(samples:now:)`로 공개돼 있고, Windows는 `ViewModels` 아래에 있다.
- 주기 경계 판정(`UsageCycleBoundary`), 페이스 모델, 임계 알림 평가기(`UsageNotificationEvaluator`, 70%와 90%. 5시간 창은 90%에서만 알림).

### 3.4 갱신 주기

- 기본 주기(양쪽 플랫폼 동일): Codex 3분, Claude 5분, Antigravity 10분, Copilot 15분. macOS의 Cursor는 5분.
- 적응형 배율: 마지막 팝오버 열기 이후 5분 이내는 기본, 1시간 이내는 2배, 4시간 미만은 4배, 그 이상이거나 절전 또는 화면 잠금이면 10배. 상한 30분.
- Claude 엔드포인트는 짧은 시간에 약 3회 읽으면 429를 돌려주므로 5분 최소 간격이 걸려 있고, 수동 새로고침으로도 뚫리지 않는다.
- Antigravity는 팝오버 열기로 인한 읽기에 2분 하한이 있다(엔진을 띄우는 비용 때문).

## 4. 연동에 빠진 것

1. 외부 표면이 없다. 두 번째 인스턴스는 조용히 종료되고, 명령행 플래그는 데모와 업데이트용뿐이다.
2. Windows는 단일 WinExe 프로젝트라 UI와 분리된 Core가 없다. macOS는 `GaugeCore`가 Foundation 전용 라이브러리로 나뉘어 있어 실행 타깃 하나만 추가하면 된다.
3. 임계 알림이 시스템 토스트로만 나간다. 밖으로 내보내는 이벤트가 없어서 리드 소진 전 인계를 촉발할 수단이 없다.
4. 적응형 갱신이 이 용도와 반대로 움직인다. 사용자가 자리를 비워 팝오버를 열지 않는 동안 에이전트가 가장 빠르게 한도를 쓰는데, 그때 주기가 가장 길어진다.
5. 캐시 파일 형식이 플랫폼마다 다르고 내부용이다. 외부 소비자를 위한 계약이 없다.

## 5. AgentGauge 레포의 기존 결정과의 정합

연동안은 레포에 기록된 다음 결정을 따른다.

| 기록된 결정 | 출처 | 연동안에 주는 제약 |
| --- | --- | --- |
| `Gauge.Core` 분리와 제네릭 스키마의 `--json` 단발 출력은 P2·L 규모의 미반영 항목. 서버(`serve`)는 과하다 | `doc/codexbar-reference.md` 3.10절, 4절 I | 상주 HTTP 서버를 앱에 넣지 않는다. `--json`과 그 위의 stdio MCP로 간다 |
| 처음부터 제네릭 스키마로 시작한다(provider 전용 키를 나중에 깨지 않도록) | 같은 문서 3.10절 | `get_usage` 응답을 provider 전용 키 없이 설계한다 |
| 에이전트 인지형 로컬 프로세스 스캔은 하지 않는다 | 같은 문서 5절, `AGENTS.md`의 적응형 갱신 항목 | 세션 상태를 AgentGauge가 스스로 탐지하지 않는다. 소비자가 밀어 넣는 신호만 받는다 |
| provider 수보다 깊이 | 같은 문서 5절 | AgentGauge의 범위를 사용량과 배분 판단으로 한정한다 |
| 인증 정보는 CLI 소유이며 AgentGauge는 읽기만 한다. 개발자 서버 없음 | `AGENTS.md`, `PRIVACY.md` | MCP 표면은 스냅샷만 내보낸다. 토큰은 어떤 경로로도 노출하지 않는다 |
| 데이터 수집과 UI의 분리. UI는 `UsageSnapshot`에만 의존 | `AGENTS.md` 핵심 규칙 | MCP 표면도 `UsageSnapshot`의 또 다른 소비자로 붙인다 |

## 6. 단계별 연동 계획

### G1. 앱을 고치지 않는 읽기 전용 MCP 서버

- 캐시 파일과 히스토리 DB를 읽기만 하는 stdio MCP 서버를 Crew 쪽에 둔다.
- 토큰 접근과 네트워크 리스너가 없다. 히스토리 DB는 읽기 전용으로 연다.
- 캐시 형식이 플랫폼마다 다르므로 플랫폼별 어댑터 두 개를 두고, 버전 필드가 모르는 값이면 `unknown`으로 응답한다.
- 소진 예상은 `samples` 테이블에서 3.3절과 같은 조건으로 다시 계산한다.
- 한계: 캐시 형식이 바뀌면 깨진다. 갱신 주기를 당길 수 없으므로 스냅샷이 최대 30분 낡을 수 있다.
- 완료 기준: 리드 세션에서 `get_usage`와 `route`를 호출해 세 서비스의 값을 받는다.

### G2. `--json` 출력 (AgentGauge 레포 작업)

- `doc/codexbar-reference.md` 4절의 I 항목을 실행한다. 제네릭 스키마의 단발 `--json` 출력을 만든다.
- macOS부터 한다. `GaugeCore`에 실행 타깃을 추가하는 것으로 끝난다. Windows는 Core 분리가 먼저다.
- 다중 계정이 있으므로 출력은 계정별 항목을 담는다.
- G1의 MCP 서버가 파일 대신 이 출력을 읽도록 바꾼다. 이 시점부터 캐시 형식 변경에 영향받지 않는다.
- 완료 기준: 같은 MCP 도구가 `--json`을 원천으로 동작하고, 캐시 파일 직접 읽기를 제거한다.

### G3. 신선도와 이벤트

- 소비자 활동 신호: MCP 호출을 팝오버 열기와 같은 상호작용으로 계산해 적응형 배율이 올라가지 않게 한다. 프로세스 스캔 없이 소비자가 직접 알리는 방식이라 5절의 제약과 맞는다.
- 임계 훅: 창이 임계를 넘을 때 지정된 외부 명령을 실행하거나 이벤트 파일에 한 줄을 쓴다. 리드 소진 전 인계가 이 훅에서 시작된다.
- 한도 보고 수신: 워커나 브리지가 한도 오류를 만난 즉시 `report_limit`으로 알리면, 다음 폴링을 기다리지 않고 해당 서비스를 소진 상태로 표시한다.
- 완료 기준: 리드의 5시간 창이 임계를 넘었을 때 인계가 자동으로 시작되는 것을 한 번 재현한다.

## 7. MCP 도구 명세 (제안)

도구는 세 개로 한정한다. 도구 정의가 각 에이전트의 컨텍스트를 차지하기 때문이다.

### 7.1 `get_usage`

입력 없음. 서비스와 계정별로 창 목록을 돌려준다. 아래 값은 형태를 보이기 위한 예시다.

```json
{
  "generated_at": "2026-11-11T13:20:00Z",
  "providers": [
    {
      "tool": "Claude",
      "account": "default",
      "plan": "Max 5x",
      "captured_at": "2026-11-11T13:17:40Z",
      "snapshot_age_sec": 140,
      "status": "ok",
      "windows": [
        {
          "key": "FiveHour",
          "group": null,
          "used_ratio": 0.42,
          "reset_time": "2026-11-11T15:00:00Z",
          "duration_sec": 18000,
          "projected_exhaustion": null
        }
      ]
    }
  ]
}
```

- `status`: `ok`, `tight`, `exhausted`, `stale`, `unknown`.
- 호출마다 provider를 새로 조회하지 않는다. 캐시된 스냅샷에 측정 시각을 붙여 돌려주고, AgentGauge의 폴링 제한은 그대로 둔다.

### 7.2 `route`

입력은 `task_kind`(`lead`, `implement`, `review`, `copy_polish`). 담당자, 근거, 차선책, 품질 저하 여부를 돌려준다.

```json
{
  "assignee": "codex",
  "reason": "all providers ok; default role",
  "fallback": ["claude"],
  "degraded": false,
  "defer_until": null
}
```

- 리드가 단계 경계에서만 호출한다. 매 턴 호출하지 않는다.
- 워커는 호출하지 않는다. 재위임 순환을 막기 위해서다.

### 7.3 `report_limit`

입력은 `tool`, `account`, `detail`(오류 문구), `observed_at`. 브리지나 워커가 한도 오류를 만난 즉시 호출한다. G1에서는 MCP 서버의 메모리에만 반영하고, G3에서 AgentGauge에 전달한다.

## 8. 배분 정책

### 8.1 판정 규칙

- 잔량 퍼센트만으로 판정하지 않는다. 소진 예상 시각이 리셋 시각보다 앞서면 `tight`, 잔량이 0에 닿았거나 `report_limit`이 들어오면 `exhausted`로 본다. 잔량 10%라도 20분 뒤 리셋이면 여유이고, 40%라도 리셋까지 나흘 남았으면 부족이다.
- 소진 예상을 낼 수 없을 때(표본 부족)는 잔량 임계로 대신한다. 전환 기준과 복귀 기준을 다르게 둬서 배분이 오락가락하지 않게 한다. 초기값은 잔량 15%에서 넘기고 30%에서 되돌리는 것이며 조정 대상이다.
- 한 서비스에 창이 여러 개면 가장 빠듯한 창을 따른다. 모델별 창(Fable 등)은 그 모델을 쓰는 작업에만 적용한다.
- 스냅샷이 오래됐으면 `stale`로 표시하고 원래 역할대로 배분하되, `report_limit`에 의존한다.

### 8.2 배분표

| 상태 | 배분 |
| --- | --- |
| 전부 여유 | 원래 역할대로 |
| Codex 부족 | 구현 조각은 Claude 서브에이전트가 맡는다. 남은 Codex 한도는 리뷰에만 쓴다 |
| Codex 소진 | 리뷰를 Claude의 리뷰 전용 서브에이전트로 대체하고, 결과에 교차 리뷰 생략을 표기한다(`degraded: true`) |
| Antigravity 부족 또는 소진 | 문구·주석·문서 정리는 병합을 막는 단계가 아니므로 리셋 시각 이후로 보류한다(`defer_until`). 급한 건만 Claude가 대신한다 |
| Claude 부족 | 구현을 Codex로 더 넘기고 Claude는 계획과 병합 판단만 한다 |
| Claude 소진 임박 | 인계 노트를 남기고 `/codex:transfer`로 현재 세션을 Codex 스레드로 넘긴다. Codex가 임시 리드를 맡는다 |

Antigravity를 구현이나 리뷰로 올리는 재배분은 하지 않는다. 요구사항에서 Antigravity의 역할을 문구와 문서 정리로 한정했다.

### 8.3 감시 주체

한도가 바닥난 리드는 스스로 재배분하지 못한다. Claude 소진 임박의 판정과 인계 촉발은 리드 밖에서 일어나야 하며, G3의 임계 훅이 그 역할이다. G3 전까지는 AgentGauge의 기존 토스트(5시간 창 90%)를 보고 사용자가 수동으로 인계한다.

## 9. 보완 데이터 경로

AgentGauge의 폴링 주기보다 빠른 공식 경로가 둘 있다. `report_limit`과 함께 폴링 지연을 메우는 용도다.

- Claude Code statusline: statusline 스크립트가 받는 JSON에 `rate_limits.five_hour`와 `rate_limits.seven_day`의 `used_percentage`, `resets_at`이 들어온다. 세션이 도는 동안 폴링 없이 갱신된다. 모델별 주간 한도는 이 경로에 없으므로 AgentGauge의 조회가 계속 필요하다.
- Codex app-server: `account/rateLimits/read` 요청과 `account/rateLimits/updated` 알림. 브리지가 이미 app-server를 붙잡고 있으므로 추가 비용이 없다.
- Antigravity: 공식 사용량 채널은 조사하지 않았다. AgentGauge의 provider가 유일한 원천이다.

## 10. 범위에서 뺀 것

- AgentGauge 팝오버에 세션 상태 레인을 넣지 않는다. 5절의 범위 결정과 맞지 않는다.
- AgentGauge 프로세스에 상주 HTTP 서버를 넣지 않는다.
- 계정 자동 전환은 다루지 않는다. 다중 계정의 값은 `get_usage`에 나오지만, 한도를 피하려고 계정을 바꿔 가며 쓰는 것이 각 서비스 약관에 맞는지 확인하지 않았다.

## 11. 미결 사항

- G1의 MCP 서버를 어디에 둘지(Crew 폴더 안의 독립 패키지를 1안으로 둔다).
- `--json` 제네릭 스키마의 확정. 7.1절은 제안이며 AgentGauge 레포에서 확정해야 한다.
- 임계 훅의 형태(외부 명령 실행, 이벤트 파일, 둘 다)와 보안 경계. 훅이 실행할 명령을 누가 등록할 수 있는지 정해야 한다.
- 소비자 활동 신호를 AgentGauge가 받는 방법. 상주 서버를 두지 않기로 했으므로 파일 기반 신호나 `--json` 호출 자체를 신호로 삼는 방식을 검토한다.
- 임계 초기값(15%, 30%)과 `stale` 판정 시간.
- Windows의 Core 분리 일정.

## 12. 번복 기록 (2026-11-11)

- 트레이 프로세스에 loopback HTTP와 MCP 엔드포인트를 올리는 안을 냈다가 철회했다. 레포 문서가 서버 방식을 과하다고 판단해 뒀다.
- 상태 보드를 AgentGauge 팝오버에 합치는 안을 냈다가 철회했다.
- macOS 포트가 아직이라는 전제와 Antigravity provider가 없다는 전제로 쓴 제약을 삭제했다. 둘 다 0.7.7에서 사실이 아니다.

## 13. 확인 근거

- AgentGauge 레포: https://github.com/ghostface2232/AgentGauge (`README.md`, `AGENTS.md`, `PRIVACY.md`, `doc/codexbar-reference.md`, `Models/`, `Services/UsageCacheStore.cs`, `Services/UsageHistoryStore.cs`, `mac/Sources/GaugeCore/`)
- Claude Code statusline의 `rate_limits` 필드: https://github.com/anthropics/claude-code/issues/45133
- Codex app-server의 rate limit 메서드: https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- Codex 플러그인의 `/codex:transfer`: https://github.com/openai/codex-plugin-cc
