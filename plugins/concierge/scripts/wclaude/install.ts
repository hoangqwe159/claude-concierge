/**
 * install.ts — install the `wclaude` command (see launcher.ts).
 *
 *   bun install.ts [--dir <folder>] [--prefix <prefix>] [--bin-dir <folder>] [--dry-run] [--force] [--no-path]
 *
 * - `--dir` is the folder the concierge session starts in (default: home).
 * - `--prefix` is the default session-name prefix (default `cc-`, so the
 *   concierge is `cc-concierge`). CONCIERGE_PREFIX overrides it at run time.
 * - `--bin-dir` is where `wclaude` goes (default: ~/.local/bin).
 * - An existing `wclaude` that differs is never replaced without `--force`;
 *   the script prints a diff and exits 3 so the agent can ask the user.
 * - When the bin folder is not on PATH, one marked line is appended to the
 *   shell's startup file (zsh, bash or fish). `--no-path` skips that.
 * - `--dry-run` reports every step and changes nothing.
 *
 * Exit codes: 0 done, 1 bad input or missing tmux/claude, 2 unsupported
 * platform (native Windows), 3 an existing different wclaude needs --force.
 *
 * tmux has no native Windows build, so on Windows this runs only inside WSL,
 * where `process.platform` is "linux".
 */
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";

export const LAUNCHER_PATH = join(import.meta.dir, "launcher.ts");
export const PATH_MARKER = "# added by concierge wclaude-setup";

export interface InstallOptions {
    dir?: string;
    /** Default session-name prefix baked into wclaude; `cc-` when unset. */
    prefix?: string;
    binDir?: string;
    dryRun?: boolean;
    force?: boolean;
    addToPath?: boolean;
    /** Injected for tests; default the real home, environment and platform. */
    home?: string;
    env?: Record<string, string | undefined>;
    platform?: NodeJS.Platform;
}

export interface InstallResult {
    code: number;
    lines: string[];
}

/** Expand a leading `~` and make the path absolute. */
export function expandHome(p: string, home: string): string {
    return resolve(p.replace(/^~(?=$|[\\/])/, home));
}

export const DEFAULT_PREFIX = "cc-";
export const PREFIX_PATTERN = /^[A-Za-z0-9_-]{0,32}$/;

/** The launcher with START_DIR and DEFAULT_PREFIX filled in. CRLF is normalised. */
export function renderLauncher(
    source: string,
    dir: string,
    prefix: string = DEFAULT_PREFIX,
): string {
    const dirLine = /^const START_DIR: string = .*$/m;
    const prefixLine = /^const DEFAULT_PREFIX: string = .*$/m;
    if (!dirLine.test(source))
        throw new Error("launcher.ts has no START_DIR line");
    if (!prefixLine.test(source))
        throw new Error("launcher.ts has no DEFAULT_PREFIX line");
    if (!PREFIX_PATTERN.test(prefix))
        throw new Error(`invalid prefix ${prefix}`);
    return source
        .replace(/\r\n/g, "\n")
        .replace(
            dirLine,
            `const START_DIR: string = ${JSON.stringify(dir)}; // set by wclaude-setup`,
        )
        .replace(
            prefixLine,
            `const DEFAULT_PREFIX: string = ${JSON.stringify(prefix)}; // set by wclaude-setup`,
        );
}

/**
 * A line diff of two texts: unchanged lines start with two spaces, removed
 * lines with `- ` and added lines with `+ `. Runs of more than four unchanged
 * lines are cut down to their ends.
 */
export function lineDiff(before: string, after: string): string {
    const a = before.split("\n");
    const b = after.split("\n");
    const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
        new Array<number>(b.length + 1).fill(0),
    );
    for (let i = a.length - 1; i >= 0; i--)
        for (let j = b.length - 1; j >= 0; j--)
            lcs[i][j] =
                a[i] === b[j]
                    ? lcs[i + 1][j + 1] + 1
                    : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    const out: string[] = [];
    let same: string[] = [];
    const flush = () => {
        if (same.length > 4)
            same = [same[0], same[1], "  ...", same.at(-2)!, same.at(-1)!];
        out.push(...same);
        same = [];
    };
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
        if (i < a.length && j < b.length && a[i] === b[j]) {
            same.push(`  ${a[i]}`);
            i++;
            j++;
        } else if (
            i < a.length &&
            (j === b.length || lcs[i + 1][j] >= lcs[i][j + 1])
        ) {
            flush();
            out.push(`- ${a[i++]}`);
        } else {
            flush();
            out.push(`+ ${b[j++]}`);
        }
    }
    flush();
    return out.join("\n");
}

/** The startup file and line that put `binDir` on PATH for this shell. */
export function pathSetup(
    shell: string | undefined,
    binDir: string,
    home: string,
    platform: NodeJS.Platform,
): { file: string; line: string } | null {
    const shown = binDir.startsWith(home + "/")
        ? `$HOME${binDir.slice(home.length)}`
        : binDir;
    switch (basename(shell ?? "")) {
        case "zsh":
            return {
                file: join(home, ".zshrc"),
                line: `export PATH="${shown}:$PATH" ${PATH_MARKER}`,
            };
        case "bash":
            return {
                file: join(
                    home,
                    platform === "darwin" ? ".bash_profile" : ".bashrc",
                ),
                line: `export PATH="${shown}:$PATH" ${PATH_MARKER}`,
            };
        case "fish":
            return {
                file: join(
                    home,
                    ".config",
                    "fish",
                    "conf.d",
                    "concierge-wclaude.fish",
                ),
                line: `fish_add_path ${shown} ${PATH_MARKER}`,
            };
        default:
            return null;
    }
}

async function readIfExists(p: string): Promise<string | null> {
    try {
        return await readFile(p, "utf8");
    } catch {
        return null;
    }
}

async function isDirectory(p: string): Promise<boolean> {
    try {
        return (await stat(p)).isDirectory();
    } catch {
        return false;
    }
}

export async function install(
    opts: InstallOptions = {},
): Promise<InstallResult> {
    const home = opts.home ?? homedir();
    const env = opts.env ?? process.env;
    const platform = opts.platform ?? process.platform;
    const lines: string[] = [];
    const done = (code: number) => ({ code, lines });
    const tag = opts.dryRun ? "would " : "";

    if (platform === "win32") {
        lines.push(
            "wclaude needs tmux, which has no native Windows build, so native Windows is not supported.",
            "Use WSL instead: in a WSL terminal install bun, Claude Code and tmux, then run this setup there.",
        );
        return done(2);
    }

    const dir = expandHome(opts.dir ?? home, home);
    if (!(await isDirectory(dir))) {
        lines.push(
            `The start folder ${dir} does not exist or is not a folder.`,
        );
        return done(1);
    }

    const prefix = opts.prefix ?? DEFAULT_PREFIX;
    if (!PREFIX_PATTERN.test(prefix)) {
        lines.push(
            `The prefix '${prefix}' may only use letters, digits, '-' and '_' (at most 32).`,
        );
        return done(1);
    }

    const missing = ["tmux", "claude"].filter(
        (cmd) => !Bun.which(cmd, { PATH: env.PATH ?? "" }),
    );
    if (missing.length) {
        lines.push(`Not installed or not on PATH: ${missing.join(", ")}.`);
        if (missing.includes("tmux"))
            lines.push(
                "  tmux: brew install tmux (macOS), sudo apt install tmux (Debian, Ubuntu, WSL), sudo dnf install tmux (Fedora).",
            );
        if (missing.includes("claude"))
            lines.push(
                "  claude: https://docs.claude.com/en/docs/claude-code/setup",
            );
        return done(1);
    }

    const binDir = expandHome(opts.binDir ?? join(home, ".local", "bin"), home);
    const target = join(binDir, "wclaude");
    const content = renderLauncher(
        await readFile(LAUNCHER_PATH, "utf8"),
        dir,
        prefix,
    );
    const existing = await readIfExists(target);

    if (existing === content) {
        lines.push(`${target} is already up to date (starts in ${dir}, session ${prefix}concierge).`);
    } else if (existing !== null && !opts.force) {
        lines.push(
            `${target} already exists and differs from the new version:`,
            "",
            lineDiff(existing.replace(/\r\n/g, "\n"), content),
            "",
            "Not replaced. Re-run with --force once the user agrees to replace it.",
        );
        return done(3);
    } else {
        if (!opts.dryRun) {
            await mkdir(binDir, { recursive: true });
            await writeFile(target, content);
            await chmod(target, 0o755);
        }
        lines.push(
            `${tag}${existing === null ? "install" : "replace"} ${target} (starts in ${dir}, session ${prefix}concierge).`,
        );
    }

    const onPath = (env.PATH ?? "")
        .split(delimiter)
        .some((p) => p && resolve(p) === binDir);
    if (onPath) {
        lines.push(`${binDir} is on PATH.`);
    } else if (opts.addToPath === false) {
        lines.push(`${binDir} is not on PATH; left alone (--no-path).`);
    } else {
        const setup = pathSetup(env.SHELL, binDir, home, platform);
        if (!setup) {
            lines.push(
                `${binDir} is not on PATH and the shell (${env.SHELL ?? "unknown"}) is not zsh, bash or fish.`,
                `Add ${binDir} to PATH in the shell's startup file by hand.`,
            );
        } else {
            const rc = (await readIfExists(setup.file)) ?? "";
            if (rc.includes(PATH_MARKER)) {
                lines.push(
                    `${setup.file} already adds ${binDir} to PATH; open a new terminal to pick it up.`,
                );
            } else {
                if (!opts.dryRun) {
                    await mkdir(dirname(setup.file), { recursive: true });
                    const sep = rc === "" || rc.endsWith("\n") ? "" : "\n";
                    await writeFile(setup.file, `${rc}${sep}${setup.line}\n`);
                }
                lines.push(
                    `${tag}add ${binDir} to PATH in ${setup.file}; open a new terminal afterwards.`,
                );
            }
        }
    }
    return done(0);
}

export function parseArgs(argv: string[]): InstallOptions | string {
    const opts: InstallOptions = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const value = () => {
            const v = argv[++i];
            if (v === undefined) throw new Error(`${arg} needs a value`);
            return v;
        };
        try {
            if (arg === "--dir") opts.dir = value();
            else if (arg === "--prefix") opts.prefix = value();
            else if (arg === "--bin-dir") opts.binDir = value();
            else if (arg === "--dry-run" || arg === "-n") opts.dryRun = true;
            else if (arg === "--force") opts.force = true;
            else if (arg === "--no-path") opts.addToPath = false;
            else if (arg === "--help" || arg === "-h") return "help";
            else return `unknown option ${arg}`;
        } catch (e) {
            return (e as Error).message;
        }
    }
    return opts;
}

const USAGE =
    "usage: bun install.ts [--dir <folder>] [--prefix <prefix>] [--bin-dir <folder>] [--dry-run] [--force] [--no-path]";

if (import.meta.main) {
    const parsed = parseArgs(process.argv.slice(2));
    if (typeof parsed === "string") {
        if (parsed !== "help") console.error(parsed);
        console.log(USAGE);
        process.exit(parsed === "help" ? 0 : 1);
    }
    const result = await install(parsed);
    console.log(result.lines.join("\n"));
    process.exit(result.code);
}
