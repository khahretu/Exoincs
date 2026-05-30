const { Telegraf, Markup } = require('telegraf');
const AdmZip = require('adm-zip');
const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');
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
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim()));

const TEMP_DIR = '/tmp/exogator_bot';
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY, secretAccessKey: R2_SECRET_KEY },
});

function isAdmin(ctx) { return ADMIN_IDS.includes(ctx.from.id); }

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

const bot = new Telegraf(BOT_TOKEN);

// Track users
bot.use(async (ctx, next) => {
    ctx.session = ctx.session || {};
    const userId = ctx.from.id;
    if (!await kvGet(`user:${userId}`)) {
        await kvPut(`user:${userId}`, { firstSeen: new Date().toISOString(), username: ctx.from.username || '', name: ctx.from.first_name });
    }
    return next();
});

bot.telegram.setMyCommands([
    { command: 'start', description: '🚀 Main menu' },
    { command: 'help', description: '📖 Commands list' },
    { command: 'stats', description: '📊 Views for short URL or APK' },
    { command: 'qr', description: '🔗 Generate QR code' },
    { command: 'admin', description: '🔐 Admin panel (restricted)' },
]);

const mainMenu = Markup.inlineKeyboard([
    [Markup.button.callback('🔌 Wallet Connect', 'menu_wallet'), Markup.button.callback('🔗 Short URL', 'menu_short')],
    [Markup.button.callback('📦 Deploy Website', 'menu_deploy'), Markup.button.callback('📱 APK Hosting', 'menu_apk')],
    [Markup.button.callback('🌐 Custom Domains', 'menu_domain'), Markup.button.callback('📊 Stats Dashboard', 'menu_stats')]
]);

bot.start(async (ctx) => {
    ctx.session = {};
    const shortKeys = await kvListKeys(`short:user_${ctx.from.id}:`);
    let totalClicks = 0;
    for (const key of shortKeys.keys) {
        const sc = key.replace(`short:user_${ctx.from.id}:`, '');
        totalClicks += (await kvGet(`views:${sc}`)) || 0;
    }
    await ctx.reply(`🚀 *Exogator Bot v3*\nYou have ${shortKeys.keys.length} short URLs with ${totalClicks} total clicks.\nChoose option:`, { parse_mode: 'Markdown', ...mainMenu });
});

bot.help(async (ctx) => {
    await ctx.reply(`📖 *Commands*\n/start - Main menu\n/help - This\n/stats <code> - Views\n/qr <url>\n/admin (admin only)\n\nUse inline buttons for features.`, { parse_mode: 'Markdown' });
});

// ---------- Wallet Connect ----------
bot.action('menu_wallet', async (ctx) => {
    ctx.session.walletConfig = ctx.session.walletConfig || { theme: 2, exogatorId: `user_${ctx.from.id}`, towsteps: 1, auto: 1 };
    await ctx.reply('⚙️ *Wallet Connect*', {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('☀️ Light', 'wallet_theme_1'), Markup.button.callback('🌙 Dark', 'wallet_theme_2'), Markup.button.callback('🔥 Neon', 'wallet_theme_3')],
            [Markup.button.callback('🎩 Classic', 'wallet_theme_4')],
            [Markup.button.callback('✏️ Change ID', 'wallet_change_id')],
            [Markup.button.callback('⬅️ Back', 'start_menu')]
        ])
    });
});
bot.action(/wallet_theme_(\d)/, async (ctx) => {
    ctx.session.walletConfig.theme = parseInt(ctx.match[1]);
    await ctx.reply('Two‑step mode?', Markup.inlineKeyboard([[Markup.button.callback('🔒 On', 'wallet_towsteps_1'), Markup.button.callback('🔓 Off', 'wallet_towsteps_0')]]));
});
bot.action('wallet_change_id', async (ctx) => {
    await ctx.reply('Send new Exogator ID (or /skip):');
    ctx.session.expecting = 'wallet_exoid';
});
bot.action(/wallet_towsteps_(\d)/, async (ctx) => {
    ctx.session.walletConfig.towsteps = parseInt(ctx.match[1]);
    await ctx.reply('Auto‑connect?', Markup.inlineKeyboard([[Markup.button.callback('✅ Yes', 'wallet_auto_1'), Markup.button.callback('❌ No', 'wallet_auto_0')]]));
});
bot.action(/wallet_auto_(\d)/, async (ctx) => {
    ctx.session.walletConfig.auto = parseInt(ctx.match[1]);
    const cfg = ctx.session.walletConfig;
    const demoUrl = `${WORKER_DEPLOY_URL}/wallet-demo?theme=${cfg.theme}&exo=${cfg.exogatorId}&towsteps=${cfg.towsteps}&auto=${cfg.auto}`;
    await ctx.reply(`✅ Saved!\nDemo: ${demoUrl}\n\nUpload ZIP to inject.`);
    await ctx.reply('🔌 Wallet Connect', { ...deployKeyboard() });
});

// ---------- Short URL ----------
const shortUrlKeyboard = () => Markup.inlineKeyboard([
    [Markup.button.callback('➕ Auto', 'short_create_auto'), Markup.button.callback('✏️ Custom', 'short_create_custom')],
    [Markup.button.callback('📋 My Short URLs', 'short_mylinks'), Markup.button.callback('🔗 QR', 'short_qr')],
    [Markup.button.callback('🌐 Custom Domain', 'short_domain'), Markup.button.callback('⬅️ Main', 'start_menu')]
]);

bot.action('menu_short', async (ctx) => {
    await ctx.reply('🔗 *Short URL*', { parse_mode: 'Markdown', ...shortUrlKeyboard() });
});
bot.action('short_create_auto', async (ctx) => {
    await ctx.reply('Send long URL:');
    ctx.session.shortMode = 'auto';
    ctx.session.expecting = 'short_url_long';
});
bot.action('short_create_custom', async (ctx) => {
    await ctx.reply('Send: `<url> <slug> [ttl_days]`\ne.g. `https://example.com mylink 7`');
    ctx.session.shortMode = 'custom';
    ctx.session.expecting = 'short_url_long';
});
bot.action('short_mylinks', async (ctx) => {
    ctx.session.shortPage = 0;
    await showMyShortUrls(ctx, 0);
});
bot.action('short_qr', async (ctx) => {
    await ctx.reply('Send short code or full URL:');
    ctx.session.expecting = 'short_qr_generate';
});
bot.action('short_domain', async (ctx) => {
    await ctx.reply('Map domain: `/domain add <shortcode> domain.com`');
});

async function showMyShortUrls(ctx, page) {
    const prefix = `short:user_${ctx.from.id}:`;
    const { keys } = await kvListKeys(prefix);
    const perPage = 5;
    const start = page * perPage;
    const pageKeys = keys.slice(start, start + perPage);
    if (!pageKeys.length) return ctx.reply('No short URLs.');
    let msg = `📋 *Page ${page+1}*\n`;
    for (const key of pageKeys) {
        const sc = key.replace(prefix, '');
        const views = (await kvGet(`views:${sc}`)) || 0;
        msg += `\`${sc}\` → ${views} clicks\n${WORKER_SHORT_URL}/${sc}\n\n`;
    }
    const nav = [];
    if (page > 0) nav.push(Markup.button.callback('◀️', `short_page_${page-1}`));
    if (start+perPage < keys.length) nav.push(Markup.button.callback('▶️', `short_page_${page+1}`));
    nav.push(Markup.button.callback('🗑 Delete', 'short_delete_pick'));
    nav.push(Markup.button.callback('🔙 Back', 'menu_short'));
    await ctx.reply(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([nav]) });
}
bot.action(/short_page_(\d+)/, async (ctx) => {
    await showMyShortUrls(ctx, parseInt(ctx.match[1]));
});
bot.action('short_delete_pick', async (ctx) => {
    await ctx.reply('Send short code to delete:');
    ctx.session.expecting = 'short_delete_code';
});

// ---------- Deploy Website ----------
const deployKeyboard = () => Markup.inlineKeyboard([
    [Markup.button.callback('📤 Upload ZIP', 'deploy_upload'), Markup.button.callback('⚙️ + Inject Wallet', 'deploy_inject')],
    [Markup.button.callback('📋 My Sites', 'deploy_mysites'), Markup.button.callback('🗑 Delete Site', 'deploy_delete')],
    [Markup.button.callback('⬅️ Main', 'start_menu')]
]);

bot.action('menu_deploy', async (ctx) => {
    await ctx.reply('📦 *Deploy Website*', { parse_mode: 'Markdown', ...deployKeyboard() });
});
bot.action('deploy_upload', async (ctx) => {
    await ctx.reply('Send ZIP (must have index.html)');
    ctx.session.expecting = 'deploy_zip';
    ctx.session.injectWallet = false;
});
bot.action('deploy_inject', async (ctx) => {
    if (!ctx.session.walletConfig) return ctx.reply('Configure Wallet Connect first.');
    await ctx.reply('Send ZIP – wallet settings will be injected.');
    ctx.session.expecting = 'deploy_zip';
    ctx.session.injectWallet = true;
});
bot.action('deploy_mysites', async (ctx) => {
    ctx.session.sitePage = 0;
    await showMySites(ctx, 0);
});
bot.action('deploy_delete', async (ctx) => {
    await ctx.reply('Send site short code to delete:');
    ctx.session.expecting = 'site_delete_code';
});

async function showMySites(ctx, page) {
    const prefix = `deploy:user_${ctx.from.id}:`;
    const { keys } = await kvListKeys(prefix);
    const perPage = 5;
    const start = page * perPage;
    const pageKeys = keys.slice(start, start+perPage);
    if (!pageKeys.length) return ctx.reply('No sites.');
    let msg = `📦 *Sites Page ${page+1}*\n`;
    for (const key of pageKeys) {
        const sc = key.replace(prefix, '');
        const views = (await kvGet(`views:${sc}`)) || 0;
        msg += `\`${sc}\` → ${views} views\n${WORKER_DEPLOY_URL}/${sc}/index.html\n\n`;
    }
    const nav = [];
    if (page > 0) nav.push(Markup.button.callback('◀️', `site_page_${page-1}`));
    if (start+perPage < keys.length) nav.push(Markup.button.callback('▶️', `site_page_${page+1}`));
    nav.push(Markup.button.callback('🔙 Back', 'menu_deploy'));
    await ctx.reply(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([nav]) });
}
bot.action(/site_page_(\d+)/, async (ctx) => {
    await showMySites(ctx, parseInt(ctx.match[1]));
});

// ---------- APK Hosting ----------
const apkKeyboard = () => Markup.inlineKeyboard([
    [Markup.button.callback('📤 Upload APK', 'apk_upload')],
    [Markup.button.callback('📋 My APKs', 'apk_mylist'), Markup.button.callback('🔗 QR', 'apk_qr')],
    [Markup.button.callback('🗑 Delete APK', 'apk_delete'), Markup.button.callback('⬅️ Main', 'start_menu')]
]);

bot.action('menu_apk', async (ctx) => {
    await ctx.reply('📱 *APK Hosting*', { parse_mode: 'Markdown', ...apkKeyboard() });
});
bot.action('apk_upload', async (ctx) => {
    await ctx.reply('Send APK file.');
    ctx.session.expecting = 'apk_file';
});
bot.action('apk_mylist', async (ctx) => {
    ctx.session.apkPage = 0;
    await showMyApks(ctx, 0);
});
bot.action('apk_qr', async (ctx) => {
    await ctx.reply('Send APK ID (e.g. `abc123`):');
    ctx.session.expecting = 'apk_qr_generate';
});
bot.action('apk_delete', async (ctx) => {
    await ctx.reply('Send APK ID to delete:');
    ctx.session.expecting = 'apk_delete_code';
});

async function showMyApks(ctx, page) {
    const prefix = `apk:user_${ctx.from.id}:`;
    const { keys } = await kvListKeys(prefix);
    const perPage = 5;
    const start = page * perPage;
    const pageKeys = keys.slice(start, start+perPage);
    if (!pageKeys.length) return ctx.reply('No APKs.');
    let msg = `📱 *APKs Page ${page+1}*\n`;
    for (const key of pageKeys) {
        const id = key.replace(prefix, '');
        const data = await kvGet(`apk:${id}`);
        const downloads = data?.downloads || 0;
        msg += `\`${id}\` → ${downloads} downloads\n${WORKER_DEPLOY_URL}/apk/${id}.apk\n\n`;
    }
    const nav = [];
    if (page > 0) nav.push(Markup.button.callback('◀️', `apk_page_${page-1}`));
    if (start+perPage < keys.length) nav.push(Markup.button.callback('▶️', `apk_page_${page+1}`));
    nav.push(Markup.button.callback('🔙 Back', 'menu_apk'));
    await ctx.reply(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([nav]) });
}
bot.action(/apk_page_(\d+)/, async (ctx) => {
    await showMyApks(ctx, parseInt(ctx.match[1]));
});

// ---------- Custom Domains ----------
const domainKeyboard = () => Markup.inlineKeyboard([
    [Markup.button.callback('➕ Add', 'domain_add'), Markup.button.callback('❌ Delete', 'domain_del')],
    [Markup.button.callback('📋 List', 'domain_list'), Markup.button.callback('⬅️ Main', 'start_menu')]
]);

bot.action('menu_domain', async (ctx) => {
    await ctx.reply('🌐 *Custom Domains*', { parse_mode: 'Markdown', ...domainKeyboard() });
});
bot.action('domain_add', async (ctx) => {
    await ctx.reply('Send: `shortcode domain.com`');
    ctx.session.expecting = 'domain_add';
});
bot.action('domain_del', async (ctx) => {
    await ctx.reply('Send domain to delete:');
    ctx.session.expecting = 'domain_del';
});
bot.action('domain_list', async (ctx) => {
    const records = await listDNSRecords();
    if (!records.length) return ctx.reply('No custom domains.');
    let msg = '🌐 *Your Domains*\n';
    for (const rec of records) {
        const domain = rec.name;
        const kvData = await kvGet(`domain:${domain}`);
        msg += `• ${domain} → ${kvData?.type || 'unknown'}\n`;
    }
    await ctx.reply(msg, { parse_mode: 'Markdown' });
});

// ---------- Stats Dashboard ----------
bot.action('menu_stats', async (ctx) => {
    const shortKeys = await kvListKeys(`short:user_${ctx.from.id}:`);
    const siteKeys = await kvListKeys(`deploy:user_${ctx.from.id}:`);
    const apkKeys = await kvListKeys(`apk:user_${ctx.from.id}:`);
    let totalClicks = 0;
    for (const key of shortKeys.keys) {
        const sc = key.replace(`short:user_${ctx.from.id}:`, '');
        totalClicks += (await kvGet(`views:${sc}`)) || 0;
    }
    await ctx.reply(`📊 *Stats*\n🔗 Short URLs: ${shortKeys.keys.length} (${totalClicks} clicks)\n📦 Sites: ${siteKeys.keys.length}\n📱 APKs: ${apkKeys.keys.length}`, { parse_mode: 'Markdown' });
});

// ---------- File & Text Handlers ----------
bot.on('document', async (ctx) => {
    const expecting = ctx.session.expecting;
    if (expecting === 'deploy_zip') {
        const doc = ctx.message.document;
        if (!doc.file_name.endsWith('.zip')) return ctx.reply('Send .zip file.');
        await ctx.reply('Processing...');
        const fileLink = await ctx.telegram.getFileLink(doc.file_id);
        const resp = await fetch(fileLink.href);
        const buffer = await resp.arrayBuffer();
        const zipPath = path.join(TEMP_DIR, `${Date.now()}.zip`);
        fs.writeFileSync(zipPath, Buffer.from(buffer));
        const zip = new AdmZip(zipPath);
        const entries = zip.getEntries();
        if (!entries.some(e => e.entryName === 'index.html')) return ctx.reply('No index.html');
        const shortCode = Math.random().toString(36).substring(2, 8);
        const folder = `sites/${shortCode}/`;
        for (const entry of entries) {
            if (entry.isDirectory) continue;
            let data = entry.getData();
            if (ctx.session.injectWallet && entry.entryName === 'index.html') {
                const cfg = ctx.session.walletConfig;
                const inject = `<script>window.walletConfig=${JSON.stringify(cfg)};</script>`;
                const html = data.toString('utf8');
                data = Buffer.from(html.replace('</head>', inject+'</head>'), 'utf8');
            }
            const ct = entry.entryName.endsWith('.html') ? 'text/html' : entry.entryName.endsWith('.css') ? 'text/css' : entry.entryName.endsWith('.js') ? 'application/javascript' : 'application/octet-stream';
            await uploadToR2(folder+entry.entryName, data, ct);
        }
        await kvPut(`deploy:${shortCode}`, { folder, createdAt: new Date().toISOString(), userId: ctx.from.id });
        await kvPut(`deploy:user_${ctx.from.id}:${shortCode}`, true);
        await kvPut(`views:${shortCode}`, 0);
        await ctx.reply(`✅ Deployed\nURL: ${WORKER_DEPLOY_URL}/${shortCode}/index.html\nCode: \`${shortCode}\``, { parse_mode: 'Markdown' });
        fs.unlinkSync(zipPath);
        delete ctx.session.expecting;
        delete ctx.session.injectWallet;
    } else if (expecting === 'apk_file') {
        const doc = ctx.message.document;
        if (!doc.file_name.endsWith('.apk')) return ctx.reply('Send .apk file.');
        const fileLink = await ctx.telegram.getFileLink(doc.file_id);
        const resp = await fetch(fileLink.href);
        const buffer = await resp.arrayBuffer();
        const shortId = Math.random().toString(36).substring(2, 10);
        await uploadToR2(`apks/${shortId}.apk`, Buffer.from(buffer), 'application/vnd.android.package-archive');
        await kvPut(`apk:${shortId}`, { originalName: doc.file_name, uploadTime: new Date().toISOString(), downloads: 0, userId: ctx.from.id });
        await kvPut(`apk:user_${ctx.from.id}:${shortId}`, true);
        await ctx.reply(`✅ APK uploaded\nLink: ${WORKER_DEPLOY_URL}/apk/${shortId}.apk\nID: \`${shortId}\``, { parse_mode: 'Markdown' });
        delete ctx.session.expecting;
    } else {
        await ctx.reply('Use menu first.');
    }
});

bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    const expecting = ctx.session.expecting;
    if (expecting === 'short_url_long') {
        let longUrl, customSlug, ttlDays = null;
        if (ctx.session.shortMode === 'auto') longUrl = text;
        else {
            const parts = text.split(' ');
            if (parts.length < 2) return ctx.reply('Format: `<url> <slug> [ttl]`');
            longUrl = parts[0]; customSlug = parts[1]; if (parts[2]) ttlDays = parseInt(parts[2]);
        }
        if (!/^https?:\/\//.test(longUrl)) return ctx.reply('Invalid URL');
        let shortCode = customSlug || Math.random().toString(36).substring(2, 8);
        if (await kvGet(`short:${shortCode}`)) return ctx.reply('Slug exists');
        await kvPut(`short:${shortCode}`, longUrl, ttlDays ? ttlDays*86400 : null);
        await kvPut(`short:user_${ctx.from.id}:${shortCode}`, true);
        await kvPut(`views:${shortCode}`, 0);
        await ctx.reply(`✅ ${WORKER_SHORT_URL}/${shortCode}${ttlDays ? ` (expires ${ttlDays}d)` : ''}`);
        delete ctx.session.expecting;
        delete ctx.session.shortMode;
    } else if (expecting === 'short_delete_code') {
        const sc = text.trim();
        if (!await kvGet(`short:${sc}`)) return ctx.reply('Not found');
        await kvDelete(`short:${sc}`); await kvDelete(`short:user_${ctx.from.id}:${sc}`); await kvDelete(`views:${sc}`);
        await ctx.reply(`Deleted ${sc}`);
        delete ctx.session.expecting;
    } else if (expecting === 'short_qr_generate') {
        let code = text.trim();
        if (code.startsWith('http')) {
            const m = code.match(/\/([a-zA-Z0-9]+)$/);
            if (!m) return ctx.reply('Invalid short URL');
            code = m[1];
        }
        if (!await kvGet(`short:${code}`)) return ctx.reply('Code not found');
        const qr = await QRCode.toBuffer(`${WORKER_SHORT_URL}/${code}`);
        await ctx.replyWithPhoto({ source: qr }, { caption: `QR for ${WORKER_SHORT_URL}/${code}` });
        delete ctx.session.expecting;
    } else if (expecting === 'site_delete_code') {
        const sc = text.trim();
        const data = await kvGet(`deploy:${sc}`);
        if (!data) return ctx.reply('Site not found');
        const objects = await listR2Folder(data.folder);
        for (const obj of objects) await deleteFromR2(obj.Key);
        await kvDelete(`deploy:${sc}`); await kvDelete(`deploy:user_${ctx.from.id}:${sc}`); await kvDelete(`views:${sc}`);
        await ctx.reply(`Deleted site ${sc}`);
        delete ctx.session.expecting;
    } else if (expecting === 'apk_delete_code') {
        let id = text.trim();
        if (id.startsWith('apk:')) id = id.split(':')[1];
        if (!await kvGet(`apk:${id}`)) return ctx.reply('APK not found');
        await deleteFromR2(`apks/${id}.apk`);
        await kvDelete(`apk:${id}`); await kvDelete(`apk:user_${ctx.from.id}:${id}`);
        await ctx.reply(`Deleted APK ${id}`);
        delete ctx.session.expecting;
    } else if (expecting === 'apk_qr_generate') {
        let id = text.trim();
        if (id.startsWith('apk:')) id = id.split(':')[1];
        if (!await kvGet(`apk:${id}`)) return ctx.reply('APK not found');
        const qr = await QRCode.toBuffer(`${WORKER_DEPLOY_URL}/apk/${id}.apk`);
        await ctx.replyWithPhoto({ source: qr }, { caption: `QR for APK ${id}` });
        delete ctx.session.expecting;
    } else if (expecting === 'wallet_exoid') {
        let exoId = text === '/skip' ? `user_${ctx.from.id}` : text;
        ctx.session.walletConfig.exogatorId = exoId;
        await ctx.reply(`✅ ID set to \`${exoId}\`. Two‑step?`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔒 On', 'wallet_towsteps_1'), Markup.button.callback('🔓 Off', 'wallet_towsteps_0')]]) });
        delete ctx.session.expecting;
    } else if (expecting === 'domain_add') {
        const parts = text.split(' ');
        if (parts.length !== 2) return ctx.reply('Format: `shortcode domain.com`');
        const [sc, domain] = parts;
        const deploy = await kvGet(`deploy:${sc}`);
        const short = await kvGet(`short:${sc}`);
        if (!deploy && !short) return ctx.reply('Short code not found');
        const target = deploy ? WORKER_DEPLOY_URL.replace('https://', '') : WORKER_SHORT_URL.replace('https://', '');
        try {
            await addCNAME(domain, target);
            await kvPut(`domain:${domain}`, { type: deploy ? 'deploy' : 'short', shortCode: sc });
            await ctx.reply(`✅ ${domain} → ${sc}`);
        } catch(e) { ctx.reply(`Error: ${e.message}`); }
        delete ctx.session.expecting;
    } else if (expecting === 'domain_del') {
        const domain = text.trim();
        try {
            await deleteCNAME(domain);
            await kvDelete(`domain:${domain}`);
            await ctx.reply(`✅ Removed ${domain}`);
        } catch(e) { ctx.reply(`Error: ${e.message}`); }
        delete ctx.session.expecting;
    } else {
        await ctx.reply('Use menu buttons.', mainMenu);
    }
});

// ---------- Admin Commands ----------
bot.command('admin', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('⛔ Unauthorized.');
    await ctx.reply('🔐 *Admin Panel*\n\n/broadcast <msg> - Send to all users\n/stats all - Global stats\n/getuser <id> - User info\n/deleteuser <id> - Delete user data', { parse_mode: 'Markdown' });
});
bot.command('broadcast', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const msg = ctx.message.text.replace('/broadcast', '').trim();
    if (!msg) return ctx.reply('Usage: /broadcast <message>');
    const { keys } = await kvListKeys('user:');
    let sent = 0;
    for (const key of keys) {
        const userId = parseInt(key.replace('user:', ''));
        try { await ctx.telegram.sendMessage(userId, `📢 *Announcement*\n${msg}`, { parse_mode: 'Markdown' }); sent++; } catch(e) {}
    }
    await ctx.reply(`Broadcast sent to ${sent} users.`);
});
bot.command('stats', async (ctx) => {
    const args = ctx.message.text.split(' ');
    if (args[1] === 'all' && isAdmin(ctx)) {
        const users = await kvListKeys('user:');
        const shorts = await kvListKeys('short:');
        const sites = await kvListKeys('deploy:');
        const apks = await kvListKeys('apk:');
        await ctx.reply(`📊 *Global Stats*\nUsers: ${users.keys.length}\nShort URLs: ${shorts.keys.length}\nSites: ${sites.keys.length}\nAPKs: ${apks.keys.length}`, { parse_mode: 'Markdown' });
    } else {
        const id = args[1];
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
            if (!short && !deploy) return ctx.reply('Short code not found');
            await ctx.reply(`📊 *${short ? 'Short URL' : 'Website'}* \`${id}\`\nViews: ${views}`, { parse_mode: 'Markdown' });
        }
    }
});
bot.command('getuser', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const userId = ctx.message.text.split(' ')[1];
    if (!userId) return ctx.reply('Usage: /getuser <user_id>');
    const data = await kvGet(`user:${userId}`);
    if (!data) return ctx.reply('User not found');
    await ctx.reply(`👤 *User ${userId}*\nFirst seen: ${data.firstSeen}\nUsername: @${data.username || 'none'}\nName: ${data.name}`, { parse_mode: 'Markdown' });
});
bot.command('deleteuser', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const userId = ctx.message.text.split(' ')[1];
    if (!userId) return ctx.reply('Usage: /deleteuser <user_id>');
    // Delete user's short URLs
    const shortKeys = await kvListKeys(`short:user_${userId}:`);
    for (const key of shortKeys.keys) {
        const sc = key.replace(`short:user_${userId}:`, '');
        await kvDelete(`short:${sc}`);
        await kvDelete(`views:${sc}`);
        await kvDelete(key);
    }
    // Delete user's sites
    const siteKeys = await kvListKeys(`deploy:user_${userId}:`);
    for (const key of siteKeys.keys) {
        const sc = key.replace(`deploy:user_${userId}:`, '');
        const data = await kvGet(`deploy:${sc}`);
        if (data?.folder) {
            const objects = await listR2Folder(data.folder);
            for (const obj of objects) await deleteFromR2(obj.Key);
        }
        await kvDelete(`deploy:${sc}`);
        await kvDelete(`views:${sc}`);
        await kvDelete(key);
    }
    // Delete user's APKs
    const apkKeys = await kvListKeys(`apk:user_${userId}:`);
    for (const key of apkKeys.keys) {
        const id = key.replace(`apk:user_${userId}:`, '');
        await deleteFromR2(`apks/${id}.apk`);
        await kvDelete(`apk:${id}`);
        await kvDelete(key);
    }
    await kvDelete(`user:${userId}`);
    await ctx.reply(`✅ Deleted all data for user ${userId}`);
});
bot.command('qr', async (ctx) => {
    const url = ctx.message.text.split(' ')[1];
    if (!url) return ctx.reply('Usage: /qr <url>');
    try {
        const qr = await QRCode.toBuffer(url);
        await ctx.replyWithPhoto({ source: qr }, { caption: `QR for ${url}` });
    } catch(e) { ctx.reply('Failed to generate QR'); }
});

bot.action('start_menu', async (ctx) => {
    await ctx.reply('🏠 *Main Menu*', { parse_mode: 'Markdown', ...mainMenu });
});

const app = express();
app.get('/', (req, res) => res.send('Bot is alive'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Web server on ${PORT}`));

bot.launch().then(() => console.log('Bot started polling'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
