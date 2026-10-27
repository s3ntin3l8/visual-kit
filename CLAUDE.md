# CLAUDE.md: visual-kit

Reproducible screenshots, loops and visual checks for web apps from one pinned Docker image. [CONTRACT.md](CONTRACT.md) is the spec every consuming repo relies on; change it in the same PR as the behaviour.

## Layout

* `src/` runner (capture, compare, loop, metrics, profiles, config); `bin/visual-kit.mjs` is the CLI inside the image
* `host/run.sh` the launcher that runs on the host (boots the demo, calls the image); extracted into consuming repos with `visual-kit host-files`, never copied by hand
* `schema/scenes.schema.json` validates a repo's `visual/scenes.json`
* `fixtures/` a small static site the tests render; `test/unit.test.mjs` (fast), `test/launcher.test.mjs` (host/run.sh against a stub docker; also runs on macOS CI), `test/e2e.test.mjs` (Chromium, ffmpeg: run in the image)

## Rules

* **The Playwright version is pinned in three places that move together:** `package.json`, the `Dockerfile` base image, the `e2e` job container in `.github/workflows/ci.yml`. Dependabot ignores both; bump them by hand in one PR, and expect every consuming repo's shots to shift slightly.
* **Determinism is the product.** Two runs on an unchanged tree must compare as 0 changed; the e2e suite asserts it. Anything that makes a shot depend on time, randomness or the host breaks that promise.
* **Profiles and file names are a contract** (`src/profiles.mjs`, CONTRACT.md, personal-landing's `sync-assets` validation). Changing a size or a name is a breaking change for every consumer.
* `scenes.json` stays declarative: no code in config, app-specific behaviour goes in the repo's `visual/hooks.mjs`.
* Conventional Commits; squash-merge; the release comes from release-please and publishes `ghcr.io/s3ntin3l8/visual-kit`.

## Test

```sh
npm ci && npm run lint && npm run test:unit
docker run --rm --ipc=host -v "$PWD:/repo" -w /repo --entrypoint bash mcr.microsoft.com/playwright:v1.64.1-noble \
  -c "apt-get update -qq && apt-get install -y -qq ffmpeg fonts-noto-color-emoji && node --test test/e2e.test.mjs"
```
