import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

/** Load only the app's dedicated CUA server, never the other servers in a manifest. */
export async function computerUseConfig(manifest: string): Promise<Record<string, unknown>> {
  const path = resolve(manifest);
  const json = JSON.parse(await readFile(path, "utf8"));
  const server = json.mcpServers?.cua_repl;
  if (!server || typeof server.command !== "string" || !isAbsolute(server.command)
    || !Array.isArray(server.args) || !server.args.every((arg: unknown) => typeof arg === "string")
    || (server.env !== undefined && (typeof server.env !== "object" || server.env === null
      || Array.isArray(server.env) || !Object.values(server.env).every(value => typeof value === "string")))) {
    throw new Error("Computer Use requires the installed app's .mcp.json with an absolute cua_repl command, string args and string env values.");
  }
  return {
    "mcp_servers.cua_repl": {
      command: server.command, args: server.args, env: server.env ?? {},
      cwd: server.cwd ? resolve(dirname(path), server.cwd) : dirname(path),
      enabled: true, enabled_tools: ["js", "js_reset", "turn_ended"],
      startup_timeout_sec: 120,
    },
  };
}
