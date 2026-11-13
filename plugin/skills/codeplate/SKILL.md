---
name: codeplate
description: Browse, install and verify CodePlate (codeplate.io) templates, agent-first starter projects for Godot and Unity games, Tauri desktop apps, Expo mobile apps, Next.js SaaS, AI chat apps, Astro sites, Discord bots and browser extensions. Use when the user asks for a CodePlate template, wants to start a game or app from a template, starter or boilerplate and CodePlate fits, or wants to run a CodePlate project's checks.
argument-hint: "[list [words] | show <id> | get <id> | status | check]"
---

# CodePlate

CodePlate templates are complete, working projects written for coding agents: each has an agent brief (`AGENTS.md`), an interview, recipes and one checks command that prints `CODEPLATE CHECKS: PASS`. This skill drives the `codeplate` script that ships with the plugin. Run it with Node (18 or newer) from any shell:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/codeplate.mjs" <command> [options]
```

Below, `codeplate …` is short for that command line. Quote paths that contain spaces. Exit codes: 0 ok, 1 failed, 2 bad usage, 3 the user has to do something (the output says what).

The user's request: $ARGUMENTS

## Commands

| Goal | Command |
|---|---|
| Browse or search the catalog | `codeplate list [words…] [--tier free\|pro] [--kind game\|app] [--stack godot]` |
| One template's details | `codeplate show <id>` |
| Where the user downloads a template | `codeplate get <id>` |
| Install the template.zip the user downloaded | `codeplate get --zip "<file>" [--dir <parent>] [--name <folder>]` |
| Describe the project here (license, interview, tools) | `codeplate status [dir]` |
| Run the project's checks | `codeplate check [dir]` |

Add `--json` to `list`, `show` and `status` when you want to parse the result.

## How to handle a request

1. **No arguments or "what do you have?"**: run `codeplate list` and summarize it for the user grouped by kind (games, apps, documents), marking Free and Pro. Don't paste the raw table.
2. **Picking a template**: match the user's idea to the catalog with `list <words>` and `show <id>`. Recommend one or two, say why, and say whether it's Free or Pro. Free templates need the credit "Built with CodePlate (codeplate.io)" in what they ship. Pro templates cost money on itch.io (`show` gives the page and price) and need no credit.
3. **Getting it**: every template, Free and Pro, downloads only from its itch.io page, and only the user can download it. You can't fetch it.
   - Run `codeplate get <id>`. It prints what the user has to do (exit 3): download template.zip from the template's itch.io page (free at $0, or after buying a Pro one). Relay it, with the link.
   - When they say where the zip is, confirm the folder with them (default: a new folder named after the template inside the current directory), then run `codeplate get --zip "<file>"`. It refuses a folder that already has files in it; never delete anything to make room. If they unzipped it themselves, work in that folder.
   - **Never ask for or accept a password or card details, and never try to buy or download it for them.**
4. **After installing, hand off to the template's brief.** Work inside the new folder:
   - Read its `AGENTS.md` completely before doing anything else.
   - If `docs/project.md` still contains `<!-- codeplate:project-stub -->`, run the **Interview** from `AGENTS.md` now: one short message, defaults suggested. Write the answers to `docs/project.md` as decisions and remove the marker.
   - Follow the brief's install steps (for Node templates usually `npm install`, sometimes a one-time browser install for the checks).
   - Run `codeplate check "<folder>"` to establish a green baseline before the first change. If a tool is missing (exit 3), tell the user exactly what to install. For Godot, the brief's "Finding Godot" section says where to look; once found, set `GODOT` for the command.
5. **Checks on request**: `codeplate check` (from inside the project, or pass its folder). It passes only on exit 0 *and* a final `CODEPLATE CHECKS: PASS` line. On failure, fix the first failure the output names, then run it again.

From then on, follow the `codeplate:workflow` skill for every change.

## Where the catalog comes from

The script reads `catalog.json` from `https://codeplate.io` by default. `CODEPLATE_BASE_URL` (or `--base-url`) points it somewhere else, such as a local preview of the site; it is not a secret. If the catalog can't be reached, say so plainly and suggest trying again later; don't guess template ids or itch.io pages.
