require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

if (!BOT_TOKEN || !ADMIN_CHAT_ID) {
  console.warn('WARNING: BOT_TOKEN or ADMIN_CHAT_ID not set in .env file!');
}

// In-memory store of payment requests.
// Structure: { [uniqueId]: { status, details, messageId, createdAt } }
// NOTE: This resets if the server restarts. For production, swap this
// for a real database (e.g. SQLite, MongoDB, Redis).
const payments = {};

// Helper: generate a unique, hard-to-guess ID per user/request
function generateUniqueId() {
  return crypto.randomBytes(16).toString('hex'); // 32-char hex string
}

// Clean up old pending requests every hour (older than 24h)
setInterval(() => {
  const now = Date.now();
  for (const id in payments) {
    if (now - payments[id].createdAt > 24 * 60 * 60 * 1000) {
      delete payments[id];
    }
  }
}, 60 * 60 * 1000);

// --- 1. User submits payment details from the HTML form ---
app.post('/api/submit', async (req, res) => {
  try {
    const { tnxNo, amount, attNo } = req.body;

    if (!tnxNo || !amount || !attNo) {
      return res.status(400).json({ error: 'Tnx No, Amount and ATT No are all required.' });
    }

    const id = generateUniqueId();
    payments[id] = {
      status: 'pending',
      details: { tnxNo, amount, attNo },
      messageId: null,
      createdAt: Date.now(),
    };

    const text =
      `🔔 *New Payment Request*\n\n` +
      `🧾 Tnx No: ${escapeMd(tnxNo)}\n` +
      `💰 Amount: ${escapeMd(String(amount))}\n` +
      `📱 ATT No: ${escapeMd(attNo)}\n` +
      `\n🆔 Ref: \`${id}\``;

    const tgRes = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: ADMIN_CHAT_ID,
        text,
        parse_mode: 'MarkdownV2',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Confirm', callback_data: `confirm_${id}` },
              { text: '❌ Reject', callback_data: `reject_${id}` },
            ],
          ],
        },
      }),
    });

    const tgData = await tgRes.json();
    if (tgData.ok) {
      payments[id].messageId = tgData.result.message_id;
    } else {
      console.error('Telegram sendMessage failed:', tgData);
    }

    res.json({ id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// --- 2. HTML page polls this endpoint to check confirmation status ---
app.get('/api/status/:id', (req, res) => {
  const record = payments[req.params.id];
  if (!record) return res.status(404).json({ error: 'Not found' });
  res.json({ status: record.status, details: record.details });
});

// --- 3. Telegram webhook: receives button clicks from the admin ---
app.post('/webhook', async (req, res) => {
  try {
    const update = req.body;

    if (update.callback_query) {
      const cb = update.callback_query;
      const data = cb.data || '';

      let action = null;
      let id = null;
      if (data.startsWith('confirm_')) {
        action = 'confirm';
        id = data.slice('confirm_'.length);
      } else if (data.startsWith('reject_')) {
        action = 'reject';
        id = data.slice('reject_'.length);
      }

      const record = id ? payments[id] : null;

      if (record && action) {
        record.status = action === 'confirm' ? 'confirmed' : 'rejected';

        await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            callback_query_id: cb.id,
            text: action === 'confirm' ? 'Payment confirmed ✅' : 'Payment rejected ❌',
          }),
        });

        const statusLine =
          record.status === 'confirmed' ? '✅ *CONFIRMED*' : '❌ *REJECTED*';

        await fetch(`${TELEGRAM_API}/editMessageText`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: cb.message.chat.id,
            message_id: cb.message.message_id,
            text: `${cb.message.text}\n\n${statusLine}`,
            parse_mode: 'MarkdownV2',
          }),
        });
      } else {
        // Unknown / expired reference
        await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            callback_query_id: cb.id,
            text: 'Request not found or expired.',
          }),
        });
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(200); // Always 200 so Telegram doesn't retry endlessly
  }
});

// Escape MarkdownV2 special characters so Telegram doesn't reject the message
function escapeMd(str) {
  return String(str).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
