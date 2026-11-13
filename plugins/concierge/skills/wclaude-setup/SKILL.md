---
name: wclaude-setup
description: |
    Install or update the `wclaude` command in ~/.local/bin, which opens the
    concierge Claude Code session (tmux session `cc-concierge`, prefix
    configurable via CONCIERGE_PREFIX) from any terminal, creating it on first
    use. Use when the user asks to set up, install, update or fix `wclaude`,
    wants a one-command way to open their concierge, or wants to change the
    folder the concierge starts in, its session-name prefix or its
    permission mode.
    Checks for tmux and claude, never overwrites an existing wclaude without
    showing a diff and asking, and puts ~/.local/bin on PATH. macOS, Linux
    and WSL; native Windows is not supported because tmux is not.
---

# wclaude setup

`wclaude` opens the concierge (see the `concierge` skill):

- The session is named `<prefix>concierge`: `cc-concierge` by default (see
  **Configuration**).
- If that tmux session does not exist, it creates it, detached, in the start
  folder chosen at setup, exports `CONCIERGE_PREFIX` (and
  `CONCIERGE_PERMISSION_MODE`, when set) into it, and types
  `claude -n cc-concierge --remote-control cc-concierge 'Act as my concierge.'`
  (plus `--permission-mode <mode>` when set) into the session's login shell,
  so the user's own PATH and profile apply. The concierge skill reads those
  variables to name workers and launch them in the same mode.
- It then attaches a grouped view of the session, which tmux removes again on
  detach (`destroy-unattached on`). Several terminals can each run `wclaude`
  and share the one concierge.
- Run inside tmux, it switches the current client to the session instead of
  nesting tmux.

Detach with the tmux prefix and `d` (`Ctrl-b d` by default); the concierge
keeps running. Exiting Claude in the session closes it, and the next
`wclaude` starts a fresh one.

The installed file is a self-contained bun script with a `#!/usr/bin/env bun`
line. Its source is `scripts/wclaude/launcher.ts` in this plugin; the
installer copies it with the start folder filled in.

## Platforms

| Platform        | Support                                                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS, Linux    | Supported.                                                                                                                                                                |
| Windows (WSL)   | Supported inside WSL. Install bun, Claude Code and tmux in the WSL distribution, then run this setup from a Claude session in WSL. `wclaude` then works in WSL terminals. |
| Windows, native | Not supported: tmux has no native Windows build. The installer exits with code 2 and says to use WSL.                                                                     |

## Installing

In this skill, **`install` means
`bun "${CLAUDE_PLUGIN_ROOT}/scripts/wclaude/install.ts"`**.

1. **Ask for the start folder.** This is where the concierge session opens,
   usually the folder that holds the user's repositories (for example
   `~/gitrepos`). If the user has no preference, use their home folder,
   which is the default.
2. **Ask for the prefix** only if the user wants something other than
   `cc-` (letters, digits, `-` and `_`; may be empty). Add `--prefix <prefix>`
   to the commands below in that case.
3. **Dry run** and show the user the result:

    ```sh
    install --dir <folder> --dry-run
    ```

    It changes nothing and reports each step.

3. **Act on the dry run:**
    - Exit 1 with `Not installed or not on PATH`: tmux or claude is missing.
      Show the install command it printed (`brew install tmux` on macOS,
      `sudo apt install tmux` on Debian, Ubuntu or WSL, `sudo dnf install tmux`
      on Fedora) and ask whether to run it. `sudo` needs the user to type
      their password, so suggest they run it themselves with `! <command>`.
      Then start again from step 3.
    - Exit 1 for a start folder that does not exist, or an invalid prefix:
      ask again.
    - Exit 3: a different `wclaude` already exists. Show the user the diff it
      printed and ask whether to replace it. Replace it only on a clear yes,
      by adding `--force` in step 5.
5. **Install**, with the same arguments and without `--dry-run`:

    ```sh
    install --dir <folder>            # add --force only if the user agreed in step 4
    ```

    It writes `~/.local/bin/wclaude` (mode 755). Running it again with the
    same folder is a no-op.

6. **PATH.** If `~/.local/bin` is not on PATH, the installer appends one line,
   marked `# added by concierge wclaude-setup`, to `~/.zshrc` (zsh),
   `~/.bash_profile` (bash on macOS), `~/.bashrc` (bash elsewhere) or
   `~/.config/fish/conf.d/concierge-wclaude.fish` (fish). It never adds the
   line twice. For any other shell it says so; tell the user to add
   `~/.local/bin` to PATH themselves. Pass `--no-path` if the user does not
   want their startup file touched. After a PATH change, the user opens a new
   terminal before running `wclaude`.
7. **Tell the user** to run `wclaude` from a terminal. The first time Claude
   opens the start folder it asks for folder trust in the session.

## Options

| Option            | Default        | Meaning                                              |
| ----------------- | -------------- | ---------------------------------------------------- |
| `--dir <folder>`  | home folder    | Folder the concierge session starts in. `~` expands. |
| `--prefix <p>`    | `cc-`          | Default session-name prefix baked into `wclaude`.    |
| `--bin-dir <dir>` | `~/.local/bin` | Where `wclaude` is installed.                        |
| `--dry-run`, `-n` | off            | Report every step, change nothing.                   |
| `--force`         | off            | Replace an existing, different `wclaude`.            |
| `--no-path`       | off            | Never edit a shell startup file.                     |

Exit codes: `0` done, `1` missing tmux or claude, a bad start folder or an
invalid prefix, `2` native Windows, `3` an existing different `wclaude` needs
`--force`.

## Configuration

`wclaude` reads two environment variables at run time; set them in the
shell's startup file to make them permanent.

| Variable                    | Default                         | Meaning                                                                                                                                                 |
| --------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONCIERGE_PREFIX`          | the `--prefix` baked in (`cc-`) | Session-name prefix. The concierge is `<prefix>concierge`, workers are `<prefix><repo>-<task>`.                                                          |
| `CONCIERGE_PERMISSION_MODE` | unset (Claude's default mode)   | Passed to the concierge as `--permission-mode`, for example `auto`. The concierge launches workers in the same mode, so cross-session messages flow. |

Both only affect a session that does not exist yet: they apply the next time
`wclaude` creates the concierge. Changing the prefix while workers are running
leaves those workers on their old names.

## Repositories with AGENTS.md

Many repositories keep their instructions in a root `AGENTS.md`, which the
concierge and its workers rely on. By default Claude Code (2.1.316) reads
`AGENTS.md` only when no `CLAUDE.md`, `.claude/CLAUDE.md` or
`CLAUDE.local.md` exists in the working folder or any folder above it; if one
does, every `AGENTS.md` is skipped, ancestors included. Two common causes:

- a `CLAUDE.md` in a folder above the repositories, such as `~/gitrepos/`;
- a `CLAUDE_CONFIG_DIR` other than `~/.claude`, which makes
  `~/.claude/CLAUDE.md` count as such a folder above.

If either applies, tell the user to add this to their **user** settings
(`~/.claude/settings.json`, or `settings.json` in their `CLAUDE_CONFIG_DIR`).
Project settings ignore it.

```json
{
    "pluginConfigs": {
        "cc-plugin-agents-md@builtin": {
            "options": { "instructionFiles": "claude-md-and-agents-md" }
        }
    }
}
```

To check, put a made-up token such as `PLUM-5150` in a scratch repository's
`AGENTS.md`, run
`claude -p "list the WORD-NNNN tokens in your instructions, without tools" --model haiku < /dev/null`
from it, and remove the token afterwards.

## Changing or removing it

- To change the start folder, run the installer again with the new `--dir`.
  The file differs, so it exits 3 with a diff; confirm with the user and
  re-run with `--force`. The running concierge keeps its folder until its
  session ends.
- To remove it, delete `~/.local/bin/wclaude` and, if wanted, the marked PATH
  line. Ask before deleting either.
