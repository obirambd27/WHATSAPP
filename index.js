const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');

const PORT = process.env.PORT || 8080;
const DATA_PATH = process.env.SESSION_PATH || '/data/.wwebjs_auth';

// Set this in Fly secrets: fly secrets set API_KEY=some-long-random-string
// Your marketing app must send this back in the x-api-key header on every request.
const API_KEY = process.env.API_KEY;

// Set this to the URL in your marketing app (Firebase Cloud Function / Lovable endpoint)
// that should receive incoming WhatsApp replies. Set via: fly secrets set WEBHOOK_URL=https://...
const WEBHOOK_URL = process.env.WEBHOOK_URL;

let lastQr = null;
let status = 'starting';

const app = express();
app.use(express.json());

// Simple auth check for the endpoints your marketing app will call
function requireApiKey(req, res, next) {
    if (!API_KEY) {
        // No key configured — allow through (fine for initial testing, NOT for production)
        return next();
    }
    if (req.headers['x-api-key'] !== API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// Health check — Fly pings this to know the app is alive
app.get('/', (req, res) => {
    res.send(`Status: ${status}`);
});

// View the QR code from a browser (useful since you can't see terminal logs easily on Fly)
app.get('/qr', (req, res) => {
    if (!lastQr) {
        return res.send('No QR code available right now. Status: ' + status);
    }
    res.send(`
        <html>
            <body style="text-align:center; font-family: sans-serif;">
                <h3>Scan this QR with WhatsApp</h3>
                <img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(lastQr)}" />
                <p>Status: ${status}</p>
            </body>
        </html>
    `);
});

// Your marketing app calls this instead of Wasender's send-message endpoint.
// Body: { "number": "971501234567", "message": "Hello from the bot" }
// Number should be digits only, country code first, no + or leading 0.
app.post('/send-message', requireApiKey, async (req, res) => {
    try {
        if (status !== 'ready') {
            return res.status(503).json({ error: 'WhatsApp client not ready yet', status });
        }
        const { number, message } = req.body;
        if (!number || !message) {
            return res.status(400).json({ error: 'number and message are required' });
        }
        const chatId = `${number}@c.us`;

        // Confirm the number is actually on WhatsApp before sending
        const isRegistered = await client.isRegisteredUser(chatId);
        if (!isRegistered) {
            return res.status(404).json({ error: 'Number is not on WhatsApp' });
        }

        const sentMsg = await client.sendMessage(chatId, message);
        res.json({ success: true, messageId: sentMsg.id._serialized });
    } catch (err) {
        console.error('Error sending message:', err);
        res.status(500).json({ error: 'Failed to send message', details: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Web server listening on port ${PORT}`);
});

const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: DATA_PATH
    }),
    puppeteer: {
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    }
});

client.on('qr', (qr) => {
    lastQr = qr;
    status = 'waiting_for_qr_scan';
    console.log('QR RECEIVED — scan it, or visit /qr on this app to view it in a browser');
    qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
    status = 'authenticated';
    console.log('Authenticated!');
});

client.on('auth_failure', (msg) => {
    status = 'auth_failure';
    console.error('AUTHENTICATION FAILURE', msg);
});

client.on('ready', () => {
    status = 'ready';
    lastQr = null;
    console.log('Client is ready!');
});

client.on('disconnected', (reason) => {
    status = 'disconnected';
    console.log('Client was disconnected', reason);
});

// Forward every incoming WhatsApp message to your marketing app,
// the same way Wasender's incoming-message webhook worked.
client.on('message', async (msg) => {
    console.log(`Message from ${msg.from}: ${msg.body}`);

    if (!WEBHOOK_URL) {
        console.warn('WEBHOOK_URL not set — incoming message not forwarded');
        return;
    }

    try {
        await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(API_KEY ? { 'x-api-key': API_KEY } : {})
            },
            body: JSON.stringify({
                from: msg.from.replace('@c.us', ''),
                message: msg.body,
                timestamp: msg.timestamp,
                messageId: msg.id._serialized
            })
        });
    } catch (err) {
        console.error('Failed to forward message to webhook:', err.message);
    }
});

client.initialize();

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('SIGTERM received, shutting down...');
    await client.destroy();
    process.exit(0);
});
