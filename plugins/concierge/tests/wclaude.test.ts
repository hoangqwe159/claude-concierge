/**
 * wclaude — the launcher's tmux plan and the installer.
 *
 * The end-to-end test installs wclaude into a tmp folder and runs it with a
 * fake `tmux` and `claude` on PATH (bun scripts that log their arguments),
 * so it needs a POSIX shebang and is skipped on Windows, where wclaude is
 * unsupported outside WSL anyway.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
    LAUNCHER_PATH,
    PATH_MARKER,
    expandHome,
    install,
    lineDiff,
    parseArgs,
    pathSetup,
    renderLauncher,
} from "../scripts/wclaude/install.ts";
import {
    PROMPT,
    SESSION,
    plan,
    settings,
} from "../scripts/wclaude/launcher.ts";

const BUN_DIR = dirname(process.execPath);
const posix = process.platform !== "win32";

let root: string;
let home: string;
let fakeBin: string;

/** A fake command that appends its argv as one JSON line to calls.log. */
async function fakeCommand(name: string, body = "") {
    const p = join(fakeBin, name);
    await writeFile(
        p,
        `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(join(root, "calls.log"))}, JSON.stringify(process.argv.slice(2)) + "\\n");
${body}
`,
    );
    await chmod(p, 0o755);
}

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "concierge-wclaude-"));
    home = join(root, "home");
    fakeBin = join(root, "fakebin");
    await mkdir(join(home, "repos"), { recursive: true });
    await mkdir(fakeBin, { recursive: true });
    await fakeCommand("tmux");
    await fakeCommand("claude");
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

const env = (over: Record<string, string> = {}) => ({
    PATH: [fakeBin, BUN_DIR].join(":"),
    SHELL: "/bin/zsh",
    ...over,
});

describe("launcher plan", () => {
    test("the default session is cc-concierge", () => {
        expect(SESSION).toBe("cc-concierge");
        expect(settings({})).toEqual({
            prefix: "cc-",
            session: "cc-concierge",
            permissionMode: undefined,
        });
    });

    test("CONCIERGE_PREFIX and CONCIERGE_PERMISSION_MODE are read and validated", () => {
        expect(
            settings({
                CONCIERGE_PREFIX: "me-",
                CONCIERGE_PERMISSION_MODE: "auto",
            }),
        ).toEqual({
            prefix: "me-",
            session: "me-concierge",
            permissionMode: "auto",
        });
        expect(settings({ CONCIERGE_PREFIX: "" })).toMatchObject({
            session: "concierge",
        });
        expect(settings({}, "x_")).toMatchObject({ session: "x_concierge" });
        expect(typeof settings({ CONCIERGE_PREFIX: "a b" })).toBe("string");
        expect(typeof settings({ CONCIERGE_PREFIX: "a.b:" })).toBe("string");
        expect(
            typeof settings({ CONCIERGE_PERMISSION_MODE: "auto; rm -rf ~" }),
        ).toBe("string");
    });

    test("a custom prefix and permission mode reach the session and the claude command", () => {
        const steps = plan({
            exists: false,
            inTmux: true,
            dir: "/w",
            name: "me-concierge",
            prefix: "me-",
            permissionMode: "auto",
        });
        expect(steps[0].slice(-4)).toEqual([
            "-e",
            "CONCIERGE_PREFIX=me-",
            "-e",
            "CONCIERGE_PERMISSION_MODE=auto",
        ]);
        expect(steps[1][4]).toBe(
            `claude -n me-concierge --remote-control me-concierge --permission-mode auto '${PROMPT}'`,
        );
        expect(steps[2]).toEqual([
            "tmux",
            "switch-client",
            "-t",
            "=me-concierge",
        ]);
    });

    test("creates the session, starts claude in its shell, then attaches a grouped view", () => {
        expect(plan({ exists: false, inTmux: false, dir: "/w" })).toEqual([
            [
                "tmux",
                "new-session",
                "-d",
                "-s",
                SESSION,
                "-c",
                "/w",
                "-x",
                "220",
                "-y",
                "50",
                "-e",
                "CONCIERGE_PREFIX=cc-",
            ],
            [
                "tmux",
                "send-keys",
                "-t",
                `=${SESSION}:`,
                `claude -n ${SESSION} --remote-control ${SESSION} '${PROMPT}'`,
                "Enter",
            ],
            [
                "tmux",
                "new-session",
                "-t",
                `=${SESSION}`,
                ";",
                "set-option",
                "destroy-unattached",
                "on",
            ],
        ]);
    });

    test("an existing session is only attached", () => {
        expect(plan({ exists: true, inTmux: false, dir: "/w" })).toEqual([
            [
                "tmux",
                "new-session",
                "-t",
                `=${SESSION}`,
                ";",
                "set-option",
                "destroy-unattached",
                "on",
            ],
        ]);
    });

    test("inside tmux it switches the client instead of nesting", () => {
        expect(plan({ exists: true, inTmux: true, dir: "/w" })).toEqual([
            ["tmux", "switch-client", "-t", `=${SESSION}`],
        ]);
    });

    test("the typed command never mentions a profile switcher", async () => {
        const src = await readFile(LAUNCHER_PATH, "utf8");
        expect(src).not.toMatch(/\bwork\s*&&|CLAUDE_CONFIG_DIR/);
    });
});

describe("installer helpers", () => {
    test("renderLauncher fills in START_DIR as a string literal", async () => {
        const src = await readFile(LAUNCHER_PATH, "utf8");
        const out = renderLauncher(src, `/a "b"/c`);
        expect(out).toContain(`const START_DIR: string = "/a \\"b\\"/c";`);
        expect(out).toContain(`const DEFAULT_PREFIX: string = "cc-";`);
        expect(out.startsWith("#!/usr/bin/env bun\n")).toBe(true);
        expect(renderLauncher(src, "/d", "me-")).toContain(
            `const DEFAULT_PREFIX: string = "me-";`,
        );
        expect(() => renderLauncher(src, "/d", "bad prefix")).toThrow();
    });

    test("expandHome", () => {
        expect(expandHome("~/x", "/h")).toBe("/h/x");
        expect(expandHome("~", "/h")).toBe("/h");
        expect(expandHome("/abs/~x", "/h")).toBe("/abs/~x");
    });

    test("lineDiff marks removed and added lines", () => {
        expect(lineDiff("a\nb\nc", "a\nB\nc")).toBe("  a\n- b\n+ B\n  c");
    });

    test("pathSetup per shell", () => {
        expect(pathSetup("/bin/zsh", "/h/.local/bin", "/h", "darwin")).toEqual({
            file: "/h/.zshrc",
            line: `export PATH="$HOME/.local/bin:$PATH" ${PATH_MARKER}`,
        });
        expect(
            pathSetup("/bin/bash", "/h/.local/bin", "/h", "darwin")?.file,
        ).toBe("/h/.bash_profile");
        expect(
            pathSetup("/bin/bash", "/h/.local/bin", "/h", "linux")?.file,
        ).toBe("/h/.bashrc");
        expect(
            pathSetup("/usr/bin/fish", "/h/.local/bin", "/h", "linux")?.line,
        ).toStartWith("fish_add_path $HOME/.local/bin");
        expect(
            pathSetup("/bin/tcsh", "/h/.local/bin", "/h", "linux"),
        ).toBeNull();
    });

    test("parseArgs", () => {
        expect(parseArgs(["--dir", "~/r", "--dry-run", "--no-path"])).toEqual({
            dir: "~/r",
            dryRun: true,
            addToPath: false,
        });
        expect(parseArgs(["--prefix", "me-"])).toEqual({ prefix: "me-" });
        expect(parseArgs(["--dir"])).toBe("--dir needs a value");
        expect(parseArgs(["--bogus"])).toBe("unknown option --bogus");
    });
});

describe("install", () => {
    const target = () => join(home, ".local", "bin", "wclaude");

    test("native Windows is refused with a pointer to WSL", async () => {
        const r = await install({ home, env: env(), platform: "win32" });
        expect(r.code).toBe(2);
        expect(r.lines.join("\n")).toContain("WSL");
    });

    test("missing tmux or claude stops before writing anything", async () => {
        const r = await install({
            home,
            env: env({ PATH: BUN_DIR }),
            platform: "linux",
        });
        expect(r.code).toBe(1);
        expect(r.lines[0]).toContain("tmux, claude");
        expect(await Bun.file(target()).exists()).toBe(false);
    });

    test("a start folder that does not exist is rejected", async () => {
        const r = await install({
            home,
            dir: "~/nope",
            env: env(),
            platform: "linux",
        });
        expect(r.code).toBe(1);
    });

    test("an invalid prefix is rejected before writing anything", async () => {
        const r = await install({
            home,
            prefix: "a b",
            env: env(),
            platform: "linux",
        });
        expect(r.code).toBe(1);
        expect(await Bun.file(target()).exists()).toBe(false);
    });

    test("dry run changes nothing", async () => {
        const r = await install({
            home,
            dir: "~/repos",
            dryRun: true,
            env: env(),
            platform: "linux",
        });
        expect(r.code).toBe(0);
        expect(r.lines.join("\n")).toContain("would install");
        expect(await Bun.file(target()).exists()).toBe(false);
        expect(await Bun.file(join(home, ".zshrc")).exists()).toBe(false);
    });

    test("installs an executable wclaude and adds the bin folder to PATH once", async () => {
        await writeFile(join(home, ".zshrc"), "alias ll='ls -l'");
        const r = await install({
            home,
            dir: "~/repos",
            env: env(),
            platform: "linux",
        });
        expect(r.code).toBe(0);
        const installed = await readFile(target(), "utf8");
        expect(installed).toContain(
            `const START_DIR: string = ${JSON.stringify(join(home, "repos"))};`,
        );
        if (posix) expect((await stat(target())).mode & 0o111).toBe(0o111);
        const rc = await readFile(join(home, ".zshrc"), "utf8");
        expect(rc).toBe(
            `alias ll='ls -l'\nexport PATH="$HOME/.local/bin:$PATH" ${PATH_MARKER}\n`,
        );

        const again = await install({
            home,
            dir: "~/repos",
            env: env(),
            platform: "linux",
        });
        expect(again.code).toBe(0);
        expect(again.lines[0]).toContain("already up to date");
        expect(await readFile(join(home, ".zshrc"), "utf8")).toBe(rc);
    });

    test("leaves PATH alone when the bin folder is already on it", async () => {
        const binDir = join(home, ".local", "bin");
        const r = await install({
            home,
            env: env({ PATH: [fakeBin, BUN_DIR, binDir].join(":") }),
            platform: "linux",
        });
        expect(r.code).toBe(0);
        expect(r.lines.at(-1)).toContain("is on PATH");
        expect(await Bun.file(join(home, ".zshrc")).exists()).toBe(false);
    });

    test("a different existing wclaude is diffed and kept until --force", async () => {
        await mkdir(dirname(target()), { recursive: true });
        await writeFile(target(), "#!/bin/zsh\necho mine\n");
        const r = await install({
            home,
            dir: "~/repos",
            env: env(),
            platform: "linux",
        });
        expect(r.code).toBe(3);
        const out = r.lines.join("\n");
        expect(out).toContain("- echo mine");
        expect(out).toContain("+ #!/usr/bin/env bun");
        expect(await readFile(target(), "utf8")).toBe(
            "#!/bin/zsh\necho mine\n",
        );

        const forced = await install({
            home,
            dir: "~/repos",
            force: true,
            env: env(),
            platform: "linux",
        });
        expect(forced.code).toBe(0);
        expect(forced.lines[0]).toContain("replace");
        expect(await readFile(target(), "utf8")).toStartWith(
            "#!/usr/bin/env bun",
        );
    });
});

describe.skipIf(!posix)(
    "installed wclaude, end to end with a fake tmux",
    () => {
        async function runWclaude(extraEnv: Record<string, string> = {}) {
            const r = await install({
                home,
                dir: "~/repos",
                env: env(),
                platform: "linux",
            });
            expect(r.code).toBe(0);
            const proc = Bun.spawn([join(home, ".local", "bin", "wclaude")], {
                env: { PATH: env().PATH, HOME: home, ...extraEnv },
                stdout: "pipe",
                stderr: "pipe",
            });
            const code = await proc.exited;
            const logFile = Bun.file(join(root, "calls.log"));
            const text = (await logFile.exists())
                ? (await logFile.text()).trim()
                : "";
            const log = text
                ? text.split("\n").map((l) => JSON.parse(l) as string[])
                : [];
            return { code, log };
        }

        test("no session yet: create it in the chosen folder, start claude, attach", async () => {
            // The fake tmux fails `has-session`, like a server with no such session.
            await fakeCommand(
                "tmux",
                `if (process.argv[2] === "has-session") process.exit(1);`,
            );
            const { code, log } = await runWclaude();
            expect(code).toBe(0);
            expect(log.map((a) => a[0])).toEqual([
                "has-session",
                "new-session",
                "send-keys",
                "new-session",
            ]);
            expect(log[1]).toContain(join(home, "repos"));
            expect(log[2][3]).toBe(
                `claude -n ${SESSION} --remote-control ${SESSION} '${PROMPT}'`,
            );
            expect(log[3]).toEqual([
                "new-session",
                "-t",
                `=${SESSION}`,
                ";",
                "set-option",
                "destroy-unattached",
                "on",
            ]);
        });

        test("CONCIERGE_PREFIX at run time renames the concierge session", async () => {
            await fakeCommand(
                "tmux",
                `if (process.argv[2] === "has-session") process.exit(1);`,
            );
            const { code, log } = await runWclaude({
                CONCIERGE_PREFIX: "me-",
                CONCIERGE_PERMISSION_MODE: "auto",
            });
            expect(code).toBe(0);
            expect(log[0]).toEqual(["has-session", "-t", "=me-concierge"]);
            expect(log[1]).toContain("CONCIERGE_PREFIX=me-");
            expect(log[1]).toContain("CONCIERGE_PERMISSION_MODE=auto");
            expect(log[2][3]).toBe(
                `claude -n me-concierge --remote-control me-concierge --permission-mode auto '${PROMPT}'`,
            );
        });

        test("a bad CONCIERGE_PREFIX stops before touching tmux", async () => {
            const { code, log } = await runWclaude({
                CONCIERGE_PREFIX: "bad;name",
            });
            expect(code).toBe(1);
            expect(log).toEqual([]);
        });

        test("session exists and already in tmux: only switch the client", async () => {
            const { code, log } = await runWclaude({ TMUX: "/tmp/fake,1,0" });
            expect(code).toBe(0);
            expect(log).toEqual([
                ["has-session", "-t", `=${SESSION}`],
                ["switch-client", "-t", `=${SESSION}`],
            ]);
        });
    },
);
