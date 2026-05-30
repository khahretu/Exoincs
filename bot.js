const { Telegraf, Markup } = require('telegraf');
const AdmZip = require('adm-zip');
const { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');
const express = require('express');
const QRCode = require('qrcode');

// ========== ENV VARIABLES ==========
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

// ---------- R2 Helpers ----------
async function uploadToR2(key, buffer, contentType) {
    await s3.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: buffer, ContentType: contentType }));
}
async function deleteFromR2(key) {
    await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
}
async function listR2Folder(prefix) {
    const cmd = new ListObjectsV2Command({ Bucket: R2_BUCKET, Prefix: prefix });
    const data = await s3.send(cmd);
    return data.Contents || [];
}

// ---------- Cloudflare KV Helpers (with list) ----------
async function kvPut(key, value, ttlSeconds = null) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`;
    const headers = { 'Authorization': `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' };
    const body = typeof value === 'string' ? value : JSON.stringify(value);
    const params = ttlSeconds ? `?expiration_ttl=${ttlSeconds}` : '';
    const res = await fetch(url + params, { method: 'PUT', headers, body });
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
async function kvListKeys(prefix, cursor = null) {
    let url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}/keys?prefix=${encodeURIComponent(prefix)}&limit=100`;
    if (cursor) url += `&cursor=${cursor}`;
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${CF_API_TOKEN}` } });
    if (!res.ok) throw new Error(`KV list failed: ${await res.text()}`);
    const data = await res.json();
    return { keys: data.result.map(k => k.name), cursor: data.result_info.cursor };
}

// ---------- DNS Helpers ----------
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
async function listDNSRecords() {
    const url = `https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records?type=CNAME`;
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${CF_API_TOKEN}` } });
    const data = await res.json();
    return data.result.filter(r => r.name.endsWith('.') && !r.name.includes('cloudflare'));
}

// ---------- Bot Init ----------
const bot = new Telegraf(BOT_TOKEN);

// Session (in‑memory – for production use Redis)
bot.use(async (ctx, next) => {
    ctx.session = ctx.session || {};
    return next();
});

// ---------- Main Menu ----------
const mainMenu = Markup.inlineKeyboard([
    [Markup.button.callback('🔌 Wallet Connect', 'menu_wallet')],
    [Markup.button.callback('🔗 Short URL', 'menu_short')],
    [Markup.button.callback('📦 Deploy Website', 'menu_deploy')],
    [Markup.button.callback('📱 APK Hosting', 'menu_apk')],
    [Markup.button.callback('🌐 Custom Domains', 'menu_domain')],
    [Markup.button.callback('📊 Stats Dashboard', 'menu_stats')]
]);

bot.start(async (ctx) => {
    ctx.session = {};
    await ctx.reply('🚀 *Exogator Bot v2* – All‑in‑one crypto tool\nChoose an option:', { parse_mode: 'Markdown', ...mainMenu });
});

// ---------- Wallet Connect ----------
bot.action('menu_wallet', async (ctx) => {
    ctx.session.walletConfig = ctx.session.walletConfig || { theme: 2, exogatorId: `user_${ctx.from.id}`, towsteps: 1, auto: 1 };
    await ctx.reply('⚙️ *Wallet Connect Configuration*\nSelect Modal Theme:', {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('☀️ Light', 'wallet_theme_1'), Markup.button.callback('🌙 Dark', 'wallet_theme_2'), Markup.button.callback('🔥 Neon', 'wallet_theme_3')],
            [Markup.button.callback('🎩 Classic', 'wallet_theme_4')],
            [Markup.button.callback('✏️ Change Exogator ID', 'wallet_change_id')],
            [Markup.button.callback('⬅️ Back', 'start_menu')]
        ])
    });
});
bot.action(/wallet_theme_(\d)/, async (ctx) => {
    ctx.session.walletConfig.theme = parseInt(ctx.match[1]);
    await ctx.reply(`✅ Theme set to ${ctx.match[1]}\n\nTwo‑step mode?`, {
        ...Markup.inlineKeyboard([
            [Markup.button.callback('🔒 Enabled', 'wallet_towsteps_1'), Markup.button.callback('🔓 Disabled', 'wallet_towsteps_0')]
        ])
    });
});
bot.action('wallet_change_id', async (ctx) => {
    await ctx.reply('Send your new *Exogator ID* (or /skip to keep default):', { parse_mode: 'Markdown' });
    ctx.session.expecting = 'wallet_exoid';
});
bot.action(/wallet_towsteps_(\d)/, async (ctx) => {
    ctx.session.walletConfig.towsteps = parseInt(ctx.match[1]);
    await ctx.reply('Auto‑connect on page load?', Markup.inlineKeyboard([
        [Markup.button.callback('✅ Yes', 'wallet_auto_1'), Markup.button.callback('❌ No', 'wallet_auto_0')]
    ]));
});
bot.action(/wallet_auto_(\d)/, async (ctx) => {
    ctx.session.walletConfig.auto = parseInt(ctx.match[1]);
    const cfg = ctx.session.walletConfig;
    const demoUrl = `${WORKER_DEPLOY_URL}/wallet-demo?theme=${cfg.theme}&exo=${cfg.exogatorId}&towsteps=${cfg.towsteps}&auto=${cfg.auto}`;
    await ctx.reply(`✅ Config saved!\n\n🔗 *Demo Link:*\n${demoUrl}\n\nYou can now upload a ZIP – wallet settings will be injected.`, { parse_mode: 'Markdown' });
    await ctx.reply('🔌 *Wallet Connect*', { ...deployKeyboard() });  // reuse deploy menu
});

// ---------- Short URL Module (with custom slug & TTL) ----------
const shortUrlKeyboard = () => Markup.inlineKeyboard([
    [Markup.button.callback('➕ Create (auto slug)', 'short_create_auto')],
    [Markup.button.callback('✏️ Create (custom slug)', 'short_create_custom')],
    [Markup.button.callback('📋 My Short URLs', 'short_mylinks')],
    [Markup.button.callback('🔗 QR Code', 'short_qr')],
    [Markup.button.callback('🌐 Custom Domain', 'short_domain')],
    [Markup.button.callback('🏠 Main Menu', 'start_menu')]
]);

bot.action('menu_short', async (ctx) => {
    await ctx.reply('🔗 *Short URL Manager*', { parse_mode: 'Markdown', ...shortUrlKeyboard() });
});
bot.action('short_create_auto', async (ctx) => {
    await ctx.reply('Send me a long URL (http://...):');
    ctx.session.shortMode = 'auto';
    ctx.session.expecting = 'short_url_long';
});
bot.action('short_create_custom', async (ctx) => {
    await ctx.reply('Send in format:\n`<long_url> <desired_slug>`\ne.g. `https://example.com mylink`\nSlug: letters/numbers only, 4‑12 chars.');
    ctx.session.shortMode = 'custom';
    ctx.session.expecting = 'short_url_long';
});
bot.action('short_mylinks', async (ctx) => {
    ctx.session.shortPage = 0;
    await showMyShortUrls(ctx, 0);
});
bot.action('short_qr', async (ctx) => {
    await ctx.reply('Send a short URL (e.g. `abc123` or full https://short.../abc123) to generate QR code:');
    ctx.session.expecting = 'short_qr_generate';
});
bot.action('short_domain', async (ctx) => {
    await ctx.reply('🌐 Map a custom domain to a short URL:\n`/domain add <shortcode> yourdomain.com`\n(make sure domain is on Cloudflare)');
});

async function showMyShortUrls(ctx, page) {
    const prefix = `short:user_${ctx.from.id}:`;
    const { keys, cursor } = await kvListKeys(prefix);
    const perPage = 5;
    const start = page * perPage;
    const pageKeys = keys.slice(start, start + perPage);
    if (pageKeys.length === 0) return ctx.reply('No short URLs found.');
    let msg = `📋 *Your Short URLs (Page ${page+1})*\n\n`;
    for (const key of pageKeys) {
        const shortCode = key.replace(prefix, '');
        const longUrl = await kvGet(key);
        const views = (await kvGet(`views:${shortCode}`)) || 0;
        msg += `\`${shortCode}\` → ${views} clicks\n${WORKER_SHORT_URL}/${shortCode}\n\n`;
    }
    const navButtons = [];
    if (page > 0) navButtons.push(Markup.button.callback('◀️ Prev', `short_page_${page-1}`));
    if (start + perPage < keys.length) navButtons.push(Markup.button.callback('Next ▶️', `short_page_${page+1}`));
    navButtons.push(Markup.button.callback('🗑 Delete One', 'short_delete_pick'));
    navButtons.push(Markup.button.callback('🔙 Back', 'menu_short'));
    await ctx.reply(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([navButtons]) });
}
bot.action(/short_page_(\d+)/, async (ctx) => {
    await showMyShortUrls(ctx, parseInt(ctx.match[1]));
});
bot.action('short_delete_pick', async (ctx) => {
    await ctx.reply('Send the *short code* you want to delete (e.g. `abc123`):', { parse_mode: 'Markdown' });
    ctx.session.expecting = 'short_delete_code';
});
// Delete handler in text section

// ---------- Deploy Website (with inject & delete) ----------
const deployKeyboard = () => Markup.inlineKeyboard([
    [Markup.button.callback('📤 Upload ZIP', 'deploy_upload')],
    [Markup.button.callback('⚙️ Upload + Inject Wallet', 'deploy_inject')],
    [Markup.button.callback('📋 My Sites', 'deploy_mysites')],
    [Markup.button.callback('🗑 Delete Site', 'deploy_delete')],
    [Markup.button.callback('🏠 Main Menu', 'start_menu')]
]);

bot.action('menu_deploy', async (ctx) => {
    await ctx.reply('📦 *Deploy Website*', { parse_mode: 'Markdown', ...deployKeyboard() });
});
bot.action('deploy_upload', async (ctx) => {
    await ctx.reply('Send me a ZIP file of your website (must contain index.html at root).');
    ctx.session.expecting = 'deploy_zip';
    ctx.session.injectWallet = false;
});
bot.action('deploy_inject', async (ctx) => {
    if (!ctx.session.walletConfig) return ctx.reply('Please configure Wallet Connect first via the main menu.');
    await ctx.reply('⚙️ Your current wallet settings will be injected. Send ZIP:');
    ctx.session.expecting = 'deploy_zip';
    ctx.session.injectWallet = true;
});
bot.action('deploy_mysites', async (ctx) => {
    ctx.session.sitePage = 0;
    await showMySites(ctx, 0);
});
bot.action('deploy_delete', async (ctx) => {
    await ctx.reply('Send the *short code* of the site you want to delete (e.g. `abc123`):', { parse_mode: 'Markdown' });
    ctx.session.expecting = 'site_delete_code';
});

async function showMySites(ctx, page) {
    const prefix = `deploy:user_${ctx.from.id}:`;
    const { keys, cursor } = await kvListKeys(prefix);
    const perPage = 5;
    const start = page * perPage;
    const pageKeys = keys.slice(start, start + perPage);
    if (pageKeys.length === 0) return ctx.reply('No deployed sites found.');
    let msg = `📦 *Your Sites (Page ${page+1})*\n\n`;
    for (const key of pageKeys) {
        const shortCode = key.replace(prefix, '');
        const data = await kvGet(key);
        const views = (await kvGet(`views:${shortCode}`)) || 0;
        msg += `\`${shortCode}\` → ${views} views\n${WORKER_DEPLOY_URL}/${shortCode}/index.html\n\n`;
    }
    const navButtons = [];
    if (page > 0) navButtons.push(Markup.button.callback('◀️ Prev', `site_page_${page-1}`));
    if (start + perPage < keys.length) navButtons.push(Markup.button.callback('Next ▶️', `site_page_${page+1}`));
    navButtons.push(Markup.button.callback('🔙 Back', 'menu_deploy'));
    await ctx.reply(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([navButtons]) });
}
bot.action(/site_page_(\d+)/, async (ctx) => {
    await showMySites(ctx, parseInt(ctx.match[1]));
});

// ---------- APK Hosting (with delete & QR) ----------
const apkKeyboard = () => Markup.inlineKeyboard([
    [Markup.button.callback('📤 Upload APK', 'apk_upload')],
    [Markup.button.callback('📋 My APKs', 'apk_mylist')],
    [Markup.button.callback('🔗 QR Code', 'apk_qr')],
    [Markup.button.callback('🗑 Delete APK', 'apk_delete')],
    [Markup.button.callback('🏠 Main Menu', 'start_menu')]
]);

bot.action('menu_apk', async (ctx) => {
    await ctx.reply('📱 *APK Hosting*', { parse_mode: 'Markdown', ...apkKeyboard() });
});
bot.action('apk_upload', async (ctx) => {
    await ctx.reply('Send me an APK file.');
    ctx.session.expecting = 'apk_file';
});
bot.action('apk_mylist', async (ctx) => {
    ctx.session.apkPage = 0;
    await showMyApks(ctx, 0);
});
bot.action('apk_qr', async (ctx) => {
    await ctx.reply('Send the APK ID (e.g. `apk:abc123`) to get QR code:');
    ctx.session.expecting = 'apk_qr_generate';
});
bot.action('apk_delete', async (ctx) => {
    await ctx.reply('Send the APK ID to delete (e.g. `apk:abc123`):');
    ctx.session.expecting = 'apk_delete_code';
});

async function showMyApks(ctx, page) {
    const prefix = `apk:user_${ctx.from.id}:`;
    const { keys, cursor } = await kvListKeys(prefix);
    const perPage = 5;
    const start = page * perPage;
    const pageKeys = keys.slice(start, start + perPage);
    if (pageKeys.length === 0) return ctx.reply('No APKs found.');
    let msg = `📱 *Your APKs (Page ${page+1})*\n\n`;
    for (const key of pageKeys) {
        const apkId = key.replace(prefix, '');
        const data = await kvGet(key);
        const downloads = data.downloads || 0;
        msg += `\`${apkId}\` → ${downloads} downloads\n${WORKER_DEPLOY_URL}/apk/${apkId}.apk\n\n`;
    }
    const navButtons = [];
    if (page > 0) navButtons.push(Markup.button.callback('◀️ Prev', `apk_page_${page-1}`));
    if (start + perPage < keys.length) navButtons.push(Markup.button.callback('Next ▶️', `apk_page_${page+1}`));
    navButtons.push(Markup.button.callback('🔙 Back', 'menu_apk'));
    await ctx.reply(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([navButtons]) });
}
bot.action(/apk_page_(\d+)/, async (ctx) => {
    await showMyApks(ctx, parseInt(ctx.match[1]));
});

// ---------- Custom Domains (with list) ----------
const domainKeyboard = () => Markup.inlineKeyboard([
    [Markup.button.callback('➕ Add Domain', 'domain_add')],
    [Markup.button.callback('❌ Delete Domain', 'domain_del')],
    [Markup.button.callback('📋 List Domains', 'domain_list')],
    [Markup.button.callback('🏠 Main Menu', 'start_menu')]
]);

bot.action('menu_domain', async (ctx) => {
    await ctx.reply('🌐 *Custom Domains*', { parse_mode: 'Markdown', ...domainKeyboard() });
});
bot.action('domain_add', async (ctx) => {
    await ctx.reply('Send as: `shortcode domain.com`\nExample: `abc123 mysite.com`');
    ctx.session.expecting = 'domain_add';
});
bot.action('domain_del', async (ctx) => {
    await ctx.reply('Send the domain to delete (e.g. `mysite.com`):');
    ctx.session.expecting = 'domain_del';
});
bot.action('domain_list', async (ctx) => {
    const records = await listDNSRecords();
    if (!records.length) return ctx.reply('No custom domains found.');
    let msg = '🌐 *Your Custom Domains*\n\n';
    for (const rec of records) {
        const domain = rec.name;
        const kvData = await kvGet(`domain:${domain}`);
        const type = kvData?.type || 'unknown';
        msg += `• ${domain} → ${type}\n`;
    }
    await ctx.reply(msg, { parse_mode: 'Markdown' });
});

// ---------- Stats Dashboard ----------
bot.action('menu_stats', async (ctx) => {
    const prefix = `short:user_${ctx.from.id}:`;
    const { keys } = await kvListKeys(prefix);
    let totalClicks = 0;
    for (const key of keys) {
        const shortCode = key.replace(prefix, '');
        const views = (await kvGet(`views:${shortCode}`)) || 0;
        totalClicks += views;
    }
    await ctx.reply(`📊 *Your Stats Dashboard*\n\n🔗 Short URLs: ${keys.length}\n👆 Total Clicks: ${totalClicks}\n\nUse /stats <code> for detailed info.`, { parse_mode: 'Markdown' });
});

// ---------- File Handlers (ZIP & APK) ----------
bot.on('document', async (ctx) => {
    const expecting = ctx.session.expecting;
    if (expecting === 'deploy_zip') {
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
            let data = entry.getData();
            // Inject wallet script if needed
            if (ctx.session.injectWallet && entry.entryName === 'index.html') {
                const html = data.toString('utf8');
                const cfg = ctx.session.walletConfig;
                const injectScript = `<script>window.walletConfig = { theme:${cfg.theme}, exogatorId:"${cfg.exogatorId}", towsteps:${cfg.towsteps}, auto:${cfg.auto} };</script>`;
                const newHtml = html.replace('</head>', `${injectScript}</head>`);
                data = Buffer.from(newHtml, 'utf8');
            }
            const key = folder + entry.entryName;
            let ct = 'application/octet-stream';
            if (entry.entryName.endsWith('.html')) ct = 'text/html';
            else if (entry.entryName.endsWith('.css')) ct = 'text/css';
            else if (entry.entryName.endsWith('.js')) ct = 'application/javascript';
            else if (entry.entryName.endsWith('.png')) ct = 'image/png';
            else if (entry.entryName.endsWith('.jpg')) ct = 'image/jpeg';
            await uploadToR2(key, data, ct);
            count++;
        }
        const siteData = { folder, createdAt: new Date().toISOString(), userId: ctx.from.id };
        await kvPut(`deploy:${shortCode}`, siteData);
        await kvPut(`deploy:user_${ctx.from.id}:${shortCode}`, true);
        await kvPut(`views:${shortCode}`, 0);
        const deployUrl = `${WORKER_DEPLOY_URL}/${shortCode}/index.html`;
        await ctx.reply(`✅ Deployed ${count} files.\nURL: ${deployUrl}\nShort code: \`${shortCode}\``, { parse_mode: 'Markdown' });
        fs.unlinkSync(zipPath);
        delete ctx.session.expecting;
        delete ctx.session.injectWallet;
    } 
    else if (expecting === 'apk_file') {
        const doc = ctx.message.document;
        if (!doc.file_name.endsWith('.apk')) return ctx.reply('❌ Please send an .apk file.');
        await ctx.reply('⏳ Uploading APK...');
        const fileLink = await ctx.telegram.getFileLink(doc.file_id);
        const resp = await fetch(fileLink.href);
        const buffer = await resp.arrayBuffer();
        const shortId = Math.random().toString(36).substring(2, 10);
        const key = `apks/${shortId}.apk`;
        await uploadToR2(key, Buffer.from(buffer), 'application/vnd.android.package-archive');
        const apkData = { originalName: doc.file_name, uploadTime: new Date().toISOString(), downloads: 0, userId: ctx.from.id };
        await kvPut(`apk:${shortId}`, apkData);
        await kvPut(`apk:user_${ctx.from.id}:${shortId}`, true);
        const downloadUrl = `${WORKER_DEPLOY_URL}/apk/${shortId}.apk`;
        await ctx.reply(`✅ APK uploaded.\nDownload: ${downloadUrl}\nAPK ID: \`${shortId}\``, { parse_mode: 'Markdown' });
        delete ctx.session.expecting;
    } 
    else {
        await ctx.reply('Please use the menu first.');
    }
});

// ---------- Text handlers for all interactions ----------
bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    const expecting = ctx.session.expecting;

    if (expecting === 'short_url_long') {
        const parts = text.split(' ');
        let longUrl, customSlug = null, ttlDays = null;
        if (ctx.session.shortMode === 'auto') {
            longUrl = text;
        } else if (ctx.session.shortMode === 'custom') {
            if (parts.length < 2) return ctx.reply('Send as: `<url> <slug> [ttl_days]`');
            longUrl = parts[0];
            customSlug = parts[1];
            if (parts[2]) ttlDays = parseInt(parts[2]);
        }
        if (!/^https?:\/\//.test(longUrl)) return ctx.reply('❌ URL must start with http:// or https://');
        let shortCode = customSlug || Math.random().toString(36).substring(2, 8);
        // check if code exists
        const existing = await kvGet(`short:${shortCode}`);
        if (existing) return ctx.reply('❌ Slug already exists. Try another.');
        await kvPut(`short:${shortCode}`, longUrl);
        await kvPut(`short:user_${ctx.from.id}:${shortCode}`, true);
        await kvPut(`views:${shortCode}`, 0);
        if (ttlDays && !isNaN(ttlDays)) {
            const ttlSeconds = ttlDays * 86400;
            await kvPut(`short:${shortCode}`, longUrl, ttlSeconds);
        }
        const shortUrl = `${WORKER_SHORT_URL}/${shortCode}`;
        await ctx.reply(`✅ Short URL created:\n${shortUrl}\n\n${ttlDays ? `⏰ Expires in ${ttlDays} days.` : ''}`);
        delete ctx.session.expecting;
        delete ctx.session.shortMode;
        await ctx.reply('🔗 *Short URL Manager*', { ...shortUrlKeyboard() });
    }
    else if (expecting === 'short_delete_code') {
        const shortCode = text.trim();
        const shortData = await kvGet(`short:${shortCode}`);
        if (!shortData) return ctx.reply('❌ Short code not found.');
        await kvDelete(`short:${shortCode}`);
        await kvDelete(`short:user_${ctx.from.id}:${shortCode}`);
        await kvDelete(`views:${shortCode}`);
        await ctx.reply(`✅ Deleted short URL \`${shortCode}\``, { parse_mode: 'Markdown' });
        delete ctx.session.expecting;
    }
    else if (expecting === 'short_qr_generate') {
        let code = text.trim();
        if (code.startsWith('http')) {
            const match = code.match(/\/([a-zA-Z0-9]+)$/);
            if (!match) return ctx.reply('Invalid short URL.');
            code = match[1];
        }
        const exists = await kvGet(`short:${code}`);
        if (!exists) return ctx.reply('Short code not found.');
        const fullUrl = `${WORKER_SHORT_URL}/${code}`;
        const qrBuffer = await QRCode.toBuffer(fullUrl);
        await ctx.replyWithPhoto({ source: qrBuffer }, { caption: `QR for ${fullUrl}` });
        delete ctx.session.expecting;
    }
    else if (expecting === 'site_delete_code') {
        const shortCode = text.trim();
        const siteData = await kvGet(`deploy:${shortCode}`);
        if (!siteData) return ctx.reply('❌ Site not found.');
        // delete all files in R2
        const folder = siteData.folder;
        const objects = await listR2Folder(folder);
        for (const obj of objects) await deleteFromR2(obj.Key);
        await kvDelete(`deploy:${shortCode}`);
        await kvDelete(`deploy:user_${ctx.from.id}:${shortCode}`);
        await kvDelete(`views:${shortCode}`);
        await ctx.reply(`✅ Deleted site \`${shortCode}\` and all files.`, { parse_mode: 'Markdown' });
        delete ctx.session.expecting;
    }
    else if (expecting === 'apk_delete_code') {
        let apkId = text.trim();
        if (apkId.startsWith('apk:')) apkId = apkId.split(':')[1];
        const apkData = await kvGet(`apk:${apkId}`);
        if (!apkData) return ctx.reply('❌ APK not found.');
        await deleteFromR2(`apks/${apkId}.apk`);
        await kvDelete(`apk:${apkId}`);
        await kvDelete(`apk:user_${ctx.from.id}:${apkId}`);
        await ctx.reply(`✅ Deleted APK \`${apkId}\``, { parse_mode: 'Markdown' });
        delete ctx.session.expecting;
    }
    else if (expecting === 'apk_qr_generate') {
        let apkId = text.trim();
        if (apkId.startsWith('apk:')) apkId = apkId.split(':')[1];
        const exists = await kvGet(`apk:${apkId}`);
        if (!exists) return ctx.reply('APK ID not found.');
        const downloadUrl = `${WORKER_DEPLOY_URL}/apk/${apkId}.apk`;
        const qrBuffer = await QRCode.toBuffer(downloadUrl);
        await ctx.replyWithPhoto({ source: qrBuffer }, { caption: `QR for APK ${apkId}` });
        delete ctx.session.expecting;
    }
    else if (expecting === 'wallet_exoid') {
        let exoId = text.trim();
        if (exoId === '/skip') exoId = `user_${ctx.from.id}`;
        ctx.session.walletConfig.exogatorId = exoId;
        await ctx.reply(`✅ Exogator ID set to \`${exoId}\`\n\nTwo‑step mode?`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
            [Markup.button.callback('🔒 Enabled', 'wallet_towsteps_1'), Markup.button.callback('🔓 Disabled', 'wallet_towsteps_0')]
        ]) });
        delete ctx.session.expecting;
    }
    else if (expecting === 'domain_add') {
        const parts = text.split(' ');
        if (parts.length !== 2) return ctx.reply('Send as: `shortcode domain.com`');
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
        delete ctx.session.expecting;
    }
    else if (expecting === 'domain_del') {
        const domain = text.trim();
        try {
            await deleteCNAME(domain);
            await kvDelete(`domain:${domain}`);
            await ctx.reply(`✅ Domain ${domain} removed.`);
        } catch(e) { ctx.reply(`❌ Error: ${e.message}`); }
        delete ctx.session.expecting;
    }
    else {
        await ctx.reply('Please use the menu buttons.', mainMenu);
    }
});

// ---------- Commands ----------
bot.command('stats', async (ctx) => {
    const id = ctx.message.text.split(' ')[1];
    if (!id) return ctx.reply('Usage: /stats <shortcode or apk:id>');
    if (id.startsWith('apk:')) {
        const apkId = id.split(':')[1];
        const data = await kvGet(`apk:${apkId}`);
        if (!data) return ctx.reply('APK not found');
        await ctx.reply(`📊 APK *${apkId}*\nDownloads: ${data.downloads || 0}\nUploaded: ${data.uploadTime}`, { parse_mode: 'Markdown' });
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

bot.command('qr', async (ctx) => {
    const url = ctx.message.text.split(' ')[1];
    if (!url) return ctx.reply('Usage: /qr <url>');
    try {
        const qrBuffer = await QRCode.toBuffer(url);
        await ctx.replyWithPhoto({ source: qrBuffer }, { caption: `QR for ${url}` });
    } catch(e) { ctx.reply('Failed to generate QR.'); }
});

bot.action('start_menu', async (ctx) => {
    await ctx.reply('🏠 *Main Menu*', { parse_mode: 'Markdown', ...mainMenu });
});

// ---------- Web server for Render ----------
const app = express();
app.get('/', (req, res) => res.send('Bot is alive'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Web server on ${PORT}`));

bot.launch().then(() => console.log('Bot started polling'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
