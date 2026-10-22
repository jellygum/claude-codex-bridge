import { getStaticTOMLValue, parseForESLint } from "toml-eslint-parser";

export const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

// Edit AST value ranges, not regex sections: quoted keys, comments and multiline
// strings can all contain text that looks like a TOML table header.
export function updateCodexConfig(source, servers) {
  const ast = parseForESLint(source).ast;
  const existing = getStaticTOMLValue(ast).mcp_servers ?? {};
  const tables = ast.body[0].body.filter((node) => node.type === "TOMLTable");
  const edits = [];
  let append = "";
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  for (const [name, config] of Object.entries(servers)) {
    const table = tables.find(
      (node) =>
        node.kind === "standard" &&
        node.resolvedKey.length === 2 &&
        node.resolvedKey[0] === "mcp_servers" &&
        node.resolvedKey[1] === name,
    );
    if (existing[name] !== undefined && !table) {
      throw new Error(
        `Use an explicit [mcp_servers.${name}] table instead of inline/dotted definitions; no files were changed.`,
      );
    }
    if (existing[name]?.url !== undefined) {
      throw new Error(
        `${name} is configured as a remote MCP server. Rename it before local registration; no files were changed.`,
      );
    }
    const fields = { command: config.command, args: config.args };
    if (existing[name]?.tool_timeout_sec === undefined) fields.tool_timeout_sec = 600;
    let missing = "";
    for (const [key, value] of Object.entries(fields)) {
      const entry = table?.body.find(
        (node) =>
          node.key.keys.length === 1 && (node.key.keys[0].name ?? node.key.keys[0].value) === key,
      );
      const text = JSON.stringify(value);
      if (entry) edits.push({ start: entry.value.range[0], end: entry.value.range[1], text });
      else missing += `${key} = ${text}${newline}`;
    }
    if (!table) append += `${newline}[mcp_servers.${name}]${newline}${missing}`;
    else if (missing) {
      const lineEnd = source.indexOf("\n", table.range[1]);
      const position = lineEnd === -1 ? source.length : lineEnd + 1;
      edits.push({
        start: position,
        end: position,
        text: (lineEnd === -1 ? newline : "") + missing,
      });
    }
  }
  let result = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  if (append) result += (result && !result.endsWith("\n") ? newline : "") + append;
  // Reject unsupported shapes or conflicting keys before any configuration write.
  parseForESLint(result);
  return result;
}
