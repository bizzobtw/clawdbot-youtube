const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Redis = require('ioredis');
const basicAuth = require('express-basic-auth');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const REDIS_URL = process.env.REDIS_URL;
const DASHBOARD_USER = process.env.DASHBOARD_USER || 'bizzo';
const DASHBOARD_PASS = process.env.DASHBOARD_PASS || 'clawdbot123';

const redisSub = new Redis(REDIS_URL);
const redis = new Redis(REDIS_URL);

app.use(basicAuth({ users: { [DASHBOARD_USER]: DASHBOARD_PASS }, challenge: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/api/state', async (req, res) => {
  try {
    const [messages, tasks, costs] = await Promise.all([
      redis.lrange('messages', 0, 49),
      redis.lrange('tasks', 0, 29),
      redis.hgetall('costs'),
    ]);
    res.json({
      messages: (messages || []).map(m => JSON.parse(m)),
      tasks: (tasks || []).map(t => JSON.parse(t)),
      costs: costs || {},
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

io.on('connection', (socket) => {
  console.log('[Dashboard] Browser connected');
});

const CHANNELS = ['dashboard:messages','dashboard:agent_status','dashboard:tasks','dashboard:costs','dashboard:alerts'];

redisSub.subscribe(...CHANNELS, (err, count) => {
  if (err) console.error('[Redis]', err);
  else console.log(`[Redis] Subscribed to ${count} channels`);
});

redisSub.on('message', (channel, raw) => {
  try {
    const payload = JSON.parse(raw);
    if (channel === 'dashboard:messages') { redis.lpush('messages', raw); redis.ltrim('messages', 0, 199); }
    if (channel === 'dashboard:tasks') { redis.lpush('tasks', raw); redis.ltrim('tasks', 0, 99); }
    if (channel === 'dashboard:costs') { redis.hset('costs', payload.service, payload.amount); }
    io.emit(channel, payload);
  } catch (err) { console.error('[Redis parse]', err.message); }
});

server.listen(PORT, () => console.log(`[Dashboard] Running on port ${PORT}`));
