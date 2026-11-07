# Changelog

## [0.4.0](https://github.com/s3ntin3l8/visual-kit/compare/visual-kit-v0.3.0...visual-kit-v0.4.0) (2026-11-07)


### Features

* baseHarness, render the base with the head's harness paths ([#39](https://github.com/s3ntin3l8/visual-kit/issues/39)) ([babecdc](https://github.com/s3ntin3l8/visual-kit/commit/babecdcccf56b788ac4bd5bd7bcff8dd4237f21f))
* check --repeat N, a determinism self-check ([#40](https://github.com/s3ntin3l8/visual-kit/issues/40)) ([0612913](https://github.com/s3ntin3l8/visual-kit/commit/0612913e6c5aead2fe454d475b8f7ce995c267b1))

## [0.3.0](https://github.com/s3ntin3l8/visual-kit/compare/visual-kit-v0.2.0...visual-kit-v0.3.0) (2026-11-06)


### Features

* --fail-on-health, a verdict for new console errors and serious axe nodes ([06a3861](https://github.com/s3ntin3l8/visual-kit/commit/06a3861869bcccd7b5b0c01b9352069b9854bb13))
* configurable pixel tolerance (maxDiffPixels, threshold) in scenes.json ([240fac1](https://github.com/s3ntin3l8/visual-kit/commit/240fac14e604306a5421f42a44eda4ee83220c31))
* motion option so a scene can render with normal (not reduced) motion ([52e7aa6](https://github.com/s3ntin3l8/visual-kit/commit/52e7aa605a1fece53ea81b4a350ea69f96116268))

## [0.2.0](https://github.com/s3ntin3l8/visual-kit/compare/visual-kit-v0.1.0...visual-kit-v0.2.0) (2026-10-27)


### Features

* a host-side hook for demos that need the host ([#22](https://github.com/s3ntin3l8/visual-kit/issues/22)) ([db870bd](https://github.com/s3ntin3l8/visual-kit/commit/db870bd572317aa0e9d1f222e859f8eb1b0529eb))
* loop-only scenes as a first-class option (stills: false) ([#18](https://github.com/s3ntin3l8/visual-kit/issues/18)) ([259c9d8](https://github.com/s3ntin3l8/visual-kit/commit/259c9d824d06a8554e69cde68b7c7a562a90105b))
* optional committed baselines for a few key screens ([#24](https://github.com/s3ntin3l8/visual-kit/issues/24)) ([6a0c277](https://github.com/s3ntin3l8/visual-kit/commit/6a0c27752098440f5fff4ec2f907e4b04d98b6e3))
* record which runner rendered a committed baseline and report a stale set ([#26](https://github.com/s3ntin3l8/visual-kit/issues/26)) ([48eca65](https://github.com/s3ntin3l8/visual-kit/commit/48eca652852a2e35dbab5a45c2328870ee365879))
* run the launcher on macOS, and test its guards ([#17](https://github.com/s3ntin3l8/visual-kit/issues/17)) ([8634005](https://github.com/s3ntin3l8/visual-kit/commit/863400591db02bdc9abceb0f3476702f9a4c7f2c))


### Bug Fixes

* bound a host hook's output and stop a hook the capture gave up on ([#27](https://github.com/s3ntin3l8/visual-kit/issues/27)) ([4a3081a](https://github.com/s3ntin3l8/visual-kit/commit/4a3081ae24bfee58e068ed86d2203018688c48d6))
* let the base cache key include the files baseDeps were built from ([#21](https://github.com/s3ntin3l8/visual-kit/issues/21)) ([1308a72](https://github.com/s3ntin3l8/visual-kit/commit/1308a72d4c376244e19f9fe0de4fd8ec0f229e40))

## 0.1.0 (2026-10-26)


### Features

* find controls cut off at the viewport edge ([#15](https://github.com/s3ntin3l8/visual-kit/issues/15)) ([a62923f](https://github.com/s3ntin3l8/visual-kit/commit/a62923f9e829a3e27bf279bb7639ff01ac141fbe))
* runner, host launcher and image for reproducible screenshots and visual checks ([#2](https://github.com/s3ntin3l8/visual-kit/issues/2)) ([a759e12](https://github.com/s3ntin3l8/visual-kit/commit/a759e124b77f2df4123b32bb22468d5194c1e9b4))
