# 10. Design tokens (native macOS app)

Written 2026-11-14, updated 2026-11-15. Every size, gap, color and type style in the native app comes from `native/Sources/Crew/DesignTokens.swift`. Views name a token instead of writing a number, so a change made there reaches every screen. This page lists each token and where it is used. The web board has its own CSS and is not covered here.

When no token fits, add one here and in the file; do not write the number in the view.

Some numbers stay outside the token file.
- **Geometry a single view owns** is a named constant next to its code, listed under Composite views below. Examples are `MissionTrack.marker` and `EvidenceTile.minWidth`, the heading and request-card widths in `BoardView`, and the Settings tab and scope picker widths.
- **Bare numbers** are left only where a name would add nothing:
  - motion (durations, delays, and the small offsets of a transition)
  - 1-point hairlines
  - opacity steps inside a view's own gradient or mask
  - three values tied to AppKit, each with a comment: the placeholder's 5-point inset (the text view's line fragment padding), the answer field's trailing room (`IconButton.diameter` plus its inset), and the Settings window's clearance under its transparent title bar

## Spacing — `Space`

One scale for gaps (`spacing:`) and padding. Values between two steps are rounded to the nearer step.

| Token | Points | Typical use |
| --- | --- | --- |
| `xxs` | 2 | A name over its role |
| `xs` | 4 | A title over its meta line; rows in a list (`rowGap`) |
| `s` | 6 | Items in a chip line or meta line |
| `m` | 8 | Items in a row; the window inset |
| `ml` | 10 | A mark or icon beside its text; a row's vertical padding |
| `l` | 12 | Controls in a group; a row's horizontal padding; gray insets |
| `xl` | 16 | Blocks inside a card; the gap between cards; banner padding |
| `xxl` | 20 | Card padding |
| `x3l` | 24 | Detail panel and sheet padding |
| `x4l` | 28 | Sections of the detail panel; Settings side padding |
| `x5l` | 32 | The page heading's columns |
| `x6l` | 40 | The page margin |

## Layout — `WorkspaceStyle`

These aliases name a role for a scale step. Use the alias when the role fits, so changing a role means changing one line.

| Token | Value | Role |
| --- | --- | --- |
| `pageMargin` | 40 | The page's side margin and the room below its last card |
| `pageTop` | 12 | Above the page heading |
| `cardPadding` | 20 | Inside every card |
| `cardGap` | 16 | Between cards, across and down |
| `blockGap` | 16 | Between blocks stacked inside a card or section |
| `sectionGap` | 28 | Between detail panel sections |
| `bannerPadding` | 16 | Connection and attention banners |
| `panelPadding` | 24 | Detail panel and New Job sheet |
| `panelWidth` | 420 | The detail panel |
| `rowInsets` | 10 × 12 | Job and session rows |
| `rowGap` | 4 | Between rows of one kind: a mission's jobs and the list cards (Recently finished, Other jobs, Claude sessions) |
| `insetPadding` | 12 | The gray inset (`inset()`) holding a detail section's contents, or an agent card's sessions or jobs. The agent card leaves the inset out when there are none |
| `iconColumn` | 20 | The column a row's icon or mark sits in, so titles line up |
| `titleInset` | 6 | Titles outside a card (page heading, Agents, Settings) sit this far in from the cards' edge, since a rounded corner pulls the card's edge in visually |
| `rowTitleInset` | 4 | The same correction inside a card, for text beside its gray rows and insets: mission stop names, notes and outcomes, list card titles, detail section titles |
| `factLabelWidth` | 72 | A fact's label column in the detail panel; `factColumnGap` (16) and `factRowGap` (8) space its grid |
| `elapsedColumn` | 28 | The elapsed time at a row's end, so short and long times line up |
| `rowSpacer` | 8 | The least room between a row's text and what follows it |
| `summaryBarHeight` | 5 | The summary bar |
| `usageBarHeight` | 3 | An agent's usage bar |
| `editorHeight` | 80–180 | A message editor grows within this range; `answerHeight` (56–160) for an answer field |
| `panelShadowRadius` | 26 | The detail panel's shadow, offset by `panelShadowOffset` (−8, 8) |
| `windowInset` | 8 | The toolbar items' distance from the window edge, kept by floating panels |

## Windows — `WorkspaceStyle`

| Token | Value | Use |
| --- | --- | --- |
| `pageMaxWidth` | 1280 | The page stops widening here and centers |
| `contentMinWidth` | 560 | The page column's minimum width |
| `windowMinHeight` | 560 | The main window's minimum height |
| `windowDefaultSize` | 1180 × 780 | The main window's first size |
| `sidebarWidth` | 180 / 210 / 300 | The project sidebar's minimum, ideal and maximum width |
| `sheetWidth` | 560 | The New Job sheet |
| `settingsSize` | 720 × 620 | The Settings window, which shrinks no smaller than `settingsMinSize` (640 × 570) |
| `pickerWidth` | 180 | Settings pickers in a column |

## Radii

| Token | Points | Use |
| --- | --- | --- |
| `cardRadius` | 20 | Cards and banners |
| `panelRadius` | 18 | The floating detail panel: concentric with the window corner across `windowInset`, and equal to the toolbar capsules |
| `fieldRadius` | 14 | Text fields and editors |
| `rowRadius` | 12 | Rows, gray insets and thumbnails inside a card |
| capsule | — | Chips and pill buttons |
| circle | — | Icon buttons and step markers |

## Color — `WorkspaceStyle` surfaces and `Palette`

Surfaces change between light and dark appearance. Status colors are system colors, so they follow accessibility settings.

| Token | Use |
| --- | --- |
| `canvas` | The page background. In dark mode, cards are about 9% lighter than the canvas. |
| `surface` | Cards and the detail panel |
| `rowFill` | Rows and gray insets on a surface |
| `hairline` | Card and field outlines |
| `Palette.accent` | Running work and the current step |
| `Palette.success` | Done |
| `Palette.warning` | Waiting, stalled, unsaved, usage at 70% or more |
| `Palette.danger` | Failed, errors, refusals, usage at 90% or more or at its limit |
| `Palette.attention(color)` | A row or card that needs attention, tinted 7% with its status color |
| `Palette.chip(color)` | A chip's background, 12% of its status color |
| `Palette.selection` | The row whose details are open |
| `Palette.contrastStroke` | Outlines when Increase Contrast is on |
| `Palette.panelShadow` | The detail panel's shadow |

Chip text in light mode is the status color mixed 22% toward black, so orange and green reach about 3:1 contrast on their tint.

## Type — `Typeface`

Titles use SF Pro Rounded and headlines SF Pro Display. Body text uses SF Pro Text, and source text uses SF Mono.

| Token | Size / weight | Family | Use |
| --- | --- | --- | --- |
| `pageTitle` | 38 semibold | Rounded | The page heading |
| `number` | 40 regular | Rounded | Summary counts |
| `windowTitle` | 30 semibold | Rounded | The Settings window heading |
| `section` | 21 semibold | Display | Page section titles, such as Agents |
| `title` | 19 semibold | Rounded | Card, mission and detail titles |
| `emptyTitle` | 18 regular | Rounded | Empty states |
| `cardTitle` | 17 semibold | Rounded | Agent names, Settings cards |
| `headline` | 16 medium | Display | The request in an approval or question; a debate round's title |
| `subheadline` | 14 semibold | Text | Detail section titles |
| `bodyStrong` | 14 medium | Text | Row titles, report headings, a mission stop's name above its jobs, a detail item's title |
| `body` | 14 regular | Text | What the user types: message and answer editors |
| `calloutStrong` | 13 medium | Text | Pill buttons, agent names in events |
| `callout` | 13 regular | Text | Text in the detail panel: facts, reports, debate messages and points, notes |
| `captionStrong` | 12 semibold | Text | The current mission step's name on the track; other step names use `caption` |
| `chip` | 12 medium | Text | Status chips, step numbers |
| `caption` | 12 regular | Text | Meta lines, usage, times; `captionSize` exposes its size for layout |
| `micro` | 11 semibold | Text | Row chevrons |
| `code` | 13 regular | Mono | Diff stats, file paths, code blocks |
| `codeSmall` | 12 regular | Mono | Ids |

`calloutSize` exposes the callout's point size for layout that counts its lines.

## Symbols — `Symbol`

A symbol inside a label takes the label's font. These tokens are for symbols that stand alone.

| Token | Size / weight | Use |
| --- | --- | --- |
| `badge` | 9 bold | Inside a small filled shape, such as a passed step |
| `control` | 11 semibold | The glyph of an icon button or the send button |
| `large` | 17 medium | Thumbnail placeholders, Settings section icons |
| `empty` | 30 light | Empty state illustrations |
| `stance` | 14 medium | A debate point's stance mark |
| `dot` | 6 regular | A small dot before words, such as Unsaved changes |
| `controlFrame` | 16 pt | The frame a control glyph sits in; also the event list's status column |
| `chevronNudge` | 1 pt | A sideways chevron shifts this far toward its point, where its frame leaves it looking off center |

## Agent marks — `MarkSize`

| Token | Points | Use |
| --- | --- | --- |
| `inline` | 13 | Beside caption text, such as the Needs You chip line |
| `row` | 16 | A job or session row's leading mark: the agent that ran it, so the row's detail line leaves the agent's name out |
| `list` | 20 | The compact agent list |
| `card` | 22 | Agent cards and Settings role cards |

## Composite views

These views keep their own geometry next to their code, built from the tokens above.

**Mission track (`MissionTrack`).**
- Step markers are `marker` (24-point) circles. The first and last marker centers sit `inset` (24 points) in from the edges, and the other markers are spread evenly between them.
- Each step name is centered under its marker and truncated to the space between markers.
- Markers are joined by a `line` (2-point) track that runs under them. An outlined marker is filled with the card's surface, so the track does not show through it.
- Steps not reached yet share one color, `upcoming` (12% primary), for both their outline and the track leading to them.
- A passed step is filled with primary and shows a `Symbol.badge` checkmark. A done mission uses secondary instead. An abandoned one outlines its passed and stopped steps in a lighter secondary (55%), with the glyph in the same color, so the glyph stays legible.
- The space between markers never goes below zero, however narrow the card or long the plan.
- The current step of an active mission is filled with `Palette.accent`. The step a mission ended on without passing it is filled like a passed step, with its number in the surface color.

**Summary bar (`WorkspaceSummary`).** The bar is `summaryBarHeight` (5 points) tall and made only of its colored parts, 4 points (`Space.xs`) apart. The bare `quaternary` track shows only when every count is zero.

**Detail sections (`detailSection`, `DetailItem`).** A section is a `subheadline` title over a gray inset.
- The inset holds items `Space.l` apart.
- An item is a title row in `bodyStrong`, then its body starting `Space.xs` below it at the same leading edge, never beside the title. The title row may lead with a status symbol, and it ends with the item's status words, marks or own action.
- Text inside the panel is one size: prose and values alike in `callout`, code in `code`, and supporting lines in `caption`. It stays below the title row, as the overview facts do.
- Examples are a check and what it ran, Runs with, a relayed approval, a round of changes, and a debate's Lead and worker replies.
- The overview facts at the top of the panel are the one two-column name–value table.

**Debate (`DebateRound`).** A round's title is `headline`. The lead's message and the worker's reply each carry a 2-point edge on the left, accent for the lead and the neutral track color for the worker.
- The latest round starts open, and earlier rounds start folded to their title.
- A round's open or folded state is fixed when it first appears, so a round arriving later does not fold the one being read.
- When the first turns predate the recorded conversation, a caption says which turns are missing.

**Detail panel header (`DetailHeader`).**
- The status and title are pinned above the details. The title runs to two lines at most, and what the work is doing now appears as a `callout` subtitle under it.
- Once details scroll under the header, a veil fades in over 0.25 seconds. The veil is the panel's surface at 100%, 90%, 60% and 0% opacity, laid over an `ultraThinMaterial` blur that thins out from halfway down.
- The veil extends `Space.x6l` (40 points) below the header. When the details are at the top, no veil shows.

## Controls

| Kind | How | Use |
| --- | --- | --- |
| Primary | `.glassPillButton()`, or `.glassPillButton(prominent: false)` for clear glass: Liquid Glass at the pill's size and face | Send message, New Job, Save, Send Job; Review requests in clear glass |
| Pill | `.pillButton()`; `.pillButton(.prominent)` for the action a group leads with, `.pillButton(.warning)` for one that drops work without completing it | Mark done, Stop tracking, Details, Retry, Copy, Undo/Keep, Cancel Job, approval decisions |
| Icon | `.iconButton()`: `IconButtonStyle`, a `Pill.fill` circle of `IconButton.diameter` (28 points), a little larger than a chip, with its symbol in `Symbol.control`; `.iconButton(prominent: true)` fills it with the accent | Close, Show job, expand a mission; Send answer (prominent) |
| Chip | `StatusLabel`: `Typeface.chip` in a `Palette.chip` capsule with `Chip.insets` (5 × 8) | Status of jobs, sessions, missions and agents |
| Reveal | `RevealToggle`: `captionStrong` secondary words with a `Symbol.badge` chevron that turns over, no fill; the words and the room around them take the click. VoiceOver reads its `subject` and whether it is expanded | Show all / Show less, an earlier debate round, a full reply, the end of a check's output, the original task |
| Stance mark | `StanceMark`: a `Symbol.stance` symbol in its status color, not a chip, which would read as a button: a green check for agree, a red cross for disagree, an accent branch for an alternative. It sits beside the worker's name, one per stance the reply takes, counted when taken more than once; a folded round's title carries the same marks beside it, and a point's line ends with its own only when the reply mixes stances | Points of a debate reply |

Pill buttons use `PillButtonStyle`, not the system bordered style. The system's regular bordered button is 24 points tall with 5 points above and below its label, which looks pressed flat. A pill instead has `Pill.insets` (7 × 14), so it is about 30 points tall, with its label in `calloutStrong`.

| Kind | Label | Fill |
| --- | --- | --- |
| plain | primary | `Pill.fill` (8% primary) |
| prominent | white | `Palette.accent` |
| warning | `Palette.warning` | `Palette.chip(warning)` |
| destructive role | `Palette.danger` | `Palette.chip(danger)` |

When a pill's label starts with a symbol, the symbol's side has `Pill.symbolTrim` (3 points) less inset. A symbol's round shape sits inside its frame, so an even inset would look wider on that side. Text-only pills stay symmetric. The symbol and the title are `Pill.symbolGap` (6 points) apart. Glass pills use the same insets and label style. A tinted label is darkened 22% in light mode, as on chips. A pressed pill dims, and a disabled one fades to 45%. Under Increase Contrast, a pill gets an outline. A group's actions sit at its trailing edge, and the completing action comes last. Placement follows two rules.
- **Actions sit at the trailing edge.** An item's action sits on the item's header row, as Undo does on a round. A section's action sits on its own last row, as Copy diff command does, or shares that row with a closing line, as Mark done shares it with a mission's outcome, centered on that line. The panel's footer gathers its actions at the trailing edge, with Cancel Job last.
- **Reveals sit at the leading edge.** A reveal goes directly under what it reveals. Pills run actions and are never used to reveal content.

Send and completing actions sit at the trailing edge too, such as Send message and Approve after Deny. A mission's Stop tracking and Mark done appear only once an active mission looks finished. An abandoned mission shows Mark done alone, which reopens it explicitly: the mission's controls lock per state through `Mission.actionKey`, so Stop tracking never leaves Mark done locked.
