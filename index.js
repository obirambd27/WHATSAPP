const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');

const PORT = process.env.PORT || 8080;
const DATA_PATH = process.env.SESSION_PATH || '/data/.wwebjs_auth';

let lastQr = null;
let status = 'starting';

const app = express();

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

// Example handler — replace with your own logic
client.on('message', async (msg) => {
    console.log(`Message from ${msg.from}: ${msg.body}`);
    if (msg.body === '!ping') {
        await msg.reply('pong');
    }
});

client.initialize();

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('SIGTERM received, shutting down...');
    await client.destroy();
    process.exit(0);
});
