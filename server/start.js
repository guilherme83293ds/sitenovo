import { fork } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

process.on('uncaughtException', (err) => { try { process.stderr.write('[ANTI-CRASH] ' + err.message + '\n'); } catch(e){} });
process.on('unhandledRejection', (reason) => { try { process.stderr.write('[ANTI-CRASH] ' + reason + '\n'); } catch(e){} });

const __dirname = dirname(fileURLToPath(import.meta.url));
const botScript = join(__dirname, 'bot-standalone.mjs');

function startBot() {
  const child = fork(botScript, [], { stdio: 'inherit', env: { ...process.env } });
  child.on('exit', (code) => {
    try { process.stderr.write('[BOT] Exited (' + code + '), respawning in 5s\n'); } catch(e){}
    setTimeout(startBot, 5000);
  });
  child.on('error', (err) => {
    try { process.stderr.write('[BOT] Error: ' + err.message + ', respawning in 5s\n'); } catch(e){}
    setTimeout(startBot, 5000);
  });
  return child;
}

if (process.env.DISABLE_BOT !== 'true') {
  startBot();
} else {
  try { process.stdout.write('[BOT] DISABLED\n'); } catch(e){}
}

// Start Nitro SSR server
await import('../.output/server/index.mjs');
