import { expect, it } from "vitest";
import { getStaticTOMLValue, parseForESLint } from "toml-eslint-parser";
import { execFileSync } from "node:child_process";
// Registration is shipped as plain JS so it works before a TS runtime is installed.
// @ts-expect-error plain-JS helper
import { shellQuote, updateCodexConfig } from "../scripts/lib/register-config.mjs";

const servers = { "ccb-claude": { command: "/path with spaces/node", args: ["/path/claude.mjs"] } };
it("preserves quoted tables, env, timeouts, comments and header-like multiline strings", () => {
  const source = `# user comment
instructions = '''
[mcp_servers.ccb-claude]
command = "this is prose"
'''
[ mcp_servers . "ccb-claude" ] # quoted header
command = "old" # retain comment
args = ["old"]
tool_timeout_sec = 321
[mcp_servers.'ccb-claude'.env]
CCB_CLAUDE_EXE = "/custom/bin/claude"
[projects."/a path"]
trust_level = "trusted"
`;
  const result = updateCodexConfig(source, servers);
  const value = getStaticTOMLValue(parseForESLint(result).ast) as any;
  expect(value.mcp_servers["ccb-claude"]).toEqual({
    ...servers["ccb-claude"],
    tool_timeout_sec: 321,
    env: { CCB_CLAUDE_EXE: "/custom/bin/claude" },
  });
  expect(value.instructions).toContain('command = "this is prose"');
  expect(result).toContain("# retain comment");
  expect(result).toContain('[projects."/a path"]\ntrust_level = "trusted"');
  expect(updateCodexConfig(result, servers)).toBe(result);
});
it.each([
  '[mcp_servers."ccb-claude"] # no newline',
  '[mcp_servers.ccb-claude]\ncommand="old" # eof',
])("handles EOF and missing fields: %s", (source) => {
  const result = updateCodexConfig(source, servers);
  expect(
    (getStaticTOMLValue(parseForESLint(result).ast) as any).mcp_servers["ccb-claude"],
  ).toMatchObject(servers["ccb-claude"]);
  expect(updateCodexConfig(result, servers)).toBe(result);
});
it.each([
  'mcp_servers.ccb-claude.command = "old"',
  '[mcp_servers]\nccb-claude = {command="old"}',
  '[mcp_servers.ccb-claude]\nurl="https://example.com"',
  "bad = [",
])("rejects unsupported or malformed definitions safely: %s", (source) => {
  expect(() => updateCodexConfig(source, servers)).toThrow();
});
it.skipIf(process.platform === "win32")(
  "quotes POSIX paths literally without shell expansion",
  () => {
    const value = "/tmp/space ' $HOME `whoami` $(whoami)/node";
    expect(
      execFileSync("/bin/sh", ["-c", `printf '%s' ${shellQuote(value)}`], { encoding: "utf8" }),
    ).toBe(value);
  },
);
