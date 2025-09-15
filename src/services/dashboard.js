import express from 'express';
import bodyParser from 'body-parser';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getRpcStatus } from './rpc.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(bodyParser.json());

// Health endpoint for the app
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: Date.now() });
});

// Expose enriched RPC status with latency percentiles and rotation metadata
app.get('/rpc/status', (req, res) => {
  try {
    const status = getRpcStatus();
    res.status(200).json(status);
  } catch (e) {
    res.status(500).json({ error: e?.message || 'failed to get rpc status' });
  }
});

// Serve user trades
app.get('/trades', (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const filePath = path.join(__dirname, '../../data/trades', `${userId}.jsonl`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'not found' });
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.trim().split('\n').map((l) => JSON.parse(l));
  res.json(lines);
});

// Summary endpoint
app.get('/summary', (req, res) => {
  // Placeholder for PnL summary computation
  res.json({ message: 'Summary not implemented yet' });
});

// Active users endpoint
app.get('/active-users', (req, res) => {
  // Placeholder for active users logic
  res.json({ users: [] });
});

export function startDashboardServer(port = 3000) {
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      console.log(`Dashboard server running on port ${port}`);
      resolve(server);
    });
  });
}

export default app;
