Telegram Payment Confirmation System
How it works
The user fills in the payment details on the HTML form: Tnx No., Amount, ATT No.
The server generates a unique reference ID for every submission (a 32-character random code, virtually impossible to guess).
That ID + the details are sent to your Telegram bot (your admin chat) as a message with Confirm / Reject buttons.
When you tap Confirm, only that specific reference ID's status is updated — no other user's page is affected.
The user's browser checks the status every 3 seconds (polling). As soon as it's confirmed, it instantly shows "Payment Confirmed ✅".
This is how multiple users can submit payments at the same time without ever seeing each other's confirmations — each user gets their own unique ID and status.
---
Step 1: Create a Telegram bot
Message @BotFather on Telegram.
Send `/newbot`, give it a name and a username.
Save the token you receive — this is your `BOT_TOKEN`.
Step 2: Find your Chat ID
Send any message to your bot (e.g. `/start`).
Visit in your browser: `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
In the response, look for `"chat":{"id":123456789...}` — that number is your `ADMIN_CHAT_ID`.
Step 3: Project setup
```bash
npm install
cp .env.example .env
# put your BOT_TOKEN and ADMIN_CHAT_ID in the .env file
npm start
```
The server will run locally at `http://localhost:3000`.
Step 4: Deploy (hosting)
Telegram's webhook requires a public HTTPS URL, so button clicks won't work with just a local server. Easy free options:
Render.com (Free web service)
Railway.app
Replit
Any VPS + domain
After deploying, your link will look like: `https://yourapp.onrender.com`
Step 5: Set the Telegram webhook
Once deployed, visit this URL once in your browser:
```
https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook?url=https://yourapp.onrender.com/webhook
```
If successful, the response will show `"ok":true`. From now on, button clicks on the bot go straight to your server.
---
File structure
```
telegram-payment/
├── server.js          ← Backend (Express + Telegram API)
├── public/
│   └── index.html      ← User-facing payment form
├── package.json
├── .env / .env.example
└── README.md
```
Important notes
Data is currently stored in-memory (RAM) — pending requests are lost if the server restarts. For production use, add a real database (SQLite/MongoDB).
`ADMIN_CHAT_ID` is just your/the admin's chat — all users' payment requests arrive here, so you can confirm everything from one place.
If you want to send requests to multiple admins or a group chat, just change `ADMIN_CHAT_ID` to a group id instead.
The fields collected from the user are: Tnx No., Amount, ATT No. — all three are required.
