# Sketch board format

Each git worktree has its own board. The Sketch pane (⌘⇧E) shows the one for
its space's worktree and reloads it the moment it changes, so an agent draws by
editing that file. To find yours, run
`node ~/.config/herdr-app/skills/herdr-sketch/scripts/sketch-board.mjs` in the worktree
(it prints the board's path; `… check` validates the board after you edit it), or look up
the worktree's root (`git rev-parse --show-toplevel`) in `~/.config/herdr-app/data/sketch/boards.json`:

```json
{ "/Users/me/code/app-wt": { "board": "data/sketch/boards/code-app-wt-1a2b3c4d/board.json", "branch": "feat/login", "machine": null } }
```

`board` is relative to `~/.config/herdr-app`; on another machine the key is
`<machine>:<root>`. A worktree gets an entry once a Sketch pane has shown it or the script has run there.
The home folder (and anything outside a space) keeps the old shared board,
`data/sketch/board.json`.

```json
{ "version": 1, "shapes": [ { "id": "api", "type": "rect", ... }, ... ] }
```

Later shapes are drawn on top. Coordinates are world pixels; y grows downward.

On the canvas, a trackpad pinch zooms around the pointer (10–600%).
Ordinary two-finger scrolling pans; Cmd/Ctrl+scroll also zooms.
Changing the viewport does not edit shapes or add undo steps.

| type | fields |
|---|---|
| `rect`, `ellipse`, `diamond` | `x`, `y`, `w`, `h`, optional `text` (centered label, `\n` for new lines), `fill` |
| `text` | `x`, `y` (top left), `text`, optional `fontSize` (default 20) |
| `diff` | `x`, `y`, `w`, `h`, `text`: a unified diff, or a filename on the first line followed by diff lines; optional `fontSize` (default 13) |
| `popup` | `x`, `y`, `w`, `h`, optional `text` (pin label), `popup: { width, height, shapes }` (the small Sketch inside) |
| `arrow`, `line` | `from` / `to`: ids of shapes to attach to (the ends follow those shapes), or `points`: `[[x, y], ...]`; optional `text` (label at the middle) |
| `pen` | `points`: `[[x, y], ...]` (freehand) |
| `image` | `x`, `y`, `w`, `h`, `src`: a picture's path relative to the board's folder (put it in that folder's `images/`, e.g. `images/flow.png`) |
| `person`, `database`, `db-table`, `server`, `cloud`, `browser`, `phone`, `document`, `queue`, `note`, `bubble`, `bulb`, `question`, `alert`, `gear`, `clock`, `lock`, `envelope`, `folder` | picture shapes: `x`, `y`, `w`, `h`, optional `text`, `fill`, like `rect` (see below) |
| `frame` | `x`, `y`, `w`, `h`, optional `text` (its name, top left), `fill`: a boundary around other shapes |

`diff` is an editable code card available in Shapes → Diff (usual size 560×280).
It uses monospace text, old/new line numbers, green additions, red deletions
and blue hunk headers, with colors for light and dark themes. Double-click or
press Enter to edit the full patch; Option+Enter inserts a newline and Enter
finishes. The filename is inferred from file headers, or taken from the first
line of a hand-written card. Small cards report hidden lines; resize to show
more (up to 200 visible rows). All text stays in the board, including hidden
lines. Diff cards move, resize, group and accept attached arrows like boxes.
Their code colors and clean border are fixed; generic ink/fill/rough/dash
controls apply to other shapes.

### Popup sketches and diff comments

Choose **Popup C** (or Shapes → Popup), then click the board to place a pin.
An ordinary click opens a pin's own small Sketch; no Command key is needed.
Dragging the pin moves it. Double-click
or Enter edits the pin's label. The popup uses the same tools, text editor,
images, diff cards, pan, pinch and undo as the main board. Drag its title to
move the window and its bottom-right corner to resize it. Window dimensions
and content are saved in the pin's `popup` field. Clicking another part of the
same Sketch closes the popup; that click is consumed, so it does not draw or
select something underneath. Clicks inside the popup keep it open, and clicks
outside Sketch do not dismiss it. Closing the window also saves
text still being edited. Only the open window creates a nested view.

The default popup is 520×380 logical pixels; its editable minimum is 280×240.
Large saved dimensions fit the current pane when displayed. A nested sketch
shares its parent board's images folder. A duplicated pin gets an independent
copy of its contents.

In a Diff card, drag the line-number gutter across code rows, or click a line
number and Shift-click another, then press **+** beside the line numbers at
the end of the selected range. Existing comment pins are also on the left,
beside the line numbers, and open with an ordinary click.
A comment pin appears at the end of the range and opens a compact 320px-wide
text editor. Its height follows the wrapped text (up to 12 rows) and it opens
above the selected range. It lays out invisibly while the initial text wraps,
then appears after size measurements have stopped changing for 50ms. Its bottom edge stays anchored
above the range while text wraps or changes; height measurement never moves it
to the other side. Available space above the range limits the input height. Click outside it (including other panes) or press Escape to close
and save the draft. Legacy shapes and arrows inside comments stay in the board
data; the editor changes only the first text shape.
**댓글 N** lists all comments; **댓글 삭제** in an open comment window deletes
that comment and supports undo.

Each Diff shape stores `comments`. `startRow` and `endRow` are zero-based,
inclusive indexes into the displayed diff rows (including hunk/file headers;
the optional manual filename is excluded). `quote` preserves their exact
prefixed text. If other rows are inserted, a unique unchanged range is
located again. Changed or ambiguous ranges remain in **댓글 N**, labeled
**변경된 줄**, and keep their contents.

```json
{ "id": "details", "type": "popup", "x": 80, "y": 300, "w": 44, "h": 44,
  "text": "Details", "popup": { "width": 520, "height": 380, "shapes": [
    { "id": "explanation", "type": "text", "x": 0, "y": 0, "text": "An editable explanation" }
  ] } }
```

```json
{ "id": "review", "startRow": 2, "endRow": 3,
  "quote": ["-const enabled = false;", "+const enabled = true;"],
  "popup": { "width": 520, "height": 380, "shapes": [
    { "id": "comment-text", "type": "text", "x": 0, "y": 0, "text": "Check retry limits." }
  ] } }
```

The second example is an entry in a Diff shape's `comments` array. The board
validator recursively checks popup shapes, comments, arrow references and
images. Nested boards have their own shape ids and groups.

**도구 숨기기 / 도구 보기** (or M with the canvas focused) toggles the drawing
toolbar and hints. The popup title keeps its own toggle available even when
its tools are hidden. Hiding the main Sketch's tools also hides the tools in
open popups; a popup can then show or hide its own tools independently.
Popup tool visibility is saved as `popup.toolsVisible` and is restored when
the popup reopens. Hiding tools does not interrupt an active text draft.

```json
{ "id": "change", "type": "diff", "x": 0, "y": 0, "w": 560, "h": 280,
  "text": "example.js\n@@ -1 +1 @@\n-const enabled = false;\n+const enabled = true;" }
```

Picture shapes draw a simple picture of the thing, scaled to their box; arrows attach
to them like boxes. Use them instead of a labeled box when the thing has one:

| type | for | usual size | label |
|---|---|---|---|
| `person` | a user, admin, team, customer | 64×84 | under it |
| `database` | a database, cache, any data store (a cylinder) | 110×120 | inside |
| `db-table` | a database table (title strip, three rows, key column); `text` names the table | 220×160 | title strip |
| `server` | a backend, API, worker host (a rack) | 96×110 | under it |
| `cloud` | the internet, a third party, an external service | 190×115 | inside |
| `browser` | a web app or frontend (a window) | 230×150 | inside |
| `phone` | a mobile app | 76×136 | under it |
| `document` | a file, spec, report, config (folded corner) | 110×140 | inside |
| `queue` | a message queue, event bus, stream (a sideways cylinder) | 210×70 | inside |
| `frame` | a boundary: "Backend", "VPC", "Team A" | any | its name, top left |
| `note` | a sticky note: a thought, a to-do (yellow unless `fill` says otherwise) | 150×130 | inside |
| `bubble` | what someone says or thinks (tail at the bottom left) | 180×110 | inside |
| `bulb` | an idea | 60×84 | under it |
| `question` | an open question (a ? in a circle) | 56×56 | under it |
| `alert` | a risk or warning (a ! in a triangle) | 64×56 | under it |
| `gear` | a job, a process, settings | 64×64 | under it |
| `clock` | a schedule, cron, a timeout | 64×64 | under it |
| `lock` | auth, permissions, a secret | 60×76 | under it |
| `envelope` | email, a notification, a message | 96×64 | under it |
| `folder` | a folder, file storage, a bucket | 140×105 | inside |

The small markers (`bulb`, `question`, `alert`, `gear`, `clock`, `lock`, `envelope`)
work beside a box or on an arrow's path: a `clock` next to a job says it's scheduled,
a `question` next to a step says it's undecided. A `note` should say "fill": "#fff3bf"
to look like the toolbar's.

Name the actual thing in `text` ("Postgres", "Admin", "Stripe"); there are no
vendor logos. Put frames first in `shapes`, so they're drawn behind what they
hold, and give them `"dashed": true` as the toolbar does. A frame is picked by
its border or name, so pressing inside it still reaches the shapes and the canvas.

Optional on every shape: `color` (ink, default `#1e1e1e`), `width` (stroke, default 2),
`dashed: true`, `fontSize` (label size; text and arrow/line labels default to 20,
most shape labels to 16), `rough: false` (draw this shape with
clean lines even when the hand-drawn look is on; the person toggles that look with H).
`group`: any string shared by shapes that belong together; pressing one selects them all
(the person groups with ⌘G and ungroups with ⌘⇧G). One level only: a shape is in one group at most.

Arrow and line labels use their own `fontSize`, with the same board zoom scaling
as ordinary text. Personal drawing rules (matching body and connection label
sizes, and ordinary step numbers) are maintained in
`~/.agents/skills/herdr-sketch/SKILL.md`; specify `fontSize` explicitly when drawing.

Palette used by the toolbar (ink / fill): `#1e1e1e` / `#e9ecef`, `#e03131` / `#ffc9c9`,
`#2f9e44` / `#b2f2bb`, `#1971c2` / `#a5d8ff`, `#f08c00` / `#ffd8a8`, `#9c36b5` / `#eebefa`.

Layout tips: boxes about 180×70 with 60–90 px gaps (under a shape labeled under it, leave about 22 px per label line plus 10); give every shape a readable `id`
and attach arrows with `from`/`to` instead of coordinates.

Diff code shortcuts open the Files side panel in this Sketch board's worktree. The header's `코드 ↗` uses the first selected row, or the first source row when nothing is selected; each source row also has a `↗` shortcut. Added and context rows use the new line number. Removed rows point to the following line in the current file. Deleted files have no current-file link. Paths come from unified diff `+++` headers or a handwritten filename title; unknown paths do not produce a shortcut.

The configured personal Files panel opens files in PR diff mode by default: the locally available `origin/main` ref (or local `main` when absent), compared from its merge base with `HEAD` (`main...HEAD`). This shows committed branch changes, including three unchanged context lines; it does not fetch or include uncommitted changes. The `코드` toggle shows the working file. Source rows outside the PR diff's context open code mode at the requested line. The diff list renders only visible rows and bounds previews to 400,000 characters / 10,000 rows.
