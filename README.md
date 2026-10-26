# visual-kit

Reproducible screenshots, loops and visual checks for web apps, from one pinned Docker image.

Three jobs, one foundation:

- **Presentation**: curated scenes for the README and for a personal landing page (stills, sharp section
  shots, short silent loops), regenerated whenever the UI changes.
- **Visual check**: for every UI change, render the touched routes on the merge base and on the working tree
  in the same image, and diff them (plus axe, console errors, overflow, unnamed controls).
- **Audit**: every route in every form factor, as evidence for a periodic audit.

Free and self-hosted: Playwright, a pinned Chromium and fonts, `pixelmatch`, ffmpeg. No service, no account.

## How it fits together

```
make visual-check ROUTES=/triage
        │
        ▼
visual/.kit/run.sh  (host)         boots `make demo` for the merge base (a temp worktree), then for the tree
        │
        ▼
docker run visual-kit  (pinned)    capture → PNGs + metrics.json        compare → report/{index.html,summary.md}
```

The demo runs on the host, because it needs the app's own toolchain. Only the browser, fonts and ffmpeg are in
the image, so the pixels are identical on a laptop, in CI and for an agent, and the repo needs no Node. The
launcher is extracted from the image (`visual-kit host-files`), so it always matches the pinned version.

## Use it in a repo

See [CONTRACT.md](CONTRACT.md): a `visual/Dockerfile` (one `FROM` line), a `visual/scenes.json`, and four
make targets.

## Develop

```sh
npm ci
npm run test:unit                       # fast, no browser
docker build -t visual-kit:dev .        # the image
docker run --rm --ipc=host -v "$PWD:/repo" -w /repo --entrypoint bash mcr.microsoft.com/playwright:v1.64.1-noble \
  -c "apt-get update -qq && apt-get install -y -qq ffmpeg fonts-noto-color-emoji && node --test test/e2e.test.mjs"
```

The e2e suite renders a small fixture site (`fixtures/`) and asserts the two promises everything rests on:
the same page renders identically twice, and a known change is found where it shows and nowhere else.

The Playwright version is pinned in three places that move together: `package.json`, the `FROM` line of the
`Dockerfile`, and the `e2e` job's container in `.github/workflows/ci.yml`.

## License

Copyright (C) 2026 Björn Hansen

This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero
General Public License as published by the Free Software Foundation, either version 3 of the License, or (at
your option) any later version. See [LICENSE](LICENSE).
