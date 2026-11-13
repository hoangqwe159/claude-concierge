/**
 * concierge — manifest, marketplace entry and skill frontmatter, and a guard
 * that the skills carry nothing specific to one machine, account or employer.
 */
import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const PLUGIN = join(import.meta.dir, "..");
const REPO = join(PLUGIN, "..", "..");
const SKILLS = ["concierge", "wclaude-setup"];

async function frontmatter(skill: string) {
    const text = await readFile(
        join(PLUGIN, "skills", skill, "SKILL.md"),
        "utf8",
    );
    const m = text.match(/^---\n([\s\S]*?)\n---\n/);
    if (!m) throw new Error(`${skill}: no frontmatter`);
    return {
        text,
        meta: Bun.YAML.parse(m[1]) as Record<string, unknown>,
        body: text.slice(m[0].length),
    };
}

describe("manifest", () => {
    test("plugin.json and the marketplace entry agree", async () => {
        const manifest = JSON.parse(
            await readFile(
                join(PLUGIN, ".claude-plugin", "plugin.json"),
                "utf8",
            ),
        );
        expect(manifest.name).toBe("concierge");
        expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
        const market = JSON.parse(
            await readFile(
                join(REPO, ".claude-plugin", "marketplace.json"),
                "utf8",
            ),
        );
        expect(market.name).toBe("claude-concierge");
        const entry = market.plugins.find(
            (p: { name: string }) => p.name === manifest.name,
        );
        expect(entry?.source).toBe("./plugins/concierge");
    });

    test("ships exactly the expected skills", async () => {
        expect((await readdir(join(PLUGIN, "skills"))).sort()).toEqual(SKILLS);
    });
});

describe.each(SKILLS)("skill %s", (skill) => {
    test("frontmatter has a matching name and a trigger description", async () => {
        const { meta, body } = await frontmatter(skill);
        expect(meta.name).toBe(skill);
        expect(typeof meta.description).toBe("string");
        expect((meta.description as string).length).toBeGreaterThan(80);
        expect(body).toMatch(/^\n?# /);
    });

    test("nothing specific to one machine, account or employer", async () => {
        const { text } = await frontmatter(skill);
        expect(text).not.toMatch(/^\s*work\s*$/m); // a bare profile-switch command line
        expect(text).not.toMatch(
            /\bwork &&|CLAUDE_CONFIG_DIR=|\.work\/claude|\/Users\/[a-z]|\/home\/[a-z]/,
        );
        // Remotes are placeholders only: no real organization, owner or URL.
        expect(text).not.toMatch(/ssh\.dev\.azure\.com:v3\/[^<]/);
        expect(text).not.toMatch(/git@github\.com:[^<]/);
        expect(text).not.toMatch(/https:\/\/dev\.azure\.com\//);
    });

    test("session names use the configurable prefix, default cc-", async () => {
        const { text } = await frontmatter(skill);
        expect(text).toContain("cc-concierge");
        expect(text).toContain("CONCIERGE_PREFIX");
    });
});

describe("concierge skill", () => {
    test("the launch recipe starts claude directly in the session's shell", async () => {
        const { body } = await frontmatter("concierge");
        expect(body).toContain(
            "tmux new-session -d -s <name> -c <worktree> -x 220 -y 50",
        );
        expect(body).toMatch(/send-keys -t "=<name>:" "exec claude -n <name>/);
        expect(body).toContain("<prefix><repo>-<task>");
    });

    test("workers default to the concierge's permission mode, skip-permissions is opt-in", async () => {
        const { body } = await frontmatter("concierge");
        expect(body).toContain("--permission-mode");
        expect(body).toContain("CONCIERGE_PERMISSION_MODE");
        expect(body).toMatch(/permission laundering/i);
        expect(body).toMatch(/--dangerously-skip-permissions[^\n]*opt-in/);
        const launch = body.match(/send-keys -t "=<name>:" "exec claude[^\n]*/);
        expect(launch?.[0]).not.toContain("--dangerously-skip-permissions");
    });

    test("secrets hygiene is covered", async () => {
        const { body } = await frontmatter("concierge");
        expect(body).toContain("## Secrets hygiene");
        expect(body).toMatch(/file paths?, never the values?/i);
        expect(body).toMatch(/transcripts?/);
    });

    test("bare-repo layout with the .bare/ pointer-file variant and why", async () => {
        const { body } = await frontmatter("concierge");
        expect(body).toContain(
            `printf 'gitdir: %s/.bare\\n' "$R" > "$R/.git"`,
        );
        expect(body).toContain("Why `.bare/` and not `.git/`");
        expect(body).toContain("worktree repair");
        expect(body).toContain("git@github.com:<owner>/<repo>.git");
        expect(body).toContain("az repos pr show");
        expect(body).toContain("gh pr view");
    });

    test("source section credits the user, not an employer", async () => {
        const { body } = await frontmatter("concierge");
        expect(body).toMatch(/## Source\n\nWritten by the repository owner/);
    });
});
