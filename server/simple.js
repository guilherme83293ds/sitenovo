import express from 'express';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), '../.output')));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Status do servidor
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    env: process.env.NODE_ENV,
    uptime: process.uptime(),
    memory: process.memoryUsage()
  });
});

// Fallback para SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '../.output/index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ Servidor iniciado na porta ${PORT}`);
  console.log(`📍 http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Encerrando servidor...');
  process.exit(0);
});
