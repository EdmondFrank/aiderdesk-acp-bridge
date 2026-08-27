#!/usr/bin/env bun
import * as acp from '@agentclientprotocol/sdk';

import { AcpAgent, getVersion } from './agent';
import { DEFAULT_HOST, DEFAULT_PORT, resolvePort } from './constants';
import { fetchJSON } from './http';

function printUsage(): void {
  console.log(`
AiderDesk ACP Bridge — expose AiderDesk to ACP (Agent Client Protocol) clients over stdio.

Usage:
  aiderdesk-acp-bridge [options]

Options:
  -p, --port <port>   AiderDesk server port (default: ${DEFAULT_PORT}, env: AIDER_DESK_PORT)
      --host <host>   AiderDesk server host (default: ${DEFAULT_HOST})
  -v, --version       Print version
  -h, --help          Show this help
`);
}

type CliOptions = {
  host: string;
  port: number | undefined;
  help: boolean;
  version: boolean;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    host: DEFAULT_HOST,
    port: undefined,
    help: false,
    version: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '-v':
      case '--version':
        options.version = true;
        break;
      case '--host': {
        const value = argv[++i];
        if (value !== undefined) {
          options.host = value;
        }
        break;
      }
      case '-p':
      case '--port': {
        const value = argv[++i];
        if (value !== undefined) {
          options.port = parseInt(value, 10);
        }
        break;
      }
      default:
        if (arg.startsWith('--host=')) {
          options.host = arg.slice('--host='.length);
        } else if (arg.startsWith('--port=')) {
          options.port = parseInt(arg.slice('--port='.length), 10);
        }
        break;
    }
  }

  return options;
}

async function startAcpAgent(host: string, port: number): Promise<void> {
  try {
    const health = await fetchJSON(host, port, '/api/health', 'GET');
    const healthData = health.data as { status?: string };
    if (health.status !== 200 || healthData.status !== 'ok') {
      process.stderr.write('Error: AiderDesk server is not healthy.\n');
      process.exit(1);
    }
  } catch {
    process.stderr.write(`Error: AiderDesk server is not running on ${host}:${port}. Start it first with 'aiderdesk' or 'aiderdesk start'.\n`);
    process.exit(1);
  }

  const agentInstance = new AcpAgent(host, port);

  // Bun.stdout.stream()/Bun.stdin.stream() are typed as BunFile streams at
  // compile time but return web streams at runtime; the SDK expects web streams.
  const output = Bun.stdout.stream() as unknown as WritableStream<Uint8Array>;
  const input = Bun.stdin.stream() as unknown as ReadableStream<Uint8Array>;

  const stream = acp.ndJsonStream(output, input);

  const connection = acp
    .agent({ name: 'aiderdesk' })
    .onRequest('initialize', (ctx) => agentInstance.initialize(ctx.params))
    .onRequest('authenticate', (ctx) => agentInstance.authenticate(ctx.params))
    .onRequest('session/new', (ctx) => agentInstance.newSession(ctx.params))
    .onRequest('session/set_config_option', (ctx) => agentInstance.setConfigOption(ctx.params))
    .onRequest('session/prompt', (ctx) => agentInstance.prompt(ctx.params, ctx.client))
    .onNotification('session/cancel', (ctx) => agentInstance.cancel(ctx.params))
    .connect(stream);

  await connection.closed;
}

async function main(): Promise<void> {
  const options = parseArgs(Bun.argv.slice(2));

  if (options.help) {
    printUsage();
    return;
  }
  if (options.version) {
    console.log(getVersion());
    return;
  }

  const port = resolvePort(options.port);
  await startAcpAgent(options.host, port);
}

await main();