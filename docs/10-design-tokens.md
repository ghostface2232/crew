# 10. Design tokens (native macOS app)

Written 2026-11-14. Every size, gap, color and type style in the native app comes from `native/Sources/Crew/DesignTokens.swift`. Views name a token instead of writing a number, so a change made there reaches every screen. This page lists each token and where it is used. The web board has its own CSS and is not covered here.

When no token fits, add one here and in the file. Do not write the number in the view. The few numbers left in views are geometry tied to AppKit, and each has a comment:
- the placeholder's 5-point inset (the text view's line fragment padding),
- the answer field's room for its send button,
- the Settings window's clearance under its transparent title bar.

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
| `rowGap` | 4 | Between rows in a list |
| `insetPadding` | 12 | The gray inset holding a section's contents |
| `iconColumn` | 20 | The column a row's icon or mark sits in, so titles line up |
| `titleInset` | 6 | Titles outside a card (page heading, Agents, Settings) sit this far in from the cards' edge, since a rounded corner pulls the card's edge in visually |
| `windowInset` | 8 | The toolbar items' distance from the window edge, kept by floating panels |

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
| `headline` | 16 medium | Display | The request in an approval or question |
| `subheadline` | 14 semibold | Text | Detail section titles |
| `bodyStrong` | 14 medium | Text | Row titles, report headings |
| `body` | 14 regular | Text | Reports, messages |
| `calloutStrong` | 13 medium | Text | Pill buttons, agent names in events |
| `callout` | 13 regular | Text | Facts, notes, secondary copy |
| `captionStrong` | 12 semibold | Text | Mission stop names |
| `chip` | 12 medium | Text | Status chips, step numbers |
| `caption` | 12 regular | Text | Meta lines, usage, times |
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
| `row` | 14 regular | A row's leading icon |
| `large` | 17 medium | Thumbnail placeholders, Settings section icons |
| `empty` | 30 light | Empty state illustrations |
| `controlFrame` | 16 pt | The frame a control glyph sits in |

## Agent marks — `MarkSize`

| Token | Points | Use |
| --- | --- | --- |
| `inline` | 13 | Beside caption text, such as the Needs You chip line |
| `row` | 16 | A session row's leading mark |
| `list` | 20 | The compact agent list |
| `card` | 22 | Agent cards and Settings role cards |

## Controls

| Kind | How | Use |
| --- | --- | --- |
| Primary | `.glassPillButton()`, or `.glassPillButton(prominent: false)` for clear glass: Liquid Glass at the pill's size and face | Send message, New Job, Save, Send Job; Review requests in clear glass |
| Pill | `.pillButton()`; `.pillButton(.prominent)` for the action a group leads with, `.pillButton(.warning)` for one that drops work without completing it | Mark done, Stop tracking, Details, Retry, Copy, Undo/Keep, Cancel Job, approval decisions |
| Icon | `.iconButton()`; a custom glyph takes `Symbol.control` in `Symbol.controlFrame` | Close, Show job, expand a mission |
| Chip | `StatusLabel`: `Typeface.chip` in a `Palette.chip` capsule with `Chip.insets` (5 × 8) | Status of jobs, sessions, missions and agents |

Pill buttons use `PillButtonStyle`, not the system bordered style. The system's regular bordered button is 24 points tall with 5 points above and below its label, which looks pressed flat. A pill instead has `Pill.insets` (7 × 14), so it is about 30 points tall, with its label in `calloutStrong`.

| Kind | Label | Fill |
| --- | --- | --- |
| plain | primary | `Pill.fill` (8% primary) |
| prominent | white | `Palette.accent` |
| warning | `Palette.warning` | `Palette.chip(warning)` |
| destructive role | `Palette.danger` | `Palette.chip(danger)` |

When a pill's label starts with a symbol, the symbol's side has `Pill.symbolTrim` (3 points) less inset. A symbol's round shape sits inside its frame, so an even inset would look wider on that side. Text-only pills stay symmetric. The symbol and the title are `Pill.symbolGap` (6 points) apart. Glass pills use the same insets and label style. A tinted label is darkened 22% in light mode, as on chips. A pressed pill dims, and a disabled one fades to 45%. Under Increase Contrast, a pill gets an outline. A group's actions sit at its trailing edge, and the completing action comes last.
