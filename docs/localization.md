# Localization

The board, the Windows app, and the macOS app show their interface in English or Korean. Each follows the language the person already chose for their system or browser; there is no language setting of Crew's own, so the board and the app beside it never disagree. English is the source language: text written in English in the code is the key to its translation, and anything without a translation reads in English.

**Key files:** `plugin/board/src/i18n.ts`, `plugin/board/src/ko.ts`, `native/Resources/ko.lproj/Localizable.strings`, `scripts/build-desktop.mjs`, `test/i18n.test.ts`

## How the language is chosen

- **Board.** The first language in `navigator.languages` that Crew speaks; English when none is. In a browser that is the browser's language list, and inside the Windows app it is the system's, since Electron's Chromium takes it from Windows. The page sets `<html lang>` to match, so Korean text wraps between words (`word-break: keep-all`) instead of mid-word.
- **Windows app.** The main process (tray menu, dialogs, update messages) passes `app.getLocale()` through the same choice once the app is ready. That is the locale the board's Chromium takes its languages from, so the tray and the board agree.
- **macOS app.** macOS picks the language from the system list or the app's own entry in System Settings › General › Language & Region, among the languages the bundle declares (`CFBundleLocalizations`). SwiftUI looks up literal text in `Text`, `Button`, `Label`, and the like in the bundle's `Localizable.strings` by itself; text built as a `String` outside a view goes through `String(localized:)`.

Choosing per platform convention rather than adding a setting keeps one source of truth and keeps the board and the app in the same language. Revisit if people ask for a language different from their system's.

## Writing interface text

- In the board and the Windows app, every string a person reads (text, `title`, `aria-label`, placeholders, dialog and menu text) goes through `t('English text')`. Values go in as named placeholders, `t('{count} waiting', { count })`, never by joining translated pieces, because Korean orders words differently. When a placeholder is an element, such as a command in `<code>`, use `tNodes()` from `ui.tsx`.
- Plurals: keep the English choice in code (`count === 1 ? t('1 job') : t('{count} jobs', { count })`); Korean gives both the same text.
- Text the daemon sends (job summaries, agent output, error messages) is shown as it comes. Role names and summaries the daemon sends are passed through `t()` by their English text, so the known ones read in Korean.
- Add the Korean text in the same change. `test/i18n.test.ts` fails when a literal `t()` key has no Korean entry or when the two disagree on placeholders. In the macOS app, add the key to `Localizable.strings`; Swift interpolations become format specifiers in the key (`"%lld jobs"`, `"%@ is running"`).

## Korean style

- Labels, buttons, menu items, headings, and table headers are short noun phrases without a final period: `병합`, `설정 저장`, `새 작업`.
- Sentences (descriptions, empty states, confirmations, errors, tooltips that explain) use 해요체: `아직 작업이 없어요.` Avoid `~하십시오`, `당신`, and passive translationese.
- Compact durations: `5분`, `3시간`, `2일`; `<1m` is `1분 미만`; "5m ago" is `5분 전`.
- Product and agent names stay as they are: Crew, Claude, Claude Code, Codex, Antigravity, GitHub. So do code-like words such as branch names, `check`, and file paths.

| English | Korean | English | Korean |
| --- | --- | --- | --- |
| job | 작업 | mission | 미션 |
| lead | 리드 | worker | 워커 |
| agent | 에이전트 | role | 역할 |
| board | 보드 | session | 세션 |
| project | 프로젝트 | task (a mission's) | 할 일 |
| approval, approve | 승인 | deny, decline | 거절 |
| question | 질문 | answer | 답변 |
| Needs you | 확인 필요 | waiting on you | 내 응답 대기 |
| implementation | 구현 | refactoring | 리팩터링 |
| release preparation | 릴리스 준비 | debate | 토론 |
| review | 리뷰 | cross-review | 교차 리뷰 |
| self-review | 셀프 리뷰 | review that runs the app | 앱 실행 리뷰 |
| fix | 수정 | wording, polish | 문구 다듬기 |
| merge | 병합 | discard | 폐기 |
| worktree | 워크트리 | branch | 브랜치 |
| diff, changes | 변경 사항 | pull request | PR |
| settings | 설정 | scores | 점수 |
| usage | 사용량 | preset | 프리셋 |
| tier | 티어 | effort | 추론 강도 |
| token | 토큰 | model | 모델 |
| daemon | 데몬 | update | 업데이트 |
| working, running | 작업 중, 실행 중 | waiting | 대기 중 |
| done | 완료 | failed | 실패 |
| cancelled | 취소됨 | New Job | 새 작업 |
| Overview | 현황 | note | 노트 |
| sub-agent | 서브에이전트 | details | 세부 정보 |
| instructions (shared) | 지침 | instructions (a job's) | 지시 내용 |

Mission stops: Plan `계획`, Build `구현`, Review `리뷰`, Fix `수정`, Polish `다듬기`, Final `마무리`.

"Task" outside a mission's task list means the work itself and reads `작업`. Tiers: Fast `빠름`, Light `경량`, Standard `표준`, Frontier `최상위`. Presets: Economy `절약`, Balanced `균형`, Best `최고`. Usage states: ok `정상`, tight `한도 임박`, exhausted `한도 도달`, stale `오래됨`.

The board's `ko.ts` and the macOS app's `Localizable.strings` give the same English the same Korean, so the two read alike side by side.

## Not verified

- The macOS app's Korean text is checked by `npm run test:native` and a look at the built app, which need a Mac.

## Tests

- `test/i18n.test.ts`: every literal `t()` key in the board and Windows app has Korean text with the same placeholders, the language choice, and the English fallback.
- `playwright.config.ts` pins the browser to `en-US`, so the board regressions and layout snapshots read English on any machine.

## History

- 2026-11-24: Korean added to the board, the Windows app, and the macOS app.
