# CodePlate plugin for Claude Code

Brings [CodePlate](https://codeplate.io) templates into Claude Code. CodePlate templates are agent-first starter projects (Godot and Unity games, Tauri, Expo, Next.js, AI chat, Astro, Discord bots, browser extensions, Typst documents and more), each with a brief for your agent and headless checks that prove a change didn't break anything.

## Install

```
claude plugin marketplace add IASoft-PVT-LTD/codeplate-plugins
claude plugin install codeplate@codeplate
```

Or, inside Claude Code, run `/plugin`, add the marketplace `IASoft-PVT-LTD/codeplate-plugins` and install **codeplate**. It needs Node 18 or newer on PATH and nothing else; it runs the same on Windows, macOS and Linux.

## What you get

- **`/codeplate [list | show <id> | get <id> | status | check]`**: browse and search the catalog, see a template, fetch it into a new folder, and run its checks. Claude also uses it on its own when you ask for a CodePlate template.
- **`codeplate:workflow`**: teaches Claude the CodePlate loop: read the template's `AGENTS.md` first, run its interview, record decisions in `docs/project.md`, use its recipes, run the checks after every change, and keep the license credit on free templates.
- **A guard hook** that only acts inside CodePlate projects: it blocks reading, editing or searching `.env` files (`.env.example` stays readable) and asks before edits to a vendored `addons/codeplate/` folder. It's a guard rail, not a sandbox.

## Fetching templates

- **Free templates:** `get <id>` downloads the zip, checks its SHA-256 against the catalog and unpacks it into a new, empty folder.
- **Pro templates** need a CodePlate plan. The plugin never asks for passwords or tokens: sign in on the template's page in your browser, then either press **Download** and tell Claude where the zip is, or press **Copy link for your agent** and paste the link (it works for a few minutes, for that one version).

`CODEPLATE_BASE_URL` points the plugin at another copy of the site (for example a local preview). It is not a secret.

## License

The plugin is MIT licensed (see [LICENSE](LICENSE)). The templates it downloads have their own licenses: see [codeplate.io/license](https://codeplate.io/license/).
