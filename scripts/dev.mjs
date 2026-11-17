import { spawn } from 'node:child_process';

const children = [];

function startProcess(label, colorCode, command, args) {
  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '1' },
  });

  const prefix = `\x1b[${colorCode}m[${label}]\x1b[0m `;

  child.stdout.on('data', (chunk) => {
    const lines = chunk.toString().split(/\r?\n/);
    for (const line of lines) {
      if (line.trim().length > 0) {
        process.stdout.write(`${prefix}${line}\n`);
      }
    }
  });

  child.stderr.on('data', (chunk) => {
    const lines = chunk.toString().split(/\r?\n/);
    for (const line of lines) {
      if (line.trim().length > 0) {
        process.stderr.write(`${prefix}${line}\n`);
      }
    }
  });

  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      process.stderr.write(`${prefix}exited with code ${code}\n`);
    }
  });

  children.push(child);
  return child;
}

startProcess('server', '36', 'npm', ['run', 'dev', '--workspace=@whiteboard/server']);
startProcess('web', '35', 'npm', ['run', 'dev', '--workspace=@whiteboard/web']);

function shutdown() {
  for (const child of children) {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }
  setTimeout(() => process.exit(0), 300);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
