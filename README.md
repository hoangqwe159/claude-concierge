# claude-concierge

A Claude Code plugin marketplace with one plugin, **`concierge`**: a workflow
where you talk to one Claude Code session (the concierge) and it launches,
briefs, checks on and closes Claude Code worker sessions in tmux, each on its
own git worktree and branch.

This is a private repository for personal use. It has no license file.

## What's in it

| Skill           | What it does                                                                                                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `concierge`     | The concierge role: delegation rules, session naming, a bare-repository worktree layout, worker launch and briefing, permission modes, secrets hygiene, two-hourly status checks and closing workers.              |
| `wclaude-setup` | Installs the `wclaude` command in `~/.local/bin`. `wclaude` opens the concierge tmux session from any terminal, creating it on first use, and attaches a grouped view so several terminals can share it. |

```text
.claude-plugin/marketplace.json     marketplace "claude-concierge"
plugins/concierge/
  .claude-plugin/plugin.json        plugin "concierge"
  skills/concierge/SKILL.md
  skills/wclaude-setup/SKILL.md
  scripts/wclaude/launcher.ts       source of ~/.local/bin/wclaude
  scripts/wclaude/install.ts        installer used by wclaude-setup
  tests/                            bun tests
```

## Requirements

- [Claude Code](https://docs.claude.com/en/docs/claude-code/setup)
- [bun](https://bun.sh) (wclaude and its installer are bun scripts)
- tmux
- macOS, Linux or WSL. Native Windows is not supported, because tmux has no
  native Windows build; use WSL.
- Optional: `gh` (GitHub) or `az` with the `azure-devops` extension, for the
  PR checks the workers and concierge run.

## Install

In Claude Code:

```text
/plugin marketplace add hoangqwe159/claude-concierge
/plugin install concierge@claude-concierge
```

The repository is private, so your git credentials (for example `gh auth
login`) must be able to read it.

## Quick start

1. In any Claude Code session, ask: "set up wclaude". The `wclaude-setup`
   skill asks for the folder the concierge should start in (for example
   `~/gitrepos`), shows a dry run, then installs `~/.local/bin/wclaude`.
2. Open a new terminal and run `wclaude`. It creates the tmux session
   `cc-concierge`, starts Claude in it with "Act as my concierge.", and
   attaches.
3. Ask the concierge for work: "in myapp, fix the login redirect bug". It
   prepares a worktree, writes a brief, and launches a worker session named
   `cc-myapp-<task>`. Workers report `IN PROGRESS`, `BLOCKED` or `COMPLETE`.
4. Detach with `Ctrl-b d`; everything keeps running. Run `wclaude` again to
   come back. Attach to a worker with `tmux new -t cc-myapp-<task>`.

## Configuration

| Setting                     | How                                                                 | Default         |
| --------------------------- | ------------------------------------------------------------------- | --------------- |
| Session-name prefix         | `CONCIERGE_PREFIX` env var, or `--prefix` when installing `wclaude` | `cc-`           |
| Concierge permission mode   | `CONCIERGE_PERMISSION_MODE` env var, for example `auto`             | Claude default  |
| Concierge start folder      | `--dir` when installing `wclaude`                                   | home folder     |
| Worker registry             | `${XDG_STATE_HOME:-~/.local/state}/concierge/<name>/`               | as shown        |

With the default prefix the concierge is `cc-concierge` and workers are
`cc-<repo>-<task>`. `wclaude` exports both variables into the concierge's
tmux session, and the concierge launches workers with the same prefix and the
same permission mode. Matching modes matter: cross-session messages between
sessions in different modes are held for your approval and can expire.
`--dangerously-skip-permissions` for workers is opt-in only.

Settings apply when `wclaude` creates the session; an already running
concierge keeps its old ones.

## Tests

```sh
bun test
```

The tests check the plugin manifest against the marketplace, the skills'
frontmatter and content, the launcher's tmux plan, the installer, and an
end-to-end run of an installed `wclaude` against a fake `tmux` and `claude`.
