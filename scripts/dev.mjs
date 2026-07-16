import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import net from 'node:net';

const clientArgs = process.argv.slice(2);
const isWindows = process.platform === 'win32';
const npmCommand = isWindows ? 'npm.cmd' : 'npm';
const serverEnv = readEnvFile(new URL('../server/.env', import.meta.url));
const serverPort = Number(process.env.PORT || serverEnv.PORT || 4000);
const serverHost = process.env.HOST || serverEnv.HOST || '0.0.0.0';
const expectedProtocolVersion = 6;
const shouldStartServer = await getShouldStartServer(serverPort, serverHost);

const commands = [
  ...(shouldStartServer
    ? [{
        name: 'server',
        command: npmCommand,
        args: ['--prefix', 'server', 'run', 'dev'],
      }]
    : []),
  {
    name: 'client',
    command: npmCommand,
    args: ['--prefix', 'client', 'run', 'dev', '--', ...clientArgs],
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: `http://localhost:${serverPort}`,
    },
  },
];

let shuttingDown = false;
let children = [];

children = commands.map(({ name, command, args, env = process.env }) => {
  const child = spawn(command, args, {
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: false,
    env,
  });

  pipeWithPrefix(child.stdout, process.stdout, name);
  pipeWithPrefix(child.stderr, process.stderr, name);

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopChildren(child);
    scheduleExit(signal ? 1 : code ?? 1);
  });

  return child;
});

function pipeWithPrefix(stream, output, prefix) {
  let pending = '';
  stream.on('data', (chunk) => {
    pending += chunk.toString();
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (line) output.write(`[${prefix}] ${line}\n`);
    }
  });
  stream.on('end', () => {
    if (pending) output.write(`[${prefix}] ${pending}\n`);
  });
}

function stopChildren(except) {
  for (const child of children) {
    if (child !== except && !child.killed) child.kill();
  }
}

function scheduleExit(code) {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 500).unref();
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  stopChildren();
  scheduleExit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function readEnvFile(fileUrl) {
  try {
    return Object.fromEntries(
      readFileSync(fileUrl, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#') && line.includes('='))
        .map((line) => {
          const index = line.indexOf('=');
          const key = line.slice(0, index).trim();
          const value = line.slice(index + 1).trim().replace(/^["']|["']$/g, '');
          return [key, value];
        })
    );
  } catch {
    return {};
  }
}

async function getShouldStartServer(port, host) {
  if (await isPortAvailable(port, host)) return true;
  if (await hasRunningSkyjoServer(port)) {
    console.log(`Serveur déjà actif sur le port ${port} ; lancement du client seulement.`);
    return false;
  }

  console.error(`Le port serveur ${port} est déjà utilisé par un serveur non compatible. Arrêtez l'ancien serveur ou changez PORT dans server/.env.`);
  process.exit(1);
}

function isPortAvailable(port, host) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', (err) => {
      if (err.code !== 'EADDRINUSE') {
        console.error(`Impossible de tester le port serveur ${port}: ${err.message}`);
      }
      reject(err);
    });
    probe.once('listening', () => {
      probe.close(() => resolve(true));
    });
    probe.listen(port, host);
  }).catch(() => false);
}

async function hasRunningSkyjoServer(port) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 500);
  timeout.unref();

  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data?.ok === true && data?.clientProtocolVersion === expectedProtocolVersion;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
