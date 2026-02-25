#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { RPSAgent } from "./agent.js";
import { toolDefinitions, handleToolCall } from "./tools.js";

const FLAG_MAP: Record<string, string> = {
  "--entry-fee": "entry_fee_usdc",
  "--match-id": "match_id",
  "--amount": "amount_usdc",
  "--choice": "choice",
  "--round": "round",
  "--agent-id": "agent_id",
  "--name": "name",
  "--description": "description",
  "--image": "image",
};

function printUsage() {
  console.log(`WatchOrFight CLI — On-chain Rock Paper Scissors

Usage:
  wof <command> [flags]

Commands:`);

  for (const tool of toolDefinitions) {
    const params = Object.entries(tool.inputSchema.properties)
      .map(([k, v]: [string, any]) => {
        const flag = Object.entries(FLAG_MAP).find(([, val]) => val === k)?.[0] ?? `--${k.replace(/_/g, "-")}`;
        const req = tool.inputSchema.required?.includes(k) ? " (required)" : "";
        return `${flag} <${v.type}>${req}`;
      })
      .join("  ");
    console.log(`  ${tool.name.padEnd(20)} ${tool.description.split(".")[0]}.`);
    if (params) console.log(`${"".padEnd(22)} ${params}`);
  }

  console.log(`
Environment:
  PRIVATE_KEY          Your wallet private key (required)
  NETWORK              "testnet" or "mainnet" (default: mainnet)
  RPC_URL              RPC URL (auto-selected by NETWORK)

Examples:
  wof get_balance
  wof play_rps --entry-fee 1.0
  wof get_match --match-id 5
  wof find_open_matches`);
}

function parseFlags(argv: string[]): Record<string, any> {
  const args: Record<string, any> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const mapped = FLAG_MAP[flag];
    if (mapped && i + 1 < argv.length) {
      const raw = argv[++i];
      const num = Number(raw);
      args[mapped] = Number.isNaN(num) ? raw : num;
    }
  }
  return args;
}

async function main() {
  const command = process.argv[2];

  if (!command || command === "--help" || command === "-h") {
    printUsage();
    process.exit(0);
  }

  const validCommands = toolDefinitions.map((t) => t.name);
  if (!validCommands.includes(command)) {
    process.stderr.write(`Error: Unknown command "${command}"\n\n`);
    process.stderr.write(`Valid commands: ${validCommands.join(", ")}\n`);
    process.stderr.write(`Run "wof --help" for usage.\n`);
    process.exit(1);
  }

  const flags = parseFlags(process.argv.slice(3));
  const onProgress = (msg: string) => process.stderr.write(`[wof] ${msg}\n`);

  try {
    const config = loadConfig();
    const agent = new RPSAgent(config);
    process.stderr.write(`[wof] Agent: ${agent.address}\n`);

    const result = await handleToolCall(agent, command, flags, onProgress);
    process.stdout.write(result + "\n");
    process.exit(0);
  } catch (error: any) {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exit(1);
  }
}

main();
