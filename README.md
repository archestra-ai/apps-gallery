<p align="center">
  <img src="./logo.svg" alt="Archestra" width="360">
</p>

# Archestra Apps Hackathon — App Gallery

Public submission repo for the **Archestra Apps Hackathon** (July 22–29). Each
submission is an **app-session recording** — a self-contained, replayable demo of
an app someone vibe-coded in Archestra, captured straight from the product and
shared here as a pull request.

Merged submissions are published to the gallery on the Archestra website, where
each app gets a card and a detail page with an interactive-ready player.

> An **App** in Archestra is a rich, interactive UI (charts, dashboards, forms,
> games) built entirely in chat and powered by the MCP servers you already have.
> See [archestra.ai/apps-hackathon](https://www.archestra.ai/apps-hackathon).

## How a submission works

You don't hand-write anything in this repo. In Archestra:

1. Record an app session (Record/Stop in the app surface), then trim it in the
   built-in player to the final cut you want to show.
2. Fill in the one-shot build prompt / description the player drafts for you and
   pick a **category**.
3. Hit **Share to gallery** and sign in to GitHub. Archestra opens a pull request
   here on your behalf.

The PR adds exactly one folder:

```
apps/<your-github-login>_<app-name-slug>/
├── recording.json      # the final-cut recording bundle (the demo)
└── thumbnail.png        # optional opening-frame image (a card is generated if absent)
```

GitHub logins can't contain underscores, so the first `_` splits your login from
the app slug. One folder per app; re-sharing the same app updates the same PR.

## Rules

- **Submit as many apps as you like** — there's no limit on open submissions per
  person.
- **Submit only your own app**, under `apps/<your-login>_.../`. The folder login
  must match the PR author.
- The bundle must be a valid, playable final-cut recording produced by Archestra
  (CI validates the schema, playability, and content). Don't hand-edit it.
- Categories: one of the [canonical set](./categories.json) or a short free-text
  **Other** you chose at submit time.
- Your GitHub username and public profile name are attached as the author. **Your
  email is never read, stored, or sent.**

## What CI does

- **Validation** (`.github/workflows/validate.yml`, read-only): checks every
  changed file is one of your two submission files, then validates
  `recording.json` against the [bundle schema](./schema/app-recording-bundle.mjs),
  plus playability, category, and thumbnail. Runs on `pull_request` and never
  executes anything from the PR.
- **Review**: a maintainer is auto-assigned (round-robin) and a Claude review
  comments on the submission.
- **Owner approval gates everything.** Only a maintainer can approve, and by repo
  policy PR workflows for outside contributors run only after a maintainer
  approves. Merges require a maintainer (code-owner) review; nobody else can merge.
- **On merge**, the gallery index (`index.json`) is regenerated and published to
  the `gallery-index` branch, which the website reads.

## Repo layout

```
apps/                     # submissions, one folder each (apps/<login>_<slug>/)
categories.json           # canonical gallery categories (mirrored on the website)
schema/                   # vendored, pinned copy of the Archestra bundle contract
scripts/                  # validation + index-build tooling (Node, only zod at runtime)
.github/workflows/        # validation, governance, review, publish-index
```

## Local development

```bash
npm install
npm test                  # unit + contract tests
npm run validate:all      # validate every folder under apps/
npm run build-index -- --out index.json   # build the website manifest locally
```

The `schema/` copy is pinned to a platform version and hand-synced; `npm test`
includes a contract test that a real Archestra bundle still validates against it.
