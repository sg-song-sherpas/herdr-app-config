# herdr-app config

My Herdr app setup: a layout with a Linear panel, Linear
issue search, a Sketch whiteboard pane, and the keys for them. Herdr reads `~/.config/herdr-app` live, so
changes show up as soon as the files are saved.

## Song의 로컬 설정

이 포크는 Song의 로컬 Herdr 설정을 보관합니다. `settings.json`의 화면·소리 설정,
`programs.json`의 Codex 실행 설정, 두 커스텀 레이아웃과 개인 모드를 포함합니다.
세션 기록, 인증 정보, 캐시, 작업별 Sketch 보드는 포함하지 않습니다.

기본 Herdr 모드와 생성되는 타입 파일은 Herdr 앱이 제공합니다. 현재 설정은
개인 Herdr Custom 빌드를 사용하며, 그 빌드의 `ai-context`·`switcher` 등 기본 모드에
의존합니다. 이 저장소는 Herdr 실행 파일 자체를 포함하지 않습니다.

레이아웃 선택 화면에서 `main-linear` 또는 `agent-control-center`를 선택합니다.

## What's here

| Path | What it is |
|---|---|
| `layouts/main-linear.json` | The `main` layout plus a right-hand panel (Files, Changes, Linear), with one Spaces list that shows each space's agents |
| `mods/spaces-agents/` | That sidebar list: a copy of Herdr's Spaces list with each space's agents (status, time in that state) listed under it; replaces the separate Agents list |
| `mods/tabs-linear/` | The tab bar for that layout, with buttons that open the panel |
| `mods/linear-issues/` | The Linear panel: issues assigned to you, grouped by project or state, matched to Herdr spaces by branch, plus an issue detail view |
| `mods/linear-search/` | ⌘I popup that searches every Linear issue |
| `mods/Sketch/` | A whiteboard pane drawn natively: boxes, ellipses, diamonds, arrows that stay attached, pen, text; follows light/dark themes. The board is `data/sketch/board.json`, which agents can edit (format in `mods/Sketch/FORMAT.md`) |
| `mods/codex-usage/` | Bottom status bar and popup: Codex usage, reset times, reset tickets, and a confirmed ticket reset |

Click the star to the left of an agent’s AI icon to mark or unmark a currently
important agent. Stars persist across restarts without changing the list order.

In `main-linear`, an unnamed tab (or a new tab called `Codex`) automatically
keeps Codex's conversation title after its first completed response. The folder
suffix is removed. This runs once per tab, including background tabs; custom
names are preserved, and later turns do not replace the saved name.

Double-click a worktree or space in the sidebar to edit its name in place.
Press Enter or click elsewhere to save; press Escape to cancel.
This changes its Herdr display name; its Git branch and folder stay the same.

Double-click an agent in the sidebar or a top tab to rename it in place.
Saving also renames this tab's local Codex conversations through the existing
app-server's `thread/name/set` API, without restarting Codex or sending chat input.
The bridge requires a unique exact match of the live terminal title and working
folder; ambiguous, disconnected, or remote conversations show a failure toast
while preserving the saved Herdr tab name. Confirming the same name retries the
sync, including tabs renamed before this integration. Python 3 and `hc` must be
on the app's PATH. The bridge never starts or updates the Codex daemon.
| `keys.json` | Key bindings, including the ones below |
| `tests/`, `package.json` | Unit and integration tests for the mods (`npm test`); how to write them is in `tests/AGENTS.md` |
| `CLAUDE.md` | Points agents at `tests/AGENTS.md` (Herdr rewrites the root `AGENTS.md`) |

Everything else in `~/.config/herdr-app` is written by Herdr or is personal
state, so `.gitignore` leaves it out.

## Keys

| Key | Does |
|---|---|
| Control+Tab / Control+Shift+Tab | In `main-linear`, hold Control and cycle recent tabs forward/backward in the top bar; release Control to select, Esc to cancel (history starts when the tab bar loads) |
| ⌘I | Search Linear issues (popup) |
| ⌘⇧I | Open or close the Linear panel (floating window outside `main-linear`) |
| ⌘⇧L | Switch layout (pick `main-linear`) |
| ⌘⇧E | Open a Sketch pane to the right (also the Sketch button in the tab bar) |

The Linear panel's open/closed state is shared across all worktrees and saved
across restarts. Files and Changes keep their per-worktree panel choices.

In the search popup: ↵ shows details (and opens the Linear panel), ⌘↵ opens the
issue in Linear, ⌘G goes to the issue's space or makes a worktree for its branch,
⌘⇧C copies the ID, Esc closes.

## Setup

1. **Linear API key.** Create a personal key in Linear (Settings → Security &
   access → Personal API keys) and put it in the macOS keychain. The mods read it
   from there; it never goes into these files:

   ```sh
   security add-generic-password -s linear-api-key -a "$USER" -w 'lin_api_…'
   ```

2. **Get the files.** `~/.config/herdr-app` already exists once Herdr has run,
   so check the repo out into it. This replaces your `keys.json`; back it up
   first if you've changed it.

   ```sh
   cd ~/.config/herdr-app
   cp keys.json keys.json.bak 2>/dev/null
   git init -b main
   git remote add origin <this repo's URL>
   git fetch origin
   git checkout -f -t origin/main
   ```

3. **Pick the layout:** ⌘⇧L → `main-linear`.

4. **Check:** `herdr-app check ~/.config/herdr-app/mods/linear-search`
   (and the same for `linear-issues`, `tabs-linear`, `Sketch` and `spaces-agents`), then `herdr-app status`,
   which should list no errors.

## Things to know

- New worktrees for an issue are made from `~/Sherpas/basecamp`. If your
  checkout lives elsewhere, change `REPO` in `mods/linear-issues/main.js` and
  `mods/linear-search/main.js`, and the path in `mods/linear-issues/detail.js`.
- Mods can't import from each other, so `mods/linear-search/common.js` is a copy
  of `mods/linear-issues/common.js`. Change both together.
- The two Linear mods share a cache in `shared.json` (`linear.mine`,
  `linear.states`), which isn't committed.

## Tests

Node 22.15+ and nothing else:

```sh
npm test              # unit + integration (mods run against a fake Herdr; config checked by the real herdr-app)
npm run test:live     # smoke tests against the running app (opens and closes a pane)
```

Changes start with a failing test; see `tests/AGENTS.md`.

## Codex usage

The bottom status bar uses the local Codex CLI ChatGPT login (`CODEX_HOME`, else `~/.codex`). It refreshes every minute and when the popup opens; ↻ refreshes manually. The Python bridge sends credentials only as HTTPS headers and returns only usage fields to the mod. Tickets are consumed only after the popup confirmation. A failed request keeps its redemption ID for a safe retry. Reset endpoints follow the installed Orca integration and may change upstream.

사이드바 +, 메뉴, Linear 목록·검색·상세는 모두 기본 `worktree` 모드를 사용합니다. 선택한 이슈의 제목과 브랜치를 확인하고 Enter를 누르면 생성하며, 공간 이름은 이슈 제목으로 지정합니다. 사이드바는 선택한 저장소를, Linear 화면은 Basecamp 저장소를 사용합니다. 기본 모드의 원본은 Herdr Custom의 `defaults/mods/worktree/`에 있습니다.

In the + menu, New worktree accepts a Linear issue ID (for example `PRD-1234`), a `https://linear.app/…/issue/…` link, or a branch name. Issue input uses the existing Keychain connection, creates the checkout on the issue branch in the selected repository, and names the space after the issue title. Lookup failures leave the dialog open without creating a checkout.

The Spaces sidebar + opens New worktree directly. Right-clicking a space → New worktree also opens the Linear-enabled dialog for that space’s repository. Open worktree and Remove worktree keep the shipped dialogs.

Typing a Linear issue ID or link in New worktree shows its identifier, title, and branch before Enter. Lookup starts after a short pause in typing; changing the input clears the previous preview. Enter uses the displayed issue, or waits for its current lookup.

New worktree also accepts a bare issue number: `10355` looks up `PRD-10355`, both in the preview and when creating the worktree.

## Sketch update

Sketch supports image insertion (file picker, clipboard and drop), copying and
pasting shapes, duplication, groups, a right-click menu, and resizing from any
edge. Press M to hide or show the toolbar.

K or Shapes opens a palette of 19 picture shapes for system diagrams and notes:
person, database, server, cloud, browser, phone, document, queue, frame, note,
bubble, idea, question, alert, gear, clock, lock, envelope and folder. They
resize, take ink and fill colors, use the hand-drawn look, and keep arrows attached.

Each worktree has its own board under `data/sketch/boards/`; the home folder
keeps the previous shared `data/sketch/board.json`. The `herdr-sketch` agent
skill finds the board for the current worktree and validates edits with
`node ~/.config/herdr-app/skills/herdr-sketch/scripts/sketch-board.mjs check`.

In `main-linear`, both the Sketch button and ⌘⇧E open or close the current
tab's worktree board. In Sketch, ⌘D duplicates and ⌘⇧G ungroups.
