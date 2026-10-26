# The visual-kit contract

This is the one place the spec lives. Every repo that uses visual-kit, and
[personal-landing](https://github.com/s3ntin3l8/personal-landing) which pulls from them, relies on it.

## What a repo provides

1. **A demo**: one command (`make demo`) that boots an isolated, seeded instance on a loopback port and
   prints a line matching `readyOutput` (default `DEMO_READY`) once it is ready. It never touches live data,
   binds only to loopback, and tears itself down on `SIGTERM`.
2. **`visual/Dockerfile`** with one line: `FROM ghcr.io/s3ntin3l8/visual-kit:<version>`. Dependabot bumps it.
3. **`visual/scenes.json`** (see below), and optionally **`visual/hooks.mjs`**.
4. **Four make targets**, thin wrappers around `visual/.kit/run.sh`, which is extracted from the image
   and never committed.
5. **`.gitignore`** entries: `visual/.kit/`, `visual/.out/`, `docs/audit/assets/`, `*.staging`.

```make
VISUAL_IMAGE := visual-kit-local/$(notdir $(CURDIR))
VISUAL_RUN   := VISUAL_KIT_IMAGE=$(VISUAL_IMAGE) visual/.kit/run.sh

visual/.kit/run.sh: visual/Dockerfile
	docker build -q -t $(VISUAL_IMAGE) - < visual/Dockerfile
	mkdir -p visual/.kit && docker run --rm $(VISUAL_IMAGE) host-files | tar -x -C visual/.kit

screenshots: visual/.kit/run.sh ## README screenshots into docs/screenshots (committed)
	$(VISUAL_RUN) readme

screenshots-landing: visual/.kit/run.sh ## Landing stills and loops into OUT
	$(VISUAL_RUN) landing --out "$(or $(OUT),landing-shots)"

screenshots-audit: visual/.kit/run.sh ## Audit evidence into docs/audit/assets/$(AUDIT) (local only)
	$(VISUAL_RUN) audit --slug "$(AUDIT)"

visual-check: visual/.kit/run.sh ## Before/after of ROUTES against BASE (default origin/main)
	$(VISUAL_RUN) check $(if $(ROUTES),--routes "$(ROUTES)") $(if $(BASE),--base "$(BASE)")
```

## Targets

| Target | Renders | Output | Committed |
| --- | --- | --- | --- |
| `make screenshots` | scenes tagged `presentation`, README profile | `docs/screenshots/` (replaced wholesale) | yes |
| `make screenshots-landing OUT=dir` | scenes tagged `presentation`, landing profile | `dir/` | by personal-landing |
| `make screenshots-audit AUDIT=YYYY-MM-<scope>-<topic>` | scenes tagged `audit`, every form factor | `docs/audit/assets/<slug>/` | no |
| `make visual-check [ROUTES=a,b] [BASE=ref]` | scenes tagged `check`, base vs working tree | `visual/.out/check/` | no |

`ROUTES` is a comma-separated list of scene names or paths. A path matches itself and everything below it
(`/cases` and `/cases/` both match `/cases`, `/cases?x` and `/cases/ADV-024-A`).

Only one check runs per checkout at a time (they share the base cache, the worktree and the demo port).

## Profiles

All presentation shots are **viewport-sized** unless the scene says `fullPage`; check and audit shots are
**full-page** unless the scene says otherwise.

| Profile | Schemes | Viewports (CSS px, device scale) | File names |
| --- | --- | --- | --- |
| `landing` | dark | `desktop` 1600×1000 @2x · `mobile` 390×844 @3x | `<scene>-<desktop\|mobile>.png`, loops `<scene>.{webm,mp4,jpg}` |
| `readme` | light, dark | `desktop` 1440×900 @2x · `mobile` 390×844 @2x | `<scene>-<light\|dark>-<desktop\|mobile>.png`, loops as above |
| `check` | dark, light | `desktop` 1440×900 @1x · `phone` 390×844 @1x | `<scene>.<viewport>.<scheme>.png` |
| `audit` | dark, light | `desktop` 1440×900 @1x · `tablet` 820×1180 @1x · `phone` 390×844 @2x | `<scene>.<viewport>.<scheme>.png` |

`viewports` in `scenes.json` overrides or adds viewports for `readme`, `check` and `audit`; the `landing` spec is
fixed for every app and ignores it.

Chromium rounds the phone viewport at @3x, so a landing mobile shot can be one device pixel short
(2531 instead of 2532). Consumers must allow ±1px.

**Loops** (`landing` and `readme` only, scenes with `loop`): a silent recording of the scene's steps at the
profile's first viewport, trimmed to start after the page settled and to end `tailSec` after the last
on-screen change. webm (VP9), mp4 (H.264, `yuv420p`, faststart) and a jpg poster of the last frame. All
three or none.

## `visual/scenes.json`

Validated against [`schema/scenes.schema.json`](schema/scenes.schema.json) (`visual-kit validate`).

```jsonc
{
  "demo": { "start": "make demo", "url": "http://127.0.0.1:3985", "readyOutput": "DEMO_READY",
            "startTimeoutSec": 300, "env": { "DEMO_NOW": "2026-10-01T09:00:00Z" } },
  "baseDeps": [".venv", "frontend/node_modules"],   // symlinked into the base worktree of a check
  "clock": "2026-10-01T09:00:00Z",                  // fixed browser time; pair with DEMO_NOW
  "mask": [".timestamp"],                           // painted over in every shot
  "scenes": [
    { "name": "triage-filters", "path": "/triage", "tags": ["check", "presentation"],
      "steps": [{ "click": "[aria-label='Filter by proceeding']" }],
      "settle": "[role=menu]",
      "target": "[data-shot=triage-table]", "padding": 24,
      "emphasis": { "spotlight": "[role=menu]", "dim": 0.5 } },
    { "name": "graph", "path": "/cases/ADV-024-A", "tags": ["presentation"], "loop": { "tailSec": 1.5 },
      "steps": [{ "click": "text=Timeline" }, { "wait": 800 }] }
  ]
}
```

- **Tags** pick the workflows a scene belongs to: `presentation` (README and landing), `check`, `audit`.
  Default `["check", "audit"]`.
- **Steps** are declarative, one action each: `click`, `hover`, `fill` (+`value`), `press`, `waitFor`,
  `wait` (≤ 5000 ms). Selectors are Playwright selectors. There is no code in the config.
- **`target`** shoots one element plus `padding` (default 24) at full device scale, instead of the page. This is
  how a landing tile gets a sharp feature shot instead of a crop of a full screenshot. `clip` is a fixed
  rectangle. They are mutually exclusive, and neither combines with `loop`.
- **`emphasis`** dims everything but a `spotlight` element (an overlay over its box, so popovers and other
  positioned elements stay where they are), or injects `css`.
- **`hooks.mjs`** may export `beforeScene({context, page, scene, variant, cfg})` (log in, dismiss a banner) and
  `settle({page, scene})` (app-specific readiness, e.g. wait for charts). Throw to fail the scene.

## What the runner does to every shot

Fonts are loaded, nothing is `aria-busy`, the network is idle, animations and transitions are disabled, the
caret is hidden, reduced motion is on, and `Date` is fixed to `clock`. Anything still volatile goes in `mask`.
A scene that fails is reported and the others still render; the run exits non-zero.

**Output is replaced wholesale, and only when it is safe.** A run renders into a staging folder and swaps it in
at the end. If any scene failed, a presentation or audit run leaves the previous output untouched (a flaky scene
must never delete a committed screenshot); only a `check` publishes a partial set, because the other side
compares whatever rendered. A folder is replaced only if it is empty or carries the `.visual-kit` marker the
tool wrote; anything else needs `--force` once (the first `make screenshots` over hand-made screenshots). The
launcher refuses an output that is the repository, one of its parents, or inside `.git`. A loop is
`webm` + `mp4` + `jpg` or nothing, and a missing ffmpeg fails the run instead of dropping the loop silently.

**Loopback only.** `demo.url` must be loopback (schema), the CLI refuses a non-loopback `--url`, and a scene
path that would leave the demo (`//host/x`) is refused, so a capture never reaches another host.

A `check` renders **both sides with the working tree's `scenes.json` and `hooks.mjs`**, so the comparison
varies only the app. A scene whose steps need UI the base does not have yet (the new filter you just added)
fails on the base, which the report shows as **new**; a scene that fails on the working tree fails the check
after the report is written.

A `check` (and an `audit`) also records per shot: axe violations (rule, impact, node count), console errors, horizontal
overflow, and controls without an accessible name. The report shows what changed against the base.

## What personal-landing validates

For each app it pulls with `make screenshots-landing OUT=<dir>`:

- only `*.png`, `*.webm`, `*.mp4`, `*.jpg` files (the `.visual-kit` marker is ignored);
- stills named `<scene>-desktop.png` / `<scene>-mobile.png`, 3200×2000 / 1170×2532 (±1px) for viewport-sized
  scenes (a `target` scene has the element's size, so only the ratio-to-scale rule applies);
- each loop as a complete `webm` + `mp4` + `jpg` triplet.

## Determinism checklist for a new repo

1. Seed relative dates from one anchor (`DEMO_NOW`), and run the demo server under that clock.
2. Set `clock` to the same instant.
3. `mask` or seed away anything random: avatars, ids, "n seconds ago".
4. Run `make visual-check` twice on an unchanged tree: the report must say `0 changed`.
