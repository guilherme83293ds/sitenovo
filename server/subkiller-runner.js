import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OSINTGRAM_DIR = path.join(__dirname, 'osintgram');
const PYTHON_PATH = path.join(OSINTGRAM_DIR, 'venv', 'Scripts', 'python.exe');
const RUNNER_PY = path.join(__dirname, 'subkiller', 'runner.py');

const DEFAULT_TIMEOUT = 120_000;

export default function subkillerRouter(app) {
  app.post('/api/subkiller/run', async (req, res) => {
    const { target } = req.body;
    if (!target) return res.status(400).json({ error: 'target is required' });

    const proc = spawn(PYTHON_PATH, [RUNNER_PY, target], {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    const timeout = setTimeout(() => {
      proc.kill();
      return res.status(504).json({ error: 'Command timed out' });
    }, DEFAULT_TIMEOUT);

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0 && !stdout) {
        return res.status(500).json({ error: 'Command failed', stderr });
      }
      try {
        const data = JSON.parse(stdout);
        res.json(data);
      } catch {
        res.json({ target, count: 0, results: [], raw: stdout });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      return res.status(500).json({ error: 'Process error: ' + err.message });
    });
  });
}
