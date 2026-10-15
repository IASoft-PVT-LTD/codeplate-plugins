---
name: workflow
description: How to build on a CodePlate template project (a folder with codeplate.json and AGENTS.md, from codeplate.io). Use before making any change in such a project, and whenever the user asks to customize, extend, re-theme or verify one: read the brief, interview first, record decisions in docs/project.md, use the recipes, keep the checks green and respect the license credit.
---

# Working in a CodePlate project

A CodePlate project has `codeplate.json` at its root. Its `AGENTS.md` is written for you and is the authority on that project: when this skill and `AGENTS.md` disagree, follow `AGENTS.md`. To see where you are, run:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/codeplate.mjs" status
```

It prints the template, its license, whether the interview is done and whether the tools its checks need are installed.

## The loop

1. **Read `AGENTS.md` first, all of it**, once per session, before editing. It has the architecture, the rules that keep the template working, and the exact verify command. `CLAUDE.md` only points to it.
2. **Interview before the first change.** Open `docs/project.md`. If it still contains `<!-- codeplate:project-stub -->`, ask the questions from the brief's **Interview** section in one short message, with defaults the user can accept. Write the answers to `docs/project.md` as short decisions and remove the marker. If it has decisions already, follow them.
3. **Keep `docs/project.md` current.** Add each new decision the user makes (names, colors, rules changed, platforms, tool paths such as the Godot binary). It's how the next session picks up where this one stopped.
4. **Use the recipes.** For a common change, open the matching `docs/recipes/*.md` (indexed under **Recipes** in `AGENTS.md`) and follow its steps; each ends with a Verify section. `docs/customization-map.md` maps "I want X" to the files to touch.
5. **Keep the rules.** The **Rules** section lists invariants, such as where tunables live, text-only scenes, static types, pinned versions, and asset slots listed in `assets.json` with their exact pixel sizes. Don't trade one away to make a change easier; ask the user if a request needs it.
6. **Verify every change.** Run the checks after each change, not only at the end:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/codeplate.mjs" check
   ```
   Green means exit 0 and a final `CODEPLATE CHECKS: PASS` line. If it fails, fix the cause (never weaken or delete a check to get green) and run it again. Then do the brief's manual checks under **Verify**, if any. Tell the user the result.

## Don't touch

- **`.env` files.** They hold the user's secrets. Read `.env.example` to learn the variables, and ask the user to put values in `.env` themselves. The plugin's guard hook blocks file reads of `.env` in CodePlate projects; don't work around it with shell commands.
- **`addons/codeplate/`** in Godot templates. It's the vendored CodePlate add-on that runs the checks, and template updates replace it. Put project code and checks where the brief says (`checks/tests/`, `tools/screenshot_hooks.gd`). The guard hook asks the user before any edit there.
- **The checks themselves**, except to add tests for new features the way the brief describes.

## License and credit

`codeplate status` says which license the copy has (from `codeplate.json` → `license`):

- **CodePlate Free License** (`CodePlate-Free-1.3`): the user may ship and sell what they build, but it must show the credit **"Built with CodePlate (codeplate.io)"** where people can see it, such as an About or credits screen, or the docs. Keep the template's credit in place, and when you rework credits or About screens, keep it visible.
- **CodePlate Pro License** (`CodePlate-Pro-1.4`, with `CODEPLATE-LICENSE.txt` holding the license ID): no credit needed. Keep `CODEPLATE-LICENSE.txt` in the project.
- Under either license, the template itself must not be resold or redistributed *as a template*. If the user wants to publish the project as a starter kit or share the template's source publicly, point them to https://codeplate.io/license/ before doing it.
- Assets must stay original or CC0, recorded in `assets.json` (and `CREDITS.md`). When the user brings new art or audio, record its source and license there. Don't pull in assets of unknown origin.
