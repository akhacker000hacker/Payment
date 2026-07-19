require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Bot 1: Payment Bot (for admin notification & receiving webhook clicks)
const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Bot 2: Main APK Bot (for sending confirmation message to the user)
const MAIN_BOT_TOKEN = process.env.MAIN_BOT_TOKEN || BOT_TOKEN;
const MAIN_TELEGRAM_API = `https://api.telegram.org/bot${MAIN_BOT_TOKEN}`;

const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const BOT_USERNAME = process.env.BOT_USERNAME || '';

if (!BOT_TOKEN || !ADMIN_CHAT_ID) {
  console.warn('WARNING: BOT_TOKEN or ADMIN_CHAT_ID not set in .env file!');
}

// In-memory store of payment requests.
// Structure: { [uniqueId]: { status, details, uid, messageId, createdAt } }
const payments = {};

function generateUniqueId() {
  return crypto.randomBytes(16).toString('hex');
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

// Helper: send a Telegram message to a user via the MAIN APK BOT
async function tgSendUser(chat_id, text, parse_mode = 'MarkdownV2', extra = {}) {
  return fetch(`${MAIN_TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id, text, parse_mode, ...extra }),
  });
}

// --- 1. User submits payment details from the HTML form ---
app.post('/api/submit', async (req, res) => {
  try {
    const { tnxNo, amount, attNo, uid } = req.body;

    if (!tnxNo || !amount || !attNo) {
      return res.status(400).json({ error: 'Tnx No, Amount and ATT No are all required.' });
    }

    const id = generateUniqueId();
    payments[id] = {
      status:    'pending',
      details:   { tnxNo, amount, attNo },
      uid:       uid || null,   // Telegram user chat ID
      messageId: null,
      createdAt: Date.now(),
    };

    // --- Notify admin using Payment Bot ---
    const userLine = uid
      ? `👤 User ID: \`${escapeMd(String(uid))}\``
      : `👤 User ID: _unknown_`;

    const text =
      `🔔 *New Payment Request*\n\n` +
      `${userLine}\n` +
      `🧾 Tnx No: ${escapeMd(tnxNo)}\n` +
      `💰 Amount: ₹${escapeMd(String(amount))}\n` +
      `📱 ATT No: ${escapeMd(attNo)}\n` +
      `\n🆔 Ref: \`${id}\`\n\n` +
      (uid ? `_Use_ \`/addcredit ${uid} <credits>\` _after confirming\\._` : '');

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
              { text: '❌ Reject',  callback_data: `reject_${id}` },
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

// --- 2. Expose bot config to frontend (for redirect button) ---
app.get('/api/config', (req, res) => {
  res.json({ botUsername: BOT_USERNAME });
});

// --- 3. HTML page polls this endpoint to check confirmation status ---
app.get('/api/status/:id', (req, res) => {
  const record = payments[req.params.id];
  if (!record) return res.status(404).json({ error: 'Not found' });
  res.json({ status: record.status, details: record.details });
});

// --- 4. Webhook listener for Payment Bot button clicks ---
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

        // Answer the callback on Payment Bot
        await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            callback_query_id: cb.id,
            text: action === 'confirm' ? 'Payment confirmed ✅' : 'Payment rejected ❌',
          }),
        });

        const statusLine = record.status === 'confirmed' ? '✅ *CONFIRMED*' : '❌ *REJECTED*';

        // Edit original notification message on Payment Bot (removes buttons)
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

        // --- Notify the User via the MAIN APK BOT ---
        const userChatId = record.uid;
        if (userChatId) {
          const { amount } = record.details;
          if (action === 'confirm') {
            await tgSendUser(
              userChatId,
              `✅ *Payment Confirmed\\!*\n\n` +
              `Your payment of *₹${escapeMd(String(amount))}* has been approved\\.\n` +
              `An admin will add your credits shortly\\.\n\n` +
              `Return to the bot and send your APK to continue\\.`,
            );
          } else {
            await tgSendUser(
              userChatId,
              `❌ *Payment Rejected*\n\n` +
              `Your payment of *₹${escapeMd(String(amount))}* could not be verified\\.\n` +
              `Please contact support or try again with the correct details\\.`,
            );
          }
        }
      } else {
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
    res.sendStatus(200); // Send 200 so Telegram doesn't retry
  }
});

// --- 5. Admin API endpoint (backup/fallback if webhook fails or called directly) ---
app.post('/api/admin/:action/:id', async (req, res) => {
  try {
    const { action, id } = req.params;
    const record = payments[id];

    if (!record) {
      return res.status(404).json({ error: 'Payment request not found or expired.' });
    }

    if (action !== 'confirm' && action !== 'reject') {
      return res.status(400).json({ error: 'Invalid action' });
    }

    record.status = action === 'confirm' ? 'confirmed' : 'rejected';

    // --- Notify the User via the MAIN APK BOT ---
    const userChatId = record.uid;
    if (userChatId) {
      const { amount } = record.details;
      if (action === 'confirm') {
        await tgSendUser(
          userChatId,
          `✅ *Payment Confirmed\\!*\n\n` +
          `Your payment of *₹${escapeMd(String(amount))}* has been approved\\.\n` +
          `An admin will add your credits shortly\\.\n\n` +
          `Return to the bot and send your APK to continue\\.`,
        );
      } else {
        await tgSendUser(
          userChatId,
          `❌ *Payment Rejected*\n\n` +
          `Your payment of *₹${escapeMd(String(amount))}* could not be verified\\.\n` +
          `Please contact support or try again with the correct details\\.`,
        );
      }
    }

    res.json({ success: true, status: record.status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Escape MarkdownV2 special characters
function escapeMd(str) {
  return String(str).replace(/[_*[\]()~`>#+=|{}.!\-\\]/g, '\\$&');
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
