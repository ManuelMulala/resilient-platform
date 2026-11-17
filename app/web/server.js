const os = require('os');
const express = require('express');
const mysql = require('mysql2/promise');
const { createClient } = require('redis');
const { SQSClient, SendMessageCommand, SendMessageBatchCommand } = require('@aws-sdk/client-sqs');

// All configuration comes from the ECS task definition (set by CDK). Nothing is hardcoded.
const {
  DB_HOST, DB_USER, DB_PASSWORD, DB_NAME = 'shop',
  REDIS_HOST, REDIS_PORT = '6379', QUEUE_URL, PORT = '3000',
} = process.env;
const VERSION = process.env.APP_VERSION || 'v2';
const CACHE_KEY = 'products:all';
const CACHE_TTL_SECONDS = 60;

const pool = mysql.createPool({
  host: DB_HOST, user: DB_USER, password: DB_PASSWORD, database: DB_NAME,
  connectionLimit: 5, waitForConnections: true,
});

const redis = createClient({
  socket: { host: REDIS_HOST, port: Number(REDIS_PORT), reconnectStrategy: (n) => Math.min(n * 200, 5000) },
});
redis.on('error', (e) => console.error('redis error:', e.message));

const sqs = new SQSClient({});

async function withRetry(name, fn, attempts = 30, delayMs = 5000) {
  for (let i = 1; i <= attempts; i++) {
    try { await fn(); console.log(`${name}: ok`); return true; }
    catch (e) { console.error(`${name}: attempt ${i}/${attempts} failed: ${e.message}`); }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

async function initSchema() {
  await pool.query(`CREATE TABLE IF NOT EXISTS products (
    id INT PRIMARY KEY, name VARCHAR(100) NOT NULL, price DECIMAL(10,2) NOT NULL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS orders (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, message_id VARCHAR(100) UNIQUE,
    product_id INT NOT NULL, quantity INT NOT NULL, processed_by VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await pool.query(`INSERT IGNORE INTO products (id, name, price) VALUES
    (1, 'Wireless Earbuds', 3499.00), (2, 'Smartphone 128GB', 24999.00),
    (3, 'Home Router Wi-Fi 6', 7999.00), (4, 'Power Bank 20000mAh', 2999.00)`);
}

const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok', version: VERSION }));

app.get('/', (req, res) => res.json({
  service: 'shop-web', version: VERSION, task: os.hostname(),
  endpoints: ['GET /products', 'POST /orders', 'POST /orders/burst?count=N', 'GET /orders', 'GET /health'],
}));

// Cache-aside: read from Redis, fall back to MySQL on a miss, then populate the cache
app.get('/products', async (req, res) => {
  try {
    if (redis.isReady) {
      const cached = await redis.get(CACHE_KEY);
      if (cached) {
        res.set('X-Cache', 'HIT');
        return res.json(JSON.parse(cached));
      }
    }
    const started = Date.now();
    const [rows] = await pool.query('SELECT id, name, price FROM products ORDER BY id');
    const body = { source: 'database', queryMs: Date.now() - started, products: rows };
    if (redis.isReady) {
      await redis.set(CACHE_KEY, JSON.stringify({ ...body, source: 'cache' }), { EX: CACHE_TTL_SECONDS });
    }
    res.set('X-Cache', redis.isReady ? 'MISS' : 'BYPASS');
    res.json(body);
  } catch (e) {
    console.error('GET /products failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Decoupling: the web tier only enqueues; the worker does the slow processing
app.post('/orders', async (req, res) => {
  const productId = Number(req.body.productId ?? 1);
  const quantity = Number(req.body.quantity ?? 1);
  if (!Number.isInteger(productId) || !Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
    return res.status(400).json({ error: 'productId and quantity (1-100) must be integers' });
  }
  try {
    const out = await sqs.send(new SendMessageCommand({
      QueueUrl: QUEUE_URL,
      MessageBody: JSON.stringify({ productId, quantity, requestedAt: new Date().toISOString() }),
    }));
    res.status(202).json({ queued: true, messageId: out.MessageId });
  } catch (e) {
    console.error('POST /orders failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Demo helper for the scaling proof: queues up to 2000 orders in batches of 10
app.post('/orders/burst', async (req, res) => {
  const count = Math.min(Math.max(parseInt(req.query.count || '100', 10) || 1, 1), 2000);
  let queued = 0;
  try {
    for (let i = 0; i < count; i += 10) {
      const entries = [];
      for (let j = i; j < Math.min(i + 10, count); j++) {
        entries.push({
          Id: String(j),
          MessageBody: JSON.stringify({ productId: (j % 4) + 1, quantity: 1, requestedAt: new Date().toISOString(), burst: true }),
        });
      }
      const out = await sqs.send(new SendMessageBatchCommand({ QueueUrl: QUEUE_URL, Entries: entries }));
      queued += (out.Successful || []).length;
    }
    res.status(202).json({ requested: count, queued });
  } catch (e) {
    console.error('POST /orders/burst failed:', e.message);
    res.status(500).json({ error: e.message, queued });
  }
});

app.get('/orders', async (req, res) => {
  try {
    const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM orders');
    const [recent] = await pool.query(
      'SELECT id, product_id, quantity, processed_by, created_at FROM orders ORDER BY id DESC LIMIT 20');
    res.json({ total, recent });
  } catch (e) {
    console.error('GET /orders failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const server = app.listen(Number(PORT), () => console.log(`shop-web ${VERSION} listening on ${PORT}`));
redis.connect().catch((e) => console.error('redis connect failed:', e.message));
withRetry('schema init', initSchema);

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down');
  server.close();
  await Promise.allSettled([redis.quit(), pool.end()]);
  process.exit(0);
});
