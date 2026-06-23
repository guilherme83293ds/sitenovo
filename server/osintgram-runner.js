import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OSINTGRAM_DIR = path.join(__dirname, 'osintgram');
const CREDENTIALS_PATH = path.join(OSINTGRAM_DIR, 'config', 'credentials.ini');
const PYTHON_PATH = path.join(OSINTGRAM_DIR, 'venv', 'Scripts', 'python.exe');
const MAIN_PY = path.join(OSINTGRAM_DIR, 'main.py');

const DEFAULT_TIMEOUT = 120_000;

export default function osintgramRouter(app) {
  app.post('/api/osintgram/run', async (req, res) => {
    const { target, command, username, password, hikerapi_token } = req.body;

    if (!target || !command) {
      return res.status(400).json({ error: 'target and command are required' });
    }

    let backup = '';
    try {
      backup = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
    } catch { /* no backup */ }

    const iniContent = `[Credentials]\nusername = ${username || ''}\npassword = ${password || ''}\nhikerapi_token = ${hikerapi_token || ''}\n`;

    try {
      fs.writeFileSync(CREDENTIALS_PATH, iniContent, 'utf8');
    } catch (err) {
      return res.status(500).json({ error: 'Failed to write credentials: ' + err.message });
    }

    const proc = spawn(PYTHON_PATH, [MAIN_PY, target, '-c', command], {
      cwd: OSINTGRAM_DIR,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    const timeout = setTimeout(() => {
      proc.kill();
      return res.status(504).json({ error: 'Command timed out', output: stdout });
    }, DEFAULT_TIMEOUT);

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timeout);

      try { fs.writeFileSync(CREDENTIALS_PATH, backup || iniContent, 'utf8'); } catch {}

      if (code !== 0 && !stdout) {
        return res.status(500).json({ error: 'Command failed', stderr, stdout });
      }

      res.json({ target, command, output: stdout, stderr, exitCode: code });
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      try { fs.writeFileSync(CREDENTIALS_PATH, backup || iniContent, 'utf8'); } catch {}
      return res.status(500).json({ error: 'Process error: ' + err.message });
    });
  });
}
