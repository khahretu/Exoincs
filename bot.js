const { Telegraf, Markup } = require('telegraf');
const AdmZip = require('adm-zip');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');
const express = require('express');

// ========== ENVIRONMENT VARIABLES ==========
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY;
const R2_SECRET_KEY = process.env.R2_SECRET_KEY;
const R2_BUCKET = process.env.R2_BUCKET || 'exoincs';
const CF_API_TOKEN = process.env.CF_API_TOKEN;
const CF_ZONE_ID = process.env.CF_ZONE_ID;
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_KV_NAMESPACE_ID = process.env.CF_KV_NAMESPACE_ID;
const WORKER_SHORT_URL = process.env.WORKER_SHORT_URL || 'https://short.exogator.workers.dev';
const WORKER_DEPLOY_URL = process.env.WORKER_DEPLOY_URL || 'https://deploy.exogator.workers.dev';

const TEMP_DIR = '/tmp/exogator_bot';
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// R2 client
const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY, secretAccessKey: R2_SECRET_KEY },
});

// ---------- Helper: R2 operations ----------
async function uploadToR2(key, buffer, contentType) {
    await s3.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: buffer, ContentType: contentType }));
}
async function getFromR2(key) {
    const obj = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    const chunks = [];
    for await (const chunk of obj.Body) chunks.push(chunk);
    return Buffer.concat(chunks);
}

// ---------- Helper: Cloudflare KV API ----------
async function kvPut(key, value) {
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
async function kvDelete(key) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`;
    const res = await fetch(url, { method: 'DELETE', headers: { 'Authorization': `Bearer ${CF_API_TOKEN}` } });
    if (!res.ok && res.status !== 404) throw new Error(`KV delete failed: ${await res.text()}`);
}

// ---------- Helper: DNS (CNAME) ----------
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
    const listUrl = `https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records?type=CNAME&name=${domain}`;
    const list = await fetch(listUrl, { headers: { 'Authorization': `Bearer ${CF_API_TOKEN}` } });
    const listData = await list.json();
    const record = listData.result.find(r => r.name === domain);
    if (!record) throw new Error('Record not found');
    const delUrl = `https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records/${record.id}`;
    const delRes = await fetch(delUrl, { method: 'DELETE', headers: { 'Authorization': `Bearer ${CF_API_TOKEN}` } });
    const delData = await delRes.json();
    if (!delData.success) throw new Error('Delete failed');
}

// ---------- Bot Initialization ----------
const bot = new Telegraf(BOT_TOKEN);

// Session middleware (simple memory store)
bot.use(async (ctx, next) => {
    if (!ctx.session) ctx.session = {};
    return next();
});

// Main menu
bot.start(async (ctx) => {
    ctx.session = {};
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

// ==================== WALLET CONNECT (with config) ====================
bot.action('menu_wallet', async (ctx) => {
    ctx.session.walletConfig = { theme: 2, exogatorId: '', towsteps: 1, auto: 1 };
    await ctx.reply('⚙️ *Wallet Connect Configuration*\nSelect Modal Theme:', {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('1️⃣ Light', 'wallet_theme_1')],
            [Markup.button.callback('2️⃣ Dark', 'wallet_theme_2')],
            [Markup.button.callback('3️⃣ Neon', 'wallet_theme_3')],
            [Markup.button.callback('4️⃣ Classic', 'wallet_theme_4')],
            [Markup.button.callback('🔙 Back', 'start_menu')]
        ])
    });
});
bot.action(/wallet_theme_(\d)/, async (ctx) => {
    const theme = parseInt(ctx.match[1]);
    ctx.session.walletConfig.theme = theme;
    await ctx.reply(`✅ Theme set to ${theme}\n\nNow send me your *Exogator ID* (or type /skip to use default).`, { parse_mode: 'Markdown' });
    ctx.session.expecting = 'wallet_exoid';
});
bot.on('text', async (ctx) => {
    if (ctx.session.expecting === 'wallet_exoid') {
        let exoId = ctx.message.text.trim();
        if (exoId === '/skip') exoId = `user_${ctx.from.id}`;
        ctx.session.walletConfig.exogatorId = exoId;
        ctx.session.expecting = null;
        await ctx.reply(`✅ Exogator ID: \`${exoId}\`\n\nTwo‑step mode?`, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✅ Enabled', 'wallet_towsteps_1')],
                [Markup.button.callback('❌ Disabled', 'wallet_towsteps_0')],
            ])
        });
    } else if (ctx.session.expecting === 'short_url_long') {
        const longUrl = ctx.message.text;
        if (!/^https?:\/\//.test(longUrl)) return ctx.reply('❌ Invalid URL. Must start with http:// or https://');
        const shortCode = Math.random().toString(36).substring(2, 8);
        await kvPut(`short:${shortCode}`, longUrl);
        await kvPut(`views:${shortCode}`, 0);
        const shortUrl = `${WORKER_SHORT_URL}/${shortCode}`;
        await ctx.reply(`✅ Short URL created:\n${shortUrl}\n\nUse /stats ${shortCode} to see clicks.`);
        ctx.session.expecting = null;
        // Return to short submenu
        await ctx.reply('🔗 *Short URL Manager*', { parse_mode: 'Markdown', ...shortUrlKeyboard() });
    } else if (ctx.session.expecting === 'domain_add') {
        const parts = ctx.message.text.split(' ');
        if (parts.length !== 2) return ctx.reply('Send as: `shortcode domain.com`', { parse_mode: 'Markdown' });
        const [shortCode, domain] = parts;
        const deploy = await kvGet(`deploy:${shortCode}`);
        const short = await kvGet(`short:${shortCode}`);
        if (!deploy && !short) return ctx.reply('Short code not found.');
        const target = deploy ? WORKER_DEPLOY_URL.replace('https://', '') : WORKER_SHORT_URL.replace('https://', '');
        try {
            await addCNAME(domain, target);
            await kvPut(`domain:${domain}`, { type: deploy ? 'deploy' : 'short', shortCode });
            await ctx.reply(`✅ Domain ${domain} mapped to ${shortCode}.`);
        } catch(e) { ctx.reply(`❌ Error: ${e.message}`); }
        ctx.session.expecting = null;
        await ctx.reply('🌐 *Custom Domains*', { parse_mode: 'Markdown', ...domainKeyboard() });
    } else if (ctx.session.expecting === 'domain_del') {
        const domain = ctx.message.text.trim();
        try {
            await deleteCNAME(domain);
            await kvDelete(`domain:${domain}`);
            await ctx.reply(`✅ Domain ${domain} removed.`);
        } catch(e) { ctx.reply(`❌ Error: ${e.message}`); }
        ctx.session.expecting = null;
        await ctx.reply('🌐 *Custom Domains*', { parse_mode: 'Markdown', ...domainKeyboard() });
    } else {
        // fallback
        await ctx.reply('Please use the menu buttons.', Markup.inlineKeyboard([Markup.button.callback('🔙 Main menu', 'start_menu')]));
    }
});
bot.action(/wallet_towsteps_(\d)/, async (ctx) => {
    const towsteps = parseInt(ctx.match[1]);
    ctx.session.walletConfig.towsteps = towsteps;
    await ctx.reply(towsteps ? '✅ Two-step enabled' : '❌ Two-step disabled');
    await ctx.reply('Auto‑connect on page load?', Markup.inlineKeyboard([
        [Markup.button.callback('✅ Yes', 'wallet_auto_1')],
        [Markup.button.callback('❌ No', 'wallet_auto_0')],
    ]));
});
bot.action(/wallet_auto_(\d)/, async (ctx) => {
    const auto = parseInt(ctx.match[1]);
    ctx.session.walletConfig.auto = auto;
    const cfg = ctx.session.walletConfig;
    const demoUrl = `${WORKER_DEPLOY_URL}/wallet-demo?theme=${cfg.theme}&exo=${cfg.exogatorId}&towsteps=${cfg.towsteps}&auto=${cfg.auto}`;
    await ctx.reply(`✅ Configuration saved!\n\n🔗 *Demo Link:*\n${demoUrl}\n\nYou can also send me a ZIP and I will inject these settings.`, { parse_mode: 'Markdown' });
    await ctx.reply('🔌 *Wallet Connect*', { parse_mode: 'Markdown', ...walletKeyboard() });
});

// ==================== SHORT URL SUBMENU ====================
function shortUrlKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('➕ Create New', 'short_create')],
        [Markup.button.callback('📊 Stats', 'short_stats')],
        [Markup.button.callback('📋 My Links', 'short_mylinks')],
        [Markup.button.callback('🌐 Custom Domain', 'short_domain')],
        [Markup.button.callback('🔙 Back', 'start_menu')],
    ]);
}
bot.action('menu_short', async (ctx) => {
    await ctx.reply('🔗 *Short URL Manager*', { parse_mode: 'Markdown', ...shortUrlKeyboard() });
});
bot.action('short_create', async (ctx) => {
    await ctx.reply('Send me a long URL (starting with http:// or https://):');
    ctx.session.expecting = 'short_url_long';
});
bot.action('short_stats', async (ctx) => {
    await ctx.reply('Send the short code (e.g., `abc123`) to see stats:', { parse_mode: 'Markdown' });
    ctx.session.expecting = 'short_stats_code';
});
bot.action('short_mylinks', async (ctx) => {
    // In a real implementation, you would query KV for keys with prefix `short:user_${ctx.from.id}`
    await ctx.reply('🔧 Feature in development. You can use /stats <code> for now.');
});
bot.action('short_domain', async (ctx) => {
    await ctx.reply('To map a custom domain to a short URL, use:\n`/domain add <shortcode> yourdomain.com`\n\nMake sure your domain is on Cloudflare.', { parse_mode: 'Markdown' });
    await ctx.reply('🌐 *Custom Domains*', { parse_mode: 'Markdown', ...domainKeyboard() });
});

// ==================== DEPLOY WEBSITE SUBMENU ====================
function deployKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('📤 Upload ZIP', 'deploy_upload')],
        [Markup.button.callback('📋 My Sites', 'deploy_mysites')],
        [Markup.button.callback('⚙️ Inject Wallet Settings', 'deploy_inject')],
        [Markup.button.callback('🔙 Back', 'start_menu')],
    ]);
}
bot.action('menu_deploy', async (ctx) => {
    await ctx.reply('📦 *Deploy Website*', { parse_mode: 'Markdown', ...deployKeyboard() });
});
bot.action('deploy_upload', async (ctx) => {
    await ctx.reply('Send me a ZIP file of your website (must contain index.html).');
    ctx.session.expecting = 'deploy_zip';
});
bot.action('deploy_inject', async (ctx) => {
    await ctx.reply('⚙️ You can configure wallet settings first via the Wallet Connect menu, then send me a ZIP – I will inject those settings automatically.');
    await ctx.reply('Send a ZIP file now:');
    ctx.session.expecting = 'deploy_zip_with_inject';
});
bot.action('deploy_mysites', async (ctx) => {
    await ctx.reply('🔧 Feature in development. Use `/stats <shortcode>` for now.');
});

// ==================== APK HOSTING SUBMENU ====================
function apkKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('📤 Upload APK', 'apk_upload')],
        [Markup.button.callback('📊 Stats', 'apk_stats')],
        [Markup.button.callback('📋 My APKs', 'apk_mylist')],
        [Markup.button.callback('🔙 Back', 'start_menu')],
    ]);
}
bot.action('menu_apk', async (ctx) => {
    await ctx.reply('📱 *APK Hosting*', { parse_mode: 'Markdown', ...apkKeyboard() });
});
bot.action('apk_upload', async (ctx) => {
    await ctx.reply('Send me an APK file.');
    ctx.session.expecting = 'apk_file';
});
bot.action('apk_stats', async (ctx) => {
    await ctx.reply('Send the APK ID (e.g., `apk:xyz`) to see stats:', { parse_mode: 'Markdown' });
    ctx.session.expecting = 'apk_stats';
});
bot.action('apk_mylist', async (ctx) => {
    await ctx.reply('🔧 Feature in development.');
});

// ==================== CUSTOM DOMAIN SUBMENU ====================
function domainKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('➕ Add Domain', 'domain_add')],
        [Markup.button.callback('❌ Delete Domain', 'domain_del')],
        [Markup.button.callback('📋 List Domains', 'domain_list')],
        [Markup.button.callback('🔙 Back', 'start_menu')],
    ]);
}
bot.action('menu_domain', async (ctx) => {
    await ctx.reply('🌐 *Custom Domains*', { parse_mode: 'Markdown', ...domainKeyboard() });
});
bot.action('domain_add', async (ctx) => {
    await ctx.reply('Send as: `shortcode domain.com`\nExample: `abc123 mysite.com`');
    ctx.session.expecting = 'domain_add';
});
bot.action('domain_del', async (ctx) => {
    await ctx.reply('Send the domain to delete (e.g., `mysite.com`):');
    ctx.session.expecting = 'domain_del';
});
bot.action('domain_list', async (ctx) => {
    // In a real implementation, query KV for keys with prefix "domain:"
    await ctx.reply('🔧 To list domains, please use the `/domain list` command.');
});

// ==================== STATS SUBMENU ====================
function statsKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('🔗 Short URL Stats', 'stats_short')],
        [Markup.button.callback('📱 APK Stats', 'stats_apk')],
        [Markup.button.callback('📦 Site Stats', 'stats_site')],
        [Markup.button.callback('🔙 Back', 'start_menu')],
    ]);
}
bot.action('menu_stats', async (ctx) => {
    await ctx.reply('📊 *Stats*', { parse_mode: 'Markdown', ...statsKeyboard() });
});
bot.action('stats_short', async (ctx) => {
    await ctx.reply('Send the short code (e.g., `abc123`):');
    ctx.session.expecting = 'short_stats_code';
});
bot.action('stats_apk', async (ctx) => {
    await ctx.reply('Send the APK ID (e.g., `apk:xyz`):');
    ctx.session.expecting = 'apk_stats';
});
bot.action('stats_site', async (ctx) => {
    await ctx.reply('Send the site short code (e.g., `abc123`):');
    ctx.session.expecting = 'site_stats';
});

// ==================== FILE HANDLERS ====================
bot.on('document', async (ctx) => {
    const expecting = ctx.session.expecting;
    if (expecting === 'deploy_zip' || expecting === 'deploy_zip_with_inject') {
        const doc = ctx.message.document;
        if (!doc.file_name.endsWith('.zip')) return ctx.reply('❌ Please send a .zip file.');
        await ctx.reply('⏳ Processing ZIP...');
        const fileLink = await ctx.telegram.getFileLink(doc.file_id);
        const resp = await fetch(fileLink.href);
        const buffer = await resp.arrayBuffer();
        const zipPath = path.join(TEMP_DIR, `${Date.now()}_${doc.file_name}`);
        fs.writeFileSync(zipPath, Buffer.from(buffer));

        let zip;
        try { zip = new AdmZip(zipPath); } catch(e) { return ctx.reply('Invalid ZIP'); }
        const entries = zip.getEntries();
        let hasIndex = false;
        for (const e of entries) if (e.entryName === 'index.html') { hasIndex = true; break; }
        if (!hasIndex) return ctx.reply('ZIP must contain index.html at root.');

        const shortCode = Math.random().toString(36).substring(2, 8);
        const folder = `sites/${shortCode}/`;
        let count = 0;
        for (const entry of entries) {
            if (entry.isDirectory) continue;
            const key = folder + entry.entryName;
            let ct = 'application/octet-stream';
            if (entry.entryName.endsWith('.html')) ct = 'text/html';
            else if (entry.entryName.endsWith('.css')) ct = 'text/css';
            else if (entry.entryName.endsWith('.js')) ct = 'application/javascript';
            else if (entry.entryName.endsWith('.png')) ct = 'image/png';
            else if (entry.entryName.endsWith('.jpg')) ct = 'image/jpeg';
            await uploadToR2(key, entry.getData(), ct);
            count++;
        }
        await kvPut(`deploy:${shortCode}`, { folder, createdAt: new Date().toISOString() });
        const deployUrl = `${WORKER_DEPLOY_URL}/${shortCode}/index.html`;
        await ctx.reply(`✅ Deployed ${count} files.\nURL: ${deployUrl}\nShort code: \`${shortCode}\``, { parse_mode: 'Markdown' });
        fs.unlinkSync(zipPath);
        delete ctx.session.expecting;
    } else if (expecting === 'apk_file') {
        const doc = ctx.message.document;
        if (!doc.file_name.endsWith('.apk')) return ctx.reply('❌ Please send an .apk file.');
        await ctx.reply('⏳ Uploading APK...');
        const fileLink = await ctx.telegram.getFileLink(doc.file_id);
        const resp = await fetch(fileLink.href);
        const buffer = await resp.arrayBuffer();
        const shortId = Math.random().toString(36).substring(2, 10);
        const key = `apks/${shortId}.apk`;
        await uploadToR2(key, Buffer.from(buffer), 'application/vnd.android.package-archive');
        await kvPut(`apk:${shortId}`, { originalName: doc.file_name, uploadTime: new Date().toISOString(), downloads: 0 });
        const downloadUrl = `${WORKER_DEPLOY_URL}/apk/${shortId}.apk`;
        await ctx.reply(`✅ APK uploaded.\nDownload link: ${downloadUrl}\nAPK ID: \`${shortId}\``, { parse_mode: 'Markdown' });
        delete ctx.session.expecting;
    } else {
        await ctx.reply('Please select an option from the menu first.');
    }
});

// ==================== COMMAND HANDLERS ====================
bot.command('stats', async (ctx) => {
    const id = ctx.message.text.split(' ')[1];
    if (!id) return ctx.reply('Usage: /stats <shortcode or apk:id>');
    if (id.startsWith('apk:')) {
        const apkId = id.split(':')[1];
        const data = await kvGet(`apk:${apkId}`);
        if (!data) return ctx.reply('APK not found');
        const downloads = data.downloads || 0;
        await ctx.reply(`📊 APK *${apkId}*\nDownloads: ${downloads}\nUploaded: ${data.uploadTime}`, { parse_mode: 'Markdown' });
    } else {
        const views = (await kvGet(`views:${id}`)) || 0;
        const short = await kvGet(`short:${id}`);
        const deploy = await kvGet(`deploy:${id}`);
        if (!short && !deploy) return ctx.reply('Short code not found.');
        let type = short ? 'Short URL' : 'Website';
        await ctx.reply(`📊 *${type}* \`${id}\`\nViews: ${views}`, { parse_mode: 'Markdown' });
    }
});

bot.command('domain', async (ctx) => {
    const args = ctx.message.text.split(' ');
    if (args[1] === 'add' && args[2] && args[3]) {
        const shortCode = args[2];
        const domain = args[3];
        const deploy = await kvGet(`deploy:${shortCode}`);
        const short = await kvGet(`short:${shortCode}`);
        if (!deploy && !short) return ctx.reply('Short code not found.');
        const target = deploy ? WORKER_DEPLOY_URL.replace('https://', '') : WORKER_SHORT_URL.replace('https://', '');
        try {
            await addCNAME(domain, target);
            await kvPut(`domain:${domain}`, { type: deploy ? 'deploy' : 'short', shortCode });
            await ctx.reply(`✅ Domain ${domain} mapped to ${shortCode}.`);
        } catch(e) { ctx.reply(`❌ Error: ${e.message}`); }
    } else if (args[1] === 'del' && args[2]) {
        const domain = args[2];
        try {
            await deleteCNAME(domain);
            await kvDelete(`domain:${domain}`);
            await ctx.reply(`✅ Domain ${domain} removed.`);
        } catch(e) { ctx.reply(`❌ Error: ${e.message}`); }
    } else {
        await ctx.reply('Usage:\n/domain add <shortcode> <domain.com>\n/domain del <domain.com>');
    }
});

// Back to main menu action
bot.action('start_menu', async (ctx) => {
    await ctx.reply('🔙 Main menu', Markup.inlineKeyboard([
        [Markup.button.callback('🔌 Wallet Connect', 'menu_wallet')],
        [Markup.button.callback('🔗 Short URL', 'menu_short')],
        [Markup.button.callback('📦 Deploy Website', 'menu_deploy')],
        [Markup.button.callback('📱 APK Hosting', 'menu_apk')],
        [Markup.button.callback('🌐 Custom Domains', 'menu_domain')],
        [Markup.button.callback('📊 Stats', 'menu_stats')],
    ]));
});

// Wallet submenu back (simple)
function walletKeyboard() {
    return Markup.inlineKeyboard([Markup.button.callback('🔙 Back', 'start_menu')]);
}

// ==================== WEB SERVER FOR RENDER ====================
const app = express();
app.get('/', (req, res) => res.send('Bot is alive'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Web server on ${PORT}`));

bot.launch().then(() => console.log('Bot started polling'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
