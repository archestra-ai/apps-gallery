# Contributing

Submissions to this repo are created **for you by Archestra** — you should not
build a folder or edit `recording.json` by hand. This guide explains what the
automated submission does and what the rules are, so you know what to expect on
your pull request.

## Submitting an app

1. In Archestra, record an app session and open it in the built-in player.
2. Trim to the **final cut** you want to show. Everything sent is derived from
   that final cut (duration, events, transcript, and the thumbnail).
3. Review the drafted one-sentence description and one-shot build prompt, and
   choose a **category** (one of the [canonical categories](./categories.json),
   or a short free-text *Other* if none fit).
4. Click **Share to gallery**, sign in to GitHub, and confirm. Archestra opens a
   PR that adds `apps/<your-login>_<app-slug>/recording.json` (and, when
   available, `thumbnail.png`) on a branch named `submission/<app-slug>`.

Your GitHub **username** and **public profile name** are included with the
submission as the app's author. **Your email is never read, stored, or sent.**

## Rules enforced by CI

- **Submit as many apps as you like.** There's no limit on open submissions per
  person — each app is its own PR.
- **Own-app only.** The folder must be `apps/<your-github-login>_<slug>/` and the
  login must match the PR author.
- **Only two files.** A PR may add `recording.json` and optionally
  `thumbnail.png`, under a single `apps/<...>/` folder — nothing else.
- **Valid, playable bundle.** `recording.json` must pass the bundle schema and
  carry a non-empty app, a positive final-cut duration, a one-sentence
  description, a build prompt, and a category.

## Review & merge

- A maintainer is auto-assigned to your PR, and a Claude review posts feedback.
- Only maintainers (code owners) can approve and merge. PRs from outside
  contributors run CI only after a maintainer approves the run.
- Once merged, your app appears in the gallery on the Archestra website
  shortly after — usually within minutes, occasionally a bit longer since it
  also depends on GitHub's own CDN — with no site redeploy needed.

## Licensing of submissions

By submitting, you confirm the app and recording are yours to share and you grant
Archestra permission to display them in the hackathon gallery. Repository tooling
is under the repo's [LICENSE](./LICENSE).
