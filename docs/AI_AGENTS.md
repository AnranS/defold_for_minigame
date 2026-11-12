# Hand it to an AI coding agent

The repository carries a skill, in [`skills/defold-minigame/`](../skills/defold-minigame/SKILL.md). It is the manual an AI coding agent works from: where to find the exporter, which project settings to look at before an export, how the three platforms differ, how to add the Lua SDK, and what it means when the start-up log stops at a certain line. With it installed, "export this Defold project as a WeChat mini game" is enough.

It is in the Agent Skills format: a folder with a `SKILL.md` and a few reference documents. Claude Code, DeepSeek Harness (`dsh`), Codex, and other tools that read that format can use it.

## Install

The skill is on the `main` branch. It was added after v0.1.0 was released and is not in the v0.1.0 archive.

### Claude Code

```text
/plugin install defold-minigame --marketplace AnranS/defold_for_minigame
```

Before Claude Code 2.1.275 it takes two steps:

```text
/plugin marketplace add AnranS/defold_for_minigame
/plugin install defold-minigame@defold-for-minigame
```

In a terminal, write `claude plugin` where these lines have `/plugin`. The plugin is this repository, so the exporter is installed with it and nothing else has to be cloned.

### dsh, Codex, and other tools

Put the folder `skills/defold-minigame` into the tool's skill folder, as a copy or as a symbolic link:

| Tool | This project only | Every project |
|---|---|---|
| DeepSeek Harness (`dsh`) | `<project>/.dsh/skills/` or `<project>/.agents/skills/` | `~/.dsh/skills/` or `~/.agents/skills/` |
| Codex | `<project>/.agents/skills/` | `~/.agents/skills/` |
| Claude Code, without the plugin | `<project>/.claude/skills/` | `~/.claude/skills/` |

`~/.agents/skills/` is read by dsh and by Codex:

```bash
git clone --branch main --depth 1 https://github.com/AnranS/defold_for_minigame.git
mkdir -p ~/.agents/skills
ln -s "$PWD/defold_for_minigame/skills/defold-minigame" ~/.agents/skills/defold-minigame
```

- With a link into a clone, the exporter is right beside the skill and the agent has nothing to download; a `git pull` in the clone updates the skill too.
- A copy of the skill folder alone works as well. An agent that finds no exporter runs the released version through `npx`, or asks where the repository is.
- dsh looks one level deep: `defold-minigame` sits directly in the skill folder, not inside another folder.

### An installer for many tools

Many tools read Agent Skills, and the `skills` command-line tool puts a skill into the folder each of them reads:

```bash
npx skills add AnranS/defold_for_minigame
```

It asks which tools to install for, and whether into this project or for your user.

### What has been tried

| Way | What was done |
|---|---|
| Claude Code plugin | Installed from GitHub with the line above, on Claude Code 2.1.322: the install succeeds, the one skill is found, and the exporter that comes with the plugin runs |
| dsh | Run through the skill loader that ships with dsh 0.1.1-rc.2: the skill is found and read from `<project>/.agents/skills/` (a link) and from the user's `skills/` (a copy), without a warning. No full session was run |
| Codex | The folders are the ones its documentation names; not tried |
| `npx skills add` | The layout follows the discovery rules in its documentation; not tried |

## Using it

Start a new session after installing and say what you want:

- "Export this Defold project as a WeChat mini game. The App ID is …"
- "In Douyin DevTools the start-up log stops at 1/5. Have a look."
- "Add login and a rewarded video to the game."
- "There is no sound on TikTok. Play it through the host's player."

The agent picks the skill up when the task calls for it. To name it yourself, type `/defold-minigame` in Claude Code or `$defold-minigame` in Codex.

A few things stay with you, and the skill tells the agent so:

- **You give the App ID.** The agent asks for it and does not make one up; on TikTok it is the Client Key.
- **You build the HTML5 bundle, or say where bob.jar is.** Choose **Project > Bundle > HTML5 Application** in the Defold editor, or let the agent run bob.jar with the `build` command. It does not download bob.jar, a JDK, or a developer tool without asking.
- **Whether it runs is seen in a developer tool or on a phone.** An export that succeeds has not run. Paste the console lines that begin with `[DefoldMiniGame]` and the agent knows what each one means.
- **Files in the output folder are not edited by hand.** The agent changes the game and the export options, then exports again.

## Without installing

Have the agent read this file before it starts:

```text
https://github.com/AnranS/defold_for_minigame/blob/main/skills/defold-minigame/SKILL.md
```

## What the skill contains

| File | Content |
|---|---|
| `SKILL.md` | Six rules, six steps from finding the exporter to running in a developer tool, common failures, and how the three platforms differ |
| `references/quick-start.md` | The [quick start](QUICK_START.md) |
| `references/usage.md` | The [usage guide](USAGE.md) |
| `references/api.md` | The [Lua SDK reference](API.md) |

The three files under `references/` are generated from the documents in `docs/`; do not edit them. After changing a document, run:

```bash
node scripts/generate_skill_references.mjs
```

The tests check that they are current, that the command-line options and SDK functions `SKILL.md` names exist, and that its version and platform limits are the ones in `support-matrix.json`.

## Updating and removing

- Claude Code: `claude plugin update defold-minigame@defold-for-minigame`, and `claude plugin uninstall defold-minigame@defold-for-minigame` to remove it.
- Installed as a link: `git pull` in the clone; delete the link to remove it.
- Installed as a copy: copy it again; delete the folder to remove it.
