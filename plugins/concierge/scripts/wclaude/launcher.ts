#!/usr/bin/env bun
/**
 * wclaude — open the concierge Claude Code session in tmux.
 *
 * The concierge session is named `<prefix>concierge`. The prefix comes from
 * the `CONCIERGE_PREFIX` environment variable, else from DEFAULT_PREFIX
 * below (set by wclaude-setup, `cc-` unless the user chose another), so the
 * default session is `cc-concierge`.
 *
 * If that tmux session does not exist, create it detached in START_DIR, with
 * `CONCIERGE_PREFIX` (and `CONCIERGE_PERMISSION_MODE`, when set) exported into
 * it, and type `claude -n <session> --remote-control <session>
 * [--permission-mode <mode>] 'Act as my concierge.'` into its login shell, so
 * the shell's own PATH and profile apply. Then attach a grouped view of it
 * that tmux removes again on detach (`destroy-unattached on`), or, when
 * already inside tmux, switch this client to it.
 *
 * This file is the source of `~/.local/bin/wclaude`. The concierge plugin's
 * `wclaude-setup` skill copies it there with START_DIR and DEFAULT_PREFIX
 * filled in; re-run that skill to change them. It must stay self-contained
 * (no imports outside bun and node built-ins) because it runs from the copy.
 */
import { homedir } from "node:os";

const START_DIR: string = ""; // set by wclaude-setup; empty means the home folder
const DEFAULT_PREFIX: string = "cc-"; // set by wclaude-setup

export const PROMPT = "Act as my concierge.";

/** Session-name prefixes must be safe in tmux names and in a typed shell line. */
export const PREFIX_PATTERN = /^[A-Za-z0-9_-]{0,32}$/;
/** Permission modes are a single word, such as `auto` or `acceptEdits`. */
export const MODE_PATTERN = /^[A-Za-z]{1,32}$/;

export interface Settings {
    prefix: string;
    session: string;
    permissionMode?: string;
}

/** Resolve the prefix and permission mode from the environment. */
export function settings(
    env: Record<string, string | undefined>,
    fallback: string = DEFAULT_PREFIX,
): Settings | string {
    const prefix = env.CONCIERGE_PREFIX ?? fallback;
    if (!PREFIX_PATTERN.test(prefix))
        return `CONCIERGE_PREFIX '${prefix}' may only use letters, digits, '-' and '_' (at most 32).`;
    const mode = env.CONCIERGE_PERMISSION_MODE || undefined;
    if (mode !== undefined && !MODE_PATTERN.test(mode))
        return `CONCIERGE_PERMISSION_MODE '${mode}' is not a permission mode name.`;
    return { prefix, session: `${prefix}concierge`, permissionMode: mode };
}

export const SESSION = (settings({}) as Settings).session;

export interface PlanInput {
    /** Whether the tmux session already exists. */
    exists: boolean;
    /** Whether wclaude runs inside tmux (`$TMUX` is set). */
    inTmux: boolean;
    /** The folder a new session starts in. */
    dir: string;
    /** Session name; defaults to `cc-concierge`. */
    name?: string;
    /** Prefix exported to the session as CONCIERGE_PREFIX. */
    prefix?: string;
    /** Passed as `--permission-mode` and exported as CONCIERGE_PERMISSION_MODE. */
    permissionMode?: string;
}

/** The tmux commands to run, in order. The last one is the attach. */
export function plan(input: PlanInput): string[][] {
    const name = input.name ?? SESSION;
    const prefix = input.prefix ?? DEFAULT_PREFIX;
    const steps: string[][] = [];
    if (!input.exists) {
        const envArgs = ["-e", `CONCIERGE_PREFIX=${prefix}`];
        if (input.permissionMode)
            envArgs.push(
                "-e",
                `CONCIERGE_PERMISSION_MODE=${input.permissionMode}`,
            );
        steps.push([
            "tmux",
            "new-session",
            "-d",
            "-s",
            name,
            "-c",
            input.dir,
            "-x",
            "220",
            "-y",
            "50",
            ...envArgs,
        ]);
        const mode = input.permissionMode
            ? ` --permission-mode ${input.permissionMode}`
            : "";
        steps.push([
            "tmux",
            "send-keys",
            "-t",
            `=${name}:`,
            `claude -n ${name} --remote-control ${name}${mode} '${PROMPT}'`,
            "Enter",
        ]);
    }
    if (input.inTmux) {
        steps.push(["tmux", "switch-client", "-t", `=${name}`]);
    } else {
        // Grouped view (like `tmux new -t`); it is removed again on detach.
        steps.push([
            "tmux",
            "new-session",
            "-t",
            `=${name}`,
            ";",
            "set-option",
            "destroy-unattached",
            "on",
        ]);
    }
    return steps;
}

async function run(argv: string[], inherit: boolean): Promise<number> {
    const io = inherit ? "inherit" : "ignore";
    const proc = Bun.spawn(argv, { stdin: io, stdout: io, stderr: "inherit" });
    return await proc.exited;
}

async function main(): Promise<number> {
    const s = settings(process.env);
    if (typeof s === "string") {
        console.error(`wclaude: ${s}`);
        return 1;
    }
    if (!Bun.which("tmux")) {
        console.error(
            "wclaude: tmux is not installed. Install it (brew install tmux, or sudo apt install tmux) and try again.",
        );
        return 1;
    }
    const exists =
        (await run(["tmux", "has-session", "-t", `=${s.session}`], false)) ===
        0;
    if (!exists && !Bun.which("claude")) {
        console.error(
            "wclaude: claude is not on PATH. Install Claude Code and try again.",
        );
        return 1;
    }
    const steps = plan({
        exists,
        inTmux: Boolean(process.env.TMUX),
        dir: START_DIR || homedir(),
        name: s.session,
        prefix: s.prefix,
        permissionMode: s.permissionMode,
    });
    const attach = steps.pop()!;
    for (const step of steps) {
        const code = await run(step, false);
        if (code !== 0) {
            console.error(`wclaude: '${step.slice(0, 2).join(" ")}' failed`);
            return code;
        }
    }
    return await run(attach, true);
}

if (import.meta.main) {
    process.exit(await main());
}
