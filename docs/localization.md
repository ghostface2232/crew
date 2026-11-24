# Localization

The board, the Windows app, and the macOS app show their interface in English or Korean. By default each follows the language the person already chose for their system or browser; Settings › Language can pick one for all of them instead. English is the source language: text written in English in the code is the key to its translation, and anything without a translation reads in English.

**Key files:** `plugin/board/src/i18n.ts`, `plugin/board/src/ko.ts`, `native/Resources/ko.lproj/Localizable.strings`, `plugin/bridge/settings.ts` (`saveLanguage`), `desktop/main.ts`, `native/Sources/Crew/CrewStore.swift` (`applyLanguage`), `scripts/build-desktop.mjs`, `test/i18n.test.ts`

## How the language is chosen

The setting is `language` in `~/.crew/config.json`: `"en"`, `"ko"`, or left out to follow the system. It lives with the daemon rather than in each app, so a browser board and the app beside it read one source and agree. Settings › Language in the board and the macOS app writes it through `POST /api/language` ([daemon-api.md](daemon-api.md#endpoints)), and every client hears the change as a `language` event. A value other than a known language makes the whole file invalid, as other settings do.

- **Board.** The setting when one is given, otherwise the first language in `navigator.languages` that Crew speaks, and English when none is. In a browser that list is the browser's, and inside the Windows app it is the system's, since Electron's Chromium takes it from Windows. A change switches the page in place. A reload would sign a browser tab out, since its credential lives only in the page's memory ([daemon-api.md](daemon-api.md#authentication)). `App` draws everything below it again, so memoized components lose text in the old language. Settings, if open, comes back on its Language page, and it asks before dropping instructions still being edited. Anything else open below `App`, such as a New Job draft, starts over, which matters only when the change comes from another client. The board keeps the last setting it heard in `localStorage` (`crew.language`), so a new page starts in it rather than switch once the daemon answers; where storage is blocked, it starts in the browser's language. The page sets `<html lang>` to match, so Korean text wraps between words (`word-break: keep-all`) instead of mid-word.
- **Windows app.** The main process (tray menu, dialogs, update messages) reads the setting from `config.json` as it starts, so a dialog about starting the daemon already uses it, then takes it from each state poll, so the tray switches within a few seconds. Without a setting it passes `app.getLocale()` through the board's choice; that is the locale the board's Chromium takes its languages from, so the tray and the board agree.
- **macOS app.** macOS picks the language from the app's `AppleLanguages` preference, else the system list or the app's entry in System Settings › General › Language & Region, among the languages the bundle declares (`CFBundleLocalizations`). The app writes the setting to its own `AppleLanguages` whenever it hears one, and removes it only while it still holds what Crew wrote (`appliedLanguage`), so a language picked for Crew in System Settings survives while the setting follows the system. A daemon that predates the setting sends none, and the app leaves its preference as it is, as the board does. macOS reads that preference as the app opens, so the app changes language the next time it opens. An instance run with `CREW_HOME` keeps its preferences in a suite of its own, so the setting does not change its language: it shares the installed app's bundle identifier, and writing to the app's own preferences would change the installed app's language. SwiftUI looks up literal text in `Text`, `Button`, `Label`, and the like in the bundle's `Localizable.strings` by itself; text built as a `String` outside a view goes through `String(localized:)`.

## Writing interface text

- In the board and the Windows app, every string a person reads (text, `title`, `aria-label`, placeholders, dialog and menu text) goes through `t('English text')`. Values go in as named placeholders, `t('{count} waiting', { count })`, never by joining translated pieces, because Korean orders words differently. When a placeholder is an element, such as a command in `<code>`, use `tNodes()` from `ui.tsx`.
- Plurals: keep the English choice in code (`count === 1 ? t('1 job') : t('{count} jobs', { count })`); Korean gives both the same text.
- Text the daemon sends (job summaries, agent output, error messages) is shown as it comes. Role names and summaries the daemon sends are passed through `t()` by their English text, so the known ones read in Korean.
- Text a module keeps outside a component, such as a table of labels, is built with `translated(() => …)` and read as a call, so it follows a change of language. A bare `t()` at module level would keep the language the page loaded in.
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

- The macOS app's setting was checked on a Mac only under `CREW_HOME`, where it lands in the instance's suite. That the same `AppleLanguages` in the app's own preferences switches the built app between Korean and English on its next open was checked by writing it by hand.

## Tests

- `test/i18n.test.ts`: every literal `t()` key in the board and Windows app has Korean text with the same placeholders, the language choice, the English fallback, how the board follows and remembers the setting, and `translated()` building again only when the language changes.
- `test/e2e/board.spec.ts`: choosing a language in a signed-in browser tab switches the board in place, keeps it signed in, and brings Settings back on its Language page.
- `test/settings.test.ts` and `test/questions.test.ts`: storing and validating `language`, and the board's right to change it.
- `native/Tests/CrewTests/CrewTests.swift`: the macOS app reads the setting from state and `language` events, tells an older daemon by the missing key, and writes and clears only its own `AppleLanguages`.
- `playwright.config.ts` pins the browser to `en-US`, so the board regressions and layout snapshots read English on any machine.

## History

- 2026-11-24: Korean added to the board, the Windows app, and the macOS app. Each followed the system's or the browser's language, with no setting of Crew's own, to keep one source of truth.
- 2026-11-24: Settings › Language added, for people who want Crew in a language other than their system's. The daemon keeps it, so the board and the apps still read one source and agree.
- 2026-11-24: The board switches language in place instead of reloading, because a reload signed a browser tab out (review of ghostface2232/crew#52). Text that modules kept as constants moved into `translated()`.
