const os = require('os');
const mysql = require('mysql2/promise');
const { SQSClient, ReceiveMessageCommand, DeleteMessageBatchCommand } = require('@aws-sdk/client-sqs');

const { DB_HOST, DB_USER, DB_PASSWORD, DB_NAME = 'shop', QUEUE_URL } = process.env;
const WORK_MS = Number(process.env.WORK_MS || 500); // simulated processing time per order
const WORKER_ID = os.hostname();

const pool = mysql.createPool({
  host: DB_HOST, user: DB_USER, password: DB_PASSWORD, database: DB_NAME,
  connectionLimit: 3, waitForConnections: true,
});
const sqs = new SQSClient({});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let running = true;
process.on('SIGTERM', () => { console.log('SIGTERM: finishing current batch, then stopping'); running = false; });

async function withRetry(name, fn, attempts = 30, delayMs = 5000) {
  for (let i = 1; i <= attempts; i++) {
    try { await fn(); console.log(`${name}: ok`); return true; }
    catch (e) { console.error(`${name}: attempt ${i}/${attempts} failed: ${e.message}`); }
    await sleep(delayMs);
  }
  return false;
}

async function ensureSchema() {
  await pool.query(`CREATE TABLE IF NOT EXISTS orders (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, message_id VARCHAR(100) UNIQUE,
    product_id INT NOT NULL, quantity INT NOT NULL, processed_by VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
}

async function processMessage(m) {
  const order = JSON.parse(m.Body); // invalid JSON throws -> message is retried, then goes to the DLQ
  await sleep(WORK_MS);
  // INSERT IGNORE on the unique message_id makes processing idempotent if SQS delivers twice
  await pool.query(
    'INSERT IGNORE INTO orders (message_id, product_id, quantity, processed_by) VALUES (?, ?, ?, ?)',
    [m.MessageId, order.productId, order.quantity, WORKER_ID]);
}

async function main() {
  if (!(await withRetry('schema init', ensureSchema))) process.exit(1); // let ECS restart the task
  console.log(`worker ${WORKER_ID} polling ${QUEUE_URL} (WORK_MS=${WORK_MS})`);

  while (running) {
    try {
      const { Messages = [] } = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: QUEUE_URL, MaxNumberOfMessages: 10, WaitTimeSeconds: 20, VisibilityTimeout: 60,
      }));
      if (Messages.length === 0) continue;

      const done = [];
      for (const m of Messages) {
        try {
          await processMessage(m);
          done.push({ Id: m.MessageId, ReceiptHandle: m.ReceiptHandle });
        } catch (e) {
          console.error(`message ${m.MessageId} failed: ${e.message}`);
        }
      }
      if (done.length) await sqs.send(new DeleteMessageBatchCommand({ QueueUrl: QUEUE_URL, Entries: done }));
      console.log(`processed ${done.length}/${Messages.length} orders`);
    } catch (e) {
      console.error('poll error:', e.message);
      await sleep(5000);
    }
  }
  await pool.end();
  console.log('worker stopped');
}

main();
