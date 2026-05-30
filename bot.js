// bot.js - Exogator Universal Bot
const { Telegraf, Markup } = require('telegraf');
const AdmZip = require('adm-zip');
const { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');
const express = require('express');

// ========== CONFIGURATION (Environment Variables) ==========
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY;
const R2_SECRET_KEY = process.env.R2_SECRET_KEY;
const R2_BUCKET = process.env.R2_BUCKET || 'exoincs';
const CF_API_TOKEN = process.env.CF_API_TOKEN;
const CF_ZONE_ID = process.env.CF_ZONE_ID;          // Zone for custom domains (must be managed by Cloudflare)
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_KV_NAMESPACE_ID = process.env.CF_KV_NAMESPACE_ID; // KV namespace ID (for short links, domain mapping)
const WORKER_SHORT_URL = process.env.WORKER_SHORT_URL || 'https://short.exogator.workers.dev'; // Worker for short links
const WORKER_DEPLOY_URL = process.env.WORKER_DEPLOY_URL || 'https://deploy.exogator.workers.dev'; // Worker for serving sites & APKs

const TEMP_DIR = '/tmp/exogator_bot';
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// Initialize R2 client (S3 compatible)
const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY, secretAccessKey: R2_SECRET_KEY },
});

// Helper: upload buffer to R2
async function uploadToR2(key, buffer, contentType) {
    const command = new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
        Body: buffer,
        ContentType: contentType,
    });
    await s3.send(command);
}

// Helper: get file from R2
async function getFromR2(key) {
    const command = new GetObjectCommand({ Bucket: R2_BUCKET, Key: key });
    const response = await s3.send(command);
    const stream = response.Body;
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
}

// Helper: store JSON in KV (via Cloudflare API)
async function kvPut(key, value, ttlSeconds = 0) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`;
    const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: typeof value === 'string' ? value : JSON.stringify(value),
    });
    if (!res.ok) throw new Error(`KV put failed: ${await res.text()}`);
}

async function kvGet(key) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`;
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${CF_API_TOKEN}` } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`KV get failed: ${await res.text()}`);
    const text = await res.text();
    try { return JSON.parse(text); } catch(e) { return text; }
}

// Helper: add CNAME record via Cloudflare API
async function addCNAME(domain, target) {
    const url = `https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'CNAME', name: domain, content: target, ttl: 120, proxied: true }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(`DNS error: ${JSON.stringify(data.errors)}`);
}

async function deleteCNAME(domain) {
    // First get record id
    const listUrl = `https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records?type=CNAME&name=${domain}`;
    const listRes = await fetch(listUrl, { headers: { 'Authorization': `Bearer ${CF_API_TOKEN}` } });
    const listData = await listRes.json();
    const record = listData.result.find(r => r.name === domain);
    if (!record) throw new Error('Record not found');
    const delUrl = `https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records/${record.id}`;
    const delRes = await fetch(delUrl, { method: 'DELETE', headers: { 'Authorization': `Bearer ${CF_API_TOKEN}` } });
    const delData = await delRes.json();
    if (!delData.success) throw new Error('Delete failed');
}

// ---------- BOT COMMANDS ----------
const bot = new Telegraf(BOT_TOKEN);

// Main menu
bot.start(async (ctx) => {
    await ctx.reply('🚀 *Exogator Bot* – All-in-one crypto tool\n\nChoose an option:', {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('🔌 Wallet Connect', 'menu_wallet')],
            [Markup.button.callback('🔗 Short URL', 'menu_short')],
            [Markup.button.callback('📦 Deploy Website', 'menu_deploy')],
            [Markup.button.callback('📱 APK Hosting', 'menu_apk')],
            [Markup.button.callback('🌐 Custom Domains', 'menu_domain')],
            [Markup.button.callback('📊 Stats', 'menu_stats')],
        ])
    });
});

// Wallet connect demo
bot.action('menu_wallet', async (ctx) => {
    const demoUrl = `${WORKER_DEPLOY_URL}/wallet-demo/index.html`; // You need to host a demo page
    await ctx.reply(`🔌 *Wallet Connect Demo*\n\nUse this URL to test wallet connection (your wallet SDK):\n${demoUrl}\n\nYou can also send me a ZIP of your site and I will inject the wallet code.`, { parse_mode: 'Markdown' });
});

// Short URL: user sends long URL after this command
bot.action('menu_short', async (ctx) => {
    await ctx.reply('✂️ *Create Short URL*\n\nSend me a long URL (starting with http:// or https://).', { parse_mode: 'Markdown' });
    ctx.session = { expecting: 'short_url' };
});

// Deploy website: user sends zip
bot.action('menu_deploy', async (ctx) => {
    await ctx.reply('📦 *Deploy Website*\n\nSend me a ZIP file containing your website (must have index.html). I will deploy it and give you a short URL.', { parse_mode: 'Markdown' });
    ctx.session = { expecting: 'deploy_zip' };
});

// APK hosting
bot.action('menu_apk', async (ctx) => {
    await ctx.reply('📱 *APK Hosting*\n\nSend me an APK file. I will give you a download link with tracking.', { parse_mode: 'Markdown' });
    ctx.session = { expecting: 'apk_file' };
});

// Custom domain management (submenu)
bot.action('menu_domain', async (ctx) => {
    await ctx.reply('🌐 *Custom Domains*\n\nChoose action:', Markup.inlineKeyboard([
        [Markup.button.callback('➕ Add domain', 'domain_add')],
        [Markup.button.callback('❌ Delete domain', 'domain_del')],
        [Markup.button.callback('✏️ Edit domain', 'domain_edit')],
        [Markup.button.callback('📋 List domains', 'domain_list')],
        [Markup.button.callback('🔙 Back', 'start_menu')],
    ]));
});

// Stats submenu
bot.action('menu_stats', async (ctx) => {
    await ctx.reply('📊 *Stats*\n\nSend a short code or APK ID to get stats.\nExample: `/stats abc123`', { parse_mode: 'Markdown' });
});

// ========== HANDLING MESSAGES ==========
bot.on('text', async (ctx) => {
    const expecting = ctx.session?.expecting;
    if (expecting === 'short_url') {
        const longUrl = ctx.message.text;
        if (!longUrl.match(/^https?:\/\//)) return ctx.reply('❌ Invalid URL. Must start with http:// or https://');
        const shortCode = Math.random().toString(36).substring(2, 8);
        await kvPut(`short:${shortCode}`, longUrl);
        await kvPut(`views:${shortCode}`, 0);
        const shortUrl = `${WORKER_SHORT_URL}/${shortCode}`;
        await ctx.reply(`✅ Short URL created:\n${shortUrl}\n\nUse /stats ${shortCode} to see clicks.`);
        delete ctx.session.expecting;
    } else {
        await ctx.reply('Please use the buttons to choose an action.', Markup.inlineKeyboard([Markup.button.callback('🔙 Main menu', 'start_menu')]));
    }
});

bot.on('document', async (ctx) => {
    const expecting = ctx.session?.expecting;
    if (expecting === 'deploy_zip') {
        const doc = ctx.message.document;
        if (!doc.file_name.endsWith('.zip')) return ctx.reply('❌ Please send a .zip file.');
        await ctx.reply('⏳ Processing ZIP...');

        // Download zip
        const fileLink = await ctx.telegram.getFileLink(doc.file_id);
        const resp = await fetch(fileLink.href);
        const buffer = await resp.arrayBuffer();
        const zipPath = path.join(TEMP_DIR, `${Date.now()}_${doc.file_name}`);
        fs.writeFileSync(zipPath, Buffer.from(buffer));

        let zip;
        try {
            zip = new AdmZip(zipPath);
        } catch(e) { return ctx.reply('Invalid ZIP'); }
        const entries = zip.getEntries();
        let hasIndex = false;
        for (const e of entries) if (e.entryName === 'index.html') { hasIndex = true; break; }
        if (!hasIndex) return ctx.reply('ZIP must contain index.html at root.');

        // Generate short code
        const shortCode = Math.random().toString(36).substring(2, 8);
        const folder = `sites/${shortCode}/`;

        // Upload each file to R2
        let count = 0;
        for (const entry of entries) {
            if (entry.isDirectory) continue;
            const key = folder + entry.entryName;
            let contentType = 'application/octet-stream';
            if (entry.entryName.endsWith('.html')) contentType = 'text/html';
            else if (entry.entryName.endsWith('.css')) contentType = 'text/css';
            else if (entry.entryName.endsWith('.js')) contentType = 'application/javascript';
            else if (entry.entryName.endsWith('.png')) contentType = 'image/png';
            else if (entry.entryName.endsWith('.jpg')) contentType = 'image/jpeg';
            await uploadToR2(key, entry.getData(), contentType);
            count++;
        }

        // Store mapping
        await kvPut(`deploy:${shortCode}`, { folder, createdAt: new Date().toISOString() });
        const deployUrl = `${WORKER_DEPLOY_URL}/${shortCode}/index.html`;
        await ctx.reply(`✅ Deployed ${count} files.\nURL: ${deployUrl}\n\nShort code: \`${shortCode}\`\nUse /domain add ${shortCode} yourdomain.com to add custom domain.`, { parse_mode: 'Markdown' });
        fs.unlinkSync(zipPath);
        delete ctx.session.expecting;
    } else if (expecting === 'apk_file') {
        const doc = ctx.message.document;
        if (!doc.file_name.endsWith('.apk')) return ctx.reply('❌ Please send an .apk file.');
        await ctx.reply('⏳ Uploading APK...');

        const fileLink = await ctx.telegram.getFileLink(doc.file_id);
        const resp = await fetch(fileLink.href);
        const buffer = await resp.arrayBuffer();
        const fileName = doc.file_name;
        const shortId = Math.random().toString(36).substring(2, 10);
        const key = `apks/${shortId}.apk`;
        await uploadToR2(key, Buffer.from(buffer), 'application/vnd.android.package-archive');

        const originalName = fileName;
        await kvPut(`apk:${shortId}`, { originalName, uploadTime: new Date().toISOString(), downloads: 0 });
        const downloadUrl = `${WORKER_DEPLOY_URL}/apk/${shortId}.apk`;
        await ctx.reply(`✅ APK uploaded.\nDownload link: ${downloadUrl}\nTracking ID: \`${shortId}\`\nUse /stats apk:${shortId} to see downloads.`, { parse_mode: 'Markdown' });
        delete ctx.session.expecting;
    } else {
        await ctx.reply('Please select an option from the menu first.', Markup.inlineKeyboard([Markup.button.callback('🔙 Main menu', 'start_menu')]));
    }
});

// Custom domain subcommands (inline callbacks)
bot.action('domain_add', async (ctx) => {
    await ctx.reply('Send domain info as: `shortcode domain.com`\nExample: `/domain abc123 mysite.com`\n\nYou must own the domain and have it on Cloudflare.', { parse_mode: 'Markdown' });
    ctx.session = { expecting: 'domain_add' };
});

bot.action('domain_del', async (ctx) => {
    await ctx.reply('Send domain to delete: `/domain del mysite.com`', { parse_mode: 'Markdown' });
    ctx.session = { expecting: 'domain_del' };
});

bot.action('domain_edit', async (ctx) => {
    await ctx.reply('Send edit info: `/domain edit olddomain.com newdomain.com`', { parse_mode: 'Markdown' });
    ctx.session = { expecting: 'domain_edit' };
});

bot.action('domain_list', async (ctx) => {
    // List all domain mappings from KV (prefix "domain:")
    // This is complex; for simplicity, just instruct user to use /domain list command
    await ctx.reply('Use `/domain list` command to list all domains.', { parse_mode: 'Markdown' });
});

// Handle text commands for domain management
bot.command('domain', async (ctx) => {
    const args = ctx.message.text.split(' ');
    const sub = args[1];
    if (sub === 'add' && args[2] && args[3]) {
        const shortCode = args[2];
        const domain = args[3];
        // Check if shortCode exists (deploy or short)
        const deploy = await kvGet(`deploy:${shortCode}`);
        const shortLink = await kvGet(`short:${shortCode}`);
        if (!deploy && !shortLink) return ctx.reply('Short code not found.');
        const target = deploy ? WORKER_DEPLOY_URL.replace('https://', '') : WORKER_SHORT_URL.replace('https://', '');
        try {
            await addCNAME(domain, target);
            await kvPut(`domain:${domain}`, { type: deploy ? 'deploy' : 'short', shortCode });
            await ctx.reply(`✅ Domain ${domain} mapped to ${shortCode}. DNS propagation may take a few minutes.`);
        } catch(e) { ctx.reply(`❌ Error: ${e.message}`); }
    } else if (sub === 'del' && args[2]) {
        const domain = args[2];
        const mapping = await kvGet(`domain:${domain}`);
        if (!mapping) return ctx.reply('Domain not found.');
        await deleteCNAME(domain);
        await kvPut(`domain:${domain}`, null); // delete
        await ctx.reply(`✅ Domain ${domain} removed.`);
    } else if (sub === 'edit' && args[2] && args[3]) {
        // similar to add/delete
        await ctx.reply('Feature in progress. Remove and add new.');
    } else if (sub === 'list') {
        // For simplicity, we'll just reply that we don't have a listing yet
        await ctx.reply('To list domains, please use the /domains command (requires additional implementation).');
    } else {
        await ctx.reply('Usage:\n/domain add <shortcode> <domain.com>\n/domain del <domain.com>');
    }
});

bot.command('stats', async (ctx) => {
    const id = ctx.message.text.split(' ')[1];
    if (!id) return ctx.reply('Usage: /stats <shortcode or apk:id>');
    if (id.startsWith('apk:')) {
        const apkId = id.split(':')[1];
        const data = await kvGet(`apk:${apkId}`);
        if (!data) return ctx.reply('APK not found');
        const downloads = data.downloads || 0;
        await ctx.reply(`📊 APK *${apkId}*\nDownloads: ${downloads}\nOriginal name: ${data.originalName}\nUploaded: ${data.uploadTime}`, { parse_mode: 'Markdown' });
    } else {
        const viewsKey = `views:${id}`;
        const views = (await kvGet(viewsKey)) || 0;
        const short = await kvGet(`short:${id}`);
        const deploy = await kvGet(`deploy:${id}`);
        if (!short && !deploy) return ctx.reply('Short code not found.');
        let type = short ? 'Short URL' : 'Website';
        await ctx.reply(`📊 *${type}* \`${id}\`\nViews: ${views}`, { parse_mode: 'Markdown' });
    }
});

bot.action('start_menu', async (ctx) => {
    await ctx.reply('🔙 Returning to main menu.', Markup.inlineKeyboard([
        [Markup.button.callback('🔌 Wallet Connect', 'menu_wallet')],
        [Markup.button.callback('🔗 Short URL', 'menu_short')],
        [Markup.button.callback('📦 Deploy Website', 'menu_deploy')],
        [Markup.button.callback('📱 APK Hosting', 'menu_apk')],
        [Markup.button.callback('🌐 Custom Domains', 'menu_domain')],
        [Markup.button.callback('📊 Stats', 'menu_stats')],
    ]));
});

// Default fallback
bot.on('message', (ctx) => {
    if (!ctx.session?.expecting) {
        ctx.reply('Please use the main menu buttons.', Markup.inlineKeyboard([Markup.button.callback('🔙 Main menu', 'start_menu')]));
    }
});

// ---- Express web server for health checks ----
const app = express();
app.get('/', (req, res) => res.send('Bot is alive'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Web server on ${PORT}`));

// Launch bot
bot.launch().then(() => console.log('Bot started polling'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
