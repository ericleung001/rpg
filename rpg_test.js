require('dotenv').config();
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const jwt = require('jsonwebtoken'); 
const BanSystem = require('./ban'); //  引入 Ban 模組
const LotterySystem = require('./lottery');
const path = require('path'); 
const fs = require('fs');
const PLAYER_DIR = './player_stats'; // 請確認你的存檔資料夾名稱

//  [工具] 防止 XSS (HTML Injection)


//  可疑行為紀錄 (全域變數)
const suspiciousLogs = [];

function logSuspicion(name, reason) {
    const logEntry = {
        time: new Date().toLocaleString(),
        name: name,
        reason: reason
    };
    
    suspiciousLogs.unshift(logEntry); 
    if (suspiciousLogs.length > 200) suspiciousLogs.pop(); 

    //  [修改] 這裡原本可能是 'adminLogUpdate'，請改成與 admin.html 一致的名稱
    io.emit('adminSuspiciousLogsData', suspiciousLogs); 
}

// 1. 檢查是否包含非法隱藏字元
function hasForbiddenChars(str) {
    // 禁止：控制字符(0-31), DEL(127), 零寬空格(\u200B), 隱藏加號(\u2064), BOM等
    // 保留 \u200D (Zero Width Joiner) 給 Emoji 組合用
    const regex = /[\x00-\x1F\x7F\u200B\u2028-\u202F\u2060-\u2064\uFEFF]/;
    return regex.test(str);
}

// ️ [安全工具] 嚴格檢查名稱 (禁止 空格/隱形字/HTML符號)
function isValidName(name) {
    if (!name) return false;
    const cleanName = name.trim();
    
    // 檢查是否包含: 空白(\s), 全形空格(\u3000), 零寬空格(\u200B), 韓文填充符(\u3164), 
    // HTML符號(< > ' "), 控制碼(\x00-\x1F)
    const forbiddenRegex = /[\s\u3000\u200B-\u200D\uFEFF\u3164\x00-\x1F\x7F<>'"]/g;
    
    if (forbiddenRegex.test(cleanName)) return false;
    return true;
}

// 2. 轉義 HTML (防止 XSS 存入資料庫)
function escapeHtml(text) {
    if (!text) return text;
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}
// ️ [工具] 取得真實 IP (增強版)
function getSocketIp(socket) {
    const headers = socket.handshake.headers;

    // 1. Cloudflare 專用 Header (如果你有掛 CF，這個最準)
    if (headers['cf-connecting-ip']) {
        return headers['cf-connecting-ip'];
    }

    // 2. Nginx / 一般代理 Header (X-Forwarded-For)
    // 格式通常是: "真實IP, 代理1, 代理2" -> 我們取第一個
    const forwarded = headers['x-forwarded-for'];
    if (forwarded) {
        return forwarded.split(',')[0].trim();
    }

    // 3. X-Real-IP (有些 Nginx 設定用這個)
    if (headers['x-real-ip']) {
        return headers['x-real-ip'];
    }

    // 4. 最後手段：直接讀取連線 IP (如果沒經過代理，這就是真實 IP)
    let ip = socket.handshake.address;
    if (ip && ip.startsWith('::ffff:')) {
        ip = ip.replace('::ffff:', ''); // 去除 IPv6 前綴
    }
    
    return ip;
}

// 全局變數定義
let LUCKY_BAG_STOCK = 0; // 設定福袋限量
let LAST_BOSS_RANKING = [];
let lastAutoSpawnTime = ""; 
let lastLotteryTime = "";

const io = require('socket.io')(http, {
    cors: {
        origin: "*",  
        methods: ["GET", "POST"]
    }
});
const DB = require('./db'); 
const bcrypt = require('bcryptjs'); 
const nodemailer = require('nodemailer');

// ==========================================
//  Email 驗證系統
// ==========================================
const EMAIL_CODES = {}; // { email: { code, type, expires, user, pass, hash } }
const EMAIL_COOLDOWN = {}; // { email: timestamp } 防止頻繁發送
const PASSWORD_RESET_TOKENS = {}; // { token: { username, expires } }

// 寄件者地址 (Cloudflare Email Routing + Gmail SMTP)
const EMAIL_FROM = process.env.EMAIL_FROM || 'info@rpggameser.cc';
const SITE_URL = process.env.SITE_URL || 'https://mmo.ttctv-105.cc';

// 建立郵件發送器 (Gmail SMTP 做 relay，Cloudflare 做 routing)
const emailTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
});

// 發送驗證碼
async function sendVerificationEmail(toEmail, code) {
    try {
        await emailTransporter.sendMail({
            from: `"冒險者公會" <${EMAIL_FROM}>`,
            to: toEmail,
            subject: `[冒險者公會] 你的驗證碼：${code}`,
            html: `
                <div style="font-family:sans-serif; max-width:400px; margin:0 auto; padding:20px; background:#2c3e50; color:#ecf0f1; border-radius:10px;">
                    <h2 style="text-align:center; color:#f1c40f;">⚔️ 冒險者公會</h2>
                    <p style="text-align:center;">你的 Email 驗證碼是：</p>
                    <div style="text-align:center; font-size:36px; font-weight:bold; color:#2ecc71; letter-spacing:8px; margin:20px 0;">${code}</div>
                    <p style="text-align:center; font-size:12px; color:#95a5a6;">此驗證碼將在 10 分鐘後失效<br>如非本人操作，請忽略此郵件</p>
                </div>
            `
        });
        console.log(`[Email] 驗證碼已發送至 ${toEmail}`);
        return true;
    } catch (err) {
        console.error("[Email] 發送失敗:", err.message);
        return false;
    }
}

// 發送密碼重設連結
async function sendPasswordResetEmail(toEmail, username, resetToken) {
    try {
        const resetUrl = `${SITE_URL}/reset-password.html?token=${resetToken}`;
        await emailTransporter.sendMail({
            from: `"冒險者公會" <${EMAIL_FROM}>`,
            to: toEmail,
            subject: `[冒險者公會] 密碼重設申請`,
            html: `
                <div style="font-family:sans-serif; max-width:450px; margin:0 auto; padding:20px; background:#2c3e50; color:#ecf0f1; border-radius:10px;">
                    <h2 style="text-align:center; color:#f1c40f;">⚔️ 冒險者公會</h2>
                    <p style="text-align:center;">收到你的密碼重設申請</p>
                    <p style="text-align:center; font-size:12px; color:#bdc3c7;">帳號：<b style="color:#3498db;">${username}</b></p>
                    <div style="text-align:center; margin:25px 0;">
                        <a href="${resetUrl}" style="display:inline-block; background:#e74c3c; color:white; padding:14px 30px; text-decoration:none; border-radius:8px; font-weight:bold; font-size:14px;"> 重設密碼</a>
                    </div>
                    <p style="text-align:center; font-size:11px; color:#95a5a6;">此連結將在 30 分鐘後失效</p>
                    <p style="text-align:center; font-size:10px; color:#7f8c8d;">如非本人操作，請忽略此郵件<br>你的密碼不會被更改</p>
                    <hr style="border:none; border-top:1px solid #34495e; margin:15px 0;">
                    <p style="font-size:9px; color:#7f8c8d; text-align:center;">如果按鈕無法點擊，請複製以下連結：<br><span style="color:#3498db; word-break:break-all;">${resetUrl}</span></p>
                </div>
            `
        });
        console.log(`[Email] 密碼重設連結已發送至 ${toEmail} (帳號: ${username})`);
        return true;
    } catch (err) {
        console.error("[Email] 重設郵件發送失敗:", err.message);
        return false;
    }
}

// 生成 6 位數字驗證碼
function generateCode() {
    return String(Math.floor(100000 + Math.random() * 900000));
}

app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); next(); });
app.use(express.static(__dirname));

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_key_change_me_in_prod';
const JWT_EXPIRES_IN = '7d'; 

let disconnectTimers = {}; 
let MAINTENANCE_MODE = false; 
const MAINTENANCE_WHITELIST = ['test9', 'admin']; 

const SKILL_CONFIG = {
    'fireball':     { name: "火球術", level: 1,  mp: 5,  type: 'dmg',  val: 1.5, desc: "造成 1.5倍 傷害" },
    'heal_light':   { name: "小回復", level: 5,  mp: 10, type: 'heal', val: 0.2, desc: "恢復 20% 最大生命" }, 
    'thunder':      { name: "雷擊",   level: 10, mp: 15, type: 'stun', val: 1.2, desc: "1.2倍傷害 + 機率暈眩" },
    'drain':        { name: "吸血",   level: 15, mp: 20, type: 'drain',val: 1.0, desc: "吸取生命 (100% 傷害轉HP)" },
    'god_light':    { name: "神之光", level: 20, mp: 50, type: 'heal', val: 0.5, desc: "恢復 50% 最大生命" },
    'frost_nova':   { name: "冰霜新星", level: 25, mp: 30, type: 'debuff', val: 1.2, desc: "1.2倍傷害 + 降低防禦" },
    'poison_touch': { name: "劇毒之觸", level: 30, mp: 25, type: 'dot',    val: 2.5, desc: "毒素爆發 (2.5倍傷害)" },
    'holy_shield':  { name: "聖光守護", level: 35, mp: 40, type: 'buff',   val: 2.0, desc: "防禦力變為 2倍 (3回合)" },
    'berserk':      { name: "狂暴",     level: 40, mp: 60, type: 'buff_atk',val: 2.0, desc: "攻擊變為 2倍 (代價:扣血)" },
    //'meteor':       { name: "隕石術",   level: 60, mp: 80, type: 'dmg',    val: 3.5, desc: "毀滅性打擊 (3.5倍傷害)" },
    'heal_all':     { name: "聖光普照", level: 100, mp: 100, type: 'heal_all', val: 1.0, desc: "全隊生命值完全恢復" },
    //'divine_slash': { name: "次元斬",   level: 100, mp: 150, type: 'dmg',  val: 5.0, desc: "撕裂空間 (5倍傷害)" },
    'full_heal':    { name: "大天使之息",level: 120, mp: 200, type: 'heal', val: 1.0, desc: "生命值完全恢復" },
    'god_mode':     { name: "天神下凡", level: 150, mp: 300, type: 'god',  val: 3.0, desc: "攻防變為 3倍 (3回合)" },
    //'void_crush':   { name: "虛空碎擊", level: 200, mp: 1000, type: 'dmg', val: 10.0, desc: "凝聚虛空之力，造成 10倍 傷害" },
    //'entropy_decay':{ name: "熱寂·衰變", level: 240, mp: 2500, type: 'percent_dmg', val: 0.05, desc: "無視防禦，造成敵人最大生命 5% 的真實傷害 (上限ATK x50)" },
    //'big_bang':     { name: "宇宙大爆炸", level: 280, mp: 5000, type: 'dmg', val: 25.0, desc: "引爆奇異點，造成 25倍 毀滅性傷害" },
    'meteor':        { name: "隕石術",   level: 60, mp: 80, type: 'aoe',     val: 3.5, desc: "毀滅性打擊 (3.5倍全體傷害)" },
    'divine_slash': { name: "次元斬",   level: 100, mp: 150, type: 'aoe',    val: 5.0, desc: "撕裂空間 (5倍全體傷害)" },
    'void_crush':    { name: "虛空碎擊", level: 200, mp: 1000, type: 'aoe', val: 10.0, desc: "凝聚虛空之力 (10倍全體傷害)" },
    'entropy_decay':{ name: "熱寂·衰變", level: 240, mp: 2500, type: 'aoe_percent', val: 0.05, desc: "全體 5% 真實傷害" }, // 新增類型 aoe_percent
    'big_bang':      { name: "宇宙大爆炸", level: 280, mp: 5000, type: 'dmg', val: 50.0, desc: "引爆奇異點 (50倍單體毀滅傷害)" }
};

const NPC_SHOP_ALLOW_LIST = [
    'potion_hp', 'potion_mid', 'potion_high', 'potion_max', 'elixir',
    'potion_mp', 'potion_mp_mid', 'potion_mp_high',
    'grilled_carp', 'salmon_sushi', 'tuna_steak', 'eel_rice', 'void_soup', 'sushi_plate',
    'wood_sword', 'copper_dagger', 'iron_sword', 'silver_blade',
    'oak_bow', 'maple_staff',
    'cloth_armor', 'leather_armor', 'chain_mail', 'iron_armor',
    'ring_str', 'bracelet_def', 'necklace_hp', 'necklace_mp','lucky_bag','enhance_stone','safe_stone'
];

// 物品名稱對照表
// 物品名稱對照表
const ITEM_NAMES = {
    'copper_ore': '銅礦石', 'soft_fur': '柔軟皮毛', 'beast_fang': '野獸尖牙', 'slime_gel': '黏液',
    'iron_ore': '鐵礦石', 'leather': '皮革', 'tough_hide': '硬皮革', 'magic_dust': '魔粉',
    'poison_sac': '毒囊', 'bone_shard': '碎骨片', 'silver_ore': '銀礦石', 'fire_core': '火焰核心',
    'lava_rock': '熔岩石', 'dragon_scale': '龍鱗', 'gold_ore': '金礦石', 'ice_crystal': '永恆冰晶',
    'yeti_fur': '雪怪毛皮', 'spirit_dust': '靈魂粉末', 'mithril': '秘銀', 'void_dust': '虛空之塵',
    'demon_horn': '惡魔之角', 'dark_essence': '暗之精華', 'adamantite': '精金', 'god_blood': '神之血',
    'chaos_orb': '混沌寶珠', 'angel_feather': '天使之羽', 'titan_steel': '泰坦神鋼', 'star_fragment': '星之碎片',
    'oak_log': '橡木原木', 'maple_log': '楓木原木', 'yew_log': '紫杉原木', 'ancient_log': '遠古神木',
    'spirit_wood': '靈木', 'dragon_wood': '龍骨木', 'void_wood': '虛空木', 'chaos_wood': '混沌神木',
    'carp': '鯉魚', 'salmon': '鮭魚', 'koi': '錦鯉', 'magic_fish': '魔力魚', 'tuna': '黑鮪魚',
    'shark': '大白鯊', 'lava_eel': '熔岩鰻', 'void_squid': '虛空烏賊', 'god_carp': '神之鯉',
    'pearl': '珍珠', 'coal': '煤炭', 'ruby': '紅寶石', 'diamond': '鑽石',
    'void_shard': '虛空碎片', 'dark_matter': '暗物質', 'star_core': '恆星核心',
    'cosmic_steel': '宇宙鋼', 'time_sand': '時光之沙', 'dimension_gem': '維度寶石',
    'entropy_origin': '熱寂原點',
    'void_blade': '虛空之刃', 'void_armor': '虛空戰甲',
    'galaxy_saber': '銀河光劍', 'nebula_plate': '星雲板甲',
    'ring_galaxy': '銀河指環', 'genesis_weapon': '創世·終焉之劍', 'genesis_armor': '創世·神之庇護',
    
    //  Lv.400-500 新增物品
    'quantum_residue': '量子殘渣',
    'multiverse_shard': '多元宇宙碎片',
    'divinity_core': '創世神格',
    'infinity_blade': '無限之刃',
    'event_horizon': '視界戰甲',
    'mobius_ring': '莫比烏斯環',
    'singularity_weapon': '奇點·萬象崩壞',
    'singularity_armor': '奇點·絕對防禦',
    'singularity_acc': '奇點·因果律',
    // [新增] 碎片商店專屬飾物
    'shard_ring_novice': '學徒碎片戒指',   // Lv.10
    'shard_neck_brave': '勇者碎片項鍊',    // Lv.30
    'shard_charm_wind': '疾風碎片護符',    // Lv.60
    'shard_ring_vampire': '吸血鬼碎片指環', // Lv.100 (特殊：吸血)
    'shard_earring_holy': '神聖碎片耳環',   // Lv.150 (高魔力)
    'shard_belt_titan': '泰坦碎片腰帶',    // Lv.200 (高防禦)
    'shard_pendant_dragon': '龍魂碎片吊墜', // Lv.300 (高攻防)
    'shard_ring_void': '虛空碎片之戒',     // Lv.400
    'shard_core_galaxy': '銀河碎片核心',   // Lv.450
    'shard_crown_infinity': '無限碎片皇冠', // Lv.500 (畢業級)
    // 在 ITEM_NAME_MAP 中加入：
	'shard_blade_novice': '碎光長劍',
	'shard_axe_crystal': '晶體戰斧',
	'shard_scythe_void': '虛空撕裂者',
	'shard_spear_galaxy': '星河·貫穿之槍',
	'shard_wep_dimension': '維度·終焉裁決',
	'shard_wep_origin': '原初·萬物歸零',
	// 在 ITEM_NAME_MAP 中加入：
	'shard_armor_novice': '碎光輕甲',
	'shard_armor_crystal': '晶體戰甲',
	'shard_robe_void': '虛空行者法袍',
	'shard_plate_galaxy': '星河·不滅壁壘',
	'shard_armor_dimension': '維度·虛數裝甲',
	'shard_armor_origin': '原初·混沌神軀'
};

// 採集點設定
const GATHER_CONFIG = {
    'forest_1': { name: "迷霧森林 (Lv.1)",   type: 'wood', reqLv: 1,   time: 3000, drops: [{id:'oak_log', rate:0.7}, {id:'soft_fur', rate:0.2}, {id:'potion_hp', rate:0.1}] },
    'forest_2': { name: "精靈之森 (Lv.20)",  type: 'wood', reqLv: 20,  time: 4000, drops: [{id:'maple_log', rate:0.6}, {id:'oak_log', rate:0.2}, {id:'slime_gel', rate:0.1}, {id:'magic_dust', rate:0.1}] },
    'forest_3': { name: "巨木之森 (Lv.40)",  type: 'wood', reqLv: 40,  time: 5000, drops: [{id:'yew_log', rate:0.5}, {id:'maple_log', rate:0.3}, {id:'poison_sac', rate:0.1}, {id:'potion_mp', rate:0.1}] },
    'forest_4': { name: "靈魂樹海 (Lv.60)",  type: 'wood', reqLv: 60,  time: 6000, drops: [{id:'spirit_wood', rate:0.4}, {id:'yew_log', rate:0.3}, {id:'spirit_dust', rate:0.2}, {id:'amulet_soul', rate:0.05}] },
    'forest_5': { name: "龍棲之森 (Lv.80)",  type: 'wood', reqLv: 80,  time: 7000, drops: [{id:'dragon_wood', rate:0.4}, {id:'dragon_scale', rate:0.2}, {id:'fire_core', rate:0.2}, {id:'potion_high', rate:0.1}] },
    'forest_6': { name: "混沌樹界 (Lv.100)", type: 'wood', reqLv: 100, time: 8000, drops: [{id:'chaos_wood', rate:0.4}, {id:'dark_essence', rate:0.3}, {id:'chaos_orb', rate:0.05}] },
    'forest_7': { name: "腐化密林 (Lv.105)", type: 'wood', reqLv: 105, time: 8200, drops: [{id:'chaos_wood', rate:0.3}, {id:'void_dust', rate:0.3}, {id:'poison_sac', rate:0.2}] },
    'forest_8': { name: "虛空邊界 (Lv.110)", type: 'wood', reqLv: 110, time: 8400, drops: [{id:'void_wood', rate:0.4}, {id:'void_dust', rate:0.3}, {id:'void_shard', rate:0.1}] },
    'forest_9': { name: "神聖古樹 (Lv.115)", type: 'wood', reqLv: 115, time: 8600, drops: [{id:'ancient_log', rate:0.4}, {id:'god_blood', rate:0.2}, {id:'angel_feather', rate:0.1}] },
    'forest_10': { name: "泰坦之森 (Lv.120)", type: 'wood', reqLv: 120, time: 8800, drops: [{id:'ancient_log', rate:0.3}, {id:'titan_steel', rate:0.2}, {id:'adamantite', rate:0.2}] },
    'forest_11': { name: "星光林地 (Lv.125)", type: 'wood', reqLv: 125, time: 9000, drops: [{id:'void_wood', rate:0.3}, {id:'star_fragment', rate:0.3}, {id:'mithril', rate:0.2}] },
    'forest_12': { name: "恆星核心 (Lv.130)", type: 'wood', reqLv: 130, time: 9200, drops: [{id:'star_core', rate:0.2}, {id:'fire_core', rate:0.3}, {id:'magma_plate', rate:0.05}] },
    'forest_13': { name: "宇宙星雲 (Lv.135)", type: 'wood', reqLv: 135, time: 9400, drops: [{id:'cosmic_steel', rate:0.2}, {id:'star_fragment', rate:0.3}, {id:'void_shard', rate:0.2}] },
    'forest_14': { name: "維度裂縫 (Lv.140)", type: 'wood', reqLv: 140, time: 9600, drops: [{id:'dimension_gem', rate:0.1}, {id:'void_wood', rate:0.3}, {id:'time_sand', rate:0.2}] },
    'forest_15': { name: "黑洞視界 (Lv.145)", type: 'wood', reqLv: 145, time: 9800, drops: [{id:'dark_matter', rate:0.2}, {id:'dark_essence', rate:0.3}] },
    'forest_16': { name: "終焉之森 (Lv.150)", type: 'wood', reqLv: 150, time: 10000,drops: [{id:'entropy_origin', rate:0.02},  {id:'ancient_log', rate:0.4}] },

    'lake_1': { name: "寧靜湖泊 (Lv.1)",   type: 'fish', reqLv: 1,   time: 3000, drops: [{id:'carp', rate:0.6}, {id:'salmon', rate:0.3}, {id:'leather', rate:0.1}] },
    'lake_2': { name: "神秘深潭 (Lv.20)",  type: 'fish', reqLv: 20,  time: 4000, drops: [{id:'magic_fish', rate:0.4}, {id:'pearl', rate:0.1}, {id:'koi', rate:0.3}, {id:'slime_gel', rate:0.1}] },
    'lake_3': { name: "暴風海灣 (Lv.40)",  type: 'fish', reqLv: 40,  time: 5000, drops: [{id:'tuna', rate:0.5}, {id:'shark', rate:0.3}, {id:'bone_shard', rate:0.1}, {id:'snake_boots', rate:0.05}] },
    'lake_4': { name: "熔岩之河 (Lv.60)",  type: 'fish', reqLv: 60,  time: 6000, drops: [{id:'lava_eel', rate:0.5}, {id:'fire_core', rate:0.3}, {id:'coal', rate:0.1}, {id:'magma_plate', rate:0.02}] },
    'lake_5': { name: "虛空之海 (Lv.80)",  type: 'fish', reqLv: 80,  time: 7000, drops: [{id:'void_squid', rate:0.4}, {id:'void_dust', rate:0.3}, {id:'demon_horn', rate:0.1}, {id:'potion_max', rate:0.1}] },
    'lake_6': { name: "神之天池 (Lv.100)", type: 'fish', reqLv: 100, time: 8000, drops: [{id:'god_carp', rate:0.3}, {id:'angel_feather', rate:0.3}, {id:'diamond', rate:0.2}] },
    'lake_7': { name: "冰封海域 (Lv.105)", type: 'fish', reqLv: 105, time: 8200, drops: [{id:'ice_crystal', rate:0.4}, {id:'pearl', rate:0.3}, {id:'diamond', rate:0.1}] },
    'lake_8': { name: "深淵海溝 (Lv.110)", type: 'fish', reqLv: 110, time: 8400, drops: [{id:'void_squid', rate:0.3}, {id:'dark_essence', rate:0.3}, {id:'void_shard', rate:0.1}] },
    'lake_9': { name: "血色河流 (Lv.115)", type: 'fish', reqLv: 115, time: 8600, drops: [{id:'god_blood', rate:0.3}, {id:'ruby', rate:0.3}, {id:'demon_horn', rate:0.2}] },
    'lake_10': { name: "水銀之海 (Lv.120)", type: 'fish', reqLv: 120, time: 8800, drops: [{id:'mithril', rate:0.3}, {id:'silver_ore', rate:0.3}, {id:'titan_steel', rate:0.1}] },
    'lake_11': { name: "銀河之流 (Lv.125)", type: 'fish', reqLv: 125, time: 9000, drops: [{id:'star_fragment', rate:0.3}, {id:'magic_fish', rate:0.3}, {id:'star_core', rate:0.1}] },
    'lake_12': { name: "隕石瀑布 (Lv.130)", type: 'fish', reqLv: 130, time: 9200, drops: [{id:'star_core', rate:0.2}, {id:'fire_core', rate:0.3}, {id:'gold_ore', rate:0.2}] },
    'lake_13': { name: "宇宙洋流 (Lv.135)", type: 'fish', reqLv: 135, time: 9400, drops: [{id:'cosmic_steel', rate:0.2}, {id:'void_shard', rate:0.2}, {id:'void_squid', rate:0.2}] },
    'lake_14': { name: "時光漩渦 (Lv.140)", type: 'fish', reqLv: 140, time: 9600, drops: [{id:'time_sand', rate:0.2}, {id:'dimension_gem', rate:0.1}, {id:'elixir', rate:0.05}] },
    'lake_15': { name: "暗物質泉 (Lv.145)", type: 'fish', reqLv: 145, time: 9800, drops: [{id:'dark_matter', rate:0.2}, {id:'dark_essence', rate:0.3}, {id:'void_reaper_dark', rate:0.01}] },
    'lake_16': { name: "起源之海 (Lv.150)", type: 'fish', reqLv: 150, time: 10000,drops: [{id:'entropy_origin', rate:0.02},  {id:'god_carp', rate:0.3}, {id:'void_reaper_dark', rate:0.01}] },

    'mine_1': { name: "廢棄礦坑 (Lv.10)", type: 'mine', reqLv: 10, time: 3500, drops: [{id:'copper_ore', rate:0.5}, {id:'iron_ore', rate:0.3}, {id:'coal', rate:0.2}] },
    'mine_2': { name: "水晶洞窟 (Lv.50)", type: 'mine', reqLv: 50, time: 5500, drops: [{id:'silver_ore', rate:0.4}, {id:'ruby', rate:0.3}, {id:'ice_crystal', rate:0.2}, {id:'gold_ore', rate:0.1}] },
    'mine_3': { name: "隕石坑 (Lv.90)",   type: 'mine', reqLv: 90, time: 7500, drops: [{id:'mithril', rate:0.4}, {id:'adamantite', rate:0.3}, {id:'star_fragment', rate:0.2}, {id:'chaos_orb', rate:0.1}] },
    'mine_4': { name: "地獄熔爐 (Lv.100)", type: 'mine', reqLv: 100, time: 8000, drops: [{id:'fire_core', rate:0.3}, {id:'lava_rock', rate:0.4}, {id:'adamantite', rate:0.2}] },
    'mine_5': { name: "惡魔巢穴 (Lv.105)", type: 'mine', reqLv: 105, time: 8200, drops: [{id:'demon_horn', rate:0.3}, {id:'dark_essence', rate:0.3}, {id:'ruby', rate:0.2}] },
    'mine_6': { name: "虛空礦脈 (Lv.110)", type: 'mine', reqLv: 110, time: 8400, drops: [{id:'void_dust', rate:0.4}, {id:'void_shard', rate:0.2}, {id:'mithril', rate:0.2}] },
    'mine_7': { name: "神聖採石場 (Lv.115)",type:'mine', reqLv: 115, time: 8600, drops: [{id:'god_blood', rate:0.2}, {id:'angel_feather', rate:0.2}, {id:'diamond', rate:0.2}] },
    'mine_8': { name: "泰坦遺跡 (Lv.120)", type: 'mine', reqLv: 120, time: 8800, drops: [{id:'titan_steel', rate:0.2}, {id:'adamantite', rate:0.3}, {id:'iron_ore', rate:0.1}] },
    'mine_9': { name: "星塵峽谷 (Lv.125)", type: 'mine', reqLv: 125, time: 9000, drops: [{id:'star_fragment', rate:0.4}, {id:'mithril', rate:0.3}, {id:'star_core', rate:0.1}] },
    'mine_10': { name: "恆星地核 (Lv.130)", type: 'mine', reqLv: 130, time: 9200, drops: [{id:'star_core', rate:0.2}, {id:'gold_ore', rate:0.3}, {id:'fire_core', rate:0.2}] },
    'mine_11': { name: "銀河岩床 (Lv.135)", type: 'mine', reqLv: 135, time: 9400, drops: [{id:'cosmic_steel', rate:0.2}, {id:'star_fragment', rate:0.3}, {id:'diamond', rate:0.1}] },
    'mine_12': { name: "維度斷層 (Lv.140)", type: 'mine', reqLv: 140, time: 9600, drops: [{id:'dimension_gem', rate:0.15}, {id:'void_shard', rate:0.2}] },
    'mine_13': { name: "暗物質倉 (Lv.145)", type: 'mine', reqLv: 145, time: 9800, drops: [{id:'dark_matter', rate:0.2}, {id:'dark_essence', rate:0.3}] },
    'mine_14': { name: "熱寂核心 (Lv.150)", type: 'mine', reqLv: 150, time: 10000,drops: [{id:'entropy_origin', rate:0.02},  {id:'diamond', rate:0.3}] }
};

const MATERIAL_CONFIG = {
    'copper_ore':   { name: '銅礦石', cost: 10 }, 
    'soft_fur':     { name: '柔軟皮毛', cost: 10 }, 
    'beast_fang':   { name: '野獸尖牙', cost: 15 }, 
    'slime_gel':    { name: '黏液', cost: 5 },
    'iron_ore':     { name: '鐵礦石', cost: 20 }, 
    'leather':      { name: '皮革', cost: 15 }, 
    'tough_hide':   { name: '硬皮革', cost: 25 }, 
    'magic_dust':   { name: '魔粉', cost: 30 },
    'poison_sac':   { name: '毒囊', cost: 30 }, 
    'bone_shard':   { name: '碎骨片', cost: 20 }, 
    'silver_ore':   { name: '銀礦石', cost: 50 }, 
    'fire_core':    { name: '火焰核心', cost: 80 },
    'lava_rock':    { name: '熔岩石', cost: 60 }, 
    'coal':         { name: '煤炭', cost: 5 },
    'dragon_scale': { name: '龍鱗', cost: 300 }, 
    'gold_ore':     { name: '金礦石', cost: 200 }, 
    'ice_crystal':  { name: '永恆冰晶', cost: 150 },
    'yeti_fur':     { name: '雪怪毛皮', cost: 180 }, 
    'spirit_dust':  { name: '靈魂粉末', cost: 120 }, 
    'mithril':      { name: '秘銀', cost: 500 }, 
    'void_dust':    { name: '虛空之塵', cost: 400 },
    'demon_horn':   { name: '惡魔之角', cost: 600 }, 
    'dark_essence': { name: '暗之精華', cost: 800 }, 
    'adamantite':   { name: '精金', cost: 2000 }, 
    'ruby':         { name: '紅寶石', cost: 200 }, 
    'diamond':      { name: '鑽石', cost: 500 },
    'god_blood':    { name: '神之血', cost: 3000 },
    'chaos_orb':    { name: '混沌寶珠', cost: 5000 }, 
    'angel_feather':{ name: '天使之羽', cost: 4000 },
    'titan_steel':  { name: '泰坦神鋼', cost: 8000 }, 
    'star_fragment':{ name: '星之碎片', cost: 10000 }, 
    'void_shard':     { name: '虛空碎片', cost: 15000 }, 
    'dark_matter':    { name: '暗物質',   cost: 25000 }, 
    'cosmic_steel':   { name: '宇宙鋼',   cost: 50000 }, 
    'star_core':      { name: '恆星核心', cost: 60000 }, 
    'time_sand':      { name: '時光之沙', cost: 120000 }, 
    'dimension_gem':  { name: '維度寶石', cost: 250000 }, 
    'entropy_origin': { name: '熱寂原點', cost: 1000000 }, 
    'oak_log':      { name: "橡木原木", cost: 5 }, 
    'maple_log':    { name: "楓木原木", cost: 15 }, 
    'yew_log':      { name: "紫杉原木", cost: 30 }, 
    'ancient_log':  { name: "遠古神木", cost: 100 },
    'spirit_wood':  { name: "靈木", cost: 50 }, 
    'dragon_wood':  { name: "龍骨木", cost: 150 }, 
    'void_wood':    { name: "虛空木", cost: 300 }, 
    'chaos_wood':   { name: "混沌神木", cost: 1000 },
    'carp':         { name: "鯉魚", cost: 5 }, 
    'salmon':       { name: "鮭魚", cost: 10 }, 
    'koi':          { name: "錦鯉", cost: 50 }, 
    'magic_fish':   { name: "魔力魚", cost: 30 },
    'tuna':         { name: "黑鮪魚", cost: 80 }, 
    'shark':        { name: "大白鯊", cost: 100 }, 
    'lava_eel':     { name: "熔岩鰻", cost: 120 }, 
    'void_squid':   { name: "虛空烏賊", cost: 200 },
    'god_carp':     { name: "神之鯉", cost: 500 }, 
    'pearl':        { name: "珍珠", cost: 500 },
    'quantum_residue': { name: '量子殘渣', cost: 500000 },
    'multiverse_shard': { name: '多元宇宙碎片', cost: 2000000 },
    'divinity_core': { name: '創世神格', cost: 50000000 },
    'skill_shard': { name: '✨ 技能碎片', cost: 100 }
};

const ENHANCE_RATES = {
    // === +1 ~ +10 (基礎強化) ===
    1: { rate: 1.0,  cost: 1000,  risk: 'safe' },    
    2: { rate: 1.0,  cost: 2000,  risk: 'safe' },
    3: { rate: 1.0,  cost: 5000,  risk: 'safe' },
    4: { rate: 0.8,  cost: 10000, risk: 'drop' },    
    5: { rate: 0.8,  cost: 20000, risk: 'drop' },
    6: { rate: 0.7,  cost: 40000, risk: 'drop' },
    7: { rate: 0.7,  cost: 80000, risk: 'drop' },  
    8: { rate: 0.6,  cost: 150000,risk: 'drop' },
    9: { rate: 0.6,  cost: 300000,risk: 'drop' },
    10:{ rate: 0.5,  cost: 1000000,risk: 'drop'},

    // === +11 ~ +15 (進階強化 - 失敗降級) ===
    11:{ rate: 0.5, cost: 2000000, risk: 'drop'}, // 50%
    12:{ rate: 0.4, cost: 3000000, risk: 'drop'},
    13:{ rate: 0.4, cost: 5000000, risk: 'drop'}, 
    14:{ rate: 0.3, cost: 8000000, risk: 'drop'},
    15:{ rate: 0.3, cost: 10000000,risk: 'drop'}, // 30%

    // === +16 ~ +20 (神話強化 - 失敗破碎) ===
    16:{ rate: 0.3,  cost: 20000000, risk: 'break'}, // 10%
    17:{ rate: 0.4, cost: 30000000, risk: 'break'}, // 7%
    18:{ rate: 0.4, cost: 50000000, risk: 'break'}, // 5%
    19:{ rate: 0.5, cost: 80000000, risk: 'break'}, // 3%
    20:{ rate: 0.5, cost: 100000000,risk: 'break'}, // 1% (1億G)

    // === [新增] +21 ~ +25 (虛空強化 - 失敗破碎) ===
    21:{ rate: 0.4, cost: 150000000, risk: 'break'}, // 0.5% (1.5億G)
    22:{ rate: 0.3, cost: 200000000, risk: 'break'}, // 0.4% (2億G)
    23:{ rate: 0.3, cost: 300000000, risk: 'break'}, // 0.3% (3億G)
    24:{ rate: 0.2, cost: 400000000, risk: 'break'}, // 0.2% (4億G)
    25:{ rate: 0.1, cost: 500000000, risk: 'break'}, // 0.1% (5億G) - 千分之一

    // === [新增] +26 ~ +30 (創世強化 - 奇蹟機率) ===
    26:{ rate: 0.05, cost: 1000000000, risk: 'break'}, // 0.05% (10億G) - 萬分之五
    27:{ rate: 0.03, cost: 2000000000, risk: 'break'}, // 0.03% (20億G)
    28:{ rate: 0.02, cost: 4000000000, risk: 'break'}, // 0.01% (40億G) - 萬分之一
    29:{ rate: 0.01,cost: 6000000000, risk: 'break'}, // 0.005% (60億G)
    30:{ rate: 0.01,cost: 10000000000,risk: 'break'}  // 0.001% (100億G) - 十萬分之一
};

const ITEM_CONFIG = {
    'potion_hp':        { name: "小紅藥水", type: 'consumable', cost: 50, desc: "恢復 50 HP" }, 
    'potion_mid':       { name: "中紅藥水", type: 'consumable', cost: 200, desc: "恢復 500 HP" },
    'potion_high':      { name: "大紅藥水", type: 'consumable', cost: 600, desc: "恢復 2000 HP" }, 
    'potion_max':       { name: "特級秘藥", type: 'consumable', cost: 5000, desc: "恢復 10000 HP" },
    'elixir':           { name: "神之甘露", type: 'consumable', cost: 20000, desc: "恢復 50000 HP" }, 
    'potion_mp':        { name: "小藍藥水", type: 'consumable', cost: 80, desc: "恢復 30 MP" },
    'potion_mp_mid':    { name: "中藍藥水", type: 'consumable', cost: 200, desc: "恢復 100 MP" }, 
    'potion_mp_high':   { name: "大藍藥水", type: 'consumable', cost: 600, desc: "恢復 500 MP" }, 
    'grilled_carp':     { name: "烤鯉魚", type: 'consumable', cost: 30, desc: "食用: HP+100" }, 
    'salmon_sushi':     { name: "鮭魚壽司", type: 'consumable', cost: 50, desc: "食用: MP+50" }, 
    'tuna_steak':       { name: "煎鮪魚排", type: 'consumable', cost: 200, desc: "食用: HP+500" }, 
    'eel_rice':         { name: "鰻魚飯", type: 'consumable', cost: 300, desc: "食用: HP+300, MP+100" },
    'void_soup':        { name: "虛空海鮮湯", type: 'consumable', cost: 1000000, desc: "食用: 狀態全滿" },
    'sushi_plate':      { name: "壽司拼盤", type: 'consumable', cost: 500, desc: "食用: HP+500" },
    'void_shard':       { name: "虛空碎片", type: 'material', cost: 10000, desc: "來自虛無空間的殘片" },
    'dark_matter':      { name: "暗物質",   type: 'material', cost: 20000, desc: "極度沉重的宇宙物質" },
    'star_core':        { name: "恆星核心", type: 'material', cost: 50000, desc: "燃燒著永恆烈火的核心" },
    'cosmic_steel':     { name: "宇宙鋼",   type: 'material', cost: 80000, desc: "比泰坦鋼更堅硬的金屬" },
    'time_sand':        { name: "時光之沙", type: 'material', cost: 150000, desc: "流動著時間力量的沙礫" },
    'dimension_gem':    { name: "維度寶石", type: 'material', cost: 300000, desc: "能折射空間的寶石" },
    'entropy_origin':   { name: "熱寂原點", type: 'material', cost: 9999999, desc: "象徵宇宙終結的物質" },
    'wood_sword':       { name: "木劍", type: 'weapon', atk: 10, cost: 100 },
    'copper_dagger':    { name: "銅匕首", type: 'weapon', atk: 20, cost: 400 }, 
    'oak_bow':          { name: "橡木弓", type: 'weapon', atk: 25, cost: 200 },
    'iron_sword':       { name: "鐵劍", type: 'weapon', atk: 60, cost: 1500 }, 
    'maple_staff':      { name: "楓木法杖", type: 'weapon', atk: 50, cost: 500 },
    'silver_blade':     { name: "銀刃", type: 'weapon', atk: 100, cost: 4000 }, 
    'spike_club':       { name: "狼牙棒", type: 'weapon', atk: 140, hp: 300, cost: 0 }, 
    'poison_dag':       { name: "劇毒匕首", type: 'weapon', atk: 160, cost: 0 }, 
    'shark_tooth':      { name: "鯊魚牙匕首", type: 'weapon', atk: 80, cost: 800 },
    'flame_staff':      { name: "火焰法杖", type: 'weapon', atk: 300, mp: 100, cost: 0 }, 
    'emerald_staff':    { name: "翡翠法杖", type: 'weapon', atk: 300, cost: 5000 },
    'gold_axe':         { name: "黃金巨斧", type: 'weapon', atk: 500, cost: 10000 }, 
    'obsidian_blade':   { name: "黑曜石之劍", type: 'weapon', atk: 600, cost: 8000 },
    'frost_bow':        { name: "寒冰弓", type: 'weapon', atk: 1300, cost: 0 }, 
    'dragon_spear':     { name: "龍骨長槍", type: 'weapon', atk: 1200, cost: 15000 },
    'mithril_saber':    { name: "秘銀軍刀", type: 'weapon', atk: 2000, cost: 50000 },
    'void_reaper':      { name: "虛空收割者", type: 'weapon', atk: 3500, cost: 0 }, 
    'void_reaper_dark': { name: "闇·虛空收割者", type: 'weapon', atk: 5500, cost: 0, desc: "吞噬光明的死神鐮刀" }, 
    'god_slayer':       { name: "弒神劍", type: 'weapon', atk: 20000, hp: 4000, cost: 0 }, 
    'chaos_staff':      { name: "混沌法杖", type: 'weapon', atk: 25000, mp: 300, cost: 0 }, 
    'hero_sword':       { name: "勇者之劍", type: 'weapon', atk: 100, cost: 0 },
    'steel_blade':      { name: "精鋼劍", type: 'weapon', atk: 25, cost: 0 },
    'assassin_dag':     { name: "刺客短刀", type: 'weapon', atk: 120, cost: 0 },
    'genesis_weapon':   { name: "創世·終焉之劍", type: 'weapon', atk: 60000, hp: 50000, cost: 0, desc: "伺服器最強武器" },
    'void_blade':       { name: "虛空之刃", type: 'weapon', atk: 75000, hp: 80000, cost: 0, desc: "Lv.230 武器，蘊含虛空之力" },
    'galaxy_saber':     { name: "銀河光劍", type: 'weapon', atk: 110000, hp: 150000, cost: 0, desc: "Lv.260 武器，斬斷星辰" },
    'entropy_sword':    { name: "終焉·熱寂之劍", type: 'weapon', atk: 200000, hp: 300000, cost: 0, desc: "Lv.300 最強神兵，象徵宇宙終結" },
    'cloth_armor':      { name: "布衣", type: 'armor', def: 5, hp: 50, cost: 100 },
    'hunt_vest':        { name: "獵人背心", type: 'armor', def: 25, hp: 200, cost: 0 }, 
    'leather_armor':    { name: "皮甲", type: 'armor', def: 15, hp: 200, cost: 400 }, 
    'plate_mail':       { name: "板金甲", type: 'armor', def: 15, cost: 0 },
    'dragon_mail':      { name: "龍鱗甲", type: 'armor', def: 30, cost: 0 },
    'chain_mail':       { name: "鎖子甲", type: 'armor', def: 40, hp: 800, cost: 1500 }, 
    'iron_armor':       { name: "鐵盔甲", type: 'armor', def: 100, hp: 1000, cost: 4000, desc: "堅固的鐵製護甲" }, 
    'magma_plate':      { name: "熔岩胸甲", type: 'armor', def: 150, hp: 1500, cost: 0 }, 
    'ice_robe':         { name: "冰霜法袍", type: 'armor', def: 200, mp: 500, cost: 0 }, 
    'yeti_cloak':       { name: "雪怪斗篷", type: 'armor', def: 350, hp: 4000, cost: 0 }, 
    'demon_armor':      { name: "惡魔戰甲", type: 'armor', def: 1000, hp: 12000, cost: 0 }, 
    'angel_armor':      { name: "熾天使鎧甲", type: 'armor', def: 5000, hp: 50000, cost: 0 },
    'genesis_armor':    { name: "創世·神之庇護", type: 'armor', def: 30000, hp: 200000, cost: 0, desc: "伺服器最強防具" },
    'void_armor':       { name: "虛空戰甲", type: 'armor', def: 45000, hp: 300000, cost: 0, desc: "Lv.230 防具，能夠抵禦虛無" },
    'nebula_plate':     { name: "星雲板甲", type: 'armor', def: 70000, hp: 600000, cost: 0, desc: "Lv.260 防具，如星雲般厚重" },
    'entropy_god_armor':{ name: "終焉·神之庇護", type: 'armor', def: 120000, hp: 1500000, cost: 0, desc: "Lv.300 最強神甲，萬法不侵" },
    'bone_ring':        { name: "骨戒", type: 'acc', atk: 15, hp: 100, cost: 0 }, 
    'fish_ring':        { name: "魚鱗戒指", type: 'acc', def: 50, hp: 500, cost: 400 }, 
    'snake_boots':      { name: "蛇皮長靴", type: 'acc', def: 30, hp: 200, cost: 0 }, 
    'ring_str':         { name: "力量戒指", type: 'acc', atk: 30, cost: 3000 },
    'bracelet_def':     { name: "堅毅手環", type: 'acc', def: 30, cost: 3000, desc: "增加防禦的手環" }, 
    'necklace_hp':      { name: "紅水晶項鍊", type: 'acc', hp: 250, cost: 5000, desc: "增加生命值的項鍊" }, 
    'necklace_mp':      { name: "藍水晶項鍊", type: 'acc', mp: 60, cost: 5000, desc: "增加魔力的項鍊" }, 
    'ring_life':        { name: "生命護符", type: 'acc', hp: 100, cost: 0 },
    'ring_magic':       { name: "魔力耳環", type: 'acc', mp: 50, cost: 0 },
    'pearl_necklace':   { name: "珍珠項鍊", type: 'acc', mp: 150, def: 20, cost: 2000 }, 
    'amulet_soul':      { name: "靈魂護符", type: 'acc', mp: 300, hp: 1000, cost: 0 }, 
    'ring_lord':        { name: "領主指環", type: 'acc', atk: 600, def: 600, hp: 2000, mp: 400, cost: 0 }, 
    'crown_chaos':      { name: "混沌之冠", type: 'acc', atk: 2000, def: 2000, hp: 20000, mp: 500, cost: 0 },
    'ring_galaxy':      { name: "銀河指環", type: 'acc', atk: 5000, def: 5000, hp: 5000, mp: 5000, cost: 0 },
    'enhance_stone':    { name: "強化石", type: 'consumable', cost: 50000, desc: "用於強化裝備 (成功率+)" },
    'dimension_ring':   { name: "維度指環", type: 'acc', atk: 15000, def: 15000, hp: 100000, mp: 20000, cost: 0, desc: "Lv.280 飾品，操控維度" },
    'lucky_bag': { name: "奇蹟福袋", type: 'consumable', cost: 1000000000, desc: "隨機開出價值連城的稀有材料！" },
    // --- Lv.400-500 材料 ---
    'quantum_residue': { name: "量子殘渣", type: 'material', cost: 500000, desc: "物質分解後的最小單位" },
    'multiverse_shard': { name: "多元宇宙碎片", type: 'material', cost: 2000000, desc: "來自平行時空的殘片" },
    'divinity_core':    { name: "創世神格", type: 'material', cost: 50000000, desc: "成神所需的唯一核心" },

    // --- Lv.450 神話裝備 (過渡用) ---
    'infinity_blade':   { name: "無限之刃", type: 'weapon', atk: 350000, hp: 500000, cost: 0, desc: "Lv.450 武器，劍身映照著無數星河" },
    'event_horizon':    { name: "視界戰甲", type: 'armor', def: 200000, hp: 2000000, cost: 0, desc: "Lv.450 防具，連光都無法逃脫" },
    'mobius_ring':      { name: "莫比烏斯環", type: 'acc', atk: 30000, def: 30000, hp: 500000, mp: 100000, cost: 0, desc: "Lv.450 飾品，象徵無限循環" },

    // --- Lv.500 終極畢業裝備 (奇點系列) ---
    'singularity_weapon': { 
        name: "奇點·萬象崩壞", 
        type: 'weapon', 
        atk: 600000, 
        hp: 1000000, 
        cost: 0, 
        desc: "Lv.500 [最終神兵] 一擊即可重啟宇宙的絕對力量。" 
    },
    'singularity_armor': { 
        name: "奇點·絕對防禦", 
        type: 'armor', 
        def: 350000, 
        hp: 5000000, 
        cost: 0, 
        desc: "Lv.500 [最終神甲] 將所有傷害轉移至異次元。" 
    },
    'singularity_acc': { 
        name: "奇點·因果律", 
        type: 'acc', 
        atk: 80000, 
        def: 80000, 
        hp: 2000000, 
        mp: 500000,
        cost: 0, 
        desc: "Lv.500 [最終飾品] 操控因果，逆轉命運。" 
    },
    'safe_stone':       { name: "防爆石", type: 'consumable', cost: 8500000000, desc: "強化失敗不掉級，且必定成功！" },
    // 1. 新手期
    'shard_ring_novice': { name: "學徒碎片戒指", type: 'acc', atk: 10, hp: 50, cost: 100, desc: "[碎片] 適合新手的入門戒指" },
    'shard_neck_brave':  { name: "勇者碎片項鍊", type: 'acc', atk: 30, def: 10, hp: 200, cost: 500, desc: "[碎片] 賦予勇氣的項鍊" },
    
    // 2. 中期 (開始加特殊屬性)
    'shard_charm_wind':  { name: "疾風碎片護符", type: 'acc', atk: 80, mp: 200, cost: 2000, desc: "[碎片] 感覺身體變輕盈了" },
    'shard_ring_vampire':{ name: "吸血鬼碎片指環", type: 'acc', atk: 150, hp: 500, cost: 5000, desc: "[碎片] 隱約散發著血腥氣味" },
    
    // 3. 後期 (大幅提升)
    'shard_earring_holy':{ name: "神聖碎片耳環", type: 'acc', mp: 1000, def: 300, hp: 2000, cost: 20000, desc: "[碎片] 受女神祝福的耳環" },
    'shard_belt_titan':  { name: "泰坦碎片腰帶", type: 'acc', def: 1000, hp: 10000, cost: 50000, desc: "[碎片] 如泰坦般堅固" },
    
    // 4. 大後期 (數值爆炸)
    'shard_pendant_dragon': { name: "龍魂碎片吊墜", type: 'acc', atk: 5000, def: 2000, hp: 30000, cost: 200000, desc: "[碎片] 封印著古龍的靈魂" },
    'shard_ring_void':      { name: "虛空碎片之戒", type: 'acc', atk: 15000, mp: 5000, hp: 50000, cost: 1000000, desc: "[碎片] 凝視深淵..." },
    
    // 5. 巔峰 (接近神話裝備)
    'shard_core_galaxy':    { name: "銀河碎片核心", type: 'acc', atk: 100000, def: 100000, hp: 3000000,  mp: 550000, cost: 99999999, desc: "[碎片] 核心運轉著星系的力量" },
    'shard_crown_infinity': { name: "無限碎片皇冠", type: 'acc', atk: 150000, def: 130000, hp: 5000000, mp: 700000, cost: 99999999, desc: "[碎片] 象徵無盡力量的皇冠" },
    // ---  [新增] 碎片商店專屬武器 (Lv.10 - Lv.600) ---

    // 1. 新手入門 (Lv.10)
    'shard_blade_novice': { 
        name: "碎光長劍", 
        type: 'weapon', 
        atk: 250, def: 50, hp: 500, mp: 0, 
        cost: 0, 
        desc: "Lv.10 [碎片武器] 凝聚微弱星光的長劍，適合新手冒險者。" 
    },

    // 2. 進階過渡 (Lv.150)
    'shard_axe_crystal': { 
        name: "晶體戰斧", 
        type: 'weapon', 
        atk: 5000, def: 1000, hp: 20000, mp: 0, 
        cost: 0, 
        desc: "Lv.150 [碎片武器] 由高純度能量晶體打造，揮舞時帶有破風聲。" 
    },

    // 3. 中階主力 (Lv.350)
    'shard_scythe_void': { 
        name: "虛空撕裂者", 
        type: 'weapon', 
        atk: 45000, def: 10000, hp: 500000, mp: 50000, 
        cost: 0, 
        desc: "Lv.350 [碎片武器] 來自虛空深處的鐮刀，能收割靈魂。" 
    },

    // 4. 高階神兵 (Lv.480) - 接近奇點飾品強度
    'shard_spear_galaxy': { 
        name: "星河·貫穿之槍", 
        type: 'weapon', 
        atk: 90000, def: 30000, hp: 1500000, mp: 200000, 
        cost: 0, 
        desc: "Lv.480 [碎片武器] 槍尖閃爍著星河的光輝，足以貫穿星球。" 
    },

    // 5.  終極神器 (Lv.550) - 超越奇點飾品
    'shard_wep_dimension': { 
        name: "維度·終焉裁決", 
        type: 'weapon', 
        atk: 180000,  // ⚔️ 比飾品高 10萬
        def: 120000,  // ️ 比飾品高 4萬
        hp: 4000000,  // ❤️ 比飾品高 200萬
        mp: 1000000, 
        cost: 0, 
        desc: "Lv.550 [維度神器] 斬斷維度的巨劍，擁有重啟宇宙的力量。" 
    },

    // 6.  創世神話 (Lv.600) - 遊戲最強
    'shard_wep_origin': { 
        name: "原初·萬物歸零", 
        type: 'weapon', 
        atk: 350000,  // ⚔️ 毀天滅地的數值
        def: 250000, 
        hp: 8000000, 
        mp: 3000000, 
        cost: 0, 
        desc: "Lv.600 [原初神話] 一切的起點與終點，將萬物回歸虛無。" 
    },
    // ---  [新增] 碎片商店專屬防具 (Lv.10 - Lv.600) ---

    // 1. 新手入門 (Lv.10)
    'shard_armor_novice': { 
        name: "碎光輕甲", 
        type: 'armor', 
        def: 50, hp: 1000, mp: 0, 
        cost: 0, 
        desc: "Lv.10 [碎片防具] 鑲嵌著微光碎片的輕便護甲。" 
    },

    // 2. 進階過渡 (Lv.150)
    'shard_armor_crystal': { 
        name: "晶體戰甲", 
        type: 'armor', 
        def: 2000, hp: 50000, mp: 0, 
        cost: 0, 
        desc: "Lv.150 [碎片防具] 由堅硬的能量晶體編織而成。" 
    },

    // 3. 中階主力 (Lv.350)
    'shard_robe_void': { 
        name: "虛空行者法袍", 
        type: 'armor', 
        def: 20000, hp: 800000, mp: 50000, 
        cost: 0, 
        desc: "Lv.350 [碎片防具] 融入虛空之中，能稍微偏轉物理攻擊。" 
    },

    // 4. 高階神兵 (Lv.480) - 接近奇點強度
    'shard_plate_galaxy': { 
        name: "星河·不滅壁壘", 
        type: 'armor', 
        def: 150000, hp: 3000000, mp: 100000, 
        cost: 0, 
        desc: "Lv.480 [碎片防具] 表面流動著星河的光輝，生生不息。" 
    },

    // 5.  終極神器 (Lv.550) - 超越奇點防具
    'shard_armor_dimension': { 
        name: "維度·虛數裝甲", 
        type: 'armor', 
        def: 500000,   // ️ 比奇點高 15萬
        hp: 8000000,   // ❤️ 比奇點高 300萬
        mp: 500000, 
        cost: 0, 
        desc: "Lv.550 [維度神器] 存在於虛數空間的裝甲，物理法則對其無效。" 
    },

    // 6.  創世神話 (Lv.600) - 遊戲最強
    'shard_armor_origin': { 
        name: "原初·混沌神軀", 
        type: 'armor', 
        def: 800000,   // ️ 極致防禦
        hp: 15000000,  // ❤️ 海量生命
        mp: 2000000, 
        cost: 0, 
        desc: "Lv.600 [原初神話] 將肉體回歸混沌，化身為不可名狀的神祇。" 
    }
};

//  [Server 配置] 碎片商店價格表 (權威數據)
// 格式: '物品ID': { cost: 碎片數量 }
const SHARD_SHOP_CONFIG = {
    // ---  飾品 (你設定的價格) ---
    'shard_ring_novice':    { cost: 3 },      // 10 碎片 -> 改為 3
    'shard_neck_brave':     { cost: 5 },      // 30 碎片 -> 改為 5
    'shard_charm_wind':     { cost: 10 },     // 80 碎片 -> 改為 10
    'shard_ring_vampire':   { cost: 15 },     // 150 碎片 -> 改為 15
    'shard_earring_holy':   { cost: 20 },     // 300 碎片 -> 改為 20
    'shard_belt_titan':     { cost: 25 },     // 600 碎片 -> 改為 25
    'shard_pendant_dragon': { cost: 30 },     // 1200 碎片 -> 改為 30
    'shard_ring_void':      { cost: 35 },     // 2500 碎片 -> 改為 35
    'shard_core_galaxy':    { cost: 5000 },   // 5000 碎片
    'shard_crown_infinity': { cost: 10000 },  // 10000 碎片

    // --- ⚔️ 武器 (配合你的飾品價格比例調整) ---
    'shard_blade_novice':   { cost: 3 },      // 新手劍
    'shard_axe_crystal':    { cost: 15 },     // 進階斧
    'shard_scythe_void':    { cost: 35 },     // 虛空鐮
    'shard_spear_galaxy':   { cost: 1000 },   // 銀河槍
    'shard_wep_dimension':  { cost: 3000 },   // 維度劍
    'shard_wep_origin':     { cost: 8000 },    // 原初神話
    'shard_armor_novice':   { cost: 3 },      // 新手甲
    'shard_armor_crystal':  { cost: 15 },     // 進階甲
    'shard_robe_void':      { cost: 35 },     // 虛空袍
    'shard_plate_galaxy':   { cost: 1000 },   // 銀河甲
    'shard_armor_dimension':{ cost: 3000 },   // 維度甲 (強過奇點)
    'shard_armor_origin':   { cost: 8000 }    // 原初神話
};


// ==========================================
//  公會建設系統
// ==========================================
const GUILD_FACILITY_CONFIG = {
    temple: {
        name: '聖殿', icon: '⛪', maxLv: 10,
        desc: '增加公會成員上限 (+5/級)',
        effect: (lv) => ({ memberBonus: lv * 5 }),
        cost: (lv) => ({ gold: lv * 500000, shard: lv * 5000 }),
    },
    expedition: {
        name: '遠征營', icon: '⚔️', maxLv: 10,
        desc: '增加全員採集/戰鬥金幣EXP (+2%/級)',
        effect: (lv) => ({ bonusPct: lv * 2 }),
        cost: (lv) => ({ gold: lv * 800000, shard: lv * 8000 }),
    },
    vault: {
        name: '寶庫', icon: '', maxLv: 10,
        desc: '增加共享倉庫格數 (+10格/級)',
        effect: (lv) => ({ slots: 10 + lv * 10 }),
        cost: (lv) => ({ gold: lv * 300000, shard: lv * 3000 }),
    },
};

// 公會BOSS（聖殿Lv5解鎖初級，Lv10解鎖終極）
const GUILD_BOSS_CONFIG = {
    guild_beast: {
        name: '公會守護獸', reqTempleLv: 5,
        hp: 5000000, atk: 8000, level: 120,
        exp: 500000, gold: 200000,
        drops: [
            { id: 'myth_essence_fire', rate: 0.3 },
            { id: 'myth_essence_ice', rate: 0.3 },
            { id: 'skill_shard', rate: 1.0, count: 500 },
        ],
        cooldownHours: 24,
    },
    guild_titan: {
        name: '公會泰坦', reqTempleLv: 10,
        hp: 50000000, atk: 50000, level: 300,
        exp: 5000000, gold: 2000000,
        drops: [
            { id: 'myth_core', rate: 0.5 },
            { id: 'myth_dragon_soul', rate: 0.5 },
            { id: 'myth_void_crystal', rate: 0.5 },
            { id: 'skill_shard', rate: 1.0, count: 5000 },
        ],
        cooldownHours: 72,
    },
};

// ==========================================
// ⚗️ 神話鍛造系統（4層）
// ==========================================
// 層1：普通材料 → 精華（5種）
// 層2：精華 → 神器素材（3種）
// 層3：神器素材 + 金幣/碎片 → 神話裝備

const MYTH_ESSENCE_CONFIG = {
    myth_essence_fire: {
        name: '烈焰精華', icon: '',
        materials: { fire_core: 50, lava_rock: 100, dragon_scale: 30 },
        shard: 1000,
    },
    myth_essence_ice: {
        name: '永恆冰精華', icon: '❄️',
        materials: { ice_crystal: 50, yeti_fur: 80, spirit_dust: 40 },
        shard: 1000,
    },
    myth_essence_dark: {
        name: '暗淵精華', icon: '',
        materials: { dark_essence: 30, void_dust: 60, demon_horn: 20 },
        shard: 1000,
    },
    myth_essence_light: {
        name: '神聖精華', icon: '✨',
        materials: { angel_feather: 30, god_blood: 10, chaos_orb: 20 },
        shard: 1500,
    },
    myth_essence_chaos: {
        name: '混沌精華', icon: '',
        materials: { chaos_orb: 40, dark_matter: 20, entropy_origin: 5 },
        shard: 2000,
    },
};

const MYTH_ARTIFACT_CONFIG = {
    myth_core: {
        name: '神話核心', icon: '',
        essences: { myth_essence_fire: 3, myth_essence_light: 2 },
        shard: 10000,
    },
    myth_dragon_soul: {
        name: '龍魂結晶', icon: '',
        essences: { myth_essence_fire: 2, myth_essence_ice: 2, myth_essence_dark: 1 },
        shard: 10000,
    },
    myth_void_crystal: {
        name: '虛空神晶', icon: '',
        essences: { myth_essence_dark: 3, myth_essence_chaos: 2 },
        shard: 15000,
    },
};

const MYTH_GEAR_CONFIG = {
    myth_weapon: {
        name: '神話·毀滅之刃', icon: '⚔️', type: 'weapon',
        atk: 2000000, def: 500000, hp: 5000000, mp: 1000000,
        artifacts: { myth_core: 1, myth_dragon_soul: 1 },
        gold: 5000000, shard: 50000,
        desc: '神話鍛造 | ATK+200萬 DEF+50萬 HP+500萬 MP+100萬',
    },
    myth_armor: {
        name: '神話·絕對防禦', icon: '️', type: 'armor',
        def: 1500000, hp: 10000000, mp: 3000000,
        artifacts: { myth_core: 1, myth_void_crystal: 1 },
        gold: 5000000, shard: 50000,
        desc: '神話鍛造 | DEF+150萬 HP+1000萬 MP+300萬',
    },
    myth_acc: {
        name: '神話·命運之環', icon: '', type: 'acc',
        atk: 800000, def: 800000, hp: 8000000, mp: 2000000,
        artifacts: { myth_dragon_soul: 1, myth_void_crystal: 1 },
        gold: 5000000, shard: 50000,
        desc: '神話鍛造 | ATK+80萬 DEF+80萬 HP+800萬 MP+200萬',
    },
};

// 加入 ITEM_CONFIG
Object.assign(ITEM_CONFIG, {
    myth_weapon: { name: '神話·毀滅之刃', type: 'weapon', atk: 2000000, def: 500000, hp: 5000000, mp: 1000000, cost: 0, desc: MYTH_GEAR_CONFIG.myth_weapon.desc },
    myth_armor:  { name: '神話·絕對防禦', type: 'armor',  def: 1500000, hp: 10000000, mp: 3000000, cost: 0, desc: MYTH_GEAR_CONFIG.myth_armor.desc },
    myth_acc:    { name: '神話·命運之環', type: 'acc',    atk: 800000, def: 800000, hp: 8000000, mp: 2000000, cost: 0, desc: MYTH_GEAR_CONFIG.myth_acc.desc },
    myth_essence_fire:  { name: '烈焰精華',   type: 'material', cost: 0, desc: '神話鍛造素材' },
    myth_essence_ice:   { name: '永恆冰精華', type: 'material', cost: 0, desc: '神話鍛造素材' },
    myth_essence_dark:  { name: '暗淵精華',   type: 'material', cost: 0, desc: '神話鍛造素材' },
    myth_essence_light: { name: '神聖精華',   type: 'material', cost: 0, desc: '神話鍛造素材' },
    myth_essence_chaos: { name: '混沌精華',   type: 'material', cost: 0, desc: '神話鍛造素材' },
    myth_core:         { name: '神話核心',   type: 'material', cost: 0, desc: '神話鍛造素材' },
    myth_dragon_soul:  { name: '龍魂結晶',   type: 'material', cost: 0, desc: '神話鍛造素材' },
    myth_void_crystal: { name: '虛空神晶',   type: 'material', cost: 0, desc: '神話鍛造素材' },
});

// 公會倉庫（存在記憶體，定期存入guilds.json）
// 結構：guildData[gid].vault = { items: {itemId: count}, maxSlots: N }
// 公會設施：guildData[gid].facilities = { temple: 0, expedition: 0, vault: 0 }
// 公會BOSS冷卻：guildData[gid].bossCooldown = { guild_beast: timestamp, guild_titan: timestamp }

function getGuildMaxMembers(g) {
    const lv = (g.facilities && g.facilities.temple) || 0;
    return 20 + lv * 5;
}

function getGuildBonusPct(g) {
    const lv = (g.facilities && g.facilities.expedition) || 0;
    return lv * 2;
}

function getGuildVaultSlots(g) {
    const lv = (g.facilities && g.facilities.vault) || 0;
    return 10 + lv * 10;
}

// ==========================================
//  裝備耐久度系統配置
// ==========================================
// 耐久上限 = 100
// 每場戰鬥扣耐久 = round(怪物等級 / 裝備等級, 1)，範圍 0.1–1.0
// 維修費（碎片）= 按裝備等級分級，每缺1點耐久收費
const DURABILITY_CONFIG = {
    maxDurability: 100,
    // 維修費分級（按裝備等級）
    repairTiers: [
        { maxItemLv: 30,   repairPerPoint: 0.05 },  // 入門裝備
        { maxItemLv: 80,   repairPerPoint: 0.1  },  // 初階裝備
        { maxItemLv: 150,  repairPerPoint: 0.3  },  // 中階裝備
        { maxItemLv: 250,  repairPerPoint: 1    },  // 高階裝備
        { maxItemLv: 400,  repairPerPoint: 3    },  // 神話裝備
        { maxItemLv: Infinity, repairPerPoint: 8 }, // 頂級裝備
    ]
};

// 裝備等級對照表
const ITEM_LEVEL_MAP = {
    'wood_sword':10,'copper_dagger':5,'steel_blade':8,'oak_bow':10,'iron_sword':15,
    'maple_staff':20,'shark_tooth':25,'silver_blade':30,'hero_sword':35,'assassin_dag':40,
    'spike_club':45,'poison_dag':50,'emerald_staff':55,'flame_staff':60,'gold_axe':70,
    'obsidian_blade':75,'dragon_spear':80,'frost_bow':85,'mithril_saber':90,
    'void_reaper':100,'void_reaper_dark':110,'god_slayer':130,'chaos_staff':150,
    'genesis_weapon':200,'void_blade':230,'galaxy_saber':260,'entropy_sword':300,
    'infinity_blade':450,'singularity_weapon':500,
    'cloth_armor':1,'plate_mail':5,'leather_armor':10,'hunt_vest':15,'dragon_mail':20,
    'chain_mail':25,'iron_armor':35,'magma_plate':45,'ice_robe':55,'yeti_cloak':65,
    'demon_armor':90,'angel_armor':120,'genesis_armor':200,'void_armor':230,
    'nebula_plate':260,'entropy_god_armor':300,'event_horizon':450,'singularity_armor':500,
    'bone_ring':5,'snake_boots':8,'ring_life':10,'ring_magic':12,'fish_ring':15,
    'ring_str':20,'bracelet_def':22,'necklace_hp':25,'necklace_mp':28,'pearl_necklace':30,
    'amulet_soul':40,'ring_lord':60,'crown_chaos':100,'ring_galaxy':150,
    'dimension_ring':280,'mobius_ring':450,'singularity_acc':500,
    'shard_blade_novice':10,'shard_armor_novice':10,'shard_ring_novice':10,
    'shard_neck_brave':20,'shard_charm_wind':80,'shard_ring_vampire':100,
    'shard_earring_holy':120,'shard_belt_titan':150,
    'shard_axe_crystal':150,'shard_armor_crystal':150,
    'shard_pendant_dragon':200,'shard_ring_void':250,
    'shard_scythe_void':350,'shard_robe_void':350,
    'shard_spear_galaxy':480,'shard_plate_galaxy':480,
    'shard_core_galaxy':480,'shard_wep_dimension':550,'shard_armor_dimension':550,
    'shard_wep_origin':600,'shard_armor_origin':600,'shard_crown_infinity':600,
};

function getItemLevel(itemId) {
    return ITEM_LEVEL_MAP[itemId] || 1;
}

function calcDecay(monsterLevel, itemId) {
    const itemLv = getItemLevel(itemId);
    const raw = monsterLevel / itemLv;
    return Math.round(Math.max(0.1, Math.min(1.0, raw)) * 10) / 10;
}

function applyBattleDurabilityDecay(p, monsterLevel) {
    if (!p.equipment) return;
    if (!p.durability) p.durability = {};
    const mLv = monsterLevel || 1;
    let changed = false;
    Object.values(p.equipment).forEach(itemId => {
        if (!itemId || !ITEM_CONFIG[itemId]) return;
        const max = DURABILITY_CONFIG.maxDurability;
        if (p.durability[itemId] === undefined) p.durability[itemId] = max;
        const decay = calcDecay(mLv, itemId);
        p.durability[itemId] = Math.max(0, parseFloat((p.durability[itemId] - decay).toFixed(1)));
        changed = true;
    });
    if (changed) calculateStats(p);
}


// ==========================================
//  碎片付款輔助函數
// $1 金幣 = 100 碎片
// ==========================================
const SHARD_TO_GOLD_RATE = 1; // 1G = 1碎片

function payWithShards(p, goldAmount) {
    const shardCost = Math.ceil(goldAmount * SHARD_TO_GOLD_RATE);
    const owned = p.inventory['skill_shard'] || 0;
    if (owned < shardCost) return { ok: false, shardCost, owned };
    p.inventory['skill_shard'] -= shardCost;
    if (p.inventory['skill_shard'] <= 0) delete p.inventory['skill_shard'];
    return { ok: true, shardCost };
}

function payWithGold(p, goldAmount) {
    if ((p.gold || 0) < goldAmount) return { ok: false };
    p.gold -= goldAmount;
    return { ok: true };
}

function payAmount(p, goldAmount, useShards) {
    if (useShards) return payWithShards(p, goldAmount);
    return payWithGold(p, goldAmount);
}

function getRepairCost(itemId, currentDur) {
    const max = DURABILITY_CONFIG.maxDurability;
    const missing = max - Math.max(0, Math.min(max, currentDur));
    if (missing <= 0) return 0;
    const itemLv = getItemLevel(itemId);
    const tier = DURABILITY_CONFIG.repairTiers.find(t => itemLv <= t.maxItemLv)
              || DURABILITY_CONFIG.repairTiers[DURABILITY_CONFIG.repairTiers.length - 1];
    return Math.max(1, Math.ceil(missing * tier.repairPerPoint));
}



const RECIPE_CONFIG = {
    'hunt_vest':        { materials: {'soft_fur': 5, 'copper_ore': 2}, gold: 200 }, 
    'bone_ring':        { materials: {'beast_fang': 3, 'slime_gel': 5}, gold: 100 },
    'spike_club':       { materials: {'iron_ore': 10, 'bone_shard': 5}, gold: 800 }, 
    'snake_boots':      { materials: {'tough_hide': 8, 'poison_sac': 2}, gold: 600 },
    'poison_dag':       { materials: {'iron_ore': 5, 'poison_sac': 5}, gold: 1000 }, 
    'flame_staff':      { materials: {'silver_ore': 5, 'fire_core': 3}, gold: 3000 },
    'magma_plate':      { materials: {'iron_ore': 20, 'lava_rock': 10}, gold: 4000 }, 
    'frost_bow':        { materials: {'gold_ore': 5, 'ice_crystal': 5}, gold: 10000 },
    'ice_robe':         { materials: {'yeti_fur': 10, 'ice_crystal': 8}, gold: 12000 }, 
    'yeti_cloak':       { materials: {'yeti_fur': 15, 'spirit_dust': 5}, gold: 10000 },
    'amulet_soul':      { materials: {'gold_ore': 3, 'spirit_dust': 10}, gold: 8000 }, 
    'void_reaper':      { materials: {'mithril': 10, 'void_dust': 20}, gold: 50000 },
    'void_reaper_dark': { materials: {'void_reaper': 1, 'void_dust': 15, 'dark_essence': 10}, gold: 200000 },
    'demon_armor':      { materials: {'mithril': 15, 'demon_horn': 10}, gold: 60000 }, 
    'ring_lord':        { materials: {'dark_essence': 5, 'gold_ore': 20}, gold: 40000 },
    'god_slayer':       { materials: {'adamantite': 10, 'god_blood': 5, 'dragon_scale': 20}, gold: 1000000 }, 
    'chaos_staff':      { materials: {'adamantite': 10, 'chaos_orb': 5, 'void_dust': 50}, gold: 1200000 },
    'angel_armor':      { materials: {'adamantite': 20, 'angel_feather': 10, 'god_blood': 5}, gold: 1500000 }, 
    'crown_chaos':      { materials: {'chaos_orb': 3, 'angel_feather': 5, 'dark_essence': 50}, gold: 2000000 },
    'oak_bow':          { materials: {'oak_log': 5, 'soft_fur': 2}, gold: 100 }, 
    'maple_staff':      { materials: {'maple_log': 5, 'fire_core': 1}, gold: 500 },
    'fish_ring':        { materials: {'pearl': 1, 'gold_ore': 2}, gold: 1000 }, 
    'shark_tooth':      { materials: {'shark': 2, 'iron_ore': 5}, gold: 800 },
    'pearl_necklace':   { materials: {'pearl': 3, 'silver_ore': 5}, gold: 2000 }, 
    'emerald_staff':    { materials: {'yew_log': 10, 'magic_dust': 5, 'magic_fish': 2}, gold: 5000 },
    'obsidian_blade':   { materials: {'lava_rock': 10, 'coal': 20, 'iron_ore': 10}, gold: 8000 }, 
    'dragon_spear':     { materials: {'dragon_wood': 5, 'dragon_scale': 3, 'mithril': 5}, gold: 15000 },
    'grilled_carp':     { materials: {'carp': 1, 'coal': 1}, gold: 10 }, 
    'salmon_sushi':     { materials: {'salmon': 1}, gold: 20 }, 
    'tuna_steak':       { materials: {'tuna': 1, 'fire_core': 1}, gold: 50 }, 
    'eel_rice':         { materials: {'lava_eel': 1, 'coal': 2}, gold: 100 }, 
    'void_soup':        { materials: {'void_squid': 1, 'magic_fish': 2, 'dark_essence': 1}, gold: 500 },
    'genesis_weapon':   { materials: { 'god_slayer': 1, 'titan_steel': 10, 'god_blood': 20, 'star_fragment': 50 }, gold: 5000000 },
    'genesis_armor':    { materials: { 'angel_armor': 1, 'titan_steel': 10, 'god_blood': 20, 'adamantite': 50 }, gold: 5000000 },
    'ring_galaxy':      { materials: { 'star_fragment': 20, 'chaos_orb': 10, 'diamond': 5 }, gold: 500000 },
    'hero_sword':       { materials: { 'iron_sword': 1, 'iron_ore': 10, 'oak_log': 20 }, gold: 1000 },
    'void_blade':       { materials: { 'genesis_weapon': 1, 'void_shard': 50, 'dark_matter': 20, 'mithril': 100 }, gold: 500000000 },
    'void_armor':       { materials: { 'genesis_armor': 1, 'void_shard': 50, 'dark_matter': 20, 'adamantite': 100 }, gold: 500000000 },
    'galaxy_saber':     { materials: { 'void_blade': 1, 'cosmic_steel': 30, 'star_core': 10, 'titan_steel': 50 }, gold: 600000000 },
    'nebula_plate':     { materials: { 'void_armor': 1, 'cosmic_steel': 30, 'star_core': 10, 'dragon_scale': 50 }, gold: 600000000 },
    'dimension_ring':   { materials: { 'ring_galaxy': 1, 'time_sand': 20, 'dimension_gem': 5, 'diamond': 20 }, gold: 700000000 },
    'entropy_sword':    { materials: { 'galaxy_saber': 1, 'entropy_origin': 1, 'dimension_gem': 10, 'god_blood': 50 }, gold: 800000000 },
    'entropy_god_armor':{ materials: { 'nebula_plate': 1, 'entropy_origin': 1, 'time_sand': 20, 'god_blood': 50 }, gold: 800000000 },
    // Lv.450 過渡裝備
    'infinity_blade': { materials: { 'entropy_sword': 1, 'quantum_residue': 100, 'dark_matter': 50 }, gold: 1000000000 },
    'event_horizon':  { materials: { 'entropy_god_armor': 1, 'quantum_residue': 100, 'dark_matter': 50 }, gold: 1000000000 },
    'mobius_ring':    { materials: { 'dimension_ring': 1, 'quantum_residue': 50, 'time_sand': 50 }, gold: 800000000 },

    // Lv.500 奇點裝備 (天價)
    'singularity_weapon': { 
        materials: { 
            'infinity_blade': 1, 
            'multiverse_shard': 50, 
            'divinity_core': 5, 
            'entropy_origin': 10 
        }, 
        gold: 3000000000 // 30億
    },
    'singularity_armor': { 
        materials: { 
            'event_horizon': 1, 
            'multiverse_shard': 50, 
            'divinity_core': 5, 
            'entropy_origin': 10 
        }, 
        gold: 3000000000 
    },
    'singularity_acc': { 
        materials: { 
            'mobius_ring': 1, 
            'multiverse_shard': 30, 
            'divinity_core': 3, 
            'dimension_gem': 20 
        }, 
        gold: 2500000000 
    }
};

//  [新增] 怪物技能資料庫
const MONSTER_SKILL_DATA = {
    // --- 通用/低級技能 ---
    'poison_spit':   { name: "劇毒吐息", rate: 0.3, mult: 1.2, type: 'dmg', msg: "噴出了一灘毒液！" },
    'bite':          { name: "強力撕咬", rate: 0.3, mult: 1.5, type: 'dmg', msg: "張開大口狠狠咬下！" },
    'fireball':      { name: "火球術",   rate: 0.25, mult: 1.8, type: 'dmg', msg: "詠唱咒語，射出一枚火球！" },
    'smash':         { name: "重擊",     rate: 0.3, mult: 1.5, type: 'dmg', msg: "舉起武器重重砸下！" },
    'heal_self':     { name: "自我再生", rate: 0.2, mult: 0.3, type: 'heal', msg: "身上的傷口開始癒合..." }, // mult 0.3 = 回復 30% ATK 的血量

    // --- 高級/BOSS 技能 ---
    'flame_breath':  { name: "烈焰吐息", rate: 0.3, mult: 1.5, type: 'aoe', msg: "深吸一口氣，噴出漫天烈火！(全體)" },
    'earthquake':    { name: "大地震擊", rate: 0.25, mult: 1.2, type: 'aoe', msg: "猛擊地面，引發強烈震動！(全體)" },
    'void_crush':    { name: "虛空碎擊", rate: 0.2, mult: 3.0, type: 'dmg', msg: "召喚虛空能量粉碎目標！" },
    'dimension_break': { name: "維度崩壞", rate: 0.15, mult: 2.0, type: 'aoe', msg: "撕裂了空間，造成真實傷害！(全體)" },
    
    // --- 終極 BOSS 專用 ---
    'god_wipe':      { name: "萬象歸零", rate: 0.1, mult: 5.0, type: 'aoe', msg: "釋放了創世級別的能量...！(毀滅性打擊)" },
    'frost_breath':  { name: "寒冰吐息", rate: 0.3, mult: 1.4, type: 'aoe', msg: "吐出極寒凍氣，凍結一切！(全體)" },
    'ice_shard':     { name: "冰錐術",   rate: 0.25, mult: 1.6, type: 'dmg', msg: "凝聚冰晶射向目標！" }
};

//  [新增] 怪物與技能的對應表 (ID 對應上面的技能 Key)
//  [完整版] 怪物與技能的對應表
const MONSTER_SKILL_MAP = {
    // ---  初級區 (Lv.1 - Lv.40) ---
    'slime':        ['poison_spit'],           // 史萊姆：噴毒
    'rat':          ['bite'],                  // 大老鼠：咬
    'bee':          ['poison_spit'],           // 殺人蜂：毒刺
    'boar':         ['smash'],                 // 野豬：衝撞(視為重擊)
    'thief':        ['bite'],                  // 盜賊：(偷襲)視為強力撕咬
    'wolf_king':    ['bite', 'smash'],         // 狼王：撕咬 + 重擊
    'snake':        ['poison_spit'],           // 毒蛇：噴毒
    'zombie':       ['bite'],                  // 腐屍：咬
    'skeleton':     ['smash'],                 // 骷髏：重擊
    'ghoul':        ['bite', 'poison_spit'],   // 食屍鬼：咬 + 毒
    'witch':        ['fireball', 'poison_spit'], // 女巫：火球 + 毒
    'hydra':        ['poison_spit', 'bite'],   // 九頭蛇：多重毒咬

    // ---  中級區 (Lv.42 - Lv.80) ---
    'fire_imp':     ['fireball'],              // 火焰小鬼
    'lava_golem':   ['smash', 'earthquake'],   // 熔岩戈侖：重擊 + 地震
    'salamander':   ['fireball'],              // 火蜥蜴
    'fire_mage':    ['fireball', 'flame_breath'], // 烈焰法師
    'dragon_hatchling': ['flame_breath'],      // 幼龍
    'balrog':       ['flame_breath', 'smash'], // 炎魔
    'snow_wolf':    ['bite'],                  // 雪原狼
    'yeti':         ['smash', 'earthquake'],   // 雪人
    'ice_spirit':   ['fireball'],              // 冰精靈 (暫用火球代替冰箭，或新增 ice_bolt)
    'frost_knight': ['smash'],                 // 寒霜騎士
    'ice_dragon':   ['flame_breath'],          // 冰龍 (暫用吐息)
    'lich_king':    ['fireball', 'void_crush'], // 巫妖王

    // ---  高級區 (Lv.82 - Lv.200) ---
    'void_eye':     ['void_crush'],            // 虛空之眼
    'shadow_assassin': ['bite', 'void_crush'], // 暗影刺客
    'dark_paladin': ['smash', 'heal_self'],    // 墮落聖騎
    'demon_guard':  ['smash', 'flame_breath'], // 惡魔守衛
    'succubus':     ['heal_self', 'fireball'], // 魅魔 (吸血用 heal_self 模擬)
    'void_lord':    ['void_crush', 'dimension_break'], // 虛空領主
    'chaos_beast':  ['earthquake', 'void_crush'], // 混沌巨獸
    'fallen_angel': ['void_crush', 'heal_self'], // 墮天使
    'demon_king':   ['fireball', 'flame_breath', 'void_crush'], // 魔王撒旦
    'void_walker':  ['void_crush', 'dimension_break'], // 虛空行者
    'chaos_knight': ['smash', 'void_crush', 'heal_self'], // 混沌騎士
    'abyss_dragon': ['flame_breath', 'void_crush', 'earthquake'], // 深淵魔龍
    'fallen_titan': ['earthquake', 'smash', 'heal_self'], // 墮落泰坦
    'genesis_god':  ['dimension_break', 'void_crush', 'god_wipe'], // 創世破壞神

    // ---  終局區 (Lv.210+) ---
    'void_worm':    ['void_crush', 'poison_spit'], // 虛空吞噬蟲
    'shadow_phantom': ['void_crush', 'dimension_break'], // 虚影夢魘
    'star_eater':   ['dimension_break', 'god_wipe'], // 吞星巨獸
    'nebula_dragon': ['flame_breath', 'god_wipe'], // 星雲幻龍
    'time_keeper':  ['dimension_break', 'heal_self'], // 時空裁決者
    'dimension_breaker': ['dimension_break', 'void_crush'], // 維度粉碎者
    'entropy_god':  ['god_wipe', 'dimension_break', 'heal_self'], // 終焉·熱寂之神
    'akashic_record': ['god_wipe', 'dimension_break', 'heal_self'], // 全知者·阿卡西

    // --- ☠️ 世界 BOSS ---
    'chaos_boss':   ['earthquake', 'flame_breath', 'heal_self'],
    'void_devourer_god': ['void_crush', 'dimension_break', 'god_wipe', 'heal_self'] // 虛無吞噬者
};
function getMonsterSkillSet(level) {
    let pool = ['attack', 'attack', 'attack', 'attack']; 
    if (level >= 1) pool.push('def_up', 'water', 'heal');
    if (level >= 40) pool.push('atk_up', 'fire');
    if (level >= 60) pool.push('ice', 'paralyze');
    if (level >= 80) pool.push('aoe_magic');
    if (level >= 150) pool.push('lifesteal');
    if (level >= 260) pool.push('manadrain');
    return pool;
}

const MONSTER_CONFIG = {
    'slime': { name: "史萊姆", level: 1, hp: 100, exp: 10, gold: 5, atk: 10, img: 'slime.png', drops: [{id:'slime_gel', rate:0.5},{ id: 'skill_shard', rate: 0.2}] },
    'rat': { name: "大老鼠", level: 3, hp: 200, exp: 20, gold: 10, atk: 15, img: 'rat.png', drops: [{id:'soft_fur', rate:0.4},{ id: 'skill_shard', rate: 0.2}] },
    'bee': { name: "殺人蜂", level: 5, hp: 300, exp: 35, gold: 15, atk: 25, img: 'bee.png', drops: [{id:'beast_fang', rate:0.3}, {id:'potion_hp', rate:0.1},{ id: 'skill_shard', rate: 0.2}] },
    'boar': { name: "野豬", level: 8, hp: 600, exp: 60, gold: 25, atk: 35, img: 'boar.png', drops: [{id:'soft_fur', rate:0.5}, {id:'beast_fang', rate:0.3},{ id: 'skill_shard', rate: 0.2}] },
    'thief': { name: "盜賊", level: 12, hp: 1000, exp: 100, gold: 100, atk: 50, img: 'thief.png', drops: [{id:'copper_ore', rate:0.4}, {id:'copper_dagger', rate:0.05},{ id: 'skill_shard', rate: 0.2}] },
    'wolf_king': { name: "狼王", level: 15, hp: 2500, exp: 300, gold: 300, atk: 80, img: 'wolf_king.png', drops: [{id:'bone_ring', rate:0.1}, {id:'soft_fur', rate:1.0},{ id: 'skill_shard', rate: 0.2}] },
    'snake': { name: "毒蛇", level: 22, hp: 3500, exp: 400, gold: 50, atk: 100, img: 'snake.png', drops: [{id:'poison_sac', rate:0.4}, {id:'tough_hide', rate:0.2},{ id: 'skill_shard', rate: 0.2}] },
    'zombie': { name: "腐屍", level: 25, hp: 5000, exp: 500, gold: 60, atk: 110, img: 'zombie.png', drops: [{id:'bone_shard', rate:0.5}, {id:'cloth_armor', rate:0.1},{ id: 'skill_shard', rate: 0.2}] },
    'skeleton': { name: "骷髏兵", level: 28, hp: 4500, exp: 600, gold: 70, atk: 130, img: 'skeleton.png', drops: [{id:'iron_ore', rate:0.4}, {id:'bone_shard', rate:0.4},{ id: 'skill_shard', rate: 0.2}] },
    'ghoul': { name: "食屍鬼", level: 32, hp: 7000, exp: 800, gold: 90, atk: 150, img: 'ghoul.png', drops: [{id:'tough_hide', rate:0.5},{ id: 'skill_shard', rate: 0.2}] },
    'witch': { name: "沼澤女巫", level: 35, hp: 6000, exp: 1000, gold: 150, atk: 200, img: 'witch.png', drops: [{id:'poison_sac', rate:0.5}, {id:'potion_mid', rate:0.2},{ id: 'skill_shard', rate: 0.2}] },
    'hydra': { name: "九頭蛇", level: 40, hp: 20000, exp: 3000, gold: 1000, atk: 300, img: 'hydra.png', drops: [{id:'snake_boots', rate:0.1}, {id:'poison_sac', rate:1.0},{ id: 'skill_shard', rate: 0.2}] },
    'fire_imp': { name: "火焰小鬼", level: 42, hp: 15000, exp: 1500, gold: 200, atk: 350, img: 'fire_imp.png', drops: [{id:'fire_core', rate:0.3},{ id: 'skill_shard', rate: 0.2}] },
    'lava_golem': { name: "熔岩戈侖", level: 45, hp: 30000, exp: 2000, gold: 250, atk: 400, img: 'lava_golem.png', drops: [{id:'lava_rock', rate:0.6}, {id:'iron_ore', rate:0.5},{ id: 'skill_shard', rate: 0.2}] },
    'salamander': { name: "火蜥蜴", level: 48, hp: 25000, exp: 2500, gold: 300, atk: 450, img: 'salamander.png', drops: [{id:'tough_hide', rate:0.4}, {id:'fire_core', rate:0.2},{ id: 'skill_shard', rate: 0.2}] },
    'fire_mage': { name: "烈焰法師", level: 52, hp: 20000, exp: 3000, gold: 400, atk: 600, img: 'fire_mage.png', drops: [{id:'silver_ore', rate:0.4}, {id:'potion_mid', rate:0.3},{ id: 'skill_shard', rate: 0.2}] },
    'dragon_hatchling': { name: "幼龍", level: 55, hp: 40000, exp: 4000, gold: 500, atk: 700, img: 'dragon_hatchling.png', drops: [{id:'dragon_scale', rate:0.2}, {id:'fire_core', rate:0.4},{ id: 'skill_shard', rate: 0.2}] },
    'balrog': { name: "炎魔", level: 60, hp: 100000, exp: 10000, gold: 3000, atk: 1000, img: 'balrog.png', drops: [{id:'magma_plate', rate:0.01}, {id:'fire_core', rate:0.5},{ id: 'skill_shard', rate: 0.2}] },
    'snow_wolf': { name: "雪原狼", level: 62, hp: 60000, exp: 5000, gold: 600, atk: 1200, img: 'snow_wolf.png', drops: [{id:'soft_fur', rate:0.5}, {id:'ice_crystal', rate:0.2},{ id: 'skill_shard', rate: 0.2}] },
    'yeti': { name: "雪人", level: 65, hp: 120000, exp: 6000, gold: 700, atk: 1500, img: 'yeti.png', drops: [{id:'yeti_fur', rate:0.6}, {id:'gold_ore', rate:0.2},{ id: 'skill_shard', rate: 0.2}] },
    'ice_spirit': { name: "冰精靈", level: 68, hp: 80000, exp: 7000, gold: 800, atk: 1800, img: 'ice_spirit.png', drops: [{id:'ice_crystal', rate:0.5}, {id:'spirit_dust', rate:0.3},{ id: 'skill_shard', rate: 0.2}] },
    'frost_knight': { name: "寒霜騎士", level: 72, hp: 150000, exp: 9000, gold: 1000, atk: 2000, img: 'frost_knight.png', drops: [{id:'gold_ore', rate:0.4}, {id:'ice_crystal', rate:0.3},{ id: 'skill_shard', rate: 0.2}] },
    'ice_dragon': { name: "冰霜龍", level: 75, hp: 200000, exp: 12000, gold: 1500, atk: 2500, img: 'ice_dragon.png', drops: [{id:'dragon_scale', rate:0.5}, {id:'potion_high', rate:0.2},{ id: 'skill_shard', rate: 0.2}] },
    'lich_king': { name: "巫妖王", level: 80, hp: 500000, exp: 30000, gold: 10000, atk: 3500, img: 'lich_king.png', drops: [{id:'amulet_soul', rate:0.05}, {id:'spirit_dust', rate:0.05},{ id: 'skill_shard', rate: 0.2}] },
    'void_eye': { name: "虛空之眼", level: 82, hp: 300000, exp: 15000, gold: 2000, atk: 4000, img: 'void_eye.png', drops: [{id:'void_dust', rate:0.1},{ id: 'skill_shard', rate: 0.2}] },
    'shadow_assassin': { name: "暗影刺客", level: 85, hp: 400000, exp: 18000, gold: 2500, atk: 5000, img: 'shadow_assassin.png', drops: [{id:'mithril', rate:0.1}, {id:'dark_essence', rate:0.2},{ id: 'skill_shard', rate: 0.2}] },
    'dark_paladin': { name: "墮落聖騎", level: 88, hp: 600000, exp: 22000, gold: 3000, atk: 6000, img: 'dark_paladin.png', drops: [{id:'mithril', rate:0.5}, {id:'void_dust', rate:0.4},{ id: 'skill_shard', rate: 0.2}] },
    'demon_guard': { name: "惡魔守衛", level: 92, hp: 800000, exp: 28000, gold: 4000, atk: 7500, img: 'demon_guard.png', drops: [{id:'demon_horn', rate:0.4}, {id:'dragon_scale', rate:0.2},{ id: 'skill_shard', rate: 0.2}] },
    'succubus': { name: "魅魔", level: 95, hp: 700000, exp: 35000, gold: 5000, atk: 8500, img: 'succubus.png', drops: [{id:'dark_essence', rate:0.5}, {id:'potion_max', rate:0.1},{ id: 'skill_shard', rate: 0.2}] },
    'void_lord': { name: "虛空領主", level: 99, hp: 2000000, exp: 100000, gold: 50000, atk: 12000, img: 'void_lord.png', drops: [{id:'void_reaper', rate:0.05}, {id:'dark_essence', rate:0.2},{ id: 'skill_shard', rate: 0.2}] },
    'chaos_beast': { name: "混沌巨獸", level: 105, hp: 3000000, exp: 150000, gold: 10000, atk: 15000, img: 'chaos_beast.png', drops: [{id:'chaos_orb', rate:0.2}, {id:'adamantite', rate:0.2},{ id: 'skill_shard', rate: 0.2}] },
    'fallen_angel': { name: "墮天使", level: 110, hp: 4000000, exp: 200000, gold: 20000, atk: 18000, img: 'fallen_angel.png', drops: [{id:'angel_feather', rate:0.2}, {id:'god_blood', rate:0.1},{ id: 'skill_shard', rate: 0.2}] },
    'demon_king': { name: "魔王撒旦", level: 150, hp: 7000000, exp: 2000000, gold: 2000000, atk: 25000, img: 'demon_king.png', drops: [{id:'god_slayer', rate:0.1}, {id:'chaos_orb', rate:0.8}, {id:'angel_feather', rate:0.8},{ id: 'skill_shard', rate: 0.2}] },
    'void_walker': { name: "虛空行者", level: 160, hp: 8000000, exp: 3000000, gold: 15000, atk: 35000, img: 'void_walker.png', drops: [{id:'void_dust', rate:0.5}, {id:'mithril', rate:0.3}, {id:'potion_max', rate:0.2},{ id: 'skill_shard', rate: 0.2}] },
    'chaos_knight': { name: "混沌騎士", level: 170, hp: 12000000, exp: 5000000, gold: 25000, atk: 45000, img: 'chaos_knight.png', drops: [{id:'chaos_orb', rate:0.4}, {id:'adamantite', rate:0.3}, {id:'dark_essence', rate:0.3},{ id: 'skill_shard', rate: 0.2}] },
    'abyss_dragon': { name: "深淵魔龍", level: 180, hp: 20000000, exp: 12000000, gold: 50000, atk: 55000, img: 'abyss_dragon.png', drops: [{id:'dragon_scale', rate:0.8}, {id:'god_blood', rate:0.2}, {id:'void_reaper', rate:0.02},{ id: 'skill_shard', rate: 0.2}] },
    'fallen_titan': { name: "墮落泰坦", level: 190, hp: 35000000, exp: 25000000, gold: 100000, atk: 65000, img: 'fallen_titan.png', drops: [{id:'titan_steel', rate:0.3}, {id:'star_fragment', rate:0.3}, {id:'elixir', rate:0.2},{ id: 'skill_shard', rate: 0.2}] },
    'genesis_god': { name: "創世破壞神", level: 200, hp: 50000000, exp: 1000000000, gold: 500000, atk: 75000, img: 'genesis_god.png', drops: [{id:'titan_steel', rate:0.5}, {id:'god_blood', rate:0.5}, {id:'elixir', rate:0.5},{ id: 'skill_shard', rate: 0.2}] },
    'void_worm': {
        name: "虛空吞噬蟲", level: 210,
        hp: 80000000, maxHp: 80000000,
        exp: 2000000000, gold: 3000000,
        atk: 85000, def: 40000,
        img: 'void_worm.png',
        drops: [{id:'void_shard', rate:0.5}, {id:'mithril', rate:0.5}, {id:'potion_max', rate:0.3},{ id: 'skill_shard', rate: 0.2}]
    },
    'shadow_phantom': {
        name: "虚影夢魘", level: 225,
        hp: 90000000, maxHp: 150000000,
        exp: 3500000000, gold: 4000000,
        atk: 100000, def: 50000,
        img: 'shadow_phantom.png',
        drops: [{id:'dark_matter', rate:0.4}, {id:'void_shard', rate:0.4}, {id:'elixir', rate:0.1},{ id: 'skill_shard', rate: 0.2}]
    },
    'star_eater': {
        name: "吞星巨獸", level: 245,
        hp: 300000000, maxHp: 300000000,
        exp: 6000000000, gold: 5000000,
        atk: 130000, def: 75000,
        img: 'star_eater.png',
        drops: [{id:'cosmic_steel', rate:0.3}, {id:'titan_steel', rate:0.5}, {id:'star_fragment', rate:0.2},{ id: 'skill_shard', rate: 0.2}]
    },
    'nebula_dragon': {
        name: "星雲幻龍", level: 260,
        hp: 600000000, maxHp: 600000000,
        exp: 10000000000, gold: 6000000,
        atk: 160000, def: 90000,
        img: 'nebula_dragon.png',
        drops: [{id:'star_core', rate:0.2}, {id:'dragon_scale', rate:0.8}, {id:'god_blood', rate:0.3},{ id: 'skill_shard', rate: 0.2}]
    },
    'time_keeper': {
        name: "時空裁決者", level: 280,
        hp: 1500000000, maxHp: 1500000000,
        exp: 25000000000, gold: 7000000,
        atk: 250000, def: 120000,
        img: 'time_keeper.png',
        drops: [{id:'time_sand', rate:0.3}, {id:'chaos_orb', rate:0.5}, {id:'elixir', rate:0.5},{ id: 'skill_shard', rate: 0.3, count: 1 }]
    },
    'dimension_breaker': {
        name: "維度粉碎者", level: 290,
        hp: 3000000000, maxHp: 3000000000,
        exp: 50000000000, gold: 8000000,
        atk: 350000, def: 140000,
        img: 'dimension_breaker.png',
        drops: [{id:'dimension_gem', rate:0.2}, {id:'god_blood', rate:0.5},{ id: 'skill_shard', rate: 0.3, count: 1 }]
    },
    'entropy_god': {
        name: "終焉·熱寂之神", level: 300,
        hp: 3500000000, maxHp: 10000000000,
        exp: 90000000000, gold: 10000000,
        atk: 800000, def: 180000,
        img: 'entropy_god.png',
        drops: [{id:'entropy_origin', rate:1.0}, {id:'elixir', rate:0.7},{ id: 'skill_shard', rate: 0.3, count: 2 }]
    },
    'akashic_record': {
        name: "全知者·阿卡西 (Lv.550)",
        level: 500,
        hp: 50000000000,
        maxHp: 50000000000,
        exp: 500000000000,
        gold: 50000000,
        atk: 2000000,
        def: 500000,
        img: 'akashic_record.png',
        drops: [
        	{ id: 'skill_shard', rate: 0.3, count: 10 },
            { id: 'divinity_core', rate: 0.05 },
            { id: 'multiverse_shard', rate: 0.5 },
            { id: 'quantum_residue', rate: 1.0 },
            { id: 'lucky_bag', rate: 0.1 },
            { id: 'safe_stone', rate: 0.1 },
            { id: 'elixir', rate: 0.5 }
        ],
                // 特殊機制標記 (需配合 combatAction 邏輯)
        //isRegen: true,  // 每回合回血
        isRage: true    // 狂暴機制
    },
    //  [新增] 遊戲最強 BOSS - 零界·虛無吞噬者 (需2人以上)
    // 玩家數據參考: HP 2850萬, ATK 53萬, DEF 120萬
    // BOSS 設計: 單人打不動回血，或會被技能秒殺
    'void_devourer_god': {
        name: " 零界·虛無吞噬者", 
        level: 666, 
        
        // HP: 1000 億 (極高血量，考驗輸出)
        hp: 100000000000, 
        maxHp: 100000000000,
        
        // 經驗 & 金幣: 極度豐厚
        exp: 800000000000, 
        gold: 200000000,
        
        // ATK: 600萬 (普攻打玩家約 480萬傷害，玩家可撐 6 下)
        // 技能將會造成 3 倍傷害 (1800萬)，直接將滿血玩家打成殘血
        atk: 8000000,
        
        // DEF: 500萬 (普通攻擊無效，強制要求高穿透或真傷)
        def: 5000000,
        
        img: 'void_devourer.png', // 請確保有此圖片，或用預設圖
        
        // 掉落物: 必掉碎片與材料，低機率掉成品神器
        drops: [
            { id: 'skill_shard', rate: 0.3, count: 30 }, // 必掉 50 碎片
            { id: 'divinity_core', rate: 0.5 },          // 50% 掉核心
            { id: 'lucky_bag', rate: 0.2 },
            { id: 'safe_stone', rate: 0.1 }
        ],

        // 特殊機制標記 (需配合 combatAction 邏輯)
        //isRegen: true,  // 每回合回血
        isRage: true    // 狂暴機制
    }
};

// ==========================================
//  [新增] 怪物等級限制 (伺服器端驗證，防繞過前端)
//  使用怪物自身等級做限制，玩家等級必須達到怪物等級的一定比例
// ==========================================

// 檢查玩家是否有資格挑戰某怪物 (暫時關閉限制)
function checkMonsterAccess(player, monsterKey) {
    return { pass: true };
}

// ==========================================
//  僱員探險系統
// ==========================================
const EXPEDITION_ZONES = [
    { id: 'exp_forest',   name: ' 迷霧森林',   reqLv: 1,   goldMin: 500,    goldMax: 2000,   expMin: 10,  expMax: 30,
      drops: [
        {id:'oak_log',rate:0.6},{id:'soft_fur',rate:0.4},{id:'copper_ore',rate:0.3},{id:'potion_hp',rate:0.2},
        {id:'beast_fang',rate:0.2},{id:'slime_gel',rate:0.3},
        {id:'maple_log',rate:0.05},{id:'pearl',rate:0.02}
      ] },
    { id: 'exp_swamp',    name: ' 毒沼',       reqLv: 10,  goldMin: 1500,   goldMax: 5000,   expMin: 20,  expMax: 50,
      drops: [
        {id:'poison_sac',rate:0.5},{id:'bone_shard',rate:0.4},{id:'iron_ore',rate:0.3},{id:'leather',rate:0.3},
        {id:'tough_hide',rate:0.2},{id:'magic_dust',rate:0.15},
        {id:'silver_ore',rate:0.05},{id:'ruby',rate:0.02}
      ] },
    { id: 'exp_volcano',  name: ' 火山地帶',   reqLv: 25,  goldMin: 3000,   goldMax: 10000,  expMin: 30,  expMax: 80,
      drops: [
        {id:'fire_core',rate:0.4},{id:'lava_rock',rate:0.5},{id:'silver_ore',rate:0.3},{id:'iron_ore',rate:0.4},
        {id:'coal',rate:0.3},{id:'gold_ore',rate:0.1},
        {id:'dragon_scale',rate:0.03},{id:'ruby',rate:0.05},{id:'diamond',rate:0.01}
      ] },
    { id: 'exp_glacier',  name: '❄️ 冰川',       reqLv: 50,  goldMin: 5000,   goldMax: 20000,  expMin: 50,  expMax: 120,
      drops: [
        {id:'ice_crystal',rate:0.5},{id:'yeti_fur',rate:0.3},{id:'gold_ore',rate:0.2},{id:'potion_mid',rate:0.2},
        {id:'spirit_dust',rate:0.15},{id:'mithril',rate:0.08},
        {id:'diamond',rate:0.03},{id:'ancient_log',rate:0.02}
      ] },
    { id: 'exp_void',     name: ' 虛空裂隙',   reqLv: 80,  goldMin: 10000,  goldMax: 50000,  expMin: 80,  expMax: 180,
      drops: [
        {id:'void_dust',rate:0.4},{id:'dark_essence',rate:0.3},{id:'mithril',rate:0.2},{id:'spirit_dust',rate:0.3},
        {id:'demon_horn',rate:0.1},{id:'void_shard',rate:0.08},
        {id:'chaos_orb',rate:0.03},{id:'angel_feather',rate:0.02},{id:'dark_matter',rate:0.01}
      ] },
    { id: 'exp_abyss',    name: '☠️ 深淵',       reqLv: 150, goldMin: 30000,  goldMax: 100000, expMin: 120, expMax: 280,
      drops: [
        {id:'demon_horn',rate:0.3},{id:'dragon_scale',rate:0.2},{id:'adamantite',rate:0.15},{id:'chaos_orb',rate:0.1},
        {id:'god_blood',rate:0.05},{id:'dark_matter',rate:0.05},{id:'void_shard',rate:0.1},
        {id:'titan_steel',rate:0.03},{id:'star_fragment',rate:0.02},{id:'dimension_gem',rate:0.01}
      ] },
    { id: 'exp_cosmos',   name: ' 星際廢墟',   reqLv: 200, goldMin: 80000,  goldMax: 300000, expMin: 200, expMax: 450,
      drops: [
        {id:'titan_steel',rate:0.2},{id:'star_fragment',rate:0.2},{id:'god_blood',rate:0.1},{id:'angel_feather',rate:0.1},
        {id:'cosmic_steel',rate:0.08},{id:'star_core',rate:0.05},{id:'time_sand',rate:0.05},
        {id:'dimension_gem',rate:0.03},{id:'entropy_origin',rate:0.01},{id:'divinity_core',rate:0.005}
      ] },
    { id: 'exp_quantum',  name: '⚛️ 量子領域',   reqLv: 300, goldMin: 200000, goldMax: 800000, expMin: 350, expMax: 700,
      drops: [
        {id:'cosmic_steel',rate:0.3},{id:'time_sand',rate:0.2},{id:'dimension_gem',rate:0.15},{id:'star_core',rate:0.1},
        {id:'quantum_residue',rate:0.2},{id:'multiverse_shard',rate:0.08},
        {id:'entropy_origin',rate:0.03},{id:'divinity_core',rate:0.01}
      ] },
];

// ==========================================
//  裝備等級限制系統
//  神話系列 = Lv.450 (遊戲最強)
//  其他所有裝備 ≤ Lv.400
//  未列入的裝備 = 不限制 (Lv.1)
// ==========================================
const EQUIP_REQ_LV = {
    // ===== 武器 =====
    // Lv.1：新手
    'wood_sword': 1, 'copper_dagger': 1, 'oak_bow': 1, 'steel_blade': 1, 'hero_sword': 1,
    // Lv.10
    'iron_sword': 10, 'maple_staff': 10, 'shark_tooth': 10,
    // Lv.20
    'silver_blade': 20, 'spike_club': 20, 'poison_dag': 20, 'assassin_dag': 20,
    // Lv.30
    'emerald_staff': 30,
    // Lv.40
    'flame_staff': 40, 'gold_axe': 40,
    // Lv.50
    'obsidian_blade': 50,
    // Lv.60
    'frost_bow': 60, 'dragon_spear': 60,
    // Lv.80
    'mithril_saber': 80,
    // Lv.100
    'void_reaper': 100, 'void_reaper_dark': 100,
    // Lv.130
    'god_slayer': 130, 'chaos_staff': 130,
    // Lv.180
    'genesis_weapon': 180,
    // Lv.220
    'void_blade': 220,
    // Lv.260
    'galaxy_saber': 260,
    // Lv.300
    'entropy_sword': 300,
    // Lv.350
    'infinity_blade': 350,
    // Lv.400
    'singularity_weapon': 400,
    // 碎片武器
    'shard_blade_novice': 10,
    'shard_axe_crystal': 100,
    'shard_scythe_void': 200,
    'shard_spear_galaxy': 300,
    'shard_wep_dimension': 380,
    'shard_wep_origin': 400,

    // ===== 防具 =====
    // Lv.1
    'cloth_armor': 1, 'plate_mail': 1,
    // Lv.5
    'leather_armor': 5, 'hunt_vest': 5,
    // Lv.15
    'dragon_mail': 15,
    // Lv.25
    'chain_mail': 25,
    // Lv.35
    'iron_armor': 35,
    // Lv.50
    'magma_plate': 50,
    // Lv.60
    'ice_robe': 60,
    // Lv.70
    'yeti_cloak': 70,
    // Lv.100
    'demon_armor': 100,
    // Lv.130
    'angel_armor': 130,
    // Lv.180
    'genesis_armor': 180,
    // Lv.220
    'void_armor': 220,
    // Lv.260
    'nebula_plate': 260,
    // Lv.300
    'entropy_god_armor': 300,
    // Lv.350
    'event_horizon': 350,
    // Lv.400
    'singularity_armor': 400,
    // 碎片防具
    'shard_armor_novice': 10,
    'shard_armor_crystal': 100,
    'shard_robe_void': 200,
    'shard_plate_galaxy': 300,
    'shard_armor_dimension': 380,
    'shard_armor_origin': 400,

    // ===== 飾品 =====
    // Lv.1
    'bone_ring': 1, 'ring_life': 1, 'ring_magic': 1,
    // Lv.5
    'ring_str': 5, 'bracelet_def': 5, 'necklace_hp': 5, 'necklace_mp': 5,
    // Lv.10
    'fish_ring': 10, 'snake_boots': 10,
    // Lv.20
    'pearl_necklace': 20,
    // Lv.80
    'amulet_soul': 80,
    // Lv.100
    'ring_lord': 100,
    // Lv.150
    'crown_chaos': 150,
    // Lv.200
    'ring_galaxy': 200,
    // Lv.280
    'dimension_ring': 280,
    // Lv.350
    'mobius_ring': 350,
    // Lv.400
    'singularity_acc': 400,
    // 碎片飾品
    'shard_ring_novice': 10,
    'shard_neck_brave': 30,
    'shard_charm_wind': 60,
    'shard_ring_vampire': 100,
    'shard_earring_holy': 150,
    'shard_belt_titan': 200,
    'shard_pendant_dragon': 280,
    'shard_ring_void': 350,
    'shard_core_galaxy': 380,
    'shard_crown_infinity': 400,

    // ===== 神話系列 (遊戲最強 = Lv.450) =====
    'myth_weapon': 450,
    'myth_armor': 450,
    'myth_acc': 450,
};

const EXPEDITION_DURATION = 3 * 60 * 60 * 1000;  // 3 小時
const EXPEDITION_REST    = 1 * 60 * 60 * 1000;  // 1 小時休息
const EXPEDITION_COST    = 50;                   // 碎片
const HIRELING_NAMES = ['阿瑞斯','貝拉','凱恩','丹妮','艾文','菲莉','格倫','海倫','伊恩','珍妮','凱拉','里昂','瑪雅','尼克','奧莉'];

// 計算玩家最多可請多少僱員 (根據等級)
function getMaxHirelings(playerLevel) {
    if (playerLevel >= 200) return 5;
    if (playerLevel >= 100) return 4;
    if (playerLevel >= 50)  return 3;
    if (playerLevel >= 20)  return 2;
    return 1;
}

// 計算僱員升級所需經驗
function getHirelingMaxExp(hirelingLevel) {
    return Math.floor(100 * Math.pow(1.3, hirelingLevel - 1));
}

// 生成探險獎勵
function generateExpeditionRewards(zone, hirelingLevel) {
    const zoneCfg = EXPEDITION_ZONES.find(z => z.id === zone);
    if (!zoneCfg) return { gold: 0, exp: 0, items: {} };

    // 金幣：基礎隨機 + 僱員等級加成
    const lvBonus = 1 + (hirelingLevel * 0.05); // 每級 +5%
    const gold = Math.floor((zoneCfg.goldMin + Math.random() * (zoneCfg.goldMax - zoneCfg.goldMin)) * lvBonus);
    const exp = Math.floor((zoneCfg.expMin + Math.random() * (zoneCfg.expMax - zoneCfg.expMin)) * lvBonus);

    // 掉落物
    const items = {};
    zoneCfg.drops.forEach(drop => {
        // 僱員等級提高掉落率 (每級 +1%)
        const adjustedRate = Math.min(0.95, drop.rate + hirelingLevel * 0.01);
        if (Math.random() < adjustedRate) {
            const qty = 1 + Math.floor(Math.random() * (1 + Math.floor(hirelingLevel / 10)));
            items[drop.id] = (items[drop.id] || 0) + qty;
        }
    });

    return { gold, exp, items };
}

 // [修改] 隨機生成 Lv.350 - Lv.500 的混沌 Boss (含等級區分掉落)
function generateChaosBoss() {
    // 1. 隨機抽出等級 (350 ~ 500)
    const minLv = 350;
    const maxLv = 500;
    const lv = Math.floor(Math.random() * (maxLv - minLv + 1)) + minLv;
 
    // 2. 數值計算
    const hp = lv * 20000000; 
    const maxHp = hp;
    const atk = lv * 3000; 
    const def = lv * 800;  
    const mp = lv * 1000; 
    const exp = lv * 700000000; 
    const gold = lv * 1500000;

    // 3. 定義掉落物
    let drops = [];

    //  判斷等級區間
    if (lv >= 400) {
        // === Lv.400 - Lv.500 (掉落奇點裝備材料) ===
        drops = [
            // 新材料 (必掉/高機率)
            { id: 'quantum_residue', rate: 1.0 },   // 100% 量子殘渣
            { id: 'multiverse_shard', rate: 0.5 },
            { id: 'skill_shard', rate: 0.3, count: 5 },  // 50% 多元宇宙碎片'skill_shard'
            
            // 稀有材料
            { id: 'divinity_core', rate: 0.05 },    // 5% 創世神格 (超稀有)
            
            // 消耗品與其他
            { id: 'lucky_bag', rate: 0.1 },         // 10% 福袋
            { id: 'elixir', rate: 0.5 },            // 50% 甘露
            { id: 'entropy_origin', rate: 0.1 },    // 10% 熱寂原點 (舊稀有材)
            { id: 'dimension_gem', rate: 0.5 }      // 50% 維度寶石
        ];
    } else {
        // === Lv.350 - Lv.399 (原本的掉落列表) ===
        drops = [
            // 必掉/高機率
            { id: 'void_shard', rate: 1.0 },       
            { id: 'dark_matter', rate: 0.8 },      
            { id: 'cosmic_steel', rate: 0.6 },
            { id: 'skill_shard', rate: 0.5, count: 3 },
            
            // 中機率
            { id: 'star_core', rate: 0.7 },        
            { id: 'time_sand', rate: 1.0 },        
            { id: 'dimension_gem', rate: 0.5 },    
            
            // 稀有
            { id: 'entropy_origin', rate: 0.05 },  
            { id: 'lucky_bag', rate: 0.05 },       
            { id: 'elixir', rate: 0.15 }           
        ];
    }

    return {
        id: 'chaos_boss',        
        name: `混沌幻影 (Lv.${lv})`, 
        level: lv,
        hp: hp,
        maxHp: maxHp,
        mp: mp,
        maxMp: mp,
        atk: atk,
        def: def,
        exp: exp,
        gold: gold,
        img: 'void_walker.png', 
        isBoss: true,
        status: 'alive',
        isStunned: false,
        drops: drops 
    };
}

let gameState = { players: {}, battleRooms: {} };

let WORLD_BOSS = {
    active: false,
    hp: 0,
    maxHp: 1000000000000, 
    name: "虛空滅世者",
    damageLog: {}, 
    players: [],   
    startTime: 0,
    wipeTimer: null 
};
const BOSS_TIME_LIMIT = 9 * 60 * 1000;
let rateLimits = {}; 

function checkRateLimit(socketId, actionType, limitMs) {
    if (!rateLimits[socketId]) rateLimits[socketId] = {};
    const lastTime = rateLimits[socketId][actionType] || 0;
    const now = Date.now();
    if (now - lastTime < limitMs) { return false; }
    rateLimits[socketId][actionType] = now;
    return true;
}

function clearRateLimit(socketId) {
    if (rateLimits[socketId]) delete rateLimits[socketId];
}

function getStatsByLevel(lv) {
    let stats = { hp: 100, mp: 50, atk: 10, def: 5 }; 
    for (let i = 2; i <= lv; i++) {
        stats.hp += 100 + (i * 3);          
        stats.mp += 20 + Math.floor(i * 0.5);
        stats.atk += 5 + Math.floor(i / 5);
        stats.def += 3 + Math.floor(i / 15);
    }
    return stats;
}

function getMaxExpByLevel(lv) {
    let exp = 100; 
    for (let i = 2; i <= lv; i++) {
        if (i < 20) exp = Math.floor(exp * 1.5);
        else if (i < 50) exp = Math.floor(exp * 1.2);
        else exp = Math.floor(exp * 1.05);
    }
    return exp;
}

function isStrongPassword(pw) {
    if (!pw || pw.length < 8) return false;
    if (!/[A-Z]/.test(pw)) return false; 
    if (!/[a-z]/.test(pw)) return false; 
    if (!/[0-9]/.test(pw)) return false; 
    return true;
}

// ==========================================
//  [新版] 每日任務大型題庫 (20+ 個任務)
// ==========================================
const ALL_QUEST_POOL = {
    // --- 登入類 ---
    'login_1': { name: "每日簽到", desc: "登入遊戲報到", target: 1, type: 'login', reward: { gold: 10000, exp: 50, item: 'elixir', itemCount: 5 } },
    
    // --- 勝場類 (因為怪死=贏，其實跟擊殺很像，但可以設定不同描述) ---
    'win_10': { name: "初嘗勝果", desc: "贏得 10 場戰鬥", target: 10, type: 'win', reward: { gold: 15000, exp: 80 , item: 'enhance_stone', itemCount: 5} },
    'win_30': { name: "連戰連勝", desc: "贏得 30 場戰鬥", target: 30, type: 'win', reward: { gold: 30000, exp: 180 , item: 'enhance_stone', itemCount: 5} },
    'win_100': { name: "戰鬥專家", desc: "贏得 100 場戰鬥", target: 100, type: 'win', reward: { gold: 50000, exp: 350, item: 'dimension_gem' , itemCount: 1} },
    'win_1000': { name: "不敗傳說", desc: "贏得 100 場戰鬥Lv.300或以上的怪物", target: 100, reqLevel: 300, type: 'kill', reward: { gold: 80000, exp: 600 , item: 'lucky_bag', itemCount: 2} },
'win_500': { name: "不敗傳說", desc: "贏得 50 場戰鬥Lv.20或以上的怪物", target: 50, reqLevel: 20, type: 'kill', reward: { gold: 30000, exp: 600 , item: 'demon_armor', itemCount: 1} },
'win_2000': { name: "不敗傳說", desc: "贏得 100 場戰鬥Lv.20或以上的怪物", target: 100, reqLevel: 50, type: 'kill', reward: { gold: 50000, exp: 600 , item: 'void_reaper', itemCount: 1} },
    
    // --- 道具使用類 (需要在 combatAction 補上 hook) ---
    'use_3': { name: "藥罐子", desc: "在戰鬥中使用 3 次物品", target: 3, type: 'use', reward: { gold: 1000, exp: 50, item: 'void_soup', itemCount: 2 } },
    'use_5': { name: "生存大師", desc: "在戰鬥中使用 5 次物品", target: 5, type: 'use', reward: { gold: 2000, exp: 100 , item: 'void_soup', itemCount: 3} },
    'use_10': { name: "道具流大師", desc: "在戰鬥中使用 10 次物品", target: 10, type: 'use', reward: { gold: 5000, exp: 300, item: 'void_soup', itemCount: 5 } },

    // --- 趣味/幸運類 (變相送分題) ---
    'lucky_day': { name: "幸運日", desc: "完成 1 次任意戰鬥", target: 1, type: 'win', reward: { gold: 777, exp: 777, item: 'enhance_stone', itemCount: 3 } },
    'hard_work': { name: "勤勞的冒險者", desc: "擊殺 8 隻怪物", target: 8, type: 'kill', reward: { gold: 4000, exp: 250 , item: 'enhance_stone', itemCount: 3} },
    'veteran': { name: "身經百戰", desc: "贏得 12 場戰鬥", target: 12, type: 'win', reward: { gold: 6000, exp: 450 , item: 'enhance_stone', itemCount: 3} },
    'survivor': { name: "絕地求生", desc: "使用 8 次物品", target: 8, type: 'use', reward: { gold: 4000, exp: 300 , item: 'enhance_stone', itemCount: 3} },
    'rampage': { name: "殺戮時刻", desc: "擊殺 25 隻怪物", target: 25, type: 'kill', reward: { gold: 9000, exp: 700 , item: 'enhance_stone', itemCount: 3} },
    'legend': { name: "傳奇之路", desc: "贏得 20 場戰鬥", target: 20, type: 'win', reward: { gold: 20000, exp: 1500, item: 'enhance_stone', itemCount: 3 } },
    // ---  [新增] 指定等級擊殺類 ---
    // 邏輯：只要怪物的等級 >= reqLevel 就會計數
    'kill_lv50': { 
        name: "初級試煉", 
        desc: "擊殺 10 隻 Lv.50 以上的怪物", 
        target: 10, 
        type: 'kill', 
        reqLevel: 50,  //  關鍵設定：最低等級要求
        reward: { gold: 30000, exp: 200 , item: 'multiverse_shard', itemCount: 3} 
    },
    'kill_lv100': { 
        name: "中級獵手", 
        desc: "擊殺 20 隻 Lv.100 以上的怪物", 
        target: 20, 
        type: 'kill', 
        reqLevel: 100, 
        reward: { gold: 60000, exp: 500, item: 'lucky_bag', itemCount: 1 } 
    },
    'kill_lv200': { 
        name: "強者證明", 
        desc: "擊殺 30 隻 Lv.200 以上的怪物", 
        target: 30, 
        type: 'kill', 
        reqLevel: 200, 
        reward: { gold: 120000, exp: 100000, item: 'divinity_core', itemCount: 3 } 
    },
    'kill_lv400': { 
        name: "深淵挑戰", 
        desc: "擊殺 100 隻 Lv.350 以上的怪物", 
        target: 100, 
        type: 'kill', 
        reqLevel: 350, 
        reward: { gold: 200000, exp: 250000, item: 'singularity_armor', itemCount: 1 } 
    },
'kill_lv550': { 
        name: "深淵挑戰", 
        desc: "擊殺 2 隻 Lv.500 以上的怪物", 
        target: 2, 
        type: 'kill', 
        reqLevel: 500, 
        reward: { gold: 500000, exp: 500000, item: 'singularity_weapon', itemCount: 1 } 
    }
};

// [修正版] 每日重置 (強制使用 HKT 香港時間判定)
function checkDailyReset(playerArg) {
    const player = gameState.players[playerArg.id];
    if (!player) return false;

    //  關鍵修正：將時間強制轉換為香港時區 (UTC+8)
    const now = new Date();
    // 建立一個以香港時間為基準的 Date 物件
    const hkTime = new Date(now.toLocaleString("en-US", {timeZone: "Asia/Hong_Kong"}));

    // 使用 hkTime 來生成日期字串 (YYYY-MM-DD)
    const today = `${hkTime.getFullYear()}-${String(hkTime.getMonth()+1).padStart(2,'0')}-${String(hkTime.getDate()).padStart(2,'0')}`;
    
    // 讀取玩家上次重置的日期
    const oldDate = (player.dailyQuests && player.dailyQuests.date) ? player.dailyQuests.date : "無資料";

    // 比較日期：如果今天(HKT) 與 上次紀錄 不同，就重置
    if (!player.dailyQuests || oldDate !== today) {
        console.log(`[Daily] ${player.name} 觸發每日刷新 (${oldDate} -> ${today})`);

        // ==========================================
        // 1.  隨機刷新每日任務
        // ==========================================
        const allKeys = Object.keys(ALL_QUEST_POOL).filter(k => k !== 'login_1'); 
        
        // 洗牌
        for (let i = allKeys.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [allKeys[i], allKeys[j]] = [allKeys[j], allKeys[i]];
        }
        
        // 選出 5 個任務
        const selectedQuests = ['login_1', ...allKeys.slice(0, 4)];

        // 重置結構
        player.dailyQuests = {
            date: today, // 存入今天的日期 (HKT)
            active: selectedQuests,
            progress: {},
            claimed: [] // 清空領取紀錄
        };

        // 初始化進度
        selectedQuests.forEach(qid => {
            player.dailyQuests.progress[qid] = 0;
        });
        player.dailyQuests.progress['login_1'] = 1;

        // 3. 強制存檔
        if (typeof saveData === 'function') saveData();

        return true; //  回傳 true 代表剛剛發生了重置
    }

    return false; // 日期沒變
}


//  [修正版] 更新進度 (支援等級判斷)
function updateDailyProgress(player, type, amount = 1, params = {}) {
    if (!player) return;
    
    // 確保有任務資料
    if (typeof checkDailyReset === 'function') checkDailyReset(player);
    if (!player.dailyQuests || !player.dailyQuests.active) return;

    let updated = false;

    // 遍歷玩家當前的任務
    player.dailyQuests.active.forEach(qid => {
        const questConfig = ALL_QUEST_POOL[qid];
        
        // 1. 檢查任務是否存在 且 類型符合 (kill, win, use...)
        if (questConfig && questConfig.type === type) {
            
            //  2. [新增] 檢查等級限制 (如果任務有設定 reqLevel)
            if (questConfig.reqLevel) {
                // 如果傳入的參數沒有 level，或者怪物等級低於要求，就跳過不計數
                if (!params.level || params.level < questConfig.reqLevel) {
                    return; 
                }
            }

            // 3. 執行計數邏輯
            const currentProg = player.dailyQuests.progress[qid] || 0;
            
            if (currentProg < questConfig.target) {
                player.dailyQuests.progress[qid] += amount;
                
                // 防止溢位
                if (player.dailyQuests.progress[qid] > questConfig.target) {
                    player.dailyQuests.progress[qid] = questConfig.target;
                }
                updated = true;
            }
        }
    });

    // 這裡不需要存檔，交由 combatAction 統一處理
}

//  [公會系統] 設定與儲存
const GUILD_CONFIG = {
    createCost: 500000, // 創立公會費用
    maxMembers: 50,     // 最大人數
    stoneTarget: 20,    // 條件1：20人送石頭
    interestTarget: 500000000, // 條件2：5億存款
    interestRate: 0.10  // 10% 利息
};

// 讀取/儲存公會資料的變數
let guildData = {}; 


// 啟動時讀取
if (fs.existsSync('guilds.json')) {
    try { guildData = JSON.parse(fs.readFileSync('guilds.json', 'utf8')); } catch (e) {}
}

function saveGuilds() {
    fs.writeFileSync('guilds.json', JSON.stringify(guildData, null, 2));
}

io.on('connection', (socket) => {
    // 1. 獲取連線者的真實 IP
    const clientIp = getSocketIp(socket);

    // 2. ️ [修改] 檢查 IP 是否在黑名單 (使用新版 API)
    if (typeof BanSystem !== 'undefined') {
        // 注意：這裡是 isIpBanned，不是 isBanned
        const ipBan = BanSystem.isIpBanned(clientIp); 
        
        if (ipBan) {
            console.log(`[連線拒絕] 封鎖的 IP: ${clientIp} 嘗試連線`);
            
            // 計算剩餘解封時間
            let timeMsg = "永久";
            if (ipBan.expiresAt) {
                const timeLeft = Math.ceil((ipBan.expiresAt - Date.now()) / 60000);
                timeMsg = (timeLeft > 0) ? `${timeLeft} 分鐘後` : "即將解封";
            }

            //  發送強制登出訊號 (讓前端跳轉回 index.html)
            socket.emit('forceLogout', `⛔ 你的 IP 已被封鎖！\n原因: ${ipBan.reason}\n解封時間: ${timeMsg}`);
            
            // 斷開連線
            socket.disconnect(true);
            return; // 阻止後續程式執行
        }
    }

    // 3. 正常連線邏輯
    console.log(`[連線] ID: ${socket.id} (IP: ${clientIp})`);

    // 發送聊天記錄
    DB.getChatHistory(50, (rows) => {
        const history = rows.map(r => ({ name: r.sender_name, msg: r.message }));
        socket.emit('chatHistory', history);
    });

    // ... (接續原本的 register, login, joinGame 等事件) ...

    // ==========================================
    //  [改版 v3] 註冊流程 — 分兩步
    //  Step 1: register → 驗證帳號/密碼/email → 發驗證碼
    //  Step 2: verifyRegister → 驗證碼正確 → 建立帳號
    // ==========================================
    socket.on('register', (data) => { 
        const { user, pass, email } = data; 
        
        const clientIp = getSocketIp(socket);
        if (typeof BanSystem !== 'undefined' && BanSystem.isIpBanned(clientIp)) {
             socket.emit('authResult', { success: false, msg: "⛔ 此 IP 已被封鎖，無法註冊新帳號" });
             return;
        }

        if (!user || !isValidName(user)) { 
            socket.emit('authResult', { success: false, msg: "帳號包含非法字元(如空格)或格式錯誤" }); 
            return; 
        }
        if (user.length < 5) { 
            socket.emit('authResult', { success: false, msg: "帳號至少需 5 字元" }); 
            return; 
        }
        if (!isStrongPassword(pass)) { 
            socket.emit('authResult', { success: false, msg: "密碼需8位以上，含大寫、小寫及數字" }); 
            return; 
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!email || !emailRegex.test(email)) {
            socket.emit('authResult', { success: false, msg: "請填寫正確的 Email 地址" });
            return;
        }
        if (email.length > 100) {
            socket.emit('authResult', { success: false, msg: "Email 不能超過 100 字" });
            return;
        }

        const safeEmail = email.trim().toLowerCase();

        // 冷卻檢查 (60 秒內不能重發)
        if (EMAIL_COOLDOWN[safeEmail] && Date.now() - EMAIL_COOLDOWN[safeEmail] < 60000) {
            const remain = Math.ceil((60000 - (Date.now() - EMAIL_COOLDOWN[safeEmail])) / 1000);
            socket.emit('authResult', { success: false, msg: `⏳ 請等 ${remain} 秒後再重新發送驗證碼` });
            return;
        }

        // 檢查帳號是否已存在
        DB.getUserInfo(user, (existingUser) => {
            if (existingUser) {
                socket.emit('authResult', { success: false, msg: "帳號已存在" });
                return;
            }

            // 檢查 email 是否已被使用
            DB.getUserByEmail(safeEmail, (emailUser) => {
                if (emailUser) {
                    socket.emit('authResult', { success: false, msg: "此 Email 已被註冊" });
                    return;
                }

                // 生成驗證碼並發送
                const code = generateCode();
                const salt = bcrypt.genSaltSync(10);
                const hash = bcrypt.hashSync(pass, salt);

                EMAIL_CODES[safeEmail] = {
                    code: code,
                    type: 'register',
                    expires: Date.now() + 10 * 60 * 1000, // 10 分鐘
                    user: user,
                    hash: hash
                };
                EMAIL_COOLDOWN[safeEmail] = Date.now();

                sendVerificationEmail(safeEmail, code).then(sent => {
                    if (sent) {
                        socket.emit('emailCodeSent', { 
                            success: true, 
                            msg: ` 驗證碼已發送至 ${safeEmail}`,
                            type: 'register',
                            email: safeEmail
                        });
                    } else {
                        socket.emit('authResult', { success: false, msg: "❌ 驗證碼發送失敗，請檢查 Email 地址" });
                        delete EMAIL_CODES[safeEmail];
                    }
                });
            });
        });
    });

    // Step 2: 驗證註冊驗證碼
    socket.on('verifyRegister', (data) => {
        const { email, code } = data;
        if (!email || !code) {
            socket.emit('authResult', { success: false, msg: "請輸入驗證碼" });
            return;
        }
        const safeEmail = email.trim().toLowerCase();
        const record = EMAIL_CODES[safeEmail];

        if (!record || record.type !== 'register') {
            socket.emit('authResult', { success: false, msg: "找不到驗證碼記錄，請重新註冊" });
            return;
        }
        if (Date.now() > record.expires) {
            delete EMAIL_CODES[safeEmail];
            socket.emit('authResult', { success: false, msg: "驗證碼已過期，請重新註冊" });
            return;
        }
        if (record.code !== code.trim()) {
            socket.emit('authResult', { success: false, msg: "❌ 驗證碼錯誤" });
            return;
        }

        // 驗證通過 → 建立帳號
        const newToken = jwt.sign({ username: record.user }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
        const safeUser = escapeHtml(record.user);

        DB.createAccount(safeUser, record.hash, newToken, (success, msg) => { 
            if (success) {
                // 設定 email_verified = 1
                DB.setEmailVerified(safeUser, true, () => {});
                delete EMAIL_CODES[safeEmail];
                socket.emit('authResult', { success: true, msg: "✅ 註冊成功！Email 已驗證", token: newToken }); 
            } else {
                socket.emit('authResult', { success: false, msg: msg || "註冊失敗" }); 
            }
        }, safeEmail); 
    });

    // ==========================================
    //  [改版 v3] 登入 — 只能用 Email 登入
    //  舊玩家未綁定 Email → 特殊提示要先綁定
    // ==========================================
    socket.on('login', (data) => { 
        const { user, pass } = data; 
        
        const clientIp = getSocketIp(socket);
        if (typeof BanSystem !== 'undefined') {
            const ipBan = BanSystem.isIpBanned(clientIp);
            if (ipBan) {
                let timeMsg = ipBan.expiresAt ? `${Math.ceil((ipBan.expiresAt - Date.now())/60000)} 分鐘後` : "永久";
                socket.emit('authResult', { success: false, msg: `⛔ 此 IP 已被封鎖！\n原因: ${ipBan.reason}\n解封: ${timeMsg}` });
                socket.disconnect(true);
                return;
            }
        }

        if (!user || user.length < 3) { socket.emit('authResult', { success: false, msg: "請輸入 Email" }); return; }

        const isEmail = user.includes('@');

        // 如果輸入的不是 email 格式 → 檢查是否是舊帳號需要綁定
        if (!isEmail) {
            // 嘗試用 username 查找，看是否是舊玩家
            DB.getUserInfo(user, (info) => {
                if (!info) {
                    socket.emit('authResult', { success: false, msg: "請使用 Email 登入\n（新帳號請先註冊）" });
                    return;
                }
                // 舊帳號存在，檢查有沒有 email
                if (info.email && info.email_verified) {
                    // 已有 email，叫佢用 email 登入
                    const maskedEmail = info.email.replace(/(.{2}).*(@.*)/, '$1***$2');
                    socket.emit('authResult', { success: false, msg: `請使用 Email 登入\n你的 Email: ${maskedEmail}` });
                } else if (info.email && !info.email_verified) {
                    // 有 email 但未驗證
                    socket.emit('authResult', { success: false, msg: "你的 Email 尚未驗證\n請先用帳號綁定並驗證 Email" });
                    socket.emit('needBindEmail', { username: user, hasUnverifiedEmail: true });
                } else {
                    // 完全沒有 email → 需要綁定
                    if (!pass || !bcrypt.compareSync(pass, info.password)) {
                        socket.emit('authResult', { success: false, msg: "你的帳號尚未綁定 Email\n請輸入正確密碼後綁定 Email" });
                        return;
                    }
                    // 密碼正確 → 提示綁定
                    socket.emit('authResult', { success: false, msg: "你的帳號尚未綁定 Email\n請先綁定 Email 才可登入" });
                    socket.emit('needBindEmail', { username: user, hasUnverifiedEmail: false });
                }
            });
            return;
        }

        // Email 登入
        const safeEmail = user.trim().toLowerCase();
        DB.getUserByEmail(safeEmail, (info) => {
            if (!info) { 
                socket.emit('authResult', { success: false, msg: "此 Email 尚未註冊或綁定" }); 
                return;
            }

            // 檢查 email 是否已驗證
            if (!info.email_verified) {
                socket.emit('authResult', { success: false, msg: "此 Email 尚未驗證，請先完成驗證" });
                socket.emit('needBindEmail', { username: info.username, hasUnverifiedEmail: true });
                return;
            }
            
            const loginUsername = info.username;
            if (typeof BanSystem !== 'undefined') {
                const accBan = BanSystem.isAccountBanned(loginUsername);
                if (accBan) {
                    let timeMsg = accBan.expiresAt ? `${Math.ceil((accBan.expiresAt - Date.now())/60000)} 分鐘後` : "永久";
                    socket.emit('authResult', { 
                        success: false, 
                        msg: `⛔ 此帳號已被封鎖！\n原因: ${accBan.reason}\n解封: ${timeMsg}\n\n如有疑問請聯絡 Admin:\nhttps://discord.gg/7bSJtWnb` 
                    });
                    return;
                }
            }

            if (bcrypt.compareSync(pass, info.password)) {
                const newToken = jwt.sign({ username: loginUsername }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
                DB.updateUserToken(loginUsername, newToken, (updateSuccess) => {
                    if (updateSuccess) { socket.emit('authResult', { success: true, msg: "登入成功", token: newToken }); } 
                    else { socket.emit('authResult', { success: false, msg: "系統錯誤 (Token 更新失敗)" }); }
                });
            } else { socket.emit('authResult', { success: false, msg: "密碼錯誤" }); }
        });
    });

    // ==========================================
    //  [改版 v3] 綁定 Email — 分兩步（帶驗證碼）
    //  Step 1: bindEmail → 驗密碼 → 發驗證碼
    //  Step 2: verifyBindEmail → 驗證碼正確 → 綁定
    // ==========================================
    socket.on('bindEmail', (data) => {
        const { user, pass, email } = data;
        
        if (!user || !pass || !email) {
            socket.emit('bindEmailResult', { success: false, msg: "請填寫所有欄位" });
            return;
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            socket.emit('bindEmailResult', { success: false, msg: "Email 格式不正確" });
            return;
        }
        if (email.length > 100) {
            socket.emit('bindEmailResult', { success: false, msg: "Email 不能超過 100 字" });
            return;
        }

        const safeEmail = email.trim().toLowerCase();

        // 冷卻
        if (EMAIL_COOLDOWN[safeEmail] && Date.now() - EMAIL_COOLDOWN[safeEmail] < 60000) {
            const remain = Math.ceil((60000 - (Date.now() - EMAIL_COOLDOWN[safeEmail])) / 1000);
            socket.emit('bindEmailResult', { success: false, msg: `⏳ 請等 ${remain} 秒後再重新發送` });
            return;
        }

        // 驗密碼
        DB.getUserInfo(user, (info) => {
            if (!info) {
                socket.emit('bindEmailResult', { success: false, msg: "帳號不存在" });
                return;
            }
            if (!bcrypt.compareSync(pass, info.password)) {
                socket.emit('bindEmailResult', { success: false, msg: "密碼錯誤，無法綁定" });
                return;
            }

            // 檢查 email 是否已被別人用
            DB.getUserByEmail(safeEmail, (emailUser) => {
                if (emailUser && emailUser.username !== user) {
                    socket.emit('bindEmailResult', { success: false, msg: "此 Email 已被其他帳號使用" });
                    return;
                }

                // 發送驗證碼
                const code = generateCode();
                EMAIL_CODES[safeEmail] = {
                    code: code,
                    type: 'bind',
                    expires: Date.now() + 10 * 60 * 1000,
                    user: user
                };
                EMAIL_COOLDOWN[safeEmail] = Date.now();

                sendVerificationEmail(safeEmail, code).then(sent => {
                    if (sent) {
                        socket.emit('emailCodeSent', { 
                            success: true, 
                            msg: ` 驗證碼已發送至 ${safeEmail}`,
                            type: 'bind',
                            email: safeEmail
                        });
                    } else {
                        socket.emit('bindEmailResult', { success: false, msg: "❌ 驗證碼發送失敗" });
                        delete EMAIL_CODES[safeEmail];
                    }
                });
            });
        });
    });

    // Step 2: 驗證綁定驗證碼
    socket.on('verifyBindEmail', (data) => {
        const { email, code } = data;
        if (!email || !code) {
            socket.emit('bindEmailResult', { success: false, msg: "請輸入驗證碼" });
            return;
        }
        const safeEmail = email.trim().toLowerCase();
        const record = EMAIL_CODES[safeEmail];

        if (!record || record.type !== 'bind') {
            socket.emit('bindEmailResult', { success: false, msg: "找不到驗證碼記錄，請重新操作" });
            return;
        }
        if (Date.now() > record.expires) {
            delete EMAIL_CODES[safeEmail];
            socket.emit('bindEmailResult', { success: false, msg: "驗證碼已過期，請重新操作" });
            return;
        }
        if (record.code !== code.trim()) {
            socket.emit('bindEmailResult', { success: false, msg: "❌ 驗證碼錯誤" });
            return;
        }

        // 驗證通過 → 綁定 email 並設為已驗證
        DB.bindEmail(record.user, safeEmail, (result) => {
            if (result.success) {
                DB.setEmailVerified(record.user, true, () => {});
                delete EMAIL_CODES[safeEmail];
                socket.emit('bindEmailResult', { success: true, msg: "✅ Email 綁定成功！現在可以用 Email 登入了" });
            } else {
                socket.emit('bindEmailResult', result);
            }
        });
    });

    // ==========================================
    //  [新增] 查詢 Email 綁定狀態
    // ==========================================
    socket.on('getEmailStatus', () => {
        const p = gameState.players[socket.id];
        if (!p) return;
        DB.getUserEmail(p.name, (email) => {
            socket.emit('emailStatusResult', { bound: !!email, email: email || null });
        });
    });

//  [修正版] 獲取任務列表 (回傳動態配置)
    socket.on('getDailyQuests', () => {
        const p = gameState.players[socket.id];
        if (!p) return;
        checkDailyReset(p);
        
        // 動態生成 Config (只包含玩家有的任務)
        const playerQuestConfig = {};
        if (p.dailyQuests.active) {
            p.dailyQuests.active.forEach(qid => {
                if (ALL_QUEST_POOL[qid]) {
                    playerQuestConfig[qid] = ALL_QUEST_POOL[qid];
                }
            });
        }

        socket.emit('dailyQuestData', {
            config: playerQuestConfig, // 這裡只傳那 5 個
            progress: p.dailyQuests.progress,
            claimed: p.dailyQuests.claimed
        });
    });

    
    // [修正版] 領取獎勵 (支援自訂物品數量)
    socket.on('claimDailyReward', (questKey) => {
        const p = gameState.players[socket.id];
        if (!p) return;
        checkDailyReset(p);

        // 從大題庫讀取設定
        const quest = ALL_QUEST_POOL[questKey];
        // 確保 progress 物件存在
        if (!p.dailyQuests || !p.dailyQuests.progress) return;
        
        const currentProg = p.dailyQuests.progress[questKey] || 0;
        
        // 驗證：任務存在 + 已達成 + 未領取 + 玩家真的有這個任務
        if (quest && 
            p.dailyQuests.active.includes(questKey) && 
            currentProg >= quest.target && 
            !p.dailyQuests.claimed.includes(questKey)) {
            
            // 1. 標記領取
            p.dailyQuests.claimed.push(questKey);

            // 2. 發放獎勵
            let rewardMsg = "領取成功！";

            // 發金幣
            if (quest.reward.gold) {
                p.gold += quest.reward.gold;
            }
            
            // 發經驗
            if (quest.reward.exp) {
                p.exp += quest.reward.exp;
                if (typeof checkLevelUp === 'function') checkLevelUp(p);
            }
            
            //  [重點修改] 發物品 (支援數量)
            if (quest.reward.item) {
                p.inventory = p.inventory || {};
                
                // 讀取數量，如果設定檔沒寫 itemCount，預設為 1
                const qty = quest.reward.itemCount || 1;
                
                p.inventory[quest.reward.item] = (p.inventory[quest.reward.item] || 0) + qty;
                
                // (選用) 更新回傳訊息，讓前端知道拿到幾個
                // rewardMsg += ` 獲得物品 x${qty}`; 
            }

            // 3. 存檔
            saveData();
            // 如果你有獨立存任務的函式
            if (typeof forceSaveDailyQuests === 'function') forceSaveDailyQuests([p]);

            socket.emit('questResult', { success: true, msg: rewardMsg });
            
            // 刷新介面
            // 重新建構 config 給前端
            const playerQuestConfig = {};
            p.dailyQuests.active.forEach(qid => {
                if (ALL_QUEST_POOL[qid]) playerQuestConfig[qid] = ALL_QUEST_POOL[qid];
            });

            socket.emit('dailyQuestData', {
                config: playerQuestConfig,
                progress: p.dailyQuests.progress,
                claimed: p.dailyQuests.claimed
            });
            
            // 更新玩家數值 (金幣/背包)
            socket.emit('playerStatsUpdate', p); 
        } else {
            socket.emit('questResult', { success: false, msg: "未達成條件或已領取" });
        }
    });


    // ==========================================
    //  [改版 v3] 修改密碼 — 改為 Email 連結重設
    //  舊的 changePassword 保留但只給已登入玩家用
    //  新增 requestPasswordReset 透過 email 發連結
    // ==========================================
    socket.on('requestPasswordReset', (data) => {
        const { email } = data;
        if (!email) {
            socket.emit('authResult', { success: false, msg: "請輸入 Email" });
            return;
        }

        const safeEmail = email.trim().toLowerCase();

        // 冷卻
        if (EMAIL_COOLDOWN['reset_' + safeEmail] && Date.now() - EMAIL_COOLDOWN['reset_' + safeEmail] < 60000) {
            const remain = Math.ceil((60000 - (Date.now() - EMAIL_COOLDOWN['reset_' + safeEmail])) / 1000);
            socket.emit('authResult', { success: false, msg: `⏳ 請等 ${remain} 秒後再試` });
            return;
        }

        DB.getUserByEmail(safeEmail, async (info) => {
            // 安全起見，不管有沒有找到都顯示同一訊息
            if (!info || !info.email_verified) {
                socket.emit('authResult', { success: true, msg: " 如果此 Email 已註冊並驗證\n重設連結將會發送到你的信箱" });
                return;
            }

            const resetToken = require('crypto').randomBytes(32).toString('hex');
            PASSWORD_RESET_TOKENS[resetToken] = {
                username: info.username,
                email: safeEmail,
                expires: Date.now() + 30 * 60 * 1000
            };
            EMAIL_COOLDOWN['reset_' + safeEmail] = Date.now();

            const sent = await sendPasswordResetEmail(safeEmail, info.username, resetToken);
            if (sent) {
                socket.emit('authResult', { success: true, msg: " 重設連結已發送到你的 Email\n請在 30 分鐘內完成修改" });
            } else {
                delete PASSWORD_RESET_TOKENS[resetToken];
                socket.emit('authResult', { success: false, msg: "郵件發送失敗，請稍後再試" });
            }
        });
    });

    // 保留舊的 changePassword 給 admin 或其他用途
    socket.on('changePassword', (data) => {
        const { user, oldPass, newPass } = data;
        if (!isStrongPassword(newPass)) { socket.emit('authResult', { success: false, msg: "新密碼需8位以上，含大寫、小寫及數字" }); return; }
        DB.getUserInfo(user, (info) => {
            if (!info) { socket.emit('authResult', { success: false, msg: "帳號不存在" }); } 
            else {
                if (bcrypt.compareSync(oldPass, info.password)) {
                    const salt = bcrypt.genSaltSync(10);
                    const newHash = bcrypt.hashSync(newPass, salt);
                    const newToken = jwt.sign({ username: user }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
                    DB.changeUserPassword(user, newHash, newToken, (success) => {
                        if (success) {
                            socket.emit('authResult', { success: true, msg: "密碼修改成功！", token: newToken });
                            if (gameState.players[socket.id]) { gameState.players[socket.id].token = newToken; }
                        } else { socket.emit('authResult', { success: false, msg: "修改失敗 (系統錯誤)" }); }
                    });
                } else { socket.emit('authResult', { success: false, msg: "舊密碼錯誤" }); }
            }
        });
    });

    // ==========================================
    //  [新增] resetPassword — 透過 email 連結重設密碼
    //  由 reset-password.html 透過 socket 觸發
    // ==========================================
    socket.on('resetPassword', (data) => {
        const { token, newPassword } = data;
        if (!token || !newPassword) {
            socket.emit('resetPasswordResult', { success: false, msg: "缺少必要參數" });
            return;
        }

        // 驗證 token
        const record = PASSWORD_RESET_TOKENS[token];
        if (!record) {
            socket.emit('resetPasswordResult', { success: false, msg: "重設連結無效或已過期" });
            return;
        }
        if (Date.now() > record.expires) {
            delete PASSWORD_RESET_TOKENS[token];
            socket.emit('resetPasswordResult', { success: false, msg: "重設連結已過期，請重新申請" });
            return;
        }

        // 密碼強度檢查
        if (!isStrongPassword(newPassword)) {
            socket.emit('resetPasswordResult', { success: false, msg: "密碼需 8 位以上，含大寫、小寫及數字" });
            return;
        }

        // 更新密碼
        const salt = bcrypt.genSaltSync(10);
        const newHash = bcrypt.hashSync(newPassword, salt);
        const newJwt = jwt.sign({ username: record.username }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

        DB.changeUserPassword(record.username, newHash, newJwt, (success) => {
            if (success) {
                delete PASSWORD_RESET_TOKENS[token];
                // 如果玩家在線，強制更新 token
                const onlinePlayer = Object.values(gameState.players).find(p => p.name === record.username);
                if (onlinePlayer) {
                    onlinePlayer.token = newJwt;
                }
                socket.emit('resetPasswordResult', { success: true, msg: "密碼修改成功！請用新密碼登入" });
                console.log(`[ResetPW] ${record.username} 已成功重設密碼`);
            } else {
                socket.emit('resetPasswordResult', { success: false, msg: "修改失敗，請稍後再試" });
            }
        });
    });

    //  [修正版] 玩家登入邏輯 (含每日任務恢復)
    //  [修正版] 玩家登入處理 (包含公會通知推送)
    socket.on('joinGame', (token) => { 
        if (!token) return; 
        if (disconnectTimers[token]) { clearTimeout(disconnectTimers[token]); delete disconnectTimers[token]; }

        jwt.verify(token, JWT_SECRET, (err, decoded) => {
            if (err) { console.log(`[JWT] 驗證失敗: ${err.message}`); socket.emit('tokenExpired'); socket.disconnect(true); return; }
            const username = decoded.username;

            // ⛔ 檢查帳號是否被 Ban
            if (typeof BanSystem !== 'undefined') {
                const accBan = BanSystem.isAccountBanned(username);
                if (accBan) {
                    let timeMsg = accBan.expiresAt ? `${Math.ceil((accBan.expiresAt - Date.now())/60000)} 分鐘後` : "永久";
                    socket.emit('forceLogout', `⛔ 此帳號已被封鎖！\n原因: ${accBan.reason}\n解封: ${timeMsg}`);
                    socket.disconnect(true);
                    return;
                }
            }
            
            // 踢除舊連線
            const existingSocketIds = Object.keys(gameState.players).filter(sid => gameState.players[sid].name === username && sid !== socket.id);
            
            // ⚡ [修正] 保留舊連線的僱員探險數據 (防止 F5 重置)
            let preservedHirelings = null;
            existingSocketIds.forEach(oldSid => {
                const oldP = gameState.players[oldSid];
                if (oldP && oldP.hirelings && oldP.hirelings.length > 0) {
                    // 如果舊連線有僱員數據（且有人在探險中），保留之
                    const hasActive = oldP.hirelings.some(h => h.status === 'exploring' || h.status === 'resting');
                    if (hasActive) {
                        preservedHirelings = JSON.parse(JSON.stringify(oldP.hirelings));
                    }
                }
                delete gameState.players[oldSid];
                const oldSocket = io.sockets.sockets.get(oldSid);
                if (oldSocket) oldSocket.disconnect(true);
            });

            DB.loadPlayer(token, (savedData) => { 
                if (savedData) { 
                    if (savedData.username !== username) { socket.emit('errorMessage', "Token 資訊不符"); socket.disconnect(true); return; }
                    
                    // 維護模式檢查
                    if (MAINTENANCE_MODE) {
                        if (!MAINTENANCE_WHITELIST.includes(savedData.username)) { socket.emit('errorMessage', " 伺服器維護中，只有管理員可進入！"); socket.disconnect(true); return; } 
                        else { socket.emit('battleLog', `<span style="color:#e74c3c; font-weight:bold;">⚠️ 警告：目前處於維護模式</span>`); }
                    }

                    // ⛔ IP 限制檢查
                    const MAX_IP_CONNECTIONS = 99; 
                    const clientIp = getSocketIp(socket);
                    const sameIpCount = Object.values(gameState.players).filter(p => p.ip === clientIp).length;

                    if (sameIpCount >= MAX_IP_CONNECTIONS) {
                        socket.emit('errorMessage', `❌ 同一 IP 最多只能登入 ${MAX_IP_CONNECTIONS} 個帳號！`);
                        socket.disconnect(true);
                        return;
                    }

                    //  名稱合法性檢查
                    if (typeof isValidName === 'function' && !isValidName(savedData.username)) {
                        console.log(`[Security] 發現非法帳號登入: ${savedData.username}`);
                        savedData.username = `Player_${socket.id.substr(0,4)}`;
                    }

                    let p = savedData; 
                    p.name = savedData.username; 

                    if (typeof getStatsByLevel === 'function') p.baseStats = getStatsByLevel(p.level);
                    if (typeof getMaxExpByLevel === 'function') p.maxExp = getMaxExpByLevel(p.level);

                    if (!p.equipment) p.equipment = { weapon: null, armor: null, acc: null }; 
                    if (!p.inventory) p.inventory = {}; 
                    if (!p.enhancements) p.enhancements = { weapon: 0, armor: 0, acc: 0 };
                    if (!p.durability) p.durability = {};
                    if (!p.skills) p.skills = ['fireball'];
 
                    if (typeof SKILL_CONFIG !== 'undefined') {
                        Object.keys(SKILL_CONFIG).forEach(skillId => {
                            const skill = SKILL_CONFIG[skillId];
                            if (p.level >= skill.level && !p.skills.includes(skillId)) {
                                p.skills.push(skillId);
                            }
                        });
                    }

                    p.id = socket.id; 
                    p.token = token; 
                    p.ip = clientIp; 

                    // ==========================================
                    //  [關鍵修正] 從 daily_quests.json 恢復任務進度
                    // ==========================================
                    try {
                        const fs = require('fs');
                        if (fs.existsSync('daily_quests.json')) {
                            const qData = JSON.parse(fs.readFileSync('daily_quests.json', 'utf8'));
                            if (qData[p.name]) {
                                p.dailyQuests = qData[p.name];
                            }
                        }
                    } catch (e) {
                        console.error("[Daily] 讀取存檔錯誤:", e);
                    }

                    //  初始化/檢查每日任務 (解決重置問題)
                    if (typeof checkDailyReset === 'function') {
                        checkDailyReset(p);
                    }

                    // 讀取彩票紀錄 — 從 LotterySystem 讀取真實數量
                    if (typeof LotterySystem !== 'undefined' && typeof LotterySystem.getPlayerBets === 'function') {
                        const myBets = LotterySystem.getPlayerBets(p.name);
                        p.lotteryCount = Array.isArray(myBets) ? myBets.length : 0;
                    } else {
                        if (p.lotteryCount === undefined) p.lotteryCount = 0;
                    }
                    if (!p.lotteryLastDate) p.lotteryLastDate = "";

                    gameState.players[socket.id] = p; 

                    // ⚡ [修正] 如果有保留的僱員探險數據，優先使用（防止 F5 + DB 延遲導致重置）
                    if (preservedHirelings && preservedHirelings.length > 0) {
                        p.hirelings = preservedHirelings;
                        console.log(`[Hire] ${p.name} 重連，已恢復 ${preservedHirelings.length} 位僱員的探險狀態`);
                    }
                    if (!p.hirelings) p.hirelings = [];

                    // 修正 guildId：從 guildData 反查，避免存入 "undefined" 字串
                    p.guildId = null;
                    for (let gid in guildData) {
                        const g = guildData[gid];
                        if (g.members && g.members.includes(p.name)) {
                            p.guildId = gid;
                            break;
                        }
                    }

                    if (typeof calculateStats === 'function') calculateStats(p); 
                    
                    socket.emit('playerStatsUpdate', gameState.players[socket.id]); 
                    broadcastHubData(); 
                    if (typeof LAST_BOSS_RANKING !== 'undefined') socket.emit('updateHubRanking', LAST_BOSS_RANKING);

                    // ==========================================
                    //  彩票資料獲取
                    // ==========================================
                    if (typeof LotterySystem !== 'undefined') {
                        const lotInfo = LotterySystem.getInfo();
                        const playerBets = LotterySystem.getPlayerBets(p.name);
                        const myLastBets = LotterySystem.getPlayerLastBets(p.name); 

                        socket.emit('lotteryUpdate', { 
                            jackpot: lotInfo.jackpot, 
                            count: lotInfo.totalBets, 
                            lastDraw: lotInfo.lastDraw,
                            isOpen: lotInfo.isOpen,        
                            myBets: playerBets,
                            myLastBets: myLastBets,        
                            dailyCount: p.lotteryCount     
                        });
                    }

                    // ==========================================
                    //  [新增] 檢查並發送暫存通知 (公會獎勵)
                    // ==========================================
                    if (p.pendingNotice) {
                        // 使用 errorMessage 彈窗通知玩家，比較顯眼
                        socket.emit('errorMessage', `【系統通知】\n${p.pendingNotice}`);
                        p.pendingNotice = ""; // 清空通知，避免重複顯示
                    }

                    saveMyData(socket.id); 
                } else { socket.emit('tokenExpired'); socket.disconnect(true); } 
            }); 
        });
    });

    // 1. 獲取好友與申請列表 (修改版：加入未讀數量)
    socket.on('getFriends', () => {
        const player = gameState.players[socket.id];
        if (!player) return;

        // 從 DB 讀取未讀訊息
        DB.getUnreadCounts(player.name, (unreadRows) => {
            // 轉成方便查詢的物件: { 'PlayerA': 3, 'PlayerB': 1 }
            const unreadMap = {};
            unreadRows.forEach(row => unreadMap[row.sender] = row.count);

            const friendList = [];
            const myFriends = player.friends || [];
            
            myFriends.forEach(friendName => {
                const friendSocketId = Object.keys(gameState.players).find(id => gameState.players[id].name === friendName);
                friendList.push({ 
                    name: friendName, 
                    isOnline: !!friendSocketId,
                    unread: unreadMap[friendName] || 0 //  加入未讀數
                });
            });

            const requestList = player.friendRequests || [];

            // 計算總未讀數 (包含非好友傳來的陌生訊息)
            let totalUnread = 0;
            unreadRows.forEach(row => totalUnread += row.count);

            // 回傳好友列表 (含未讀)、申請列表、以及總未讀數
            socket.emit('friendListUpdate', { 
                friends: friendList, 
                requests: requestList,
                totalUnread: totalUnread 
            });
        });
    });

    //  [新增] 標記已讀
    socket.on('markAsRead', (targetName) => {
        const player = gameState.players[socket.id];
        if (!player) return;
        DB.markMessagesAsRead(player.name, targetName);
    });

    // 2. 發送好友申請 (A -> B) [支援離線版]
    socket.on('sendFriendRequest', (targetName) => {
        const player = gameState.players[socket.id];
        if (!player) return;
        if (!player.friends) player.friends = [];

        if (targetName === player.name) {
            socket.emit('errorMessage', "不能加自己！");
            return;
        }
        if (player.friends.includes(targetName)) {
            socket.emit('errorMessage', "對方已經是好友了！");
            return;
        }

        // 搜尋目標是否在線
        const targetId = Object.keys(gameState.players).find(id => gameState.players[id].name === targetName);

        if (targetId) {
            // ---  情況一：對方在線 (Online) ---
            const targetPlayer = gameState.players[targetId];
            if (!targetPlayer.friendRequests) targetPlayer.friendRequests = [];

            // 檢查重複
            if (targetPlayer.friendRequests.includes(player.name)) {
                socket.emit('errorMessage', "你已經發送過申請了！");
                return;
            }
            // 檢查是否已是好友 (雙向保險)
            if (targetPlayer.friends && targetPlayer.friends.includes(player.name)) {
                socket.emit('errorMessage', "你們已經是好友了！");
                return;
            }

            // 加入記憶體
            targetPlayer.friendRequests.push(player.name);
            
            // 通知雙方
            socket.emit('errorMessage', `已發送好友申請給 [${targetName}]`);
            io.to(targetId).emit('battleLog', `<span style="color:#f1c40f">收到 [${player.name}] 的好友申請！</span>`);
            io.to(targetId).emit('updateFriendListRequest'); // 讓對方看到紅點
            
            // 存檔
            saveMyData(targetId);

        } else {
            // ---  情況二：對方離線 (Offline) ---
            // 呼叫 DB 直接寫入
            DB.addOfflineFriendRequest(player.name, targetName, (result) => {
                if (result.success) {
                    socket.emit('errorMessage', result.msg); // 顯示成功訊息
                } else {
                    socket.emit('errorMessage', result.msg); // 顯示錯誤 (如無此人)
                }
            });
        }
    });

    // 3. 處理好友申請 (B 接受/拒絕 A) - [支援離線接受版]
    socket.on('handleFriendRequest', (data) => {
        const player = gameState.players[socket.id]; // 我是 B (在線)
        if (!player) return;

        const requesterName = data.requesterName; // 對方是 A (可能離線)
        
        // 1. 先處理 B 自己 (我) 的數據
        // 從申請列表中移除
        if (!player.friendRequests) player.friendRequests = [];
        player.friendRequests = player.friendRequests.filter(n => n !== requesterName);

        // 如果是拒絕
        if (data.action === 'reject') {
            socket.emit('errorMessage', `已拒絕 [${requesterName}]`);
            socket.emit('updateFriendListRequest');
            saveMyData(socket.id); 
            return;
        }

        // === 接受邏輯 ===
        
        // 2. 把 A 加入 B (我) 的好友列表
        if (!player.friends) player.friends = [];
        if (!player.friends.includes(requesterName)) player.friends.push(requesterName);

        // 3. 處理 A (對方) 的數據
        // 先檢查 A 是否在線
        const targetId = Object.keys(gameState.players).find(id => gameState.players[id].name === requesterName);
        
        if (targetId) {
            // ---  情況一：對方 (A) 在線 ---
            const targetPlayer = gameState.players[targetId];
            if (!targetPlayer.friends) targetPlayer.friends = [];
            
            // 把 B 加入 A 的好友
            if (!targetPlayer.friends.includes(player.name)) {
                targetPlayer.friends.push(player.name);
            }
            
            // 雙向移除申請 (避免重複)
            if (targetPlayer.friendRequests) {
                targetPlayer.friendRequests = targetPlayer.friendRequests.filter(n => n !== player.name);
            }

            // 通知 A
            io.to(targetId).emit('battleLog', `<span style="color:#2ecc71">[${player.name}] 接受了你的好友申請！</span>`);
            io.to(targetId).emit('updateFriendListRequest'); // 刷新 A 的介面
            saveMyData(targetId); // 存 A 的檔

        } else {
            // ---  情況二：對方 (A) 離線 ---
            // 必須直接修改 users.json (假設你的存檔檔名是 users.json)
            const fs = require('fs');
            const DATA_FILE = 'users.json'; 

            try {
                if (fs.existsSync(DATA_FILE)) {
                    // 1. 讀取所有存檔
                    let usersData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
                    
                    // 2. 尋找 A 的資料 (遍歷所有 ID)
                    let targetUserKey = Object.keys(usersData).find(key => usersData[key].name === requesterName);
                    
                    if (targetUserKey) {
                        let offlineA = usersData[targetUserKey];
                        
                        // 初始化欄位
                        if (!offlineA.friends) offlineA.friends = [];
                        
                        // 3. 把 B 加入 A 的好友
                        if (!offlineA.friends.includes(player.name)) {
                            offlineA.friends.push(player.name);
                        }
                        
                        // 4. 寫回硬碟
                        fs.writeFileSync(DATA_FILE, JSON.stringify(usersData, null, 2));
                        console.log(`[好友系統] 離線修改: 已將 ${player.name} 加入 ${requesterName} 的好友列表`);
                    } else {
                        socket.emit('errorMessage', "系統錯誤：找不到對方的存檔資料。");
                    }
                }
            } catch (err) {
                console.error("讀取離線存檔失敗:", err);
            }
        }

        // 4. 完成 B 自己的存檔與通知
        socket.emit('battleLog', `<span style="color:#2ecc71">與 [${requesterName}] 成為了好友！</span>`);
        socket.emit('updateFriendListRequest'); // 刷新 B 的介面
        saveMyData(socket.id); // 存 B 的檔
    });

    // 4. 刪除好友
    socket.on('removeFriend', (targetName) => {
        const player = gameState.players[socket.id];
        if (!player || !player.friends) return;

        player.friends = player.friends.filter(name => name !== targetName);
        
        // 也要刪除對方的 (如果對方在線)
        const targetId = Object.keys(gameState.players).find(id => gameState.players[id].name === targetName);
        if (targetId) {
            const targetPlayer = gameState.players[targetId];
            if (targetPlayer.friends) {
                targetPlayer.friends = targetPlayer.friends.filter(name => name !== player.name);
                io.to(targetId).emit('battleLog', `<span style="color:#e74c3c">[${player.name}] 解除了好友關係。</span>`);
                io.to(targetId).emit('updateFriendListRequest');
                saveMyData(targetId);
            }
        }

        socket.emit('battleLog', `<span style="color:#e74c3c">已刪除好友 [${targetName}]</span>`);
        socket.emit('updateFriendListRequest');
        saveMyData(socket.id);
    });

    // ==========================================
// ️ [修改 Socket 事件]
// ==========================================

    // 5. 私訊功能 (無限制版)
    socket.on('privateMessage', (data) => {
        const player = gameState.players[socket.id];
        if (!player) return;

        const targetName = data.targetName;
        let msg = data.msg; 

        // 1. 檢查是否為空
        if (!msg || typeof msg !== 'string' || msg.trim().length === 0) {
            return;
        }

        // 2. 檢查長度限制 (保留此限制以防惡意洗頻)
        if (msg.length > 200) {
            socket.emit('errorMessage', "訊息太長了 (上限 200 字)！");
            return;
        }

        // 3. 檢查隱藏字元
        if (hasForbiddenChars(msg)) {
            socket.emit('errorMessage', "發送失敗：包含非法隱藏字元！");
            return;
        }

        // 4. HTML 轉義
        msg = escapeHtml(msg); 

        // --- 發送邏輯 ---

        // A. 產生伺服器時間戳
        const timestamp = Date.now();
        
        // B. 存入資料庫
        DB.logPrivateMessage(player.name, targetName, msg);

        // C. 傳送給自己 (顯示在自己的視窗)
        socket.emit('receivePrivateChat', { 
            fromName: player.name,
            targetName: targetName,
            msg: msg,
            time: timestamp
        });
        
        // 相容舊寫法
        socket.emit('privateMessageUpdate', {
            sender: player.name,
            receiver: targetName,
            msg: msg,
            isSelf: true,
            timestamp: timestamp
        });

        // D. 傳送給對方
        const targetId = Object.keys(gameState.players).find(id => gameState.players[id].name === targetName);
        
        if (targetId) {
            io.to(targetId).emit('receivePrivateChat', {
                fromName: player.name,
                msg: msg,
                time: timestamp
            });

            io.to(targetId).emit('privateMessageUpdate', {
                sender: player.name, 
                receiver: targetName,
                msg: msg,
                isSelf: false,
                timestamp: timestamp 
            });
            
            io.to(targetId).emit('updateFriendListRequest'); 
            io.to(targetId).emit('pmNotification', player.name);
        }
    });

    // 取得歷史訊息
    socket.on('getPrivateHistory', async (targetName) => {
        const player = gameState.players[socket.id];
        if (!player) return;

        // 呼叫 DB 函式
        const history = await DB.getPrivateHistory(player.name, targetName);
        
        // 傳送給前端 (history 陣列裡現在應該有 [{sender, message, created_at}, ...])
        socket.emit('privateHistoryUpdate', { 
            targetName: targetName, 
            history: history 
        });
    });
    
    // --- 好友系統 (確認制) ---

    // 強化裝備 (支援防爆石)
    // 強化裝備 (修正版：防爆石限制 +19)
    socket.on('enhanceItem', (data) => {
        const p = gameState.players[socket.id];
        if (!p) return;

        // 1. 解析參數
        let slot = '';
        let useSafeStone = false;

        let useShardPay = false;
        if (typeof data === 'string') {
            slot = data;
        } else {
            slot = data.slot;
            useSafeStone = data.useSafeStone;
            useShardPay = data.useShardPay || false;
        }
        
        const itemId = p.equipment[slot]; 
        if (!itemId) { socket.emit('errorMessage', "該部位沒有裝備！"); return; }

        if (!p.enhancements) p.enhancements = {};
        
        const currentLv = p.enhancements[itemId] || 0;
        const nextLv = currentLv + 1;

        if (nextLv > 30) { socket.emit('errorMessage', "已達強化上限 (+30)！"); return; }

        const config = ENHANCE_RATES[nextLv];
        const itemName = ITEM_CONFIG[itemId].name;

        // 2. 檢查費用（金幣或碎片）
        if (useShardPay) {
            const shardNeed = Math.ceil(config.cost * SHARD_TO_GOLD_RATE);
            if ((p.inventory['skill_shard'] || 0) < shardNeed) {
                socket.emit('errorMessage', `碎片不足！需要 ${shardNeed} 塊技能碎片`);
                return;
            }
        } else if (p.gold < config.cost) {
            socket.emit('errorMessage', `金幣不足 (需要 ${config.cost})`);
            return;
        }

        // ==============================================
        // 3. 分支邏輯：使用防爆石 VS 普通強化
        // ==============================================
        if (useSafeStone) {
            // --- 【A. 防爆石流程】 ---

            //  [新增限制] 防爆石無法強化到 +20
            if (nextLv >= 24) {
                socket.emit('errorMessage', "⛔ 防爆石最多只能強化至 +23！\n（+24須使用強化石挑戰極限！");
                return;
            }
            
            // 檢查有沒有防爆石
            if (!p.inventory['safe_stone'] || p.inventory['safe_stone'] < 1) {
                socket.emit('errorMessage', "你沒有防爆石！");
                return;
            }

            // 扣除費用（金幣或碎片）
            const safePayResult = payAmount(p, config.cost, useShardPay);
            if (!safePayResult.ok) {
                const need = useShardPay ? `${Math.ceil(config.cost * SHARD_TO_GOLD_RATE)} 碎片` : `${config.cost} 金幣`;
                socket.emit('errorMessage', `費用不足！需要 ${need}`);
                return;
            }
            p.inventory['safe_stone']--;
            if (p.inventory['safe_stone'] <= 0) delete p.inventory['safe_stone'];

            // 強制成功
            p.enhancements[itemId] = nextLv;
            
            socket.emit('enhanceResult', { 
                success: true, 
                msg: ` [防爆] 強化成功！[${itemName}] 升級至 +${nextLv}`, 
                lv: nextLv 
            });

            // 公告
            if (nextLv >= 10) { 
                io.emit('chatMessage', { name: '系統', msg: ` 土豪 [${p.name}] 使用防爆石，將 [${itemName}] 穩穩衝上了 +${nextLv}！` }); 
            }

        } else {
            // --- 【B. 普通強化流程】 ---

            // 檢查有沒有強化石
            if (!p.inventory['enhance_stone'] || p.inventory['enhance_stone'] < 1) {
                socket.emit('errorMessage', "缺少強化石！");
                return;
            }

            // 扣除消耗品
            payAmount(p, config.cost, useShardPay);
            p.inventory['enhance_stone']--;
            if (p.inventory['enhance_stone'] <= 0) delete p.inventory['enhance_stone'];

            // 擲骰子
            const roll = Math.random();

            if (roll < config.rate) {
                // --- 成功 ---
                p.enhancements[itemId] = nextLv;
                socket.emit('enhanceResult', { success: true, msg: ` 強化成功！[${itemName}] 升級至 +${nextLv}`, lv: nextLv });
                
                if (nextLv >= 7) { 
                    io.emit('chatMessage', { name: '系統', msg: `✨ 恭喜 [${p.name}] 運氣爆棚，將 [${itemName}] 強化至 +${nextLv}！` }); 
                }
            } 
            else {
                // --- 失敗 ---
                if (config.risk === 'drop') {
                    // 倒退
                    const dropLv = Math.max(0, currentLv - 1);
                    p.enhancements[itemId] = dropLv;
                    socket.emit('enhanceResult', { success: false, msg: ` 強化失敗.. 等級倒退至 +${dropLv}`, lv: dropLv });
                } 
                else if (config.risk === 'break') {
                    // 破碎
                    p.equipment[slot] = null;
                    p.enhancements[itemId] = 0; 
                    socket.emit('enhanceResult', { success: false, msg: `☠️ 強化失敗！[${itemName}] 承受不住力量而破碎了...`, lv: 0, broken: true });
                    io.emit('chatMessage', { name: '系統', msg: ` 悲報.. [${p.name}] 在強化 +${nextLv} 時失敗，[${itemName}] 化為了粉塵...` });
                } 
                else {
                    // 無事發生
                    socket.emit('enhanceResult', { success: false, msg: "強化失敗，但裝備安然無恙。", lv: currentLv });
                }
            }
        }

        // 4. 更新數值與存檔
        calculateStats(p);
        socket.emit('playerStatsUpdate', p);
        saveMyData(socket.id);
    });

    socket.on('adminSpawnWorldBoss', (data) => {
        if (data.password !== process.env.ADMIN_PASSWORD) return;
        startWorldBossEvent();
    });


    //  [Admin] 查詢彩票超額玩家 (讀取 lottery_data.json 版本)
    socket.on('adminGetLotteryStats', (data) => {
        // 1. 驗證密碼
        if (!data || data.adminPass !== process.env.ADMIN_PASSWORD) {
            socket.emit('errorMessage', "❌ 管理員密碼錯誤");
            return;
        }

        //  2. 指向 lottery_data.json
        const FILE_PATH = path.join(__dirname, 'lottery_data.json');
        
        console.log(`[Admin] 正在掃描彩票池: ${FILE_PATH}`); 

        if (!fs.existsSync(FILE_PATH)) {
            socket.emit('adminLotteryResult', { success: false, msg: "找不到彩票檔案" });
            return;
        }

        try {
            const raw = fs.readFileSync(FILE_PATH, 'utf8');
            const lotteryData = JSON.parse(raw);
            const bets = lotteryData.bets || [];
            
            //  3. 統計每個人買了幾張
            let playerCounts = {};

            bets.forEach(bet => {
                if (bet.name) {
                    playerCounts[bet.name] = (playerCounts[bet.name] || 0) + 1;
                }
            });

            //  4. 篩選出超過 10 張的人
            let violators = [];
            const today = new Date().toLocaleDateString();

            for (const [name, count] of Object.entries(playerCounts)) {
                if (count > 10) {
                    violators.push({
                        name: name,
                        count: count,
                        date: "本期", // 因為是在彩票池內，一定是本期
                        isToday: true 
                    });
                }
            }

            // 排序
            violators.sort((a, b) => b.count - a.count);

            socket.emit('adminLotteryResult', { success: true, list: violators });

        } catch (e) {
            console.error("Admin 查詢失敗:", e);
            socket.emit('adminLotteryResult', { success: false, msg: "讀取失敗: " + e.message });
        }
    });

// ==========================================
    //  [Admin] 取得線上玩家列表 (修復版)
    // ==========================================
    socket.on('adminGetOnlinePlayers', (data) => {
        console.log(`[Admin] 收到查詢請求 (來自: ${socket.id})`); // 1. 確認收到請求

        // 檢查密碼
        if (!data || data.adminPass !== process.env.ADMIN_PASSWORD) {
            console.log(`[Admin] 密碼驗證失敗`);
            socket.emit('errorMessage', "❌ 管理員密碼錯誤");
            return;
        }

        // 檢查 gameState 是否存在
        if (typeof gameState === 'undefined' || !gameState.players) {
            console.error("[Admin Error] gameState 未定義！");
            socket.emit('errorMessage', "❌ 伺服器內部錯誤");
            return;
        }

        try {
            // 整理線上玩家數據
            const list = Object.values(gameState.players).map(p => ({
                id: p.id,
                name: p.name,
                ip: p.ip || '未知', // 確保有 IP
                level: p.level,
                gold: p.gold
            }));

            console.log(`[Admin] 成功讀取，目前線上: ${list.length} 人`); // 2. 確認回傳數量
            socket.emit('adminOnlineList', list);

        } catch (err) {
            console.error("[Admin Error] 處理列表時發生錯誤:", err);
            socket.emit('errorMessage', "❌ 處理數據失敗");
        }
    });

//  [新增/補回] Ban 帳號 (封鎖特定 Username)
    socket.on('adminBanAccount', (data) => {
        const { adminPass, targetName, reason, duration } = data;
        if (adminPass !== process.env.ADMIN_PASSWORD) { 
            socket.emit('adminResult', { success: false, msg: "❌ 密碼錯誤" }); 
            return; 
        }

        BanSystem.banAccount(targetName, reason, parseInt(duration));

        // 踢人邏輯 (保持原本的)
        const sockets = io.sockets.sockets;
        let count = 0;
        for (const [sid, s] of sockets) {
            const p = gameState.players[sid];
            if (p && p.name === targetName) {
                s.emit('forceLogout', `⛔ 你的帳號已被 GM 封鎖！\n原因: ${reason}`);
                s.disconnect(true);
                count++;
            }
        }

        socket.emit('adminResult', { success: true, msg: `✅ 已封鎖帳號 [${targetName}]` });
        //  [新增] 刷新前端的帳號封鎖列表
        socket.emit('adminAccountBanList', BanSystem.getAllAccountBans());
    });

//  [新增] 解封帳號 (Unban Account)
    socket.on('adminUnbanAccount', (data) => {
        const { adminPass, targetName } = data;
        if (adminPass !== process.env.ADMIN_PASSWORD) return;

        if (BanSystem.unbanAccount(targetName)) {
            socket.emit('adminResult', { success: true, msg: `✅ 已解封帳號 [${targetName}]` });
        } else {
            socket.emit('adminResult', { success: false, msg: "❌ 該帳號未被封鎖" });
        }
        // 刷新列表
        socket.emit('adminAccountBanList', BanSystem.getAllAccountBans());
    });

	
	//  [新增] Admin 設定彩票開關
    socket.on('adminSetLotteryState', (data) => {
        const { password, isOpen } = data; // admin.html 傳過來的是 password
        // 注意：這裡前端是用 password，後端驗證要對應
        if (password !== process.env.ADMIN_PASSWORD) {
            socket.emit('adminResult', { success: false, msg: "❌ 密碼錯誤" });
            return;
        }

        const newState = LotterySystem.setState(isOpen);
        const stateText = newState ? "開啟" : "關閉";
        
        socket.emit('adminResult', { success: true, msg: `✅ 彩票系統已${stateText}` });
        
        // 廣播給所有玩家更新介面 (如果是關閉，玩家就買不了了)
        const info = LotterySystem.getInfo();
        io.emit('lotteryUpdate', {
            jackpot: info.jackpot,
            count: info.totalBets,
            lastDraw: info.lastDraw,
            isOpen: info.isOpen // 確保前端有處理這個
        });
    });
    
    //  [新增] Admin 手動開獎
    socket.on('adminDrawLottery', (data) => {
        const { adminPass } = data;
        if (adminPass !== process.env.ADMIN_PASSWORD) {
            socket.emit('adminResult', { success: false, msg: "❌ 密碼錯誤" });
            return;
        }

        // 呼叫 server.js 內部的 drawLottery 函式 (這個函式會去呼叫 LotterySystem)
        // 確保你在 server.js 下方有定義 function drawLottery()
        if (typeof drawLottery === 'function') {
            drawLottery(); 
            socket.emit('adminResult', { success: true, msg: "✅ 已執行手動開獎！" });
        } else {
            socket.emit('adminResult', { success: false, msg: "❌ 系統錯誤：找不到開獎函式" });
        }
    });
	
//  [修正] Admin 獲取 IP 封鎖名單
    socket.on('adminGetBans', (data) => {
        const { adminPass } = data;
        if (adminPass !== process.env.ADMIN_PASSWORD) return;
        
        if (typeof BanSystem !== 'undefined') {
            // 1. 回傳 IP 封鎖名單
            socket.emit('adminBanList', BanSystem.getAllIpBans());
            // 2. [新增] 回傳 帳號 封鎖名單
            socket.emit('adminAccountBanList', BanSystem.getAllAccountBans());
        }
    });

    //  [修正] Admin 執行封鎖 (Ban IP)
    socket.on('adminBanIP', (data) => {
        const { adminPass, targetIp, reason, duration } = data;
        if (adminPass !== process.env.ADMIN_PASSWORD) {
            socket.emit('adminResult', { success: false, msg: "❌ 密碼錯誤" });
            return;
        }
        
        //  修正：使用 banIp()
        BanSystem.banIp(targetIp, reason, parseInt(duration));
        
        // 踢出該 IP 目前所有連線
        const sockets = io.sockets.sockets;
        let count = 0;
        for (const [sid, s] of sockets) {
            const sIp = getSocketIp(s);
            if (sIp === targetIp) {
                s.emit('forceLogout', `⛔ 你的 IP 已被 GM 封鎖！\n原因: ${reason}`);
                s.disconnect(true);
                count++;
            }
        }

        socket.emit('adminResult', { success: true, msg: `✅ 已封鎖 IP [${targetIp}]，踢出了 ${count} 個連線` });
        
        //  修正：刷新列表時也用 getAllIpBans()
        socket.emit('adminBanList', BanSystem.getAllIpBans());
    });

    //  [修正] Admin 解除封鎖 (Unban IP)
    socket.on('adminUnbanIP', (data) => {
        const { adminPass, targetIp } = data;
        if (adminPass !== process.env.ADMIN_PASSWORD) return;

        //  修正：使用 unbanIp()
        if (BanSystem.unbanIp(targetIp)) {
            socket.emit('adminResult', { success: true, msg: `✅ 已解封 IP [${targetIp}]` });
        } else {
            socket.emit('adminResult', { success: false, msg: "❌ 該 IP 未被封鎖" });
        }
        
        //  修正：刷新列表時也用 getAllIpBans()
        socket.emit('adminBanList', BanSystem.getAllIpBans());
    });


//  [新增] Admin 查詢玩家 IP
    socket.on('adminGetPlayerIp', (data) => {
        const { adminPass, targetName } = data;
        
        // 1. 驗證密碼
        if (adminPass !== process.env.ADMIN_PASSWORD) { 
            socket.emit('adminResult', { success: false, msg: "❌ 管理員密碼錯誤" }); 
            return; 
        }

        // 2. 搜尋線上玩家
        const targetSocketId = Object.keys(gameState.players).find(sid => gameState.players[sid].name === targetName);

        if (targetSocketId) {
            const p = gameState.players[targetSocketId];
            // 回傳查詢結果
            socket.emit('adminResult', { 
                success: true, 
                msg: ` 查詢結果:\n玩家: ${p.name}\n狀態:  在線\nIP: ${p.ip || '未知'}\nSocketID: ${p.id}` 
            });
        } else {
            // 如果不在線上
            socket.emit('adminResult', { 
                success: false, 
                msg: `⚠️ 玩家 [${targetName}] 目前不在線上 (無法查詢即時 IP)` 
            });
        }
    });

    socket.on('joinWorldBoss', () => {
        const p = gameState.players[socket.id];
        if (!p) return;
        if (!WORLD_BOSS.active) { socket.emit('errorMessage', "BOSS 已經被擊敗或尚未出現！"); return; }
        if (!WORLD_BOSS.players.includes(socket.id)) { WORLD_BOSS.players.push(socket.id); }
        socket.emit('roomJoined', { roomId: 'world_boss' });
    });

    //  [完整修正版] World Boss 動作處理 (包含所有技能升級邏輯)
    socket.on('worldBossAction', (data) => {
        // 1. 頻率限制
        if (!checkRateLimit(socket.id, 'combat', 500)) return;
        
        // 2. 檢查 BOSS 狀態
        if (!WORLD_BOSS || !WORLD_BOSS.active) return;
        
        const p = gameState.players[socket.id];
        if (!p || p.hp <= 0) return; 

        let damage = 0;
        let logMsg = "";
        
        //  計算有效攻擊力 (含 Buff 與 技能等級加成)
        let effectiveAtk = p.atk;
        
        if (p.tempBuffs) {
            // 狂暴 (基礎 2.0)
            if (p.tempBuffs.berserk) {
                effectiveAtk = Math.floor(p.atk * 2.0);
                p.tempBuffs.berserk--;
                if(p.tempBuffs.berserk <= 0) delete p.tempBuffs.berserk;
            }
            
            // 天神下凡 (動態倍率)
            if (p.tempBuffs.god) {
                // 讀取天神下凡技能等級
                const godLv = (p.skillLevels && p.skillLevels['god_mode']) ? p.skillLevels['god_mode'] : 1;
                // 計算倍率: 基礎 3.0 + 每級 10%
                const godMult = 3.0 * (1 + (godLv - 1) * 0.1);
                
                effectiveAtk = Math.floor(effectiveAtk * godMult);
                
                p.tempBuffs.god--;
                if(p.tempBuffs.god <= 0) delete p.tempBuffs.god;
            }
        }

        // 3. 執行動作
        if (data.type === 'attack') {
            damage = Math.floor(effectiveAtk * (1.0 + Math.random() * 0.2)); 
            WORLD_BOSS.hp -= damage;
            logMsg = `<span style="color:#f1c40f">你攻擊了 BOSS，造成 ${damage.toLocaleString()} 傷害！</span>`;
        } 
        else if (data.type === 'skill') {
            const skill = SKILL_CONFIG[data.skillId];
            if (!skill || !p.skills.includes(data.skillId)) return;
            
            if (p.mp < skill.mp) { 
                socket.emit('battleLog', `<span style="color:#aaa;">MP 不足...</span>`); 
                return; 
            }
            p.mp -= skill.mp;

            //  [核心] 計算技能等級倍率
            const skillLv = (p.skillLevels && p.skillLevels[data.skillId]) ? p.skillLevels[data.skillId] : 1;
            const levelMultiplier = 1 + (skillLv - 1) * 0.1; // 每級 +10%
            const lvMsg = skillLv > 1 ? ` <span style="font-size:10px; color:#f39c12;">(Lv.${skillLv})</span>` : "";

            // 一般傷害技能 (包含單體與 AOE，打 Boss 時效果一樣)
            if (['dmg', 'dot', 'stun', 'debuff', 'aoe'].includes(skill.type)) {
                // 乘上 levelMultiplier
                damage = Math.floor(effectiveAtk * skill.val * levelMultiplier);
                WORLD_BOSS.hp -= damage;
                logMsg = `<span style="color:#9b59b6; font-weight:bold;">${p.name} 施放 ${skill.name}${lvMsg}! 轟出 ${damage.toLocaleString()} 傷害!</span>`;
            }
            // 真實傷害 (熱寂·衰變 & 單體真傷)
            else if (['percent_dmg', 'aoe_percent'].includes(skill.type)) {
                // 原始傷害 (BOSS 血量百分比 * 倍率)
                let rawDmg = Math.floor(WORLD_BOSS.maxHp * skill.val * levelMultiplier);
                
                //  動態上限: 基礎 50倍 + 每級 5倍 (Lv.10 = 95倍)
                let capMult = 50 + (skillLv - 1) * 5;
                let cap = effectiveAtk * capMult; 
                
                if (rawDmg > cap) rawDmg = cap; 
                damage = rawDmg;
                
                WORLD_BOSS.hp -= damage;
                logMsg = `<span style="color:#e67e22; font-weight:bold;">${p.name} 施放 ${skill.name}${lvMsg}! 造成 ${damage.toLocaleString()} 真實傷害!</span>`;
            }
            // 治療
            else if (skill.type === 'heal') {
                // 乘上 levelMultiplier
                let healAmount = Math.floor(p.maxHp * skill.val * levelMultiplier);
                p.hp = Math.min(p.maxHp, p.hp + healAmount);
                logMsg = `<span style="color:#2ecc71">你施放了 ${skill.name}${lvMsg}，恢復 ${healAmount.toLocaleString()} HP</span>`;
            }
            // 全回覆 (不吃倍率，固定全滿)
            else if (skill.type === 'heal_all' || skill.type === 'full_heal') {
                p.hp = p.maxHp;
                logMsg = `<span style="color:#2ecc71; font-weight:bold;">✨ ${skill.name}! 你的狀態已完全恢復!</span>`;
            }
            // 吸血
            else if (skill.type === 'drain') {
                // 乘上 levelMultiplier
                damage = Math.floor(effectiveAtk * skill.val * levelMultiplier);
                WORLD_BOSS.hp -= damage;
                let heal = Math.floor(damage * 0.5); 
                p.hp = Math.min(p.maxHp, p.hp + heal);
                logMsg = `<span style="color:#e74c3c">你吸取了 BOSS 生命! (${damage.toLocaleString()}傷, +${heal.toLocaleString()}HP)${lvMsg}</span>`;
            }
            // 防禦 Buff
            else if (skill.type === 'buff') {
                if (!p.tempBuffs) p.tempBuffs = {};
                // 回合數隨等級提升 (每5級+1回合)
                let duration = 3 + Math.floor((skillLv - 1) / 5);
                p.tempBuffs.def = duration; 
                logMsg = `<span style="color:#f1c40f">聖光守護${lvMsg}! 防禦力大幅提升 (${duration}回合)!</span>`;
            }
            // 攻擊 Buff
            else if (skill.type === 'buff_atk') {
                if (!p.tempBuffs) p.tempBuffs = {};
                // 回合數隨等級提升
                let duration = 3 + Math.floor((skillLv - 1) / 5);
                p.tempBuffs.berserk = duration; 
                p.hp = Math.floor(p.hp * 0.8); 
                logMsg = `<span style="color:#c0392b">狂暴狀態${lvMsg}! 攻擊力倍增 (${duration}回合)，但犧牲了生命!</span>`;
            }
            // 天神下凡
            else if (skill.type === 'god') {
                if (!p.tempBuffs) p.tempBuffs = {};
                // 回合數隨等級提升
                let duration = 3 + Math.floor((skillLv - 1) / 5);
                p.tempBuffs.god = duration; 
                p.hp = p.maxHp; 
                
                // 計算顯示用的倍率 (只是顯示用，實際效果在下次攻擊時計算)
                let displayMult = (3.0 * levelMultiplier).toFixed(1);
                logMsg = `<span style="color:#f1c40f; font-weight:bold;">天神下凡${lvMsg}! 狀態全滿，攻防 ${displayMult}倍 (${duration}回合)!</span>`;
            }
        }
        else if (data.type === 'item') {
            const itemId = data.itemId;
            // 檢查是否有該物品
            if (!p.inventory[itemId] || p.inventory[itemId] <= 0) return;
            
            // 扣除物品
            p.inventory[itemId]--;
            if (p.inventory[itemId] === 0) delete p.inventory[itemId];
            
            let itemEffect = "使用了物品";
            if (['potion_hp', 'potion_mid', 'potion_high', 'potion_max', 'elixir', 'grilled_carp', 'tuna_steak', 'sushi_plate', 'eel_rice', 'void_soup'].includes(itemId)) {
                let h = 0;
                if (itemId === 'potion_hp') h = 50;
                else if (itemId === 'potion_mid') h = 500;
                else if (itemId === 'potion_high') h = 2000;
                else if (itemId === 'potion_max') h = 10000;
                else if (itemId === 'elixir' || itemId === 'void_soup') { p.hp = p.maxHp; p.mp = p.maxMp; itemEffect = "HP/MP 全滿"; }
                else if (itemId === 'grilled_carp') h = 100;
                else if (itemId === 'tuna_steak' || itemId === 'sushi_plate') h = 500;
                else if (itemId === 'eel_rice') { h = 300; p.mp = Math.min(p.maxMp, p.mp+100); }
                
                if (h > 0) { p.hp = Math.min(p.maxHp, p.hp + h); itemEffect = `恢復 ${h} HP`; }
            } 
            else if (['potion_mp', 'potion_mp_mid', 'potion_mp_high', 'salmon_sushi'].includes(itemId)) {
                let m = 0;
                if (itemId === 'potion_mp') m = 30;
                else if (itemId === 'potion_mp_mid') m = 100;
                else if (itemId === 'potion_mp_high') m = 500;
                else if (itemId === 'salmon_sushi') m = 50;
                
                if (m > 0) { p.mp = Math.min(p.maxMp, p.mp + m); itemEffect = `恢復 ${m} MP`; }
            }
            logMsg = `<span style="color:#e67e22">${p.name} 使用了 ${ITEM_CONFIG[itemId] ? ITEM_CONFIG[itemId].name : itemId}! ${itemEffect}</span>`;
        }

        // 4. 結算與更新
        if (WORLD_BOSS.hp < 0) WORLD_BOSS.hp = 0;
        
        if (damage > 0) {
            if (!WORLD_BOSS.damageLog) WORLD_BOSS.damageLog = {};
            if (!WORLD_BOSS.damageLog[socket.id]) WORLD_BOSS.damageLog[socket.id] = 0;
            WORLD_BOSS.damageLog[socket.id] += damage;
        }

        socket.emit('battleLog', logMsg); 
        socket.emit('playerStatsUpdate', p);
        
        // 廣播 Boss 狀態 (只給在 Boss 房的人)
        io.to('world_boss_room').emit('worldBossSync', getBossData());

        if (WORLD_BOSS.hp <= 0) { 
             if (typeof endWorldBoss === 'function') {
                 endWorldBoss(true); 
             }
        }
    });

    socket.on('connectToBossRoom', () => {
        socket.join('world_boss_room');
        if (WORLD_BOSS.active && !WORLD_BOSS.players.includes(socket.id)) {
            WORLD_BOSS.players.push(socket.id);
        }
        socket.emit('worldBossSync', getBossData());
    });

    socket.on('sendChat', (data) => {
        if (!checkRateLimit(socket.id, 'chat', 1000)) { socket.emit('errorMessage', "發言速度太快，請稍歇。"); return; }
        
        const player = gameState.players[socket.id];
        // 兼容舊格式 (msg 字串) 及新格式 ({ msg, roomId })
        const msg = (typeof data === 'string') ? data : data.msg;
        const roomId = (typeof data === 'object') ? data.roomId : null;

        if (player && msg && msg.trim().length > 0) {
            const name = player.name;
            
            let content = msg.substring(0, 50);
            content = content.replace(/&/g, "&amp;")
                             .replace(/</g, "&lt;")
                             .replace(/>/g, "&gt;")
                             .replace(/"/g, "&quot;")
                             .replace(/'/g, "&#039;");
            
            const chatObj = { 
                id: player.id, 
                name: name, 
                msg: content,
                rebirth: player.rebirth || 0
            };

            // 房間對話：唔寫入公頻 DB，只 emit 俾房間內玩家
            if (roomId && gameState.battleRooms[roomId]) {
                const battleRoom = gameState.battleRooms[roomId];
                battleRoom.players.forEach(pid => {
                    io.to(pid).emit('chatMessage', { ...chatObj, isRoomChat: true });
                });
            } else {
                // 公頻對話：寫入 DB 並全服廣播
                DB.logChat(name, content);
                io.emit('chatMessage', chatObj);
            }
        }
    });

    socket.on('getGatherNodes', () => { socket.emit('gatherNodeList', GATHER_CONFIG); });

    socket.on('useItem', (itemId) => {
        const p = gameState.players[socket.id];
        if (!p) return;
        if (!p.inventory[itemId] || p.inventory[itemId] <= 0) { socket.emit('errorMessage', "你沒有這個物品！"); return; }

        if (itemId === 'lucky_bag') {
            p.inventory[itemId]--;
            if (p.inventory[itemId] <= 0) delete p.inventory[itemId];

            const baseValue = 1000000000; 
            const randomFactor = 0.5 + Math.random(); 
            let targetValue = Math.floor(baseValue * randomFactor);
            
            let rewards = [];
            const POOLS = {
                // S級 (極稀有) - 新增神格
                S: [
                	{ id: 'safe_stone', value: 850000000, name: '防爆石' },
                    { id: 'entropy_origin', value: 10000000, name: '熱寂原點' },
                    { id: 'divinity_core',  value: 5000000,  name: '創世神格' }, //  新增
                    { id: 'dimension_gem',  value: 300000,   name: '維度寶石' },
                    { id: 'time_sand',      value: 150000,   name: '時光之沙' }
                ],
                // A級 (稀有) - 新增碎片
                A: [
                    { id: 'multiverse_shard', value: 150000, name: '多元宇宙碎片' }, //  新增
                    { id: 'cosmic_steel',   value: 80000,    name: '宇宙鋼' },
                    { id: 'star_core',      value: 60000,    name: '恆星核心' },
                    { id: 'dark_matter',    value: 25000,    name: '暗物質' },
                    { id: 'void_shard',     value: 15000,    name: '虛空碎片' },
                    { id: 'titan_steel',    value: 8000,     name: '泰坦神鋼' },
                    { id: 'star_fragment',  value: 10000,    name: '星之碎片' },
                    { id: 'chaos_orb',      value: 5000,     name: '混沌寶珠' },
                    { id: 'god_blood',      value: 3000,     name: '神之血' },
                    { id: 'angel_feather',  value: 4000,     name: '天使之羽' }
                ],
                // B級 (普通) - 新增殘渣
                B: [
                    { id: 'quantum_residue', value: 40000,   name: '量子殘渣' }, //  新增
                    { id: 'elixir',         value: 20000,    name: '神之甘露' },
                    { id: 'potion_max',     value: 5000,     name: '特級秘藥' },
                    { id: 'void_soup',      value: 1000000,  name: '虛空海鮮湯' },
                    { id: 'adamantite',     value: 2000,     name: '精金' },
                    { id: 'dark_essence',   value: 800,      name: '暗之精華' },
                    { id: 'demon_horn',     value: 600,      name: '惡魔之角' },
                    { id: 'mithril',        value: 500,      name: '秘銀' },
                    { id: 'diamond',        value: 500,      name: '鑽石' },
                    { id: 'void_dust',      value: 400,      name: '虛空之塵' },
                    { id: 'dragon_scale',   value: 300,      name: '龍鱗' },
                    { id: 'gold_ore',       value: 200,      name: '金礦石' },
                    { id: 'ruby',           value: 200,      name: '紅寶石' },
                    { id: 'yeti_fur',       value: 180,      name: '雪怪毛皮' },
                    { id: 'ice_crystal',    value: 150,      name: '永恆冰晶' },
                    { id: 'spirit_dust',    value: 120,      name: '靈魂粉末' },
                    { id: 'fire_core',      value: 80,       name: '火焰核心' },
                    { id: 'lava_rock',      value: 60,       name: '熔岩石' },
                    { id: 'iron_ore',       value: 20,       name: '鐵礦石' },
                    { id: 'magic_dust',     value: 30,       name: '魔粉' },
                    { id: 'coal',           value: 5,        name: '煤炭' }
                ]
            };

            while (targetValue > 10000) { 
                let roll = Math.random();
                let selectedItem;

                if (roll < 0.01) { 
                    selectedItem = POOLS.S[Math.floor(Math.random() * POOLS.S.length)];
                } else if (roll < 0.10) { 
                    selectedItem = POOLS.A[Math.floor(Math.random() * POOLS.A.length)];
                } else { 
                    selectedItem = POOLS.B[Math.floor(Math.random() * POOLS.B.length)];
                }

                let maxCanAfford = Math.floor(targetValue / selectedItem.value);
                if (maxCanAfford <= 0) continue; 

                let count = 1;
                if (POOLS.S.includes(selectedItem)) {
                    count = Math.ceil(Math.random() * Math.min(3, maxCanAfford));
                } else if (POOLS.A.includes(selectedItem)) {
                    count = Math.ceil(Math.random() * Math.min(20, maxCanAfford));
                } else {
                    count = Math.ceil(Math.random() * Math.min(500, maxCanAfford));
                }
                
                if (!p.inventory[selectedItem.id]) p.inventory[selectedItem.id] = 0;
                p.inventory[selectedItem.id] += count;
                targetValue -= (count * selectedItem.value);
                
                if (POOLS.S.includes(selectedItem) || POOLS.A.includes(selectedItem)) {
                    rewards.push(`${selectedItem.name} x${count}`);
                }
            }

            rewards.push("及大量進階材料與補給品");

            if (Math.random() < 0.005) {
                p.inventory['entropy_sword'] = (p.inventory['entropy_sword'] || 0) + 1;
                rewards.unshift(" [奇蹟大獎] 終焉·熱寂之劍 x1");
            }

            socket.emit('playerStatsUpdate', p);
            socket.emit('bagResult', { success: true, msg: ` 福袋開啟！獲得：${rewards.join(', ')}` });
            return;
        }

        const EFFECTS = {
            'potion_hp': { hp: 50, mp: 0, msg: "使用了小紅藥水" },
            'potion_mid': { hp: 500, mp: 0, msg: "使用了中紅藥水" },
            'potion_high': { hp: 2000, mp: 0, msg: "使用了大紅藥水" },
            'potion_max': { hp: 10000, mp: 0, msg: "使用了特級秘藥" },
            'elixir': { hp: 50000, mp: 50000, msg: "使用了神之甘露，全身充滿力量！" },
            'potion_mp': { hp: 0, mp: 30, msg: "使用了小藍藥水" },
            'potion_mp_mid': { hp: 0, mp: 100, msg: "使用了中藍藥水" },
            'potion_mp_high': { hp: 0, mp: 500, msg: "使用了大藍藥水" },
            'grilled_carp': { hp: 100, mp: 0, msg: "吃了烤鯉魚，味道不錯！" },
            'salmon_sushi': { hp: 0, mp: 50, msg: "吃了鮭魚壽司，精神百倍！" },
            'tuna_steak': { hp: 500, mp: 0, msg: "吃了鮪魚排，好飽！" },
            'eel_rice': { hp: 300, mp: 100, msg: "吃了鰻魚飯，體力充沛！" },
            'sushi_plate': { hp: 500, mp: 0, msg: "吃了壽司拼盤，超豪華！" },
            'void_soup': { hp: 999999, mp: 999999, msg: "喝了虛空海鮮湯，狀態全滿！" }
        };

        const effect = EFFECTS[itemId];

        if (effect) {
            if (effect.hp) p.hp = Math.min(p.maxHp, p.hp + effect.hp);
            if (effect.mp) p.mp = Math.min(p.maxMp, p.mp + effect.mp);
            p.inventory[itemId]--;
            if (p.inventory[itemId] <= 0) delete p.inventory[itemId];
            socket.emit('playerStatsUpdate', p);
            socket.emit('bagResult', { success: true, msg: effect.msg });
        } else {
            socket.emit('errorMessage', "此物品無法直接使用！");
        }
    });

    socket.on('startGather', (count) => {
        const p = gameState.players[socket.id];
        if (!p) return;
        if (p.isGathering) { socket.emit('errorMessage', "⏳ 上一個動作尚未結束"); return; }
        const allowedCounts = [1, 10, 20, 30, 50, 70, 90, 100, 200];
        let safeCount = parseInt(count);
        if (!allowedCounts.includes(safeCount)) { safeCount = 1; }
        p.gatherQuota = safeCount;
        socket.emit('gatherStarted', safeCount);
    });

    socket.on('gatherAction', (nodeId) => {
        if (!checkRateLimit(socket.id, 'gather', 2000)) return;
        const p = gameState.players[socket.id];
        const node = GATHER_CONFIG[nodeId];
        if (!p || !node) return;

        if (!p.gatherQuota || p.gatherQuota <= 0) {
            socket.emit('gatherResult', { success: false, msg: "⛔ 採集次數已用盡 (或未申請)" });
            socket.emit('forceStopGather'); 
            return;
        }

        if (p.isGathering) { socket.emit('gatherResult', { success: false, msg: "⏳ 動作進行中..." }); return; }

        const currentGatherLv = p.gatherLevel || 1; 
        if (currentGatherLv < node.reqLv) { 
            socket.emit('gatherResult', { success: false, msg: `採集等級不足 (需 Lv.${node.reqLv})` }); 
            return; 
        }

        p.gatherQuota--;
        p.isGathering = true;

        if (!p.gatherExp) p.gatherExp = 0;
        if (!p.gatherLevel) p.gatherLevel = 1;

        const rand = Math.random();
        let cumulativeRate = 0;
        let gainedItem = null;

        for (let drop of node.drops) {
            cumulativeRate += drop.rate;
            if (rand < cumulativeRate) { gainedItem = drop.id; break; }
        }

        let msg = "";
        let gatherExpGain = 0;
        let nextLevelExp = (p.gatherLevel || 1) * 500;

        if (gainedItem) {
            if (!p.inventory[gainedItem]) p.inventory[gainedItem] = 0;
            p.inventory[gainedItem]++;
            
            gatherExpGain = 10 + (node.reqLv * 5);
            const levelDiff = currentGatherLv - node.reqLv;
            if (levelDiff > 20) { gatherExpGain = 1; } 
            else if (levelDiff > 10) { gatherExpGain = Math.floor(gatherExpGain * 0.5); }
            
            p.gatherExp += gatherExpGain;
            
            let levelUpMsg = "";
            while (p.gatherExp >= nextLevelExp && p.gatherLevel < 150) {
                p.gatherLevel++;
                p.gatherExp -= nextLevelExp;
                nextLevelExp = p.gatherLevel * 500;
                levelUpMsg = "  等級上升！";
            }
            if (p.gatherLevel >= 150) { p.gatherLevel = 150; p.gatherExp = nextLevelExp; }

            let itemName = gainedItem;
            if (typeof MATERIAL_CONFIG !== 'undefined' && MATERIAL_CONFIG[gainedItem]) itemName = MATERIAL_CONFIG[gainedItem].name;
            else if (typeof ITEM_CONFIG !== 'undefined' && ITEM_CONFIG[gainedItem]) itemName = ITEM_CONFIG[gainedItem].name;

            msg = `獲得：${itemName} (+${gatherExpGain} Exp)${levelUpMsg}`;
        } else {
            msg = "什麼都沒找到...";
        }

        saveMyData(socket.id); 
        socket.emit('playerStatsUpdate', p);
        socket.emit('gatherResult', { 
            success: true, 
            msg: msg, 
            gatherExp: p.gatherExp, 
            gatherLevel: p.gatherLevel, 
            gatherMaxExp: nextLevelExp 
        });

        setTimeout(() => {
            if (gameState.players[socket.id]) {
                gameState.players[socket.id].isGathering = false;
            }
        }, 2000); 
    });

    socket.on('getRecipes', () => { 
        const recipes = Object.keys(RECIPE_CONFIG).map(key => { 
            const item = ITEM_CONFIG[key]; 
            const req = RECIPE_CONFIG[key]; 
            const matList = Object.keys(req.materials).map(matId => {
                let matName = matId; 
                if (MATERIAL_CONFIG[matId]) matName = MATERIAL_CONFIG[matId].name;
                else if (ITEM_CONFIG[matId]) matName = ITEM_CONFIG[matId].name; 
                return { id: matId, name: matName, count: req.materials[matId] };
            }); 
            let statsInfo = []; 
            if (item.atk) statsInfo.push(`⚔️ATK+${item.atk}`); 
            if (item.def) statsInfo.push(`️DEF+${item.def}`); 
            if (item.hp) statsInfo.push(`❤️HP+${item.hp}`); 
            if (item.mp) statsInfo.push(`MP+${item.mp}`); 
            return { itemId: key, itemName: item.name, itemDesc: item.desc || "沒有描述", itemStats: statsInfo.length > 0 ? statsInfo.join(' ') : "無特殊屬性", goldCost: req.gold, materials: matList }; 
        }); 
        socket.emit('recipeList', recipes); 
    });

    socket.on('craftItem', (data) => { 
        const targetItemId = (typeof data === 'object') ? data.itemId : data;
        const useShardPay = (typeof data === 'object') ? (data.useShardPay || false) : false;
        const p = gameState.players[socket.id]; const recipe = RECIPE_CONFIG[targetItemId]; const targetItem = ITEM_CONFIG[targetItemId]; if (!p || !recipe || !targetItem) return; 
        // 檢查費用
        if (useShardPay) {
            const shardNeed = Math.ceil(recipe.gold * SHARD_TO_GOLD_RATE);
            if ((p.inventory['skill_shard'] || 0) < shardNeed) { socket.emit('craftResult', { success: false, msg: `碎片不足！需要 ${shardNeed} 塊技能碎片` }); return; }
        } else if (p.gold < recipe.gold) { socket.emit('craftResult', { success: false, msg: "金幣不足！" }); return; }
        for (let matId in recipe.materials) { 
            const needed = recipe.materials[matId]; const has = p.inventory[matId] || 0; 
            if (has < needed) { const matName = MATERIAL_CONFIG[matId] ? MATERIAL_CONFIG[matId].name : matId; socket.emit('craftResult', { success: false, msg: `材料不足：${matName}` }); return; } 
        } 
        payAmount(p, recipe.gold, useShardPay);
        for (let matId in recipe.materials) { p.inventory[matId] -= recipe.materials[matId]; if (p.inventory[matId] <= 0) delete p.inventory[matId]; } 
        p.inventory[targetItemId] = (p.inventory[targetItemId] || 0) + 1; 
        socket.emit('craftResult', { success: true, msg: `成功打造：${targetItem.name}` }); 
        socket.emit('playerStatsUpdate', p); saveMyData(socket.id); 
    });
    
    socket.on('getMarketItems', (category) => {
        let items = [];
        if (category === 'material') { items = Object.keys(MATERIAL_CONFIG).map(key => ({ id: key, name: MATERIAL_CONFIG[key].name })); } 
        else { items = Object.keys(ITEM_CONFIG).filter(key => { const type = ITEM_CONFIG[key].type; if (category === 'weapon') return type === 'weapon'; if (category === 'armor') return type === 'armor' || type === 'acc'; if (category === 'consumable') return type === 'consumable'; return false; }).map(key => ({ id: key, name: ITEM_CONFIG[key].name })); }
        socket.emit('marketItemsList', items);
    });

    socket.on('getMarketListings', (data) => {
        const itemKey = (typeof data === 'object' && data !== null) ? data.key : data;
        const page = (typeof data === 'object' && data.page) ? parseInt(data.page) : 1;
        if (!itemKey) return;
        const limit = 10; const offset = (page - 1) * limit;
        DB.getListingsByItem(itemKey, limit, offset, (result) => {
            const rows = result.listings || [];
            const listings = rows.map(r => {
                let name = r.item_key;
                if (ITEM_CONFIG[r.item_key]) name = ITEM_CONFIG[r.item_key].name;
                else if (MATERIAL_CONFIG[r.item_key]) name = MATERIAL_CONFIG[r.item_key].name;
                return { id: r.id, seller: r.seller_name, itemKey: r.item_key, itemName: name, price: r.price, isMine: (gameState.players[socket.id] && gameState.players[socket.id].name === r.seller_name) };
            });
            socket.emit('marketListingsUpdate', { listings: listings, total: result.total, currentPage: page, totalPages: Math.ceil(result.total / limit) });
        });
    });

    socket.on('getMyListings', () => {
        const p = gameState.players[socket.id]; if (!p) return;
        DB.getListingsBySeller(p.token, (rows) => {
            const listings = rows.map(r => {
                let name = r.item_key;
                if (ITEM_CONFIG[r.item_key]) name = ITEM_CONFIG[r.item_key].name;
                else if (MATERIAL_CONFIG[r.item_key]) name = MATERIAL_CONFIG[r.item_key].name;
                return { id: r.id, seller: r.seller_name, itemKey: r.item_key, itemName: name, price: r.price, isMine: true };
            });
            socket.emit('marketListingsUpdate', listings);
        });
    });

    socket.on('forceSkipTurn', (roomId) => {
        const room = gameState.battleRooms[roomId];
        if (room && room.host === socket.id) {
            console.log(`[強制跳過] 房主 ${socket.id} 強制跳過了回合`);
            io.to(roomId).emit('battleLog', `<span style="color:red; font-weight:bold;">⚠️ 房主強制跳過了卡住的回合！</span>`);
            processNextTurn(room, roomId);
        }
    });     

    //  [修正版] 戰鬥動作處理 (包含 Boss 特殊機制)
    socket.on('combatAction', (data) => { 
        // 1. 頻率限制
        if (!checkRateLimit(socket.id, 'combat', 500)) return;

        const { roomId, type, skillId, targetIndex } = data; 
        const room = gameState.battleRooms[roomId]; 
        const player = gameState.players[socket.id]; 
        
        if (!room || !player || room.status !== 'fighting') return; 
        
        // 檢查是否還有活著的怪
        const livingMonsters = room.monsters.filter(m => m.hp > 0);
        if (livingMonsters.length === 0 || room.rewardsGiven) return;
        
        // 2. 回合權限檢查
        const currentEntityId = room.turnOrder[room.turnIndex]; 
        if (socket.id !== currentEntityId) {
            const currentName = (room.monsters.find(m => m.id === currentEntityId)) ? '怪物' : '其他玩家';
            socket.emit('turnUpdate', { 
                currentId: currentEntityId, 
                name: currentName 
            });
            return; 
        }
        
        // 麻痺檢查
        if (player.isStunned) {
            io.to(roomId).emit('battleLog', `<span style="color:#f39c12; font-weight:bold;">⚡ ${player.name} 身體麻痺，無法動彈！(跳過回合)</span>`);
            player.isStunned = false; 
            socket.emit('playerStatsUpdate', player);
            setTimeout(() => processNextTurn(room, roomId), 300); 
            return;
        }

        // 3. 目標選擇邏輯
        let targetMonster = room.monsters[targetIndex];
        if (!targetMonster || targetMonster.hp <= 0) {
            targetMonster = livingMonsters[0];
        }
        if (!targetMonster) return; 

        // 計算玩家有效攻擊力 (含天神下凡)
        let effectiveAtk = player.atk;
        let buffMsg = "";
        
        if (player.tempBuffs) {
            // 狂暴 (攻 x2)
            if (player.tempBuffs) {
            //  [同步修正] 狂暴傷害計算
	            if (player.tempBuffs.berserk) {
	                const berserkLv = (player.skillLevels && player.skillLevels['berserk']) ? parseInt(player.skillLevels['berserk']) : 1;
	                
	                // ⚙️ 這裡的數值必須跟上面的設定區一樣！
	                const BASE_MULT = 2.0; 
	                const GROWTH = 0.1;
	                
	                const berserkMult = BASE_MULT + (berserkLv - 1) * GROWTH;
	                
	                effectiveAtk = Math.floor(player.atk * berserkMult);
	                
	                // ... (扣除回合數代碼保持不變) ...
	                player.tempBuffs.berserk--;
	                if(player.tempBuffs.berserk <= 0) {
	                    delete player.tempBuffs.berserk;
	                    buffMsg += " <span style='color:#aaa; font-size:10px;'>(狂暴結束)</span>";
	                }
	            }
            }
            
            // 天神下凡 (動態倍率)
            if (player.tempBuffs.god) {
                // 1. 取得技能等級
                const godLv = (player.skillLevels && player.skillLevels['god_mode']) ? player.skillLevels['god_mode'] : 1;
                
                // 2. 計算倍率 (基礎 3.0 + 每級 10%)
                const godMult = 3.0 * (1 + (godLv - 1) * 0.1);

                // 3. 應用倍率
                effectiveAtk = Math.floor(effectiveAtk * godMult);
                
                // 扣除回合數
                player.tempBuffs.god--;
                if (player.tempBuffs.god <= 0) {
                    delete player.tempBuffs.god;
                    buffMsg = " <span style='color:#aaa; font-size:10px;'>(天神效果結束)</span>";
                }
            }
        }

        // 讀取目標怪物防禦力
        let baseMonDef = 0;
        if (room.monsterKey === 'chaos_boss' || room.monsterKey === 'void_devourer_god') {
            baseMonDef = targetMonster.def;
        } else if (typeof MONSTER_CONFIG !== 'undefined' && MONSTER_CONFIG[room.monsterKey]) {
            const cfg = MONSTER_CONFIG[room.monsterKey];
            baseMonDef = cfg.def || (cfg.level * 2);
        } else {
            baseMonDef = targetMonster.def || 10;
        }
        
        if (room.monsterBuffs && room.monsterBuffs.defTurns > 0) {
            baseMonDef = Math.floor(baseMonDef * 2.0);
        }

        let damage = 0; 
        let logMsg = "";

        // 4. 執行動作
        if (type === 'attack') { 
            damage = Math.floor(effectiveAtk + Math.floor(Math.random() * 5) - (baseMonDef * 0.5)); 
            if (damage < 1) damage = 1; 

            targetMonster.hp -= damage; 
            logMsg = `<span style="color:#f1c40f">${player.name} 攻擊 [${targetMonster.name}]! 造成 ${damage} 傷害${buffMsg}</span>`; 
            if (room.monsterBuffs && room.monsterBuffs.defTurns > 0) logMsg += ` <span style="font-size:10px; color:#aaa;">(怪物防禦中)</span>`;
        } 
        else if (type === 'skill') { 
            const skill = (typeof SKILL_CONFIG !== 'undefined') ? SKILL_CONFIG[skillId] : null;
            if (!skill || (player.skills && !player.skills.includes(skillId))) return; 
            
            if (player.mp < skill.mp) { return; }
            player.mp -= skill.mp; 
            
            // 全域技能等級倍率計算
            const skillLv = (player.skillLevels && player.skillLevels[skillId]) ? player.skillLevels[skillId] : 1;
            const levelMultiplier = 1 + (skillLv - 1) * 0.1;
            
            const lvMsg = skillLv > 1 ? ` <span style="font-size:10px; color:#f39c12;">(Lv.${skillLv})</span>` : "";

    
            // 單體傷害
            if (skill.type === 'dmg') { 
                let rawDmg = Math.floor(effectiveAtk * skill.val * levelMultiplier); 
                damage = Math.floor(rawDmg - (baseMonDef * 0.5));
                if (damage < 1) damage = 1;
                targetMonster.hp -= damage; 
                
                // 設定顏色
                let color = skill.val >= 10 ? "#9b59b6" : (skill.val >= 20 ? "#e74c3c" : "#3498db");
                
                //  針對 Big Bang 加個特效字 (選用)
                if (skillId === 'big_bang') color = "#ff0000; font-size:14px; text-shadow: 0 0 5px red;";

                logMsg = `<span style="color:${color}; font-weight:bold;">${player.name} 對 [${targetMonster.name}] 施放 ${skill.name}${lvMsg}! 轟出 ${damage} 傷害!${buffMsg}</span>`; 
            }
            // 真實傷害 (百分比)
            else if (skill.type === 'percent_dmg') {
                let rawDmg = Math.floor(targetMonster.maxHp * skill.val * levelMultiplier); 
                
                // 上限隨等級提升
                let capMult = 50 + (skillLv - 1) * 10;
                let cap = effectiveAtk * capMult; 
                
                if (rawDmg > cap) rawDmg = cap;
                damage = rawDmg;
                targetMonster.hp -= damage; 
                logMsg = `<span style="color:#e67e22; font-weight:bold;">${player.name} 對 [${targetMonster.name}] 施放 ${skill.name}${lvMsg}! 造成 ${damage} 點真實傷害!</span>`;
            }
            // 全體傷害
            else if (skill.type === 'aoe') {
                logMsg = `<span style="color:#8e44ad; font-weight:bold;">${player.name} 施放 ${skill.name}${lvMsg}! (全體攻擊)${buffMsg}</span><br>`;
                room.monsters.forEach(m => {
                    if (m.hp > 0) {
                        let mDef = m.def || 10;
                        if (room.monsterBuffs && room.monsterBuffs.defTurns > 0) mDef *= 2;
                        let dmg = Math.floor((effectiveAtk * skill.val * levelMultiplier) - (mDef * 0.5)); 
                        if (dmg < 1) dmg = 1;
                        m.hp -= dmg;
                        logMsg += `<span style="font-size:10px; color:#aaa;">.. [${m.name}] -${dmg}</span> `;
                    }
                });
            }
            // 全體真傷
            else if (skill.type === 'aoe_percent') {
                logMsg = `<span style="color:#e67e22; font-weight:bold;">${player.name} 施放 ${skill.name}${lvMsg}! (全體真實傷害)</span><br>`;
                
                room.monsters.forEach(m => {
                    if (m.hp > 0) {
                        let rawDmg = Math.floor(m.maxHp * skill.val * levelMultiplier); 
                        
                        // 動態上限
                        let capMult = 50 + (skillLv - 1) * 5;
                        let cap = effectiveAtk * capMult; 
                        
                        if (rawDmg > cap) rawDmg = cap;
                        if (rawDmg < 1) rawDmg = 1;
                        
                        m.hp -= rawDmg;
                        logMsg += `<span style="font-size:10px; color:#aaa;">.. [${m.name}] -${rawDmg}</span> `;
                    }
                });
            }
            // 治療
            else if (skill.type === 'heal') { 
                let healAmount = Math.floor(player.maxHp * skill.val * levelMultiplier); 
                player.hp = Math.min(player.hp + healAmount, player.maxHp); 
                logMsg = `<span style="color:#2ecc71">${player.name} 施放 ${skill.name}${lvMsg}! 恢復了 ${healAmount} HP</span>`; 
            }
            // 全體治療
            else if (skill.type === 'heal_all') {
                room.players.forEach(pid => {
                    const teammate = gameState.players[pid];
                    if (teammate) { teammate.hp = teammate.maxHp; io.to(pid).emit('playerStatsUpdate', teammate); }
                });
                logMsg = `<span style="color:#2ecc71; font-weight:bold;">✨ ${player.name} 施放 ${skill.name}! 全隊完全恢復!</span>`;
            }
            // 暈眩
            else if (skill.type === 'stun') { 
                let rawDmg = Math.floor(effectiveAtk * skill.val * levelMultiplier); 
                damage = Math.floor(rawDmg - (baseMonDef * 0.5));
                if(damage < 1) damage = 1;
                targetMonster.hp -= damage; 
                
                let stunChance = 0.4 + (skillLv - 1) * 0.02;
                
                if (Math.random() < stunChance) { 
                    targetMonster.isStunned = true; 
                    logMsg = `<span style="color:#9b59b6">${player.name} 施放 ${skill.name}${lvMsg}! (${damage}傷) ⚡ [${targetMonster.name}] 暈眩了!${buffMsg}</span>`; 
                } else { 
                    logMsg = `<span style="color:#95a5a6">${player.name} 施放 ${skill.name}${lvMsg}! (${damage}傷) 但 [${targetMonster.name}] 抵抗了暈眩...${buffMsg}</span>`; 
                } 
            }
            // 吸血
            else if (skill.type === 'drain') { 
                let rawDmg = Math.floor(effectiveAtk * skill.val * levelMultiplier); 
                damage = Math.floor(rawDmg - (baseMonDef * 0.5));
                if(damage < 1) damage = 1;
                targetMonster.hp -= damage; 
                let heal = Math.floor(damage * 0.5); 
                player.hp = Math.min(player.hp + heal, player.maxHp); 
                logMsg = `<span style="color:#e74c3c">${player.name} 吸取 [${targetMonster.name}] 生命! (${damage}傷, +${heal}HP)${buffMsg}</span>`; 
            }
            // 破防
            else if (skill.type === 'debuff') { 
                let rawDmg = Math.floor(effectiveAtk * skill.val * levelMultiplier); 
                damage = Math.floor(rawDmg - (baseMonDef * 0.5));
                if(damage < 1) damage = 1;
                targetMonster.hp -= damage; 
                let extraDmg = Math.floor(damage * 0.3); 
                targetMonster.hp -= extraDmg; 
                logMsg = `<span style="color:#3498db">${player.name} 對 [${targetMonster.name}] 施放 ${skill.name}${lvMsg}! 破防追擊 (${damage}+${extraDmg}傷)${buffMsg}</span>`; 
            }
            // 持續傷害
            else if (skill.type === 'dot') { 
                let rawDmg = Math.floor(effectiveAtk * skill.val * levelMultiplier); 
                damage = Math.floor(rawDmg - (baseMonDef * 0.5));
                if(damage < 1) damage = 1;
                targetMonster.hp -= damage; 
                logMsg = `<span style="color:#27ae60">${player.name} 對 [${targetMonster.name}] 施放 ${skill.name}${lvMsg}! 毒素爆發 (${damage}傷)${buffMsg}</span>`; 
            }
            // 防禦 Buff
            else if (skill.type === 'buff') { 
                if (!player.tempBuffs) player.tempBuffs = {}; 
                let duration = 3 + Math.floor((skillLv - 1) / 5);
                player.tempBuffs.def = duration; 
                logMsg = `<span style="color:#f1c40f">${player.name} 施放 ${skill.name}${lvMsg}! 防禦大幅提升 (${duration}回合)</span>`; 
            }
            // 攻擊 Buff
            // 攻擊 Buff (狂暴)
            else if (skill.type === 'buff_atk') { 
                if (!player.tempBuffs) player.tempBuffs = {}; 
                
                // 1. 取得技能等級
                const currentSkillLv = (player.skillLevels && player.skillLevels[skillId]) ? parseInt(player.skillLevels[skillId]) : 1;

                // ============ ⚙️ 數值設定區 ============
                const BASE_MULT = 2.0;  // 基礎倍率 (Lv.1 時)
                const GROWTH = 0.1;     // 每級增加多少 (0.1 = 10%)
                const DURATION_BASE = 3; // 基礎持續回合
                // =====================================

                // 2. 計算持續回合 (每 5 級 +1 回合)
                let duration = DURATION_BASE + Math.floor((currentSkillLv - 1) / 5);
                player.tempBuffs.berserk = duration; 
                
                // 3.  [核心] 計算倍率 (統一公式)
                // 使用 .toFixed(1) 確保只有一位小數，再轉回 Number 進行計算
                const rawMult = BASE_MULT + (currentSkillLv - 1) * GROWTH;
                const berserkMult = parseFloat(rawMult.toFixed(1)); 

                // 副作用：扣除當前血量 20%
                player.hp = Math.floor(player.hp * 0.8); 
                
                // 儲存倍率到 tempBuffs (選擇性，若你的 effectiveAtk 計算邏輯需要讀取它)
                // 目前你的 effectiveAtk 是即時算的，所以這裡主要是為了顯示 Log
                
                logMsg = `<span style="color:#c0392b; font-weight:bold;">${player.name} 進入狂暴狀態! (攻擊 x${berserkMult}, 持續${duration}回合)</span>`; 
            }
            // 天神
            else if (skill.type === 'god') {
                if (!player.tempBuffs) player.tempBuffs = {}; 
                let duration = 3 + Math.floor((skillLv - 1) / 5);
                player.tempBuffs.god = duration; 
                let displayMult = (3.0 * levelMultiplier).toFixed(1);
                logMsg = `<span style="color:#f1c40f; font-weight:bold; font-size:14px;">⚡ ${player.name} 開啟 ${skill.name}${lvMsg}! 攻防變為 ${displayMult}倍! (${duration}回合)</span>`;
            }
        } 
        else if (type === 'item') {
            const itemId = data.itemId;
            const itemConfig = (typeof ITEM_CONFIG !== 'undefined') ? ITEM_CONFIG : {};
            if (!player.inventory[itemId] || player.inventory[itemId] <= 0) return;
            
            player.inventory[itemId]--; 
            if (player.inventory[itemId] === 0) delete player.inventory[itemId];
            
            const item = itemConfig[itemId] || { name: "未知物品", type: "consumable" };
            let effectMsg = "使用了物品";
            
            if (item.type === 'consumable') {
                 if (itemId === 'void_soup' || itemId === 'elixir') { player.hp = player.maxHp; player.mp = player.maxMp; effectMsg = "全身發光，HP/MP 完全恢復！"; }
                 else if (itemId === 'eel_rice') { 
                     player.hp = Math.min(player.hp + 300, player.maxHp); 
                     player.mp = Math.min(player.mp + 100, player.maxMp); 
                     effectMsg = "食用鰻魚飯，恢復 300 HP 和 100 MP"; 
                 }
                 else if (['potion_hp', 'potion_mid', 'potion_high', 'potion_max', 'grilled_carp', 'tuna_steak', 'sushi_plate'].includes(itemId)) {
                    let h = 50;
                    if (itemId === 'potion_mid') h = 500; else if (itemId === 'potion_high') h = 2000; else if (itemId === 'potion_max') h = 10000;
                    else if (itemId === 'grilled_carp') h = 100; else if (itemId === 'tuna_steak') h = 500; else if (itemId === 'sushi_plate') h = 500;
                    player.hp = Math.min(player.hp + h, player.maxHp);
                    effectMsg = `恢復 ${h} HP`;
                 }
                 else if (['potion_mp', 'potion_mp_mid', 'potion_mp_high', 'salmon_sushi'].includes(itemId)) {
                    let m = 30;
                    if (itemId === 'potion_mp_mid') m = 100; else if (itemId === 'potion_mp_high') m = 500;
                    else if (itemId === 'salmon_sushi') m = 50;
                    player.mp = Math.min(player.mp + m, player.maxMp);
                    effectMsg = `恢復 ${m} MP`;
                 }
            }

            logMsg = `<span style="color:#e67e22">${player.name} 使用了 ${item.name}! ${effectMsg}</span>`; 
            damage = 0;

            if (typeof updateDailyProgress === 'function') {
                updateDailyProgress(player, 'use', 1);
            }
        }

        //  [新增] BOSS 特殊機制 (Regen & Rage)
        // 只有當怪物還活著時才觸發 (且 HP 已被扣除)
        if (targetMonster.hp > 0) {
            
            // 1. 自動回血機制
            if (targetMonster.isRegen) {
                const regenAmount = Math.max(1, Math.floor(targetMonster.maxHp * 0.01));
                if (targetMonster.hp < targetMonster.maxHp) {
                    targetMonster.hp = Math.min(targetMonster.maxHp, targetMonster.hp + regenAmount);
                    logMsg += `<br><span style="color:#2ecc71; font-weight:bold; font-size:10px;">♻️ [${targetMonster.name}] 正在自我修復... HP +${regenAmount.toLocaleString()}</span>`;
                }
            }

            // 2. 狂暴機制 (隨機全屏攻擊)
            if (targetMonster.isRage) {
                // 20% 機率觸發
                if (Math.random() < 0.2) {
                    logMsg += `<br><span style="color:#e74c3c; font-weight:bold; font-size:12px;">☠️ 警告！[${targetMonster.name}] 發動了「維度崩塌」！全體玩家受到重創！</span>`;
                    
                    // 扣除房間內所有玩家 50% 血量
                    room.players.forEach(pid => {
                        const member = gameState.players[pid];
                        if (member && member.hp > 0) {
                            const wipeDmg = Math.floor(member.hp * 0.5);
                            member.hp -= wipeDmg;
                            // 強制更新血條
                            io.to(pid).emit('playerStatsUpdate', member);
                        }
                    });
                }
            }
        }

        // 確保血量不為負
        room.monsters.forEach(m => { if (m.hp < 0) m.hp = 0; });

        // 更新數據
        io.to(roomId).emit('battleLog', logMsg); 
        io.to(roomId).emit('monstersUpdate', room.monsters); 
        socket.emit('playerStatsUpdate', player); 
        io.to(roomId).emit('roomInfoUpdate', getRoomPublicInfo(room)); 
        
        if (typeof saveMyData === 'function') saveMyData(socket.id); 

        // 3. 檢查勝利
        const remainingMonsters = room.monsters.filter(m => m.hp > 0);
        if (remainingMonsters.length === 0) { 
            if (typeof handleBattleWin === 'function') {
                handleBattleWin(room, roomId);
            } else {
                console.error("找不到 handleBattleWin 函式！");
                io.to(roomId).emit('battleWon', { exp: 0, gold: 0 });
                delete gameState.battleRooms[roomId];
            }
            return; 
        } 
        
        // 4. 下一回合
        setTimeout(() => processNextTurn(room, roomId), 300);
    });

    //  [修正版] 市集上架 (包含禁售名單)
    socket.on('marketSell', (data) => {
        // 1. 頻率限制
        if (typeof checkRateLimit === 'function' && !checkRateLimit(socket.id, 'trade', 500)) return;

        let { itemId, price, amount } = data; // 這裡我們假設前端傳來的是單個上架，或者你自定義的批量參數
        const p = gameState.players[socket.id];
        price = parseInt(price);
        
        // 雖然前端說是批量，但 DB.addListing 一次只加一筆，這裡保留你原本的邏輯
        // 如果前端是透過迴圈 call marketSell，那 amount 應該是 undefined 或 1
        // 如果你是想在後端做批量，那這裡的邏輯需要是迴圈。
        // *假設* 前端傳來的 amount 是想要上架的總數 (後端幫忙拆單):
        let countToSell = parseInt(amount) || 1;
        if (countToSell < 1) countToSell = 1;
        if (countToSell > 30) countToSell = 30; // 單次請求最多處理 30 個

        if (!p || !price || price <= 0) return;
        if (price > 999999999) { socket.emit('errorMessage', "價格過高 (上限 9.9億)"); return; }

        //  [核心] 禁售名單 (新增碎片、商店飾品、神話裝備)
        const NON_TRADABLE_ITEMS = [
            // 1. 特殊道具
            'lucky_bag', 'enhance_stone', 'safe_stone', 'skill_shard',
            
            // 2. 舊版神話/綁定裝備
            'genesis_weapon', 'genesis_armor', 'void_reaper_dark', 'ring_galaxy',
            'void_blade', 'void_armor', 'galaxy_saber', 'nebula_plate',
            'dimension_ring', 'entropy_sword', 'entropy_god_armor',

            // 3. Lv.450 & Lv.500 神話裝備 (只能自己合成)
            'infinity_blade', 'event_horizon', 'mobius_ring',
            'singularity_weapon', 'singularity_armor', 'singularity_acc',

            // 4. 碎片商店飾品 (防止誤賣)
            'shard_ring_novice', 'shard_neck_brave', 'shard_charm_wind', 
            'shard_ring_vampire', 'shard_earring_holy', 'shard_belt_titan', 
            'shard_pendant_dragon', 'shard_ring_void', 'shard_core_galaxy', 'shard_crown_infinity',
			            // 加入這 6 個 ID：
			'shard_blade_novice', 'shard_axe_crystal', 'shard_scythe_void', 
			'shard_spear_galaxy', 'shard_wep_dimension', 'shard_wep_origin',
			// 加入這 6 個 ID：
			'shard_armor_novice', 'shard_armor_crystal', 'shard_robe_void', 
			'shard_plate_galaxy', 'shard_armor_dimension', 'shard_armor_origin'
        ];

        // 檢查是否在禁售名單中
        if (NON_TRADABLE_ITEMS.includes(itemId)) { 
            socket.emit('errorMessage', "❌ 此為綁定/特殊物品，無法在市集交易！"); 
            return; 
        }

        // 檢查數量是否足夠（扣除已裝備的數量）
        const mktEquippedQty = Object.values(p.equipment).filter(e => e === itemId).length;
        const mktAvailableQty = (p.inventory[itemId] || 0) - mktEquippedQty;
        if (mktAvailableQty < countToSell) { 
            socket.emit('errorMessage', `你沒有足夠的數量 (可用: ${mktAvailableQty}, 已裝備: ${mktEquippedQty})`); 
            return; 
        }

        let successCount = 0;
        
        // 遞迴函式：處理批量上架
        function processBatchSell(remaining) {
            if (remaining <= 0) { finishBatch(); return; }

            DB.getPlayerListingCount(p.token, (currentCount) => {
                // 檢查個人上架上限 (例如 90 個)
                if (currentCount >= 90) { finishBatch("已達上架上限 (最多90個)"); return; }

                if (p.inventory[itemId] > 0) {
                    // 先扣除物品
                    p.inventory[itemId]--;
                    
                    if (p.inventory[itemId] === 0) {
                        delete p.inventory[itemId];
                        // 如果有強化屬性，也一併移除 (簡單處理)
                        if (p.enhancements && p.enhancements[itemId]) { delete p.enhancements[itemId]; }
                    }

                    const name = p.name || p.id.substr(0, 4);

                    // 寫入資料庫
                    DB.addListing(p.token, name, itemId, price, (success) => {
                        if (success) {
                            successCount++;
                            processBatchSell(remaining - 1); 
                        } else {
                            // 失敗則退還物品
                            p.inventory[itemId] = (p.inventory[itemId] || 0) + 1;
                            finishBatch("資料庫錯誤，部分上架失敗");
                        }
                    });
                } else {
                    finishBatch("物品不足");
                }
            });
        }

        function finishBatch(errorMsg) {
            saveMyData(socket.id);
            socket.emit('playerStatsUpdate', p);

            if (successCount > 0) {
                let msg = `成功上架 ${successCount} 個物品！`;
                if (errorMsg) msg += ` (${errorMsg})`;
                
                socket.emit('marketResult', { success: true, msg: msg });
                // 廣播通知市場更新 (延遲一下讓資料庫寫入)
                setTimeout(() => { io.emit('marketRefresh'); }, 1000);
            } else {
                socket.emit('marketResult', { success: false, msg: errorMsg || "上架失敗" });
            }
        }

        // 開始處理
        processBatchSell(countToSell);
    });

    socket.on('dismantleItem', (itemId) => {
        const p = gameState.players[socket.id];
        if (!p) return;

        if (!p.inventory[itemId] || p.inventory[itemId] <= 0) { socket.emit('errorMessage', "你沒有這個物品！"); return; }

        // 計算已裝備同ID的數量 (裝備中的不可分解，但多件時可分解未裝備的)
        const equippedCount = Object.values(p.equipment).filter(e => e === itemId).length;
        const availableCount = (p.inventory[itemId] || 0) - equippedCount;
        if (availableCount <= 0) { socket.emit('errorMessage', "無法分解已裝備的物品，請先卸下！"); return; }

        let refundMsg = [];

        // 優先判斷是否為碎片商店裝備（退還一半碎片，最少1塊）
        const shardShopEntry = SHARD_SHOP_CONFIG[itemId];
        if (shardShopEntry) {
            const shardRefund = Math.max(1, Math.floor(shardShopEntry.cost * 0.5));
            if (!p.inventory['skill_shard']) p.inventory['skill_shard'] = 0;
            p.inventory['skill_shard'] += shardRefund;
            refundMsg.push(`技能碎片 x${shardRefund}`);
        } else {
            // 一般合成配方裝備：退還材料
            const recipe = RECIPE_CONFIG[itemId];
            if (!recipe) { socket.emit('errorMessage', "此物品無法分解 (不是由配方製作)"); return; }

            let refundMaterials = {};
            for (let matId in recipe.materials) {
                const originalCount = recipe.materials[matId];
                let refundCount = Math.floor(originalCount * 0.5);
                if (refundCount > 0) {
                    refundMaterials[matId] = refundCount;
                    let matName = matId;
                    if (typeof ITEM_NAMES !== 'undefined' && ITEM_NAMES[matId]) matName = ITEM_NAMES[matId];
                    else if (ITEM_CONFIG[matId]) matName = ITEM_CONFIG[matId].name;
                    else if (MATERIAL_CONFIG && MATERIAL_CONFIG[matId]) matName = MATERIAL_CONFIG[matId].name;
                    refundMsg.push(`${matName} x${refundCount}`);
                }
            }

            if (refundMsg.length === 0) {
                p.gold += 100;
                refundMsg.push("100 G (補償)");
            } else {
                for (let matId in refundMaterials) {
                    if (!p.inventory[matId]) p.inventory[matId] = 0;
                    p.inventory[matId] += refundMaterials[matId];
                }
            }
        }

        p.inventory[itemId]--;
        if (p.inventory[itemId] <= 0) {
            delete p.inventory[itemId];
            if (p.enhancements && p.enhancements[itemId]) { delete p.enhancements[itemId]; }
        }

        socket.emit('playerStatsUpdate', p);
        socket.emit('bagResult', { success: true, msg: `分解成功！獲得：${refundMsg.join(', ')}` });
        saveMyData(socket.id); 
    });

    socket.on('repairItem', (itemId) => {
        const p = gameState.players[socket.id];
        if (!p) return;

        // 檢查裝備存在（背包或已裝備）
        const inInventory = p.inventory[itemId] > 0;
        const isEquipped = Object.values(p.equipment).includes(itemId);
        if (!inInventory && !isEquipped) { socket.emit('errorMessage', "你沒有這件裝備！"); return; }

        if (!ITEM_CONFIG[itemId]) { socket.emit('errorMessage', "此物品無法維修！"); return; }

        if (!p.durability) p.durability = {};
        const maxDur = DURABILITY_CONFIG.maxDurability;
        const curDur = (p.durability[itemId] !== undefined) ? p.durability[itemId] : maxDur;

        if (curDur >= maxDur) { socket.emit('errorMessage', "此裝備耐久度已滿，無需維修！"); return; }

        const cost = getRepairCost(itemId, curDur);
        const shardCount = p.inventory['skill_shard'] || 0;
        if (shardCount < cost) {
            socket.emit('errorMessage', `碎片不足！需要 ${cost} 塊技能碎片，你只有 ${shardCount} 塊。`);
            return;
        }

        // 扣碎片，恢復耐久
        p.inventory['skill_shard'] -= cost;
        if (p.inventory['skill_shard'] <= 0) delete p.inventory['skill_shard'];
        p.durability[itemId] = maxDur;

        calculateStats(p);
        socket.emit('playerStatsUpdate', p);
        socket.emit('bagResult', { success: true, msg: `✅ 維修成功！消耗 ${cost} 塊技能碎片，耐久度已恢復滿。` });
        saveMyData(socket.id);
    });


    // ==========================================
    //  公會建設 handlers
    // ==========================================

    socket.on('guildUpgradeFacility', ({ facilityId }) => {
        const p = gameState.players[socket.id];
        if (!p || !p.guildId) return socket.emit('errorMessage', '你不在公會中！');
        const g = guildData[p.guildId];
        if (!g) return socket.emit('errorMessage', '公會不存在！');
        const isLeaderUpg = g.leaderName === p.name;
        const isViceUpg = g.viceLeaderName === p.name;
        if (!isLeaderUpg && !isViceUpg)
            return socket.emit('errorMessage', '只有會長/副長可以升級設施！');

        const cfg = GUILD_FACILITY_CONFIG[facilityId];
        if (!cfg) return socket.emit('errorMessage', '設施不存在！');

        if (!g.facilities) g.facilities = { temple: 0, expedition: 0, vault: 0 };
        const curLv = g.facilities[facilityId] || 0;
        if (curLv >= cfg.maxLv) return socket.emit('errorMessage', `${cfg.name}已達最高等級！`);

        const nextLv = curLv + 1;
        const cost = cfg.cost(nextLv);
        const guildGold = g.gold || 0;
        const guildShard = g.shard || 0;

        if (guildGold < cost.gold) return socket.emit('errorMessage', `公會金庫金幣不足！需要 ${cost.gold.toLocaleString()} G（現有 ${guildGold.toLocaleString()} G）`);
        if (guildShard < cost.shard) return socket.emit('errorMessage', `公會金庫碎片不足！需要 ${cost.shard} 塊（現有 ${guildShard} 塊）`);

        g.gold -= cost.gold;
        g.shard = (g.shard || 0) - cost.shard;
        g.facilities[facilityId] = nextLv;

        saveGuilds();
        socket.emit('guildOpSuccess', `✅ ${cfg.name}升級至 Lv.${nextLv}！`);
        // Broadcast to all guild members
        const allSockets = Object.keys(gameState.players).filter(sid => gameState.players[sid].guildId === p.guildId);
        allSockets.forEach(sid => io.to(sid).emit('guildFacilityUpdate', g.facilities));
    });

    socket.on('guildDepositShard', ({ amount }) => {
        const p = gameState.players[socket.id];
        if (!p || !p.guildId) return socket.emit('errorMessage', '你不在公會中！');
        const g = guildData[p.guildId];
        if (!g) return;
        const amt = parseInt(amount) || 0;
        if (amt <= 0) return socket.emit('errorMessage', '數量無效！');
        const owned = p.inventory['skill_shard'] || 0;
        if (owned < amt) return socket.emit('errorMessage', `碎片不足！你有 ${owned} 塊`);
        p.inventory['skill_shard'] -= amt;
        if (p.inventory['skill_shard'] <= 0) delete p.inventory['skill_shard'];
        g.shard = (g.shard || 0) + amt;
        g.memberContribution = g.memberContribution || {};
        g.memberContribution[p.name] = (g.memberContribution[p.name] || 0) + amt;
        saveGuilds(); saveMyData(socket.id);
        socket.emit('playerStatsUpdate', p);
        socket.emit('guildOpSuccess', `✅ 已存入 ${amt} 塊碎片到公會金庫`);
    });

    socket.on('guildVaultDeposit', ({ itemId, count }) => {
        const p = gameState.players[socket.id];
        if (!p || !p.guildId) return socket.emit('errorMessage', '你不在公會中！');
        const g = guildData[p.guildId];
        if (!g) return;
        if (!g.vault) g.vault = { items: {} };
        const maxSlots = getGuildVaultSlots(g);
        const usedSlots = Object.keys(g.vault.items).length;
        const qty = parseInt(count) || 1;
        if (!(itemId in g.vault.items) && usedSlots >= maxSlots)
            return socket.emit('errorMessage', `公會倉庫已滿！(${usedSlots}/${maxSlots} 格)`);
        if ((p.inventory[itemId] || 0) < qty)
            return socket.emit('errorMessage', '背包物品不足！');
        p.inventory[itemId] -= qty;
        if (p.inventory[itemId] <= 0) delete p.inventory[itemId];
        g.vault.items[itemId] = (g.vault.items[itemId] || 0) + qty;
        saveGuilds(); saveMyData(socket.id);
        socket.emit('playerStatsUpdate', p);
        socket.emit('guildVaultUpdate', g.vault);
        socket.emit('guildOpSuccess', `✅ 已存入物品`);
    });

    socket.on('guildVaultWithdraw', ({ itemId, count }) => {
        const p = gameState.players[socket.id];
        if (!p || !p.guildId) return socket.emit('errorMessage', '你不在公會中！');
        const g = guildData[p.guildId];
        if (!g || !g.vault) return;
        const qty = parseInt(count) || 1;
        if ((g.vault.items[itemId] || 0) < qty)
            return socket.emit('errorMessage', '倉庫物品不足！');
        g.vault.items[itemId] -= qty;
        if (g.vault.items[itemId] <= 0) delete g.vault.items[itemId];
        p.inventory[itemId] = (p.inventory[itemId] || 0) + qty;
        saveGuilds(); saveMyData(socket.id);
        socket.emit('playerStatsUpdate', p);
        socket.emit('guildVaultUpdate', g.vault);
        socket.emit('guildOpSuccess', `✅ 已取出物品`);
    });

    socket.on('getGuildFacilities', () => {
        const p = gameState.players[socket.id];
        if (!p || !p.guildId) return;
        const g = guildData[p.guildId];
        if (!g) return;
        socket.emit('guildFacilitiesData', {
            facilities: g.facilities || { temple: 0, expedition: 0, vault: 0 },
            vault: g.vault || { items: {} },
            guildGold: g.gold || 0,
            guildShard: g.shard || 0,
            bossCooldown: g.bossCooldown || {},
        });
    });

    socket.on('startGuildBoss', ({ bossId }) => {
        const p = gameState.players[socket.id];
        if (!p || !p.guildId) return socket.emit('errorMessage', '你不在公會中！');
        const g = guildData[p.guildId];
        if (!g) return;
        const bossCfg = GUILD_BOSS_CONFIG[bossId];
        if (!bossCfg) return socket.emit('errorMessage', '無效BOSS！');
        const templeLv = (g.facilities && g.facilities.temple) || 0;
        if (templeLv < bossCfg.reqTempleLv)
            return socket.emit('errorMessage', `需要聖殿 Lv.${bossCfg.reqTempleLv} 才能召喚此BOSS（現在 Lv.${templeLv}）`);
        const now = Date.now();
        const lastKill = (g.bossCooldown && g.bossCooldown[bossId]) || 0;
        const cooldownMs = bossCfg.cooldownHours * 3600000;
        if (now - lastKill < cooldownMs) {
            const remaining = Math.ceil((cooldownMs - (now - lastKill)) / 3600000);
            return socket.emit('errorMessage', `公會BOSS冷卻中！還需 ${remaining} 小時`);
        }
        // Create a guild boss room
        const roomId = `guild_boss_${p.guildId}_${Date.now()}`;
        gameState.battleRooms[roomId] = {
            id: roomId, status: 'fighting', isGuildBoss: true,
            guildId: p.guildId, bossId,
            players: [socket.id],
            monster: { ...bossCfg, id: bossId, hp: bossCfg.hp, maxHp: bossCfg.hp, status: 'alive' },
            monsterKey: bossId,
            monsters: [{ ...bossCfg, id: bossId, hp: bossCfg.hp, maxHp: bossCfg.hp }],
            turnOrder: [socket.id, bossId], turnIndex: 0,
            rewardsGiven: false,
        };
        socket.join(roomId);
        p.battleRoomId = roomId;
        socket.emit('guildBossReady', { roomId, bossName: bossCfg.name });
    });

    // ==========================================
    // ⚗️ 神話鍛造 handlers
    // ==========================================

    socket.on('mythForgeEssence', ({ essenceId }) => {
        const p = gameState.players[socket.id];
        if (!p) return;
        const cfg = MYTH_ESSENCE_CONFIG[essenceId];
        if (!cfg) return socket.emit('mythForgeResult', { success: false, msg: '無效配方！' });

        // Check materials
        for (const [matId, need] of Object.entries(cfg.materials)) {
            if ((p.inventory[matId] || 0) < need) {
                const mName = MATERIAL_CONFIG[matId] ? MATERIAL_CONFIG[matId].name : matId;
                return socket.emit('mythForgeResult', { success: false, msg: `材料不足：${mName}（需要 ${need}）` });
            }
        }
        if ((p.inventory['skill_shard'] || 0) < cfg.shard)
            return socket.emit('mythForgeResult', { success: false, msg: `碎片不足！需要 ${cfg.shard} 塊` });

        // Deduct
        for (const [matId, need] of Object.entries(cfg.materials)) {
            p.inventory[matId] -= need;
            if (p.inventory[matId] <= 0) delete p.inventory[matId];
        }
        p.inventory['skill_shard'] = (p.inventory['skill_shard'] || 0) - cfg.shard;
        if (p.inventory['skill_shard'] <= 0) delete p.inventory['skill_shard'];
        p.inventory[essenceId] = (p.inventory[essenceId] || 0) + 1;

        calculateStats(p);
        socket.emit('playerStatsUpdate', p);
        socket.emit('mythForgeResult', { success: true, msg: `✅ 成功煉製 ${cfg.icon} ${cfg.name}！` });
        saveMyData(socket.id);
    });

    socket.on('mythForgeArtifact', ({ artifactId }) => {
        const p = gameState.players[socket.id];
        if (!p) return;
        const cfg = MYTH_ARTIFACT_CONFIG[artifactId];
        if (!cfg) return socket.emit('mythForgeResult', { success: false, msg: '無效配方！' });

        for (const [esId, need] of Object.entries(cfg.essences)) {
            if ((p.inventory[esId] || 0) < need) {
                const esName = MYTH_ESSENCE_CONFIG[esId] ? MYTH_ESSENCE_CONFIG[esId].name : esId;
                return socket.emit('mythForgeResult', { success: false, msg: `精華不足：${esName}（需要 ${need}）` });
            }
        }
        if ((p.inventory['skill_shard'] || 0) < cfg.shard)
            return socket.emit('mythForgeResult', { success: false, msg: `碎片不足！需要 ${cfg.shard} 塊` });

        for (const [esId, need] of Object.entries(cfg.essences)) {
            p.inventory[esId] -= need;
            if (p.inventory[esId] <= 0) delete p.inventory[esId];
        }
        p.inventory['skill_shard'] = (p.inventory['skill_shard'] || 0) - cfg.shard;
        if (p.inventory['skill_shard'] <= 0) delete p.inventory['skill_shard'];
        p.inventory[artifactId] = (p.inventory[artifactId] || 0) + 1;

        socket.emit('playerStatsUpdate', p);
        socket.emit('mythForgeResult', { success: true, msg: `✅ 成功凝聚 ${cfg.icon} ${cfg.name}！` });
        saveMyData(socket.id);
    });

    socket.on('mythForgeGear', ({ gearId }) => {
        const p = gameState.players[socket.id];
        if (!p) return;
        const cfg = MYTH_GEAR_CONFIG[gearId];
        if (!cfg) return socket.emit('mythForgeResult', { success: false, msg: '無效配方！' });

        for (const [artId, need] of Object.entries(cfg.artifacts)) {
            if ((p.inventory[artId] || 0) < need) {
                const artName = MYTH_ARTIFACT_CONFIG[artId] ? MYTH_ARTIFACT_CONFIG[artId].name : artId;
                return socket.emit('mythForgeResult', { success: false, msg: `神器素材不足：${artName}（需要 ${need}）` });
            }
        }
        if ((p.gold || 0) < cfg.gold) return socket.emit('mythForgeResult', { success: false, msg: `金幣不足！需要 ${cfg.gold.toLocaleString()} G` });
        if ((p.inventory['skill_shard'] || 0) < cfg.shard) return socket.emit('mythForgeResult', { success: false, msg: `碎片不足！需要 ${cfg.shard} 塊` });

        for (const [artId, need] of Object.entries(cfg.artifacts)) {
            p.inventory[artId] -= need;
            if (p.inventory[artId] <= 0) delete p.inventory[artId];
        }
        p.gold -= cfg.gold;
        p.inventory['skill_shard'] = (p.inventory['skill_shard'] || 0) - cfg.shard;
        if (p.inventory['skill_shard'] <= 0) delete p.inventory['skill_shard'];
        p.inventory[gearId] = (p.inventory[gearId] || 0) + 1;

        calculateStats(p);
        socket.emit('playerStatsUpdate', p);
        socket.emit('mythForgeResult', { success: true, msg: ` 神話鍛造成功！【${cfg.name}】已加入背包！` });
        io.emit('chatMessage', { name: '系統', msg: ` 勇者 [${p.name}] 成功鍛造出神話裝備【${cfg.name}】！` });
        saveMyData(socket.id);
    });


    socket.on('requestCaptcha', () => {
        const p = gameState.players[socket.id];
        if (!p) return;

        const code = Math.floor(1000 + Math.random() * 9000).toString();
        p.captcha = code;
        p.captchaTime = Date.now();

        const num1 = Math.floor(Math.random() * 20) + 1;
        const num2 = Math.floor(Math.random() * 10) + 1;
        p.captchaAnswer = (num1 + num2).toString();
        
        socket.emit('captchaGenerated', { question: `${num1} + ${num2} = ?` });
    });

    //  購買市集物品 (含驗證碼檢查 + 秒殺偵測)
    socket.on('marketBuy', (data) => {
        const buyer = gameState.players[socket.id];
        if (!buyer) return;

        const listingId = (typeof data === 'object') ? data.listingId : data;
        const answer = (typeof data === 'object') ? data.answer : null;

        // 1. 檢查圖形/數學驗證碼
        if (!buyer.captchaAnswer || !answer || buyer.captchaAnswer !== answer.toString().trim()) {
            socket.emit('marketResult', { success: false, msg: "❌ 驗證碼錯誤或失效！" });
            delete buyer.captchaAnswer; 
            return;
        }
        delete buyer.captchaAnswer; // 驗證通過後刪除，防止重用

        // 2. 頻率限制 (1秒)
        const now = Date.now();
        if (buyer.lastMarketAction && now - buyer.lastMarketAction < 1000) { return; }
        buyer.lastMarketAction = now;

        // 3. 確認付款方式（碎片或金幣）
        const useShardPayMarket = (typeof data === 'object') ? (data.useShardPay || false) : false;
        let effectiveGold = buyer.gold;
        if (useShardPayMarket) {
            const shardOwned = buyer.inventory['skill_shard'] || 0;
            effectiveGold = Math.floor(shardOwned / SHARD_TO_GOLD_RATE); // 等效金幣上限
        }

        DB.buyListing(listingId, effectiveGold, (result) => {
            if (!result.success) {
                socket.emit('marketResult', { success: false, msg: result.msg });
                socket.emit('marketRefresh'); 
                return;
            }

            // --- 交易成功，取得物品資料 ---
            const listing = result.listing;
            // 扣除買家費用（碎片或金幣）
            if (useShardPayMarket) {
                const shardCostMkt = Math.ceil(listing.price * SHARD_TO_GOLD_RATE);
                if ((buyer.inventory['skill_shard'] || 0) < shardCostMkt) {
                    socket.emit('marketResult', { success: false, msg: `❌ 碎片不足！需要 ${shardCostMkt} 塊` });
                    return;
                }
                buyer.inventory['skill_shard'] -= shardCostMkt;
                if (buyer.inventory['skill_shard'] <= 0) delete buyer.inventory['skill_shard'];
                // DB 已加錢給賣家，但買家沒扣金幣（因為用碎片），需要補回DB扣掉的gold操作
                // buyListing 不扣 buyer.gold，它只更新 seller gold，所以這裡直接即可
            } else {
                buyer.gold -= listing.price;
            }

            // ==========================================
            //  [新增] 秒殺偵測邏輯 (Sniper Detection)
            // ==========================================
            // 取得物品上架時間 (轉為毫秒)
            const listedTime = new Date(listing.created_at).getTime();
            // 計算時間差
            const diff = Date.now() - listedTime; 

            // 設定閾值：1.5秒 (1500ms)
            if (diff < 3000) { 
                const diffSec = (diff / 1000).toFixed(3);
                const logMsg = `⚡ 市集秒殺警報: 上架後僅 ${diffSec}秒 即被購買 (買家: ${buyer.name}, 物品: ${listing.item_name || listing.item_key}, 價格: ${listing.price})`;
                
                // 寫入後台 Log
                if (typeof logSuspicion === 'function') {
                    logSuspicion(buyer.name, logMsg);
                }
                console.log(`[MarketBot] ${buyer.name} 觸發秒殺偵測 (${diffSec}s)`);
            }
            // ==========================================

            // 4. 更新買家數據（金幣已在上方扣除，這裡只處理物品）
            const itemId = listing.item_key || listing.itemKey;
            if (!buyer.inventory[itemId]) buyer.inventory[itemId] = 0;
            buyer.inventory[itemId]++;
            
            socket.emit('marketResult', { success: true, msg: "購買成功！" });
            socket.emit('playerStatsUpdate', buyer);
            saveMyData(socket.id); 

            // 5. 處理賣家 (如果在線)
            const sellerSocketId = Object.keys(gameState.players).find(sid => gameState.players[sid].name === listing.seller_username);
            
            if (sellerSocketId) {
                const seller = gameState.players[sellerSocketId];
                seller.gold += listing.price;
                if (seller.gold > 9000000000) seller.gold = 9000000000;
                
                io.to(sellerSocketId).emit('marketResult', { success: true, msg: `你的物品 ${listing.item_name || itemId} 賣出了！獲得 ${listing.price} G` });
                io.to(sellerSocketId).emit('playerStatsUpdate', seller);
                saveMyData(sellerSocketId); // 順便幫賣家存檔
            }

            // 6. 全廣刷新市集
            io.emit('marketRefresh');
        }); 
    });
    
    socket.on('marketCancel', (listingId) => {
        const p = gameState.players[socket.id]; if (!p) return;
        DB.cancelListing(listingId, p.token, (listing) => {
            if (!listing) { socket.emit('marketResult', { success: false, msg: "取消失敗" }); } 
            else {
                p.inventory[listing.item_key] = (p.inventory[listing.item_key] || 0) + 1;
                saveMyData(socket.id); socket.emit('playerStatsUpdate', p); socket.emit('marketResult', { success: true, msg: "✅ 已取回物品" }); io.emit('marketRefresh');
            }
        });
    });

    socket.on('npcSell', (data) => { 
        // 1. 解析參數：兼容舊版(只傳ID) 與 新版(傳物件 {itemId, amount})
        const itemId = (typeof data === 'object') ? data.itemId : data;
        let amount = (typeof data === 'object') ? parseInt(data.amount) : 1;

        // 防呆：確保數量至少為 1
        if (isNaN(amount) || amount < 1) amount = 1;

        const p = gameState.players[socket.id]; 
        const item = ITEM_CONFIG[itemId] || MATERIAL_CONFIG[itemId]; 
        
        if (!p || !item) return; 
        
        // 2. 檢查庫存數量是否足夠（扣除已裝備的數量）
        const equippedQty = Object.values(p.equipment).filter(e => e === itemId).length;
        const currentQty = (p.inventory[itemId] || 0) - equippedQty;
        if (currentQty < amount) {
            socket.emit('bagResult', { success: false, msg: " 物品數量不足（已裝備的不可出售）！" }); 
            return; 
        }

        // 3. 計算價格
        let baseCost = item.cost || 10; 
        let unitSellPrice = Math.floor(baseCost * 0.2); // 單價 (原價 20%)
        if (unitSellPrice < 1) unitSellPrice = 1; 
        
        let totalSellPrice = unitSellPrice * amount; // 總價

        // 4. 扣除物品
        p.inventory[itemId] -= amount; 

        // 如果賣光了，刪除該欄位
        if (p.inventory[itemId] <= 0) { 
            delete p.inventory[itemId]; 
            if (p.enhancements && p.enhancements[itemId]) {
                delete p.enhancements[itemId];
            }
        } 

        // 5. 增加金幣
        p.gold += totalSellPrice; 
        if (p.gold > 9000000000) p.gold = 9000000000; 

        // 6. 回傳結果 (顯示賣出數量與總價)
        socket.emit('bagResult', { success: true, msg: ` 已賣出 ${amount} 個 [${item.name}]，獲得 ${totalSellPrice} G` }); 
        socket.emit('playerStatsUpdate', p); 
        saveMyData(socket.id); 
    });

    socket.on('playerBuy', (data) => { 
        if (typeof checkRateLimit === 'function' && !checkRateLimit(socket.id, 'trade', 500)) return;
        const id = (typeof data === 'object') ? data.itemId : data;
        const useShardPay = (typeof data === 'object') ? (data.useShardPay || false) : false;

        let p = gameState.players[socket.id]; 
        if(!p) { socket.emit('errorMessage', "請重新登入"); return; } 

        if (!NPC_SHOP_ALLOW_LIST.includes(id) && id !== 'lucky_bag') {
            console.log(`[作弊警告] 玩家 ${p.name} 嘗試非法購買非賣品: ${id}`);
            socket.emit('errorMessage', "❌ 此物品是非賣品！"); 
            return;
        }

        if (id === 'lucky_bag') {
            if (typeof LUCKY_BAG_STOCK === 'undefined') LUCKY_BAG_STOCK = 0; 
            if (LUCKY_BAG_STOCK <= 0) {
                socket.emit('errorMessage', "❌ 慢了一步！福袋已售罄！");
                return;
            }
        }

        const item = ITEM_CONFIG[id]; 
        if(!item) { socket.emit('errorMessage', "商品不存在"); return; } 

        let cost = item.cost;
        if (!cost || cost <= 0) { socket.emit('errorMessage', "❌ 商品價格異常"); return; }

        // 碎片付款或金幣付款
        const buyPayResult = payAmount(p, cost, useShardPay);
        if (buyPayResult.ok) {
            p.inventory[id] = (p.inventory[id]||0)+1; 
            
            if (id === 'lucky_bag') {
                LUCKY_BAG_STOCK--;
                io.emit('stockUpdate', { itemId: 'lucky_bag', count: LUCKY_BAG_STOCK });
                io.emit('chatMessage', { name: '系統', msg: ` 恭喜 ${p.name} 搶購了 1 個奇蹟福袋！(剩餘: ${LUCKY_BAG_STOCK})` });
            }

            const payMsg = useShardPay ? `(消耗 ${buyPayResult.shardCost} 碎片)` : `(消耗 ${cost} 金幣)`;
            socket.emit('buyResult', {success:true, message:`✅ 購買 ${item.name} 成功 ${payMsg}`, cost:cost}); 
            socket.emit('playerStatsUpdate', p); 
            saveMyData(socket.id); 
        } else { 
            if (useShardPay) {
                const need = Math.ceil(cost * SHARD_TO_GOLD_RATE);
                socket.emit('errorMessage', `❌ 碎片不足！需要 ${need} 塊技能碎片`);
            } else {
                socket.emit('errorMessage', "❌ 金錢不足！");
            }
        } 
    });

    socket.on('equipItem', (itemId) => { 
        let p = gameState.players[socket.id]; if(!p) { socket.emit('errorMessage', "請重新登入"); return; } const item = ITEM_CONFIG[itemId]; if(!item) { socket.emit('errorMessage', "物品錯誤"); return; } if(!p.inventory[itemId]) { socket.emit('errorMessage', "無此物品"); return; } const slot = item.type; if(!['weapon','armor','acc'].includes(slot)) { socket.emit('errorMessage', "無法裝備"); return; } 
        
        // ⛔ [新增] 裝備等級限制檢查
        const reqLv = EQUIP_REQ_LV[itemId] || 0;
        if (p.level < reqLv) {
            socket.emit('errorMessage', `❌ 等級不足！裝備 ${item.name} 需要 Lv.${reqLv} (你目前 Lv.${p.level})`);
            return;
        }

        if(p.equipment[slot]) { const oldItemId = p.equipment[slot]; p.inventory[oldItemId] = (p.inventory[oldItemId] || 0) + 1; }
        p.equipment[slot] = itemId; p.inventory[itemId]--; if(p.inventory[itemId] <= 0) delete p.inventory[itemId]; 
        calculateStats(p); socket.emit('equipResult', `✅ 已裝備 ${item.name}`); socket.emit('playerStatsUpdate', p); saveMyData(socket.id); 
    });

    socket.on('unequipItem', (slot) => { 
        let p = gameState.players[socket.id]; if(!p || !p.equipment[slot]) return; const itemId = p.equipment[slot]; p.inventory[itemId] = (p.inventory[itemId]||0)+1; p.equipment[slot] = null; calculateStats(p); socket.emit('equipResult', "已卸下！"); socket.emit('playerStatsUpdate', p); saveMyData(socket.id); 
    });

    socket.on('enterCity', (cityId) => { if (gameState.players[socket.id]) { gameState.players[socket.id].currentCity = cityId; broadcastHubData(); saveMyData(socket.id); } });
    
    // 建立房間 (支援 1-3 隻怪 + 正確回合排序)
    // ==========================================
    //  [改版] createRoom 支援 單人/公開/私人(密碼) 房間
    //  data = { monsterKey, roomType: 'solo'|'public'|'private', password? }
    //  世界 Boss 不受影響
    // ==========================================
    socket.on('createRoom', (data) => { 
        if (!checkRateLimit(socket.id, 'createRoom', 3000)) {
            socket.emit('errorMessage', "⏳ 操作太快，請稍後再試！");
            return; 
        }

        try { 
            // 兼容舊版：如果傳入的是字串，當作 monsterKey + public
            let monsterKey, roomType, roomPassword;
            if (typeof data === 'string') {
                monsterKey = data;
                roomType = 'public';
                roomPassword = null;
            } else {
                monsterKey = data.monsterKey;
                roomType = data.roomType || 'public';
                roomPassword = data.password || null;
            }

            // 驗證 roomType
            if (!['solo', 'public', 'private'].includes(roomType)) {
                roomType = 'public';
            }

            // 私人房間必須有密碼
            if (roomType === 'private') {
                if (!roomPassword || roomPassword.trim().length === 0) {
                    socket.emit('errorMessage', "❌ 私人房間必須設定密碼！");
                    return;
                }
                if (roomPassword.length > 20) {
                    socket.emit('errorMessage', "❌ 密碼不能超過 20 字！");
                    return;
                }
            }

            const p = gameState.players[socket.id]; 
            if (!p) return; 
            
            let alreadyInRoom = false; 
            for (let rid in gameState.battleRooms) { 
                if (gameState.battleRooms[rid].players.includes(socket.id)) { 
                    alreadyInRoom = true; 
                    break; 
                } 
            }
            if (alreadyInRoom) { socket.emit('errorMessage', "❌ 你已經在房間內，請先離開！"); return; }
            
            if (p.hp <= 0) { socket.emit('errorMessage', " 你已經死亡！請先去旅館復活。"); return; } 

            // ⛔ [新增] 伺服器端等級驗證 — 防止繞過前端限制
            const accessCheck = checkMonsterAccess(p, monsterKey);
            if (!accessCheck.pass) {
                socket.emit('errorMessage', accessCheck.msg);
                return;
            }
            
            //  [修改開始] 生成怪物陣列
            const monsters = [];
            
            // 1. 決定怪物數量 (1~3隻)
            const roll = Math.random();
            let count = 1;
            if (monsterKey === 'chaos_boss') count = 1; // Boss 永遠只有一隻
            else if (roll > 0.8) count = 3;
            else if (roll > 0.5) count = 2;

            // 2. 獲取怪物原型
            let baseConfig;
            if (monsterKey === 'chaos_boss') {
                baseConfig = generateChaosBoss();
            } else {
                baseConfig = MONSTER_CONFIG[monsterKey];
                if (!baseConfig) { socket.emit('errorMessage', `找不到怪物數據`); return; }
            }

            // 3. 生成每隻怪的數據
            for (let i = 0; i < count; i++) {
                let mData = JSON.parse(JSON.stringify(baseConfig));
                
                // 強制補滿 HP (防止複製時數值異常)
                if (monsterKey !== 'chaos_boss') {
                    if (!mData.maxHp) mData.maxHp = mData.hp;
                }
                mData.hp = mData.maxHp; 
                mData.status = 'alive';
                mData.isStunned = false;
                mData.id = `m_${Date.now()}_${i}`; // 給每隻怪唯一 ID

                // 等級波動：第 2, 3 隻怪等級可能較低
                if (i > 0 && monsterKey !== 'chaos_boss') {
                    const levelRatio = 0.8 + Math.random() * 0.2;
                    mData.level = Math.max(1, Math.floor(mData.level * levelRatio));
                    
                    // 數值隨等級下修
                    mData.maxHp = Math.floor(mData.maxHp * levelRatio);
                    mData.hp = mData.maxHp;
                    mData.atk = Math.floor(mData.atk * levelRatio);
                    mData.def = Math.floor(mData.def * levelRatio);
                    mData.exp = Math.floor(mData.exp * levelRatio);
                    mData.gold = Math.floor(mData.gold * levelRatio);
                    
                    // 名字加後綴區分
                    mData.name = `${mData.name} (${String.fromCharCode(65 + i)})`; 
                } else if (count > 1) {
                    mData.name = `${mData.name} (A)`;
                }

                monsters.push(mData);
            }
            //  [修改結束]

            const roomId = 'room_' + Math.random().toString(36).substr(2, 5); 
            
            // 4. 建立房間物件 (新增 roomType / password)
            gameState.battleRooms[roomId] = { 
                id: roomId, 
                monsterKey: monsterKey, 
                monsters: monsters, 
                monster: monsters[0], 
                status: 'waiting', 
                players: [socket.id], 
                host: socket.id, 
                hostName: p.name, 
                updatedAt: Date.now(), 
                turnIndex: 0, 
                turnOrder: [], 
                logs: [],
                rewardsGiven: false,
                playerCount: 1,
                roomType: roomType,                          // 'solo' | 'public' | 'private'
                password: roomType === 'private' ? roomPassword : null  // 只有私人房間存密碼
            }; 
            
            p.currentRoom = roomId;
            p.state = 'waiting';

            // 5. 初始化回合順序
            gameState.battleRooms[roomId].turnOrder = [socket.id];

            socket.emit('roomJoined', { roomId: roomId, isHost: true, roomType: roomType }); 
            broadcastHubData(); 
            
        } catch (e) { 
            console.error("Create Room Error:", e); 
            socket.emit('errorMessage', "系統錯誤，無法建立房間");
        } 
    });

    // ==========================================
    //  [改版] joinRoom 支援 私人房間密碼驗證
    //  data = { roomId, password? } 或 舊版字串 roomId
    // ==========================================
    socket.on('joinRoom', (data) => { 
        const p = gameState.players[socket.id]; 
        if (!p) return; 
        if (p.hp <= 0) { socket.emit('errorMessage', " 你已經死亡！請先去旅館復活。"); return; } 

        // 兼容舊版：如果傳入字串，當作 roomId
        let roomId, inputPassword;
        if (typeof data === 'string') {
            roomId = data;
            inputPassword = null;
        } else {
            roomId = data.roomId;
            inputPassword = data.password || null;
        }

        const room = gameState.battleRooms[roomId]; 
        if (room && room.status === 'waiting') { 
            // ⛔ [新增] 伺服器端等級驗證 — 防止繞過前端限制
            if (room.monsterKey) {
                const accessCheck = checkMonsterAccess(p, room.monsterKey);
                if (!accessCheck.pass) {
                    socket.emit('errorMessage', accessCheck.msg);
                    return;
                }
            }

            // 單人房間不可加入
            if (room.roomType === 'solo') {
                socket.emit('errorMessage', '❌ 這是單人房間，無法加入！');
                return;
            }

            // 私人房間需要密碼
            if (room.roomType === 'private') {
                if (!inputPassword || inputPassword !== room.password) {
                    socket.emit('errorMessage', '❌ 密碼錯誤，無法加入房間！');
                    return;
                }
            }

            if (room.players.length >= 5) { socket.emit('errorMessage', '❌ 房間已滿 (上限 5 人)！'); return; } 
            if (!room.players.includes(socket.id)) { room.players.push(socket.id); socket.join(roomId); } 
            socket.emit('roomJoined', { roomId: roomId, isHost: false }); 
            io.to(roomId).emit('roomInfoUpdate', getRoomPublicInfo(room)); 
            broadcastHubData(); 
        } else { 
            socket.emit('errorMessage', '無法加入'); 
        } 
    });
    
    socket.on('connectToGuildBoss', (roomId) => {
        const p = gameState.players[socket.id];
        if (!p) return;
        const room = gameState.battleRooms[roomId];
        if (!room || !room.isGuildBoss) { socket.emit('roomLeft'); return; }
        if (room.rewardsGiven) { socket.emit('errorMessage', '公會BOSS已被討伐！'); socket.emit('roomLeft'); return; }

        if (p.guildId !== room.guildId) { socket.emit('errorMessage', '你不是此公會成員！'); return; }

        socket.join(roomId);
        p.battleRoomId = roomId;

        // 檢查係咪重連（同一 token 舊 socket）
        const oldIdx = room.players.findIndex(pid => {
            const op = gameState.players[pid];
            return op && op.token === p.token && pid !== socket.id;
        });

        if (oldIdx !== -1) {
            // 重連：替換舊 socket id
            const oldId = room.players[oldIdx];
            room.players[oldIdx] = socket.id;
            const turnIdx = room.turnOrder.indexOf(oldId);
            if (turnIdx !== -1) room.turnOrder[turnIdx] = socket.id;
        } else if (!room.players.includes(socket.id)) {
            // 新加入
            if (room.players.length >= 10) { socket.emit('errorMessage', '公會BOSS房間已滿！'); return; }
            room.players.push(socket.id);
            const bossIdx = room.turnOrder.indexOf(room.monsterKey);
            if (bossIdx !== -1) room.turnOrder.splice(bossIdx, 0, socket.id);
            else room.turnOrder.unshift(socket.id);
        }

        socket.emit('battleStarted', { startTime: Date.now() });
        socket.emit('monsterUpdate', room.monster);
        socket.emit('playerStatsUpdate', p);
        io.to(roomId).emit('battleLog', `<span style="color:#f39c12;">⚔️ ${p.name} 加入了公會BOSS戰！</span>`);

        // 若當前回合是此玩家，重新廣播讓前端解鎖按鈕
        const currentId = room.turnOrder[room.turnIndex];
        if (currentId === socket.id) {
            io.to(socket.id).emit('turnUpdate', { currentId: socket.id, name: p.name });
        } else {
            broadcastTurn(room);
        }
    });

    socket.on('connectToRoom', (roomId) => { 
        const p = gameState.players[socket.id]; 
        if (!p) return; 
        
        const room = gameState.battleRooms[roomId]; 
        
        if (room) { 
            // 已結束的房間（非等待中）才拒絕進入
            if (room.status !== 'waiting' && (room.monster.hp <= 0 || room.monster.status === 'dead' || room.rewardsGiven)) { 
                socket.emit('roomLeft'); 
                return; 
            }

            const existingIdx = room.players.findIndex(pid => { 
                const targetP = gameState.players[pid]; 
                return targetP && targetP.token === p.token; 
            });

            if (existingIdx !== -1) { 
                const oldSocketId = room.players[existingIdx]; 
                
                // 重連路徑：同一個 token 重連，直接替換，不算新人，無需檢查上限
                socket.join(roomId); 
                room.players[existingIdx] = socket.id; 
                
                if (room.status === 'fighting' && room.turnOrder) {
                    const turnIndex = room.turnOrder.indexOf(oldSocketId);
                    if (turnIndex !== -1) {
                        room.turnOrder[turnIndex] = socket.id; 
                        console.log(`[重連修正] 戰鬥順序更新: ${oldSocketId} -> ${socket.id}`);
                    }
                }

                if (room.host === oldSocketId || !room.players.includes(room.host)) { 
                    room.host = socket.id; 
                } 
                
                console.log(`[系統] 玩家 ${p.name} 重連回戰鬥`); 

                io.to(roomId).emit('roomInfoUpdate', getRoomPublicInfo(room)); 
                if (room.status === 'fighting') { 
                    socket.emit('battleStarted'); 
                    socket.emit('monsterUpdate', room.monster); 
                    broadcastTurn(room); 
                } 
            } 
            else { 
                if (room.status === 'fighting') {
                    socket.emit('errorMessage', "❌ 戰鬥進行中，無法觀戰或亂入！");
                    socket.emit('roomLeft'); 
                    return; 
                }

                // 先過濾已斷線玩家，再計算實際人數
                room.players = room.players.filter(pid => gameState.players[pid]);
                if (room.players.length < 5) { 
                    if (!room.players.includes(socket.id)) {
                        socket.join(roomId);
                        room.players.push(socket.id); 
                    }
                    if (!room.players.includes(room.host)) room.host = room.players[0]; 
                    io.to(roomId).emit('roomInfoUpdate', getRoomPublicInfo(room)); 
                } else { 
                    socket.emit('errorMessage', '❌ 房間已滿 (上限 5 人)！'); 
                    socket.emit('roomLeft');
                } 
            }
        } else { 
            socket.emit('roomLeft'); 
        } 
    });
    
    //  [修正] 踢人功能 (支援戰鬥中踢人)
    socket.on('kickPlayer', (data) => {
        const { roomId, targetId } = data; 
        
        const room = gameState.battleRooms[roomId];
        const p = gameState.players[socket.id];

        // 1. 基礎驗證
        if (!p || !room) return;

        // 2. 權限驗證：只有房主能踢人
        if (room.host !== socket.id) { 
            socket.emit('errorMessage', "只有房主可以踢人！"); 
            return; 
        }

        // 3. 目標驗證：不能踢自己
        if (targetId === socket.id) { 
            socket.emit('errorMessage', "你不能踢自己 (請直接離開房間)"); 
            return; 
        }

        // 4. 確保目標真的在房間內
        if (!room.players.includes(targetId)) {
            socket.emit('errorMessage', "該玩家不在房間內");
            return;
        }

        //  [核心修改] 戰鬥中踢人的特殊處理
        let isActiveTurn = false; // 標記被踢的人是否正在行動

        if (room.status === 'fighting') {
            // A. 檢查是否輪到被踢的人
            const currentEntityId = room.turnOrder[room.turnIndex];
            if (currentEntityId === targetId) {
                isActiveTurn = true; // 是他的回合，稍後要強制切換
            }

            // B. 從回合列表 (turnOrder) 中移除該玩家 ID
            // 這樣下一回合就不會再輪到他
            room.turnOrder = room.turnOrder.filter(id => id !== targetId);

            // C. 修正 turnIndex (如果移除的人排在當前順序之前，Index 要減 1)
            // 這是一個保險措施，防止 Index 錯位
            if (room.turnIndex >= room.turnOrder.length) {
                room.turnIndex = 0;
            }
        }

        // --- 執行離開邏輯 ---
        // 這會處理從 room.players 移除、更新 UI 等通用事項
        if (typeof leaveRoomLogic === 'function') {
            leaveRoomLogic(targetId, roomId);
        } else {
            console.error("找不到 leaveRoomLogic 函式！");
            return;
        }

        // 獲取被踢玩家名稱
        const targetName = gameState.players[targetId] ? gameState.players[targetId].name : "玩家";

        // 通知房間其他人
        io.to(roomId).emit('battleLog', `<span style="color:#e74c3c; font-weight:bold;"> ${targetName} 被房主踢出了隊伍！</span>`);
        
        // 通知被踢的人 (強制跳轉回大廳)
        io.to(targetId).emit('errorMessage', "你被房主踢出了房間");
        io.to(targetId).emit('roomLeft');

        //  [關鍵] 如果戰鬥中且踢掉的是「當前行動者」，強制進入下一回合
        if (room.status === 'fighting' && isActiveTurn) {
            io.to(roomId).emit('battleLog', `<span style="color:#aaa;">(系統自動跳過回合...)</span>`);
            
            // 稍微延遲一下，避免數據衝突
            setTimeout(() => {
                if (gameState.battleRooms[roomId]) { // 確保房間還在
                    processNextTurn(room, roomId);
                }
            }, 500);
        }
    });

    // 開始戰鬥 (含 Chaos Boss 重生邏輯)
    //  [修正版] 開始戰鬥 (支援單人挑戰與多人大廳)
    //  [修正版] 開始戰鬥 (支援單人挑戰與多人大廳)
    socket.on('startBattle', (data) => {
        // =======================================================
        // CASE A: Single Player Direct Challenge (單人直接挑戰 - Chaos Boss)
        // =======================================================
        if (data === 'chaos_boss') {
            const p = gameState.players[socket.id];
            if (!p) return;

            // 1. 生成 Boss (單怪)
            const monster = generateChaosBoss();
            monster.id = `m_boss_${Date.now()}`; // 確保 Boss 也有 ID
            const monsters = [monster]; // 放入陣列

            const roomId = 'room_' + socket.id;
            
            gameState.battleRooms[roomId] = {
                id: roomId,
                host: socket.id,
                hostName: p.name,
                players: [socket.id],
                monsters: monsters, //  改用 monsters 陣列
                monsterKey: 'chaos_boss',
                status: 'fighting', 
                playerCount: 1,
                //  2. 將玩家與 Boss ID 加入回合序列
                turnOrder: shuffleArray([socket.id, monster.id]),
                turnIndex: -1,
                logs: [],
                rewardsGiven: false,
                battleStartTime: Date.now() 
            };

            p.state = 'fighting';
            p.currentRoom = roomId;

            const room = gameState.battleRooms[roomId];
            
            // 戰鬥無時間限制，已移除9分鐘狂暴計時器
            if (room.enrageTimer) { clearTimeout(room.enrageTimer); room.enrageTimer = null; }
            room.battleStartTime = room.battleStartTime || Date.now();

            socket.emit('roomJoined', roomId);
            
            //  3. 立即開始第一回合
            processNextTurn(room, roomId);
            return; 
        }

        // =======================================================
        // CASE B: Host Starting a Lobby (房主開始多人戰鬥)
        // =======================================================
        const roomId = data;
        const room = gameState.battleRooms[roomId];

        if (room && room.host === socket.id && room.status === 'waiting') {
            room.status = 'fighting';
            room.battleStartTime = Date.now(); 
            
            //  1. 處理怪物狀態重置 (若是 Chaos Boss)
            if (room.monsterKey === 'chaos_boss') {
                const boss = generateChaosBoss();
                boss.id = `m_boss_${Date.now()}`;
                room.monsters = [boss]; // 重置為新的單一 Boss
                room.rewardsGiven = false;
            } else {
                // 普通怪物已經在 createRoom 時生成好了，這裡是確保滿血
                room.monsters.forEach(m => {
                    if (m.hp <= 0) { 
                        m.hp = m.maxHp; 
                        m.status = 'alive'; 
                        m.isStunned = false; 
                    }
                });
                room.rewardsGiven = false;
            }
            
            //  2. 建立正確的 Turn Order (包含所有玩家 + 所有怪物)
            let order = [...room.players];
            room.monsters.forEach(m => order.push(m.id)); // 加入怪物 ID
            
            room.turnOrder = shuffleArray(order); 
            room.turnIndex = -1;
            
            // 通知前端戰鬥開始
            io.to(roomId).emit('battleStarted');
            
            // 傳送怪物列表 (前端已改為監聽 monstersUpdate)
            io.to(roomId).emit('monstersUpdate', room.monsters);
            
            //  3. 顯示初始順序 (動態查詢名字)
            let orderNames = room.turnOrder.map(id => {
                const m = room.monsters.find(mon => mon.id === id);
                if (m) return m.name;
                const p = gameState.players[id];
                return p ? p.name : 'Unknown';
            }).join(' → ');

            io.to(roomId).emit('battleLog', `<span style="color:#aaa; font-size:10px;">Order: ${orderNames}</span>`);
            
            // 戰鬥無時間限制，已移除9分鐘狂暴計時器
            if (room.enrageTimer) { clearTimeout(room.enrageTimer); room.enrageTimer = null; }
            room.battleStartTime = Date.now();

            broadcastHubData(); 
            
            //  4. 開始第一回合
            processNextTurn(room, roomId);
        }
    });


    // ====================================================
    // 再戰一場：重置房間並重新生成怪物
    // ====================================================
    socket.on('restartBattle', (roomId) => {
        const p = gameState.players[socket.id];
        if (!p) return;

        const room = gameState.battleRooms[roomId];
        if (!room) { socket.emit('errorMessage', '❌ 找不到房間！'); socket.emit('roomLeft'); return; }

        // 只有房主可以重置
        if (room.host !== socket.id) { socket.emit('errorMessage', '❌ 只有房主可以再戰！'); return; }

        // 重新生成怪物（沿用原本 monsterKey）
        const monsterKey = room.monsterKey;
        if (!monsterKey) { socket.emit('errorMessage', '❌ 找不到怪物資料！'); return; }

        let baseConfig;
        if (monsterKey === 'chaos_boss') {
            baseConfig = generateChaosBoss();
        } else {
            baseConfig = MONSTER_CONFIG[monsterKey];
            if (!baseConfig) { socket.emit('errorMessage', '❌ 怪物資料錯誤！'); return; }
        }

        // 隨機怪物數量
        const roll = Math.random();
        let count = 1;
        if (monsterKey === 'chaos_boss') count = 1;
        else if (roll > 0.8) count = 3;
        else if (roll > 0.5) count = 2;

        const freshMonsters = [];
        for (let i = 0; i < count; i++) {
            let mData = JSON.parse(JSON.stringify(baseConfig));
            mData.maxHp = mData.maxHp || mData.hp;
            mData.hp = mData.maxHp;
            mData.status = 'alive';
            mData.isStunned = false;
            mData.id = `m_${Date.now()}_${i}`;

            if (i > 0 && monsterKey !== 'chaos_boss') {
                const levelRatio = 0.8 + Math.random() * 0.2;
                mData.level = Math.max(1, Math.floor(mData.level * levelRatio));
                mData.maxHp = Math.floor(mData.maxHp * levelRatio);
                mData.hp = mData.maxHp;
                mData.atk = Math.floor(mData.atk * levelRatio);
                mData.def = Math.floor(mData.def * levelRatio);
                mData.exp = Math.floor(mData.exp * levelRatio);
                mData.gold = Math.floor(mData.gold * levelRatio);
                mData.name = `${mData.name} (${String.fromCharCode(65 + i)})`;
            } else if (count > 1) {
                mData.name = `${mData.name} (A)`;
            }
            freshMonsters.push(mData);
        }

        // 重置房間狀態
        room.monsters = freshMonsters;
        room.monster = freshMonsters[0];
        room.status = 'waiting';
        room.turnOrder = [];
        room.turnIndex = 0;
        room.rewardsGiven = false;
        room.battleStartTime = null;
        room.updatedAt = Date.now();
        if (room.enrageTimer) { clearTimeout(room.enrageTimer); room.enrageTimer = null; }

        // 恢復所有房間內玩家 HP/MP
        room.players.forEach(pid => {
            const rp = gameState.players[pid];
            if (rp) {
                rp.hp = rp.maxHp;
                rp.mp = rp.maxMp;
                io.to(pid).emit('playerStatsUpdate', rp);
            }
        });

        // 確保所有玩家重新 join socket room（避免因 leave 後收不到廣播）
        room.players.forEach(pid => {
            const s = io.sockets.sockets.get(pid);
            if (s) s.join(roomId);
        });

        // 通知所有人重置完成 → 前端顯示等待大廳
        io.to(roomId).emit('battleReset');
        io.to(roomId).emit('roomInfoUpdate', getRoomPublicInfo(room));
        broadcastHubData();
        console.log(`[再戰] 房間 ${roomId} 已重置，怪物: ${freshMonsters.map(m=>m.name).join(', ')}`);
    });

    socket.on('flee', (roomId) => {
        const p = gameState.players[socket.id];
        const room = gameState.battleRooms[roomId];
        if (!p || !room || room.status !== 'fighting') return;

        // 逃跑成功率：玩家等級 / (玩家等級 + 怪物平均等級) * 調整
        // 同級怪 = 50%；玩家高10級 ≈ 70%；玩家低10級 ≈ 35%
        const monsterAvgLv = room.monsters.length > 0
            ? room.monsters.reduce((s, m) => s + (m.level || 1), 0) / room.monsters.length
            : (room.monster ? room.monster.level : 1);
        const playerLv = p.level || 1;
        const fleeRate = Math.min(0.9, Math.max(0.1, playerLv / (playerLv + monsterAvgLv)));

        if (Math.random() < fleeRate) {
            io.to(roomId).emit('battleLog', `<span style="color:#f39c12;"> ${p.name} 成功逃脫！</span>`);
            socket.emit('fleeSuccess');
            leaveRoomLogic(socket.id, roomId);
        } else {
            // 逃跑失敗，怪物趁機反擊
            const monsters = room.monsters ? room.monsters.filter(m => m.hp > 0) : (room.monster ? [room.monster] : []);
            let penalty = 0;
            if (monsters.length > 0) {
                const m = monsters[Math.floor(Math.random() * monsters.length)];
                penalty = Math.max(1, Math.floor((m.atk || 10) * 0.5) - (p.def || 0));
                p.hp = Math.max(0, p.hp - penalty);
            }
            socket.emit('battleLog', `<span style="color:#e74c3c;">❌ 逃跑失敗！怪物反擊造成 ${penalty} 傷害！</span>`);
            socket.emit('playerStatsUpdate', p);

            if (p.hp <= 0) {
                const losePct = (Math.floor(Math.random() * 10) + 1) / 100;
                const loseGold = Math.floor((p.gold || 0) * losePct);
                if (loseGold > 0) {
                    p.gold = Math.max(0, p.gold - loseGold);
                    socket.emit('battleLog', `<span style="color:#e74c3c;"> 死亡懲罰：損失 ${loseGold.toLocaleString()} G (${Math.round(losePct*100)}%)</span>`);
                }
                socket.emit('playerStatsUpdate', p);
                socket.emit('playerDead');
                io.to(roomId).emit('battleLog', `<span style="color:#7f8c8d;">☠️ ${p.name} 逃跑途中倒下了...</span>`);
                saveMyData(socket.id);
                setTimeout(() => leaveRoomLogic(socket.id, roomId), 3000);
            }
            // 逃跑失敗消耗一個回合
            if (p.hp > 0) setTimeout(() => processNextTurn(room, roomId), 500);
        }
    });

    socket.on('leaveRoom', (roomId) => leaveRoomLogic(socket.id, roomId));
    
    socket.on('disconnect', () => { 
        clearRateLimit(socket.id); 
        const p = gameState.players[socket.id];
        
        if (p && p.gatherTimer) {
            clearTimeout(p.gatherTimer);
            p.isGathering = false;
            delete p.gatherTimer;
        }

        if (p && p.token) {
            // ⚡ [修正] 只有當此 socket 仍然是該玩家的當前連線時才存檔
            // 防止 F5 時舊 socket 的 disconnect 覆蓋新連線已更新的數據
            const isStillCurrentSocket = gameState.players[socket.id] && gameState.players[socket.id].id === socket.id;
            if (isStillCurrentSocket) {
                saveMyData(socket.id); 
            }
            disconnectTimers[p.token] = setTimeout(() => {
                console.log(`[超時移除] ${socket.id}`);
                for (let rid in gameState.battleRooms) { let room = gameState.battleRooms[rid]; if (room.players.includes(socket.id)) { leaveRoomLogic(socket.id, rid); } }
                delete gameState.players[socket.id]; broadcastHubData(); delete disconnectTimers[p.token]; 
            }, 5000); 
        } else { delete gameState.players[socket.id]; }
    });

    socket.on('playerRest', () => { 
        let p = gameState.players[socket.id]; if(!p) return; 
        for (let rid in gameState.battleRooms) { let room = gameState.battleRooms[rid]; if (room.players.includes(socket.id)) { leaveRoomLogic(socket.id, rid); } }
        p.hp = p.maxHp; p.mp = p.maxMp; 
        socket.emit('restResult', "恢復！"); socket.emit('playerStatsUpdate', p); saveMyData(socket.id); 
    });


	socket.on('adminGetSuspiciousLogs', (data) => {
        // data 結構可能是 { adminPass: '...' }
        const inputPass = (typeof data === 'object') ? data.adminPass : data;
        const correctPassword = process.env.ADMIN_PASSWORD; // 或 'admin123'

        if (correctPassword && inputPass === correctPassword) {
            // 密碼正確，發送數據
            //  [修改] 事件名稱改為 adminSuspiciousLogsData
            socket.emit('adminSuspiciousLogsData', suspiciousLogs);
        } else {
            socket.emit('errorMessage', "密碼錯誤");
        }
    });


    socket.on('adminGetLogs', (inputPassword) => {
        // 讀取環境變數中的密碼
        const correctPassword = process.env.ADMIN_PASSWORD;

        // 安全檢查：如果 .env 沒設定密碼，或者密碼不對
        if (!correctPassword || inputPassword !== correctPassword) {
            socket.emit('errorMessage', "密碼錯誤或未設定管理員密碼");
        } else {
            // 密碼正確
            socket.emit('adminLogUpdate', suspiciousLogs);
        }
    });
    
    //  [修改] 清除紀錄 (Admin 功能)
    socket.on('adminClearLogs', (inputPassword) => {
        const correctPassword = process.env.ADMIN_PASSWORD;

        if (correctPassword && inputPassword === correctPassword) {
            suspiciousLogs.length = 0; // 清空陣列
            io.emit('adminLogUpdate', suspiciousLogs); // 更新畫面
        } else {
            socket.emit('errorMessage', "權限不足");
        }
    });




    socket.on('adminGiveItem', (data) => {
        const { adminPass, targetName, itemId, count } = data; const amount = parseInt(count);
        if (adminPass !== process.env.ADMIN_PASSWORD) { socket.emit('adminResult', { success: false, msg: "❌ 管理員密碼錯誤" }); return; }
        if (!amount || amount <= 0) { socket.emit('adminResult', { success: false, msg: "❌ 數量必須大於 0" }); return; }
        let itemName = ""; if (ITEM_CONFIG[itemId]) itemName = ITEM_CONFIG[itemId].name; else if (MATERIAL_CONFIG[itemId]) itemName = MATERIAL_CONFIG[itemId].name; else { socket.emit('adminResult', { success: false, msg: `❌ 物品 ID [${itemId}] 不存在` }); return; }
        const targetSocketId = Object.keys(gameState.players).find(sid => gameState.players[sid].name === targetName);
        if (targetSocketId) {
            const p = gameState.players[targetSocketId]; p.inventory[itemId] = (p.inventory[itemId] || 0) + amount;
            saveMyData(targetSocketId); socket.emit('adminResult', { success: true, msg: `✅ 已發送 ${amount} 個 [${itemName}] 給線上玩家 ${targetName}` });
            io.to(targetSocketId).emit('battleLog', `<span style="color:#e67e22; font-weight:bold; font-size:12px;"> 管理員送來了禮物：${itemName} x${amount}</span>`); io.to(targetSocketId).emit('playerStatsUpdate', p); 
        } else {
            DB.getUserInfo(targetName, (user) => {
                if (!user) { socket.emit('adminResult', { success: false, msg: `❌ 找不到玩家帳號：${targetName}` }); return; }
                DB.loadPlayer(user.token, (offlineData) => {
                    if (offlineData) { 
                        if(!offlineData.inventory) offlineData.inventory = {};
                        offlineData.inventory[itemId] = (offlineData.inventory[itemId] || 0) + amount; 
                        DB.savePlayer(user.token, offlineData); socket.emit('adminResult', { success: true, msg: `✅ 已發送 ${amount} 個 [${itemName}] 給離線玩家 ${targetName}` }); 
                    } else { socket.emit('adminResult', { success: false, msg: "❌ 讀取離線玩家存檔失敗" }); }
                });
            });
        }
    });

    socket.on('adminSetGatherLevel', (data) => {
        const { adminPass, targetName, level } = data; const newLv = parseInt(level);
        if (adminPass !== process.env.ADMIN_PASSWORD) { socket.emit('adminResult', { success: false, msg: "❌ 管理員密碼錯誤" }); return; }
        if (isNaN(newLv) || newLv < 1) { socket.emit('adminResult', { success: false, msg: "❌ 等級必須為大於 0 的數字" }); return; }
        const targetSocketId = Object.keys(gameState.players).find(sid => gameState.players[sid].name === targetName);
        if (targetSocketId) {
            const p = gameState.players[targetSocketId]; p.gatherLevel = newLv; p.gatherExp = 0; 
            saveMyData(targetSocketId); socket.emit('adminResult', { success: true, msg: `✅ 線上玩家 ${targetName} 採集等級已設定為 Lv.${newLv}` });
            io.to(targetSocketId).emit('battleLog', `<span style="color:#2ecc71; font-weight:bold;"> 管理員將你的採集等級調整為 Lv.${newLv}</span>`); io.to(targetSocketId).emit('playerStatsUpdate', p);
        } else {
            DB.getUserInfo(targetName, (user) => {
                if (!user) { socket.emit('adminResult', { success: false, msg: `❌ 找不到玩家帳號：${targetName}` }); return; }
                DB.loadPlayer(user.token, (offlineData) => {
                    if (offlineData) { offlineData.gatherLevel = newLv; offlineData.gatherExp = 0; DB.savePlayer(user.token, offlineData); socket.emit('adminResult', { success: true, msg: `✅ 離線玩家 ${targetName} 採集等級已設定為 Lv.${newLv}` }); } 
                    else { socket.emit('adminResult', { success: false, msg: "❌ 該玩家沒有存檔資料" }); }
                });
            });
        }
    });

    socket.on('adminSetGold', (data) => {
        const { adminPass, targetName, amount, mode } = data; const val = parseInt(amount);
        if (adminPass !== process.env.ADMIN_PASSWORD) { socket.emit('adminResult', { success: false, msg: "❌ 管理員密碼錯誤" }); return; }
        if (isNaN(val)) { socket.emit('adminResult', { success: false, msg: "❌ 請輸入有效數字" }); return; }
        const targetSocketId = Object.keys(gameState.players).find(sid => gameState.players[sid].name === targetName);
        const calcNewGold = (currentGold) => { let finalGold = currentGold; if (mode === 'add') { finalGold += val; } else { finalGold = val; } if (finalGold < 0) finalGold = 0; if (finalGold > 9000000000) finalGold = 9000000000; return finalGold; };
        if (targetSocketId) {
            const p = gameState.players[targetSocketId]; const oldGold = p.gold; p.gold = calcNewGold(p.gold);
            saveMyData(targetSocketId); socket.emit('adminResult', { success: true, msg: `✅ 線上玩家 ${targetName} 金錢已由 ${oldGold} 變更為 ${p.gold}` });
            const diff = p.gold - oldGold; const sign = diff >= 0 ? '+' : '';
            io.to(targetSocketId).emit('battleLog', `<span style="color:#f1c40f; font-weight:bold;"> 管理員調整了你的金錢 (${sign}${diff} G)</span>`); io.to(targetSocketId).emit('playerStatsUpdate', p); 
        } else {
            if(DB.addGoldToUser) { const diff = (mode === 'add') ? val : 0; if(mode === 'add') { DB.addGoldToUser(targetName, diff); socket.emit('adminResult', { success: true, msg: `✅ 已增加離線玩家 ${targetName} 金錢` }); } else { socket.emit('adminResult', { success: false, msg: "❌ 離線玩家暫只支援 add 模式" }); } } 
            else { socket.emit('adminResult', { success: false, msg: "❌ 玩家不在線上" }); }
        }
    });

    // ==========================================
    //  僱員探險系統 — Socket 事件
    // ==========================================

    // 取得僱員資料
    socket.on('getHirelings', () => {
        const p = gameState.players[socket.id];
        if (!p) return;
        if (!p.hirelings) p.hirelings = [];
        
        // 自動檢查探險完成
        checkExpeditionCompletion(p);
        
        socket.emit('hirelingsData', {
            hirelings: p.hirelings,
            maxSlots: getMaxHirelings(p.level),
            zones: EXPEDITION_ZONES,
            shards: p.inventory?.skill_shard || 0
        });
    });

    // 雇用新僱員
    socket.on('hireNew', () => {
        const p = gameState.players[socket.id];
        if (!p) return;
        if (!p.hirelings) p.hirelings = [];

        const maxSlots = getMaxHirelings(p.level);
        if (p.hirelings.length >= maxSlots) {
            socket.emit('errorMessage', `❌ 僱員數量已達上限 (${maxSlots} 人)！升級玩家等級可解鎖更多`);
            return;
        }

        // 雇用費：100 碎片
        const hireCost = 100;
        if ((p.inventory?.skill_shard || 0) < hireCost) {
            socket.emit('errorMessage', `❌ 碎片不足！雇用需要 ${hireCost} 碎片`);
            return;
        }
        p.inventory.skill_shard -= hireCost;

        // 隨機名字
        const usedNames = p.hirelings.map(h => h.name);
        const available = HIRELING_NAMES.filter(n => !usedNames.includes(n));
        const name = available.length > 0 ? available[Math.floor(Math.random() * available.length)] : `僱員${p.hirelings.length + 1}`;

        const newHireling = {
            id: 'hire_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
            name: name,
            level: 1,
            exp: 0,
            maxExp: getHirelingMaxExp(1),
            status: 'idle',    // idle | exploring | resting
            zone: null,
            startTime: null,
            restUntil: null
        };

        p.hirelings.push(newHireling);
        saveMyData(socket.id);
        socket.emit('playerStatsUpdate', p);
        socket.emit('hirelingsData', {
            hirelings: p.hirelings,
            maxSlots: getMaxHirelings(p.level),
            zones: EXPEDITION_ZONES,
            shards: p.inventory?.skill_shard || 0
        });
        socket.emit('errorMessage', `✅ 成功雇用 ${name}！`);
    });

    // 派遣僱員探險
    socket.on('sendExpedition', (data) => {
        const p = gameState.players[socket.id];
        if (!p) return;
        if (!p.hirelings) p.hirelings = [];

        const { hirelingIds, zoneId } = data;
        if (!Array.isArray(hirelingIds) || hirelingIds.length === 0) {
            socket.emit('errorMessage', '❌ 請選擇至少一位僱員');
            return;
        }

        // 驗證區域
        const zone = EXPEDITION_ZONES.find(z => z.id === zoneId);
        if (!zone) {
            socket.emit('errorMessage', '❌ 無效的探險區域');
            return;
        }

        // 計算碎片總費用
        const totalCost = EXPEDITION_COST * hirelingIds.length;
        if ((p.inventory?.skill_shard || 0) < totalCost) {
            socket.emit('errorMessage', `❌ 碎片不足！需要 ${totalCost} 碎片 (${hirelingIds.length} 人 × ${EXPEDITION_COST})`);
            return;
        }

        // 驗證每位僱員
        const now = Date.now();
        let sentCount = 0;
        for (const hid of hirelingIds) {
            const hireling = p.hirelings.find(h => h.id === hid);
            if (!hireling) continue;

            if (hireling.status === 'exploring') {
                socket.emit('errorMessage', `❌ ${hireling.name} 正在探險中！`);
                return;
            }
            if (hireling.status === 'resting' && hireling.restUntil > now) {
                const mins = Math.ceil((hireling.restUntil - now) / 60000);
                socket.emit('errorMessage', `❌ ${hireling.name} 還在休息 (剩餘 ${mins} 分鐘)`);
                return;
            }

            // 檢查僱員等級是否達到區域要求
            if (hireling.level < zone.reqLv) {
                socket.emit('errorMessage', `❌ ${hireling.name} (Lv.${hireling.level}) 等級不足！${zone.name} 需要僱員 Lv.${zone.reqLv}+`);
                return;
            }
        }

        // 全部驗證通過 → 扣碎片 & 出發
        p.inventory.skill_shard -= totalCost;

        for (const hid of hirelingIds) {
            const hireling = p.hirelings.find(h => h.id === hid);
            if (!hireling) continue;
            hireling.status = 'exploring';
            hireling.zone = zoneId;
            hireling.startTime = now;
            hireling.restUntil = null;
            sentCount++;
        }

        saveMyData(socket.id);
        socket.emit('playerStatsUpdate', p);
        socket.emit('hirelingsData', {
            hirelings: p.hirelings,
            maxSlots: getMaxHirelings(p.level),
            zones: EXPEDITION_ZONES,
            shards: p.inventory?.skill_shard || 0
        });
        socket.emit('errorMessage', `✅ 已派出 ${sentCount} 位僱員前往 ${zone.name}！(花費 ${totalCost} 碎片)`);
    });

    // 收取探險結果
    socket.on('collectExpedition', (hirelingId) => {
        const p = gameState.players[socket.id];
        if (!p) return;
        if (!p.hirelings) p.hirelings = [];

        const hireling = p.hirelings.find(h => h.id === hirelingId);
        if (!hireling) {
            socket.emit('errorMessage', '❌ 找不到此僱員');
            return;
        }
        if (hireling.status !== 'exploring') {
            socket.emit('errorMessage', '❌ 此僱員未在探險中');
            return;
        }

        const now = Date.now();
        const elapsed = now - hireling.startTime;
        if (elapsed < EXPEDITION_DURATION) {
            const remaining = EXPEDITION_DURATION - elapsed;
            const hours = Math.floor(remaining / 3600000);
            const mins = Math.ceil((remaining % 3600000) / 60000);
            socket.emit('errorMessage', `⏳ 探險尚未完成！剩餘 ${hours} 小時 ${mins} 分鐘`);
            return;
        }

        // 生成獎勵
        const rewards = generateExpeditionRewards(hireling.zone, hireling.level);
        
        // 給玩家金幣
        p.gold += rewards.gold;

        // 給玩家物品
        if (!p.inventory) p.inventory = {};
        for (const [itemId, qty] of Object.entries(rewards.items)) {
            p.inventory[itemId] = (p.inventory[itemId] || 0) + qty;
        }

        // 僱員獲得經驗
        hireling.exp += rewards.exp;
        // 檢查升級
        while (hireling.exp >= hireling.maxExp) {
            hireling.exp -= hireling.maxExp;
            hireling.level++;
            hireling.maxExp = getHirelingMaxExp(hireling.level);
        }

        // 設定休息狀態
        hireling.status = 'resting';
        hireling.zone = null;
        hireling.startTime = null;
        hireling.restUntil = now + EXPEDITION_REST;

        saveMyData(socket.id);
        socket.emit('playerStatsUpdate', p);

        // 組裝獎勵訊息
        let itemsMsg = Object.entries(rewards.items).map(([id, qty]) => {
            const name = ITEM_NAMES[id] || id;
            return `${name} ×${qty}`;
        }).join('、');

        socket.emit('expeditionResult', {
            hirelingName: hireling.name,
            gold: rewards.gold,
            exp: rewards.exp,
            items: rewards.items,
            itemsText: itemsMsg || '(無)',
            newLevel: hireling.level
        });

        socket.emit('hirelingsData', {
            hirelings: p.hirelings,
            maxSlots: getMaxHirelings(p.level),
            zones: EXPEDITION_ZONES,
            shards: p.inventory?.skill_shard || 0
        });
    });

    // 解雇僱員
    socket.on('dismissHireling', (hirelingId) => {
        const p = gameState.players[socket.id];
        if (!p) return;
        if (!p.hirelings) return;

        const idx = p.hirelings.findIndex(h => h.id === hirelingId);
        if (idx === -1) return;

        const hireling = p.hirelings[idx];
        if (hireling.status === 'exploring') {
            socket.emit('errorMessage', '❌ 此僱員正在探險中，無法解雇！');
            return;
        }

        const name = hireling.name;
        p.hirelings.splice(idx, 1);
        saveMyData(socket.id);
        socket.emit('hirelingsData', {
            hirelings: p.hirelings,
            maxSlots: getMaxHirelings(p.level),
            zones: EXPEDITION_ZONES,
            shards: p.inventory?.skill_shard || 0
        });
        socket.emit('errorMessage', `✅ 已解雇 ${name}`);
    });

    //  [修正] 單注購買 (自選)
    socket.on('buyLottery', (numbers) => {
        const p = gameState.players[socket.id];
        if (!p) return;

        // 1. 檢查限制
        const check = checkLotteryLimit(p, 1); // 買 1 張
        if (!check.pass) {
            socket.emit('errorMessage', check.msg);
            // 即使被擋下，也要更新前端顯示正確的數字 (例如修正那個 83)
            socket.emit('lotteryUpdate', { dailyCount: p.lotteryCount });
            return;
        }

        if (!Array.isArray(numbers) || numbers.length !== 6) { 
            socket.emit('errorMessage', "❌ 請選擇 6 個號碼！"); return; 
        }
        if (p.gold < 100) { socket.emit('errorMessage', "❌ 金錢不足"); return; }

        // 2. 扣款 & 計數
        p.gold -= 100;
        p.lotteryCount += 1; // 增加次數
        
        saveMyData(socket.id); // 存檔
        socket.emit('playerStatsUpdate', p);

        // 3. 執行
        if (LotterySystem.buyTicket(p.name, numbers, 100)) {
            // 成功：保存彩票系統資料 (若 lottery.js 有匯出 saveData)
            if(LotterySystem.saveData) LotterySystem.saveData();

            socket.emit('lotteryResult', { success: true, msg: `✅ 投注成功！(今日: ${p.lotteryCount}/10)` });
            
            // 更新前端
            const info = LotterySystem.getInfo();
            socket.emit('lotteryUpdate', { 
                jackpot: info.jackpot, count: info.totalBets, 
                myBets: LotterySystem.getPlayerBets(p.name),
                myLastBets: LotterySystem.getPlayerLastBets(p.name),
                lastDraw: info.lastDraw, isOpen: info.isOpen,
                dailyCount: p.lotteryCount
            });
            socket.broadcast.emit('lotteryUpdate', { jackpot: info.jackpot, count: info.totalBets, isOpen: info.isOpen });
        } else {
            // 失敗退款
            p.gold += 100;
            p.lotteryCount -= 1;
            saveMyData(socket.id);
            socket.emit('playerStatsUpdate', p);
            socket.emit('errorMessage', "⛔ 購買失敗，系統已關閉");
        }
    });

    //  [修正] 隨機購買 (批量)
    socket.on('buyLotteryRandom', (count) => {
        if (typeof checkRateLimit === 'function' && !checkRateLimit(socket.id, 'lottery', 2000)) { 
            socket.emit('errorMessage', "⏳ 操作太快"); return; 
        }
        const p = gameState.players[socket.id];
        if (!p) return;

        let buyCount = parseInt(count);
        if (isNaN(buyCount) || buyCount < 1) return;

        // 1. 檢查限制
        const check = checkLotteryLimit(p, buyCount); // 買 N 張
        if (!check.pass) {
            socket.emit('errorMessage', check.msg);
            socket.emit('lotteryUpdate', { dailyCount: p.lotteryCount });
            return;
        }

        const cost = buyCount * 100;
        if (p.gold < cost) { socket.emit('errorMessage', `❌ 金錢不足 (需 ${cost} G)`); return; }

        // 2. 扣款 & 計數
        p.gold -= cost;
        p.lotteryCount += buyCount;
        
        saveMyData(socket.id); // 存檔
        socket.emit('playerStatsUpdate', p);

        // 3. 執行
        let successCount = 0;
        for (let i = 0; i < buyCount; i++) {
            const nums = new Set();
            while(nums.size < 6) nums.add(Math.floor(Math.random() * 49) + 1);
            const sortedNums = Array.from(nums).sort((a,b) => a - b);
            if (LotterySystem.buyTicket(p.name, sortedNums, 100)) successCount++;
        }

        if (successCount > 0) {
            if(LotterySystem.saveData) LotterySystem.saveData();

            socket.emit('lotteryResult', { success: true, msg: `✅ 成功購買 ${successCount} 注！(今日: ${p.lotteryCount}/10)` });
            
            const info = LotterySystem.getInfo();
            socket.emit('lotteryUpdate', { 
                jackpot: info.jackpot, count: info.totalBets, 
                myBets: LotterySystem.getPlayerBets(p.name),
                myLastBets: LotterySystem.getPlayerLastBets(p.name),
                lastDraw: info.lastDraw, isOpen: info.isOpen,
                dailyCount: p.lotteryCount
            });
            socket.broadcast.emit('lotteryUpdate', { jackpot: info.jackpot, count: info.totalBets, isOpen: info.isOpen });
        } else {
            p.gold += cost;
            p.lotteryCount -= buyCount;
            saveMyData(socket.id);
            socket.emit('playerStatsUpdate', p);
            socket.emit('errorMessage', "⛔ 購買失敗");
        }
    });
            
    //  [修正] 進入畫面時，就要立刻獲取上期紀錄
    socket.on('getLotteryData', () => { 
        const p = gameState.players[socket.id];
        const info = LotterySystem.getInfo();
        
        let myBets = [];
        let myLastBets = []; // 1. 宣告變數

        if (p) {
            // 獲取當前下注
            myBets = LotterySystem.getPlayerBets(p.name);
            //  2. [關鍵漏掉的這行] 從模組獲取上期資料
            myLastBets = LotterySystem.getPlayerLastBets(p.name); 
        }

        socket.emit('lotteryUpdate', { 
            jackpot: info.jackpot, 
            count: info.totalBets, 
            lastDraw: info.lastDraw,
            isOpen: info.isOpen,
            myBets: myBets,
            myLastBets: myLastBets //  3. 確保這裡有傳出去
        });
    });
    
    socket.on('adminSetMaintenance', (data) => {
        let { adminPass, mode } = data; if (typeof mode === 'string') { mode = (mode === 'true'); }
        if (adminPass !== process.env.ADMIN_PASSWORD) { socket.emit('adminResult', { success: false, msg: "❌ 密碼錯誤" }); return; }
        MAINTENANCE_MODE = !!mode; console.log(`[系統] 維護模式已切換為: ${MAINTENANCE_MODE}`);
        if (MAINTENANCE_MODE) {
            io.emit('errorMessage', " 伺服器進入維護模式，一般玩家將被登出！");
            setTimeout(() => {
                const sockets = io.sockets.sockets;
                for (const [socketId, s] of sockets) {
                    const p = gameState.players[socketId];
                    if (socketId === socket.id) continue;
                    if (p && MAINTENANCE_WHITELIST.includes(p.name)) { io.to(socketId).emit('battleLog', "⚠️ 系統進入維護模式 (您的帳號在白名單內，可繼續操作)"); continue; }
                    if(s) s.disconnect(true); if (gameState.players[socketId]) { delete gameState.players[socketId]; }
                }
                console.log("[系統] 非白名單玩家已踢除");
            }, 3000);
            socket.emit('adminResult', { success: true, msg: "✅ 維護模式已開啟 (一般玩家已踢除，白名單保留)" });
        } else { console.log("[系統] 維護模式已關閉，開放登入"); socket.emit('adminResult', { success: true, msg: "✅ 維護模式已關閉 (開放登入)" }); }
    });

    socket.on('adminResetPass', (data) => {
        const { adminPass, targetName, newPass } = data;
        if (adminPass !== process.env.ADMIN_PASSWORD) { socket.emit('adminResult', { success: false, msg: "❌ 管理員密碼錯誤" }); return; }
        if (!newPass || newPass.length < 5) { socket.emit('adminResult', { success: false, msg: "❌ 新密碼至少需 5 字元" }); return; }
        const salt = bcrypt.genSaltSync(10); const newHash = bcrypt.hashSync(newPass, salt); const fakeToken = 'reset_by_admin_' + Date.now(); 
        DB.changeUserPassword(targetName, newHash, fakeToken, (success) => { if (success) { socket.emit('adminResult', { success: true, msg: `✅ 玩家 [${targetName}] 密碼已重置` }); } else { socket.emit('adminResult', { success: false, msg: "❌ 重置失敗 (資料庫錯誤)" }); } });
    });

    socket.on('adminSetLevel', (data) => {
        const { adminPass, targetName, level } = data;
        const newLv = parseInt(level);

        if (adminPass !== process.env.ADMIN_PASSWORD) { socket.emit('adminResult', { success: false, msg: "❌ 管理員密碼錯誤" }); return; }
        if (isNaN(newLv) || newLv < 1) { socket.emit('adminResult', { success: false, msg: "❌ 等級必須為大於 0 的數字" }); return; }

        const targetSocketId = Object.keys(gameState.players).find(sid => gameState.players[sid].name === targetName);

        if (targetSocketId) {
            const p = gameState.players[targetSocketId];
            p.level = newLv; p.exp = 0;
            p.maxExp = getMaxExpByLevel(newLv); 
            p.baseStats = getStatsByLevel(newLv);
            
            if(!p.skills) p.skills = ['fireball'];
            Object.keys(SKILL_CONFIG).forEach(skillId => {
                const skill = SKILL_CONFIG[skillId];
                if (newLv >= skill.level && !p.skills.includes(skillId)) {
                    p.skills.push(skillId);
                    io.to(targetSocketId).emit('battleLog', `<span style="color:#3498db; font-weight:bold;">系統補發技能：${skill.name}</span>`);
                }
            });

            calculateStats(p); p.hp = p.maxHp; p.mp = p.maxMp;
            saveMyData(targetSocketId);
            const fmtExp = p.maxExp.toLocaleString();
            socket.emit('adminResult', { success: true, msg: `✅ 線上玩家 ${targetName} 設定為 Lv.${newLv} (MaxExp: ${fmtExp})` });
            io.to(targetSocketId).emit('battleLog', `<span style="color:#f1c40f; font-weight:bold;">⚡ 管理員將你的等級調整為 Lv.${newLv}</span>`);
            io.to(targetSocketId).emit('playerStatsUpdate', p);

        } else {
            DB.getUserInfo(targetName, (user) => {
                if (!user) { socket.emit('adminResult', { success: false, msg: `❌ 找不到玩家帳號：${targetName}` }); return; }
                DB.loadPlayer(user.token, (offlineData) => {
                    if (offlineData) {
                        offlineData.level = newLv; offlineData.exp = 0;
                        offlineData.maxExp = getMaxExpByLevel(newLv);
                        offlineData.baseStats = getStatsByLevel(newLv);
                        
                        if(!offlineData.skills) offlineData.skills = ['fireball'];
                        Object.keys(SKILL_CONFIG).forEach(skillId => {
                            const skill = SKILL_CONFIG[skillId];
                            if (newLv >= skill.level && !offlineData.skills.includes(skillId)) {
                                offlineData.skills.push(skillId);
                            }
                        });

                        offlineData.hp = offlineData.baseStats.hp; offlineData.mp = offlineData.baseStats.mp;
                        offlineData.maxHp = offlineData.baseStats.hp; offlineData.maxMp = offlineData.baseStats.mp;

                        DB.savePlayer(user.token, offlineData);
                        const fmtExp = offlineData.maxExp.toLocaleString();
                        socket.emit('adminResult', { success: true, msg: `✅ 離線玩家 ${targetName} 設定為 Lv.${newLv} (MaxExp: ${fmtExp})` });
                    } else { socket.emit('adminResult', { success: false, msg: "❌ 該玩家沒有存檔資料" }); }
                });
            });
        }
    });

    // ---  公會系統事件 (v3.0: 認名制 + 自動刷新) ---

   //  [修正版] 獲取公會資訊 (含無限領取修復 + 轉生顯示)
    //  [修正版] 取得公會資訊 (支援副會長)
    socket.on('getGuildInfo', () => {
        const p = gameState.players[socket.id];
        if (!p) return;

        // [搜尋公會邏輯]
        let foundGuild = null;
        let foundGid = null;
        for (let gid in guildData) {
            const g = guildData[gid];
            if (g.members.includes(p.name) || g.leaderName === p.name) {
                foundGuild = g;
                foundGid = gid;
                break;
            }
        }
        p.guildId = foundGid;

        if (!foundGuild) {
            // --- 沒公會 ---
            const list = Object.values(guildData).map(g => ({
                id: g.id, 
                name: g.name, 
                level: g.level || 1, 
                count: g.members.length, 
                leader: g.leaderName,
                applied: g.applicants.includes(p.name)
            }));
            socket.emit('guildListUpdate', list);
        } else {
            // --- 有公會 ---
            const g = foundGuild;
            
            //  判斷我的職位
            // 注意：這裡同時支援 Name (舊版) 和 ID (新版) 判斷，以防萬一
            const isLeader = (g.leaderName === p.name) || (g.leader === socket.id);
            const isVice = (g.viceLeaderName === p.name) || (g.viceLeader === socket.id);

            // [修正重點] 使用 dailyQuests 內的標記來判斷
            if (!p.dailyQuests) p.dailyQuests = {}; 
            
            const hasClaimed = p.dailyQuests.guildRewardClaimed === true;
            
            const TARGET_MEMBERS = (typeof GUILD_CONFIG !== 'undefined') ? GUILD_CONFIG.stoneTarget : 20;
            const TARGET_GOLD = (typeof GUILD_CONFIG !== 'undefined') ? GUILD_CONFIG.interestTarget : 500000000;
            const INTEREST_RATE = (typeof GUILD_CONFIG !== 'undefined') ? GUILD_CONFIG.interestRate : 0.10;

            let canClaim = false;
            let rewardPreview = { gold: 0, stone: 0 };

            if (!hasClaimed) {
                // A. 強化石
                if (g.members.length >= TARGET_MEMBERS) {
                    rewardPreview.stone = 1;
                }
                // B. 利息
                if (g.gold >= TARGET_GOLD) {
                    let interest = Math.floor(p.gold * INTEREST_RATE);
                    if (interest > 100000000) interest = 100000000; 
                    rewardPreview.gold = interest;
                }

                if (rewardPreview.stone > 0 || rewardPreview.gold > 0) {
                    canClaim = true;
                }
            }

            // 構建成員列表
            const memberList = g.members.map(mName => {
                const onlineP = Object.values(gameState.players).find(pl => pl.name === mName);
                
                let rb = onlineP ? (onlineP.rebirth || 0) : 0;
                let lv = onlineP ? onlineP.level : '(離線)';

                let contributed = 0;
                if (g.memberContribution && g.memberContribution[mName]) {
                    contributed = g.memberContribution[mName];
                }
                
                //  判斷該成員職位
                let rank = '會員';
                if (g.leaderName === mName) rank = '會長';
                else if (g.viceLeaderName === mName) rank = '副會長'; // 需確保 viceLeaderName 有存入

                return { 
                    id: onlineP ? onlineP.id : null, 
                    name: mName, 
                    level: lv, 
                    rank: rank, 
                    online: !!onlineP,
                    contribution: contributed,
                    rebirth: rb 
                };
            });

            // 申請列表：會長或副會長可見
            const applyList = (isLeader || isVice) ? g.applicants.map(aName => {
                const onlineP = Object.values(gameState.players).find(pl => pl.name === aName);
                return { id: onlineP ? onlineP.id : null, name: aName, level: onlineP ? onlineP.level : '?' };
            }) : [];

            socket.emit('myGuildData', {
                name: g.name,
                gold: g.gold,
                notice: g.notice,
                members: memberList,
                applicants: applyList,
                
                //  傳送職位權限給前端
                isLeader: isLeader,
                isVice: isVice,
                
                chatHistory: g.chatHistory || [],
                dailyStatus: {
                    canClaim: canClaim,
                    gold: rewardPreview.gold,
                    stone: rewardPreview.stone
                }
            });
        }
    });

//  [修正] 領取公會每日福利 (寫入 dailyQuests 防止無限領)
    socket.on('claimGuildDaily', () => {
        const p = gameState.players[socket.id];
        if (!p || !p.guildId) return;
        const g = guildData[p.guildId];
        if (!g) return;

        // 確保 dailyQuests 結構存在
        if (!p.dailyQuests) p.dailyQuests = {};

        // 1. 檢查是否已領取
        if (p.dailyQuests.guildRewardClaimed === true) {
            socket.emit('errorMessage', "今天已經領取過了！");
            return;
        }

        const TARGET_MEMBERS = (typeof GUILD_CONFIG !== 'undefined') ? GUILD_CONFIG.stoneTarget : 20;
        const TARGET_GOLD = (typeof GUILD_CONFIG !== 'undefined') ? GUILD_CONFIG.interestTarget : 500000000;
        const INTEREST_RATE = (typeof GUILD_CONFIG !== 'undefined') ? GUILD_CONFIG.interestRate : 0.10;

        let rewardMsg = " 領取成功：";
        let gotReward = false;

        // 發放強化石
        if (g.members.length >= TARGET_MEMBERS) {
            p.inventory['enhance_stone'] = (p.inventory['enhance_stone'] || 0) + 1;
            rewardMsg += "強化石 x1 ";
            gotReward = true;
        }

        // 發放利息
        if (g.gold >= TARGET_GOLD) {
            let interest = Math.floor(p.gold * INTEREST_RATE);
            if (interest > 100000000) interest = 100000000;
            if (interest > 0) {
                p.gold += interest;
                if (p.gold > 9000000000) p.gold = 9000000000;
                rewardMsg += `$${interest.toLocaleString()} (利息) `;
                gotReward = true;
            }
        }

        if (gotReward) {
            //  [關鍵] 標記為「已領取」
            // 因為 dailyQuests 會存入資料庫的 JSON 欄位，所以這個狀態會被保存
            p.dailyQuests.guildRewardClaimed = true; 
            
            saveData(); // 存檔 (重要！)
            socket.emit('playerStatsUpdate', p);
            socket.emit('guildOpSuccess', rewardMsg);
            
            // 立即刷新公會介面 (讓按鈕變灰)
            // 這裡使用 setTimeout 確保數據同步後再刷新
            setTimeout(() => {
                // 重新觸發 getGuildInfo 邏輯
                // 由於這裡是 socket 事件內部，我們可以手動 emit 回去，或者讓前端重整
                // 為了方便，我們直接 emit 新的狀態給前端
                socket.emit('getGuildInfo'); // 前端監聽到這個會自動重畫介面
            }, 100);
            
        } else {
            socket.emit('errorMessage', "公會未達標，暫無福利可領。");
        }
    });

    // 2. 創建公會
    socket.on('createGuild', (guildName) => {
        const p = gameState.players[socket.id];
        if (!p || p.guildId) return;
        if (p.gold < GUILD_CONFIG.createCost) { socket.emit('errorMessage', "金幣不足！"); return; }
        if (!guildName || guildName.length > 8 || guildName.includes('<')) { socket.emit('errorMessage', "名稱無效"); return; }

        const exists = Object.values(guildData).some(g => g.name === guildName);
        if (exists) { socket.emit('errorMessage', "公會名稱已被使用"); return; }

        p.gold -= GUILD_CONFIG.createCost;
        
        const gid = 'g_' + Date.now();
        guildData[gid] = {
            id: gid,
            name: guildName,
            leaderId: socket.id,
            leaderName: p.name, 
            gold: 0,
            members: [p.name],  
            applicants: [],
            notice: "歡迎加入！",
	    memberContribution: {}
        };
        guildData[gid].memberContribution[p.name] = 0;
        p.guildId = gid;
        saveGuilds(); saveData();
        socket.emit('guildOpSuccess', "創建成功！");
        socket.emit('playerStatsUpdate', p);
        socket.emit('getGuildInfo');
    });

    // 3. 申請加入
    socket.on('joinGuildRequest', (targetGid) => {
        const p = gameState.players[socket.id];
        const g = guildData[targetGid];
        if (!p || p.guildId || !g) return;
        
        if (g.members.includes(p.name) || g.applicants.includes(p.name)) {
            socket.emit('errorMessage', "已在名單中"); return;
        }

        g.applicants.push(p.name);
        saveGuilds();
        socket.emit('errorMessage', "申請已發送");
        
        //  通知該公會 (會長會看到紅點)
        broadcastGuildUpdate(targetGid);
    });

    //  [修正版] 處理入會申請 (會長 & 副會長皆可)
    socket.on('handleGuildApply', (data) => {
        const { targetName, action } = data;
        const p = gameState.players[socket.id];
        if (!p || !p.guildId) return;
        
        const g = guildData[p.guildId];
        if (!g) return;

        // 權限檢查：會長 OR 副會長
        const isLeader = (g.leader === socket.id) || (g.leaderName === p.name);
        const isVice = (g.viceLeader === socket.id) || (g.viceLeaderName === p.name);

        if (!isLeader && !isVice) {
            socket.emit('errorMessage', "❌ 權限不足：只有會長或副會長可以審核申請。");
            return;
        }

        // --- 以下為原本的處理邏輯 (不做更動，只需確保上方權限通過) ---
        // 1. 從申請名單移除
        const index = g.applicants.indexOf(targetName);
        if (index > -1) {
            g.applicants.splice(index, 1);
        } else {
            socket.emit('errorMessage', "該玩家已不在申請名單中");
            return;
        }

        if (action === 'reject') {
            socket.emit('errorMessage', `已拒絕 ${targetName} 的申請`);
        } else if (action === 'accept') {
            const guildMaxMembers = getGuildMaxMembers(g);
            if (g.members.length >= guildMaxMembers) {
                socket.emit('errorMessage', `公會成員已滿 (${guildMaxMembers}人)`);
                return;
            }
            if (!g.members.includes(targetName)) {
                g.members.push(targetName);
                // 嘗試通知對方 (如果對方在線)
                const targetP = Object.values(gameState.players).find(pl => pl.name === targetName);
                if (targetP) {
                    targetP.guildId = g.id;
                    targetP.dailyQuests = targetP.dailyQuests || {};
                    delete targetP.dailyQuests.guildRewardClaimed; // 重置獎勵狀態
                    io.to(targetP.id).emit('errorMessage', ` 恭喜！你已加入公會 [${g.name}]`);
                    io.to(targetP.id).emit('refreshGuildUI'); // 讓對方介面刷新
                    if (typeof saveMyData === 'function') saveMyData(targetP.id);
                }
                
                io.to(p.guildId).emit('chatMessage', { name: '公會系統', msg: ` 歡迎新成員 [${targetName}] 加入公會！` });
            }
        }

        if (typeof broadcastGuildUpdate === 'function') broadcastGuildUpdate(p.guildId);
        if (typeof saveGuilds === 'function') saveGuilds();
    });

    // 5. 捐獻資金
    socket.on('donateGuild', (amount) => {
        const p = gameState.players[socket.id];
        if (!p || !p.guildId) return;
        amount = parseInt(amount);
        const g = guildData[p.guildId];
        
        if (amount > 0 && p.gold >= amount) {
            p.gold -= amount;
            g.gold += amount;

            //  [新增] 記錄個人累積捐獻
            if (!g.memberContribution) g.memberContribution = {}; // 防止舊存檔報錯
            if (!g.memberContribution[p.name]) g.memberContribution[p.name] = 0;
            
            g.memberContribution[p.name] += amount;

            saveGuilds(); saveData();
            socket.emit('playerStatsUpdate', p);
            socket.emit('guildOpSuccess', `捐獻了 ${amount} G`);
            
            // 通知全公會更新
            broadcastGuildUpdate(p.guildId);
        } else {
            socket.emit('errorMessage', "金幣不足");
        }
    });

    // 6. 踢人
    socket.on('kickGuildMember', (targetName) => {
        const p = gameState.players[socket.id];
        if (!p || !p.guildId) return;
        const g = guildData[p.guildId];
        
        if (g.leaderName !== p.name) return;
        if (targetName === p.name) return; 

        g.members = g.members.filter(n => n !== targetName);
        
        const targetP = Object.values(gameState.players).find(pl => pl.name === targetName);
        if (targetP) {
            targetP.guildId = null;
            io.to(targetP.id).emit('errorMessage', "你被移出了公會");
            io.to(targetP.id).emit('playerStatsUpdate', targetP);
            // 讓對方回到公會列表介面
            io.to(targetP.id).emit('getGuildInfo');
            saveMyData(targetP.id);
        }
        
        saveGuilds(); 
        
        //  通知全公會更新
        broadcastGuildUpdate(p.guildId);
    });
    
    //  [最終修正] 公會派發獎勵 (會長 & 副會長皆可)
    socket.on('distributeGuildRewards', async (data) => {
        const p = gameState.players[socket.id];
        if (!p || !p.guildId) return;
        
        // 修正變數名稱：確保使用正確的 guildData
        const g = guildData[p.guildId]; 
        if (!g) return;

        //  [權限檢查邏輯修正]
        // 判斷是否為會長 (比對 ID 或 名字)
        const isLeader = (g.leader === socket.id) || (g.leaderName === p.name);
        
        // 判斷是否為副會長 (比對 ID 或 名字)
        const isVice = (g.viceLeader === socket.id) || (g.viceLeaderName && g.viceLeaderName === p.name);

        // 如果既不是會長，也不是副會長 -> 報錯
        if (!isLeader && !isVice) {
            socket.emit('errorMessage', "❌ 權限不足！只有會長或副會長可以操作。");
            return;
        }

        const { targets, gold, itemId, itemCount } = data;
        const goldPerPerson = parseInt(gold) || 0;
        const itemQtyPerPerson = parseInt(itemCount) || 0;

        // 1. 第一步：過濾在線玩家
        const onlineTargets = [];
        targets.forEach(name => {
            if (name === p.name) return; // 排除自己
            const targetP = Object.values(gameState.players).find(pl => pl.name === name);
            if (targetP) {
                onlineTargets.push(targetP); 
            }
        });

        const actualCount = onlineTargets.length; 

        if (actualCount === 0) {
            socket.emit('errorMessage', "所選名單中沒有人在線，取消派發");
            return;
        }

        // 2. 第二步：計算總成本
        const totalGoldNeeded = goldPerPerson * actualCount;
        const totalItemNeeded = itemQtyPerPerson * actualCount;

        // 3. 第三步：檢查餘額
        if (totalGoldNeeded > 0 && g.gold < totalGoldNeeded) {
            socket.emit('errorMessage', `公會資金不足！(實際需 ${totalGoldNeeded} G，目前 ${g.gold} G)`);
            return;
        }

        if (itemId && totalItemNeeded > 0) {
            if (!p.inventory[itemId] || p.inventory[itemId] < totalItemNeeded) {
                socket.emit('errorMessage', `你的背包物品不足！(實際需 ${totalItemNeeded} 個)`);
                return;
            }
        }

        // 4. 第四步：扣除成本
        if (totalGoldNeeded > 0) {
            g.gold -= totalGoldNeeded;
        }
        
        if (itemId && totalItemNeeded > 0) {
            p.inventory[itemId] -= totalItemNeeded;
            if (p.inventory[itemId] <= 0) delete p.inventory[itemId];
        }

        // 5. 第五步：開始派發
        let successCount = 0;
        
        onlineTargets.forEach(targetP => {
            // 給錢
            if (goldPerPerson > 0) {
                targetP.gold = (targetP.gold || 0) + goldPerPerson;
            }
            
            // 給物品
            if (itemId && itemQtyPerPerson > 0) {
                targetP.inventory = targetP.inventory || {};
                targetP.inventory[itemId] = (targetP.inventory[itemId] || 0) + itemQtyPerPerson;
            }

            // 通知對方
            let msg = " 公會獎勵：";
            if (goldPerPerson > 0) msg += ` ${goldPerPerson} G`;
            if (itemId) msg += ` ${itemQtyPerPerson}個物品`;

            io.to(targetP.id).emit('errorMessage', msg); 
            io.to(targetP.id).emit('playerStatsUpdate', targetP);
            
            if (typeof saveMyData === 'function') saveMyData(targetP.id);
            
            successCount++;
            console.log(`[Guild] ${p.name} 派發給: ${targetP.name}`);
        });

        // 6. 存檔與更新
        if (typeof saveGuilds === 'function') saveGuilds();
        if (typeof saveData === 'function') saveData(); 
        
        socket.emit('playerStatsUpdate', p); // 更新操作者介面
        socket.emit('guildOpSuccess', `✅ 成功派發給 ${successCount} 位在線會員！`);
        
        // 更新公會介面
        if (typeof broadcastGuildUpdate === 'function') {
            broadcastGuildUpdate(p.guildId);
        }
    });
    
    // 8.  [新增] 修改公會公告
    socket.on('updateGuildNotice', (newNotice) => {
        const p = gameState.players[socket.id];
        if (!p || !p.guildId) return;
        const g = guildData[p.guildId];

        // 權限檢查 (認名)
        if (g.leaderName !== p.name) {
            socket.emit('errorMessage', "只有會長可以修改公告！");
            return;
        }

        // 驗證內容
        if (!newNotice || newNotice.trim().length === 0) {
            socket.emit('errorMessage', "公告內容不能為空");
            return;
        }
        if (newNotice.length > 100) {
            socket.emit('errorMessage', "公告太長了 (限制100字)");
            return;
        }

        // 更新並存檔
        g.notice = newNotice;
        saveGuilds();
        
        socket.emit('guildOpSuccess', "公告已更新！");
        
        // 通知全公會 (即時更新介面)
        broadcastGuildUpdate(p.guildId);
    });
    
    // 9.  [新增] 公會聊天 (存20條 + 防XSS)
    socket.on('sendGuildChat', (msg) => {
        const p = gameState.players[socket.id];
        if (!p || !p.guildId) return;
        const g = guildData[p.guildId];

        // 1. 驗證訊息
        if (!msg || msg.trim().length === 0) return;
        if (msg.length > 50) { // 限制單條長度
            socket.emit('errorMessage', "訊息太長了 (限50字)");
            return;
        }

        // 2. 初始化陣列 (如果是舊公會資料可能沒有這個欄位)
        if (!g.chatHistory) g.chatHistory = [];

        // 3.  XSS 防護 (Server 端過濾) & 構建訊息物件
        const safeMsg = escapeHtml(msg);
        const chatObj = {
            name: p.name,
            msg: safeMsg,
            time: new Date().toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit' })
        };

        // 4. 存入並保持 20 條限制
        g.chatHistory.push(chatObj);
        if (g.chatHistory.length > 20) {
            g.chatHistory.shift(); // 移除最舊的一條
        }

        saveGuilds();

        // 5. 廣播給同公會的人 (只廣播聊天內容，減少流量)
        // 這裡我們用一個新的事件 'guildChatUpdate'，不要用 broadcastGuildUpdate (那是刷新整個介面)
        Object.values(gameState.players).forEach(member => {
            if (member.guildId === p.guildId) {
                io.to(member.id).emit('guildChatUpdate', g.chatHistory);
            }
        });
    });

// 10.  [新增] 玩家自行退出公會
    socket.on('leaveGuild', () => {
        const p = gameState.players[socket.id];
        if (!p || !p.guildId) return;
        const gid = p.guildId;
        const g = guildData[gid];

        if (!g) {
            // 例外情況：玩家身上有 ID 但公會資料不存在
            p.guildId = null;
            socket.emit('getGuildInfo');
            return;
        }

        // 1. 檢查是否為會長
        if (g.leaderName === p.name) {
            // 如果公會只剩會長一人，則視為解散
            if (g.members.length === 1) {
                delete guildData[gid];
                p.guildId = null;
                saveGuilds(); saveData();
                socket.emit('guildOpSuccess', "公會已解散！");
                socket.emit('getGuildInfo'); // 回到列表頁
                return;
            } else {
                socket.emit('errorMessage', "會長不能直接退出！\n請先踢出所有成員以解散公會。");
                return;
            }
        }

        // 2. 執行退出 (非會長)
        g.members = g.members.filter(n => n !== p.name);
        p.guildId = null;

        // 3. 存檔與通知
        saveGuilds();
        saveData(); // 儲存玩家狀態

        socket.emit('guildOpSuccess', "你已退出公會");
        socket.emit('getGuildInfo'); // 刷新前端，回到公會列表
        
        // 通知原公會的人 (更新人數顯示)
        broadcastGuildUpdate(gid);
        
        console.log(`[Guild] ${p.name} 退出了公會 ${g.name}`);
    });
    
    //  [修正版] 任命副會長 (支援離線玩家)
    socket.on('guildAppointVice', (targetName) => {
        const p = gameState.players[socket.id];
        if (!p || !p.guildId) return;
        const g = guildData[p.guildId]; // 確保變數名稱正確
        if (!g) return;

        // 1. 權限檢查 (只有會長能操作)
        const isLeader = (g.leader === socket.id) || (g.leaderName === p.name);
        if (!isLeader) {
            socket.emit('errorMessage', "❌ 只有會長可以任命副會長。");
            return;
        }

        // 2. 檢查目標是否在公會成員名單中 (直接檢查名字)
        if (!g.members.includes(targetName)) {
            socket.emit('errorMessage', "❌ 該玩家不在公會中。");
            return;
        }

        // 3. 檢查目標是否已經是副會長
        if (g.viceLeaderName === targetName) {
            socket.emit('errorMessage', "該玩家已經是副會長了。");
            return;
        }

        // 4. 執行任命 (覆蓋舊的副會長)
        const oldViceName = g.viceLeaderName || "無";
        g.viceLeaderName = targetName; 
        
        // 嘗試更新 ID (如果對方剛好在線)
        const onlineTarget = Object.values(gameState.players).find(pl => pl.name === targetName);
        g.viceLeader = onlineTarget ? onlineTarget.id : null; 

        // 5. 廣播通知
        let msg = ` 會長任命 [${targetName}] 為新任副會長！`;
        if (oldViceName !== "無" && oldViceName !== targetName) {
            msg += ` (原副會長 [${oldViceName}] 已卸任)`;
        }

        io.to(p.guildId).emit('chatMessage', { name: '公會系統', msg: msg });
        
        // 6. 更新雙方介面
        if (typeof broadcastGuildUpdate === 'function') broadcastGuildUpdate(p.guildId);
        if (typeof saveGuilds === 'function') saveGuilds();
    });

    //  [修正版] 降職副會長 (支援離線玩家)
    socket.on('guildDemoteVice', (targetName) => {
        const p = gameState.players[socket.id];
        if (!p || !p.guildId) return;
        const g = guildData[p.guildId];
        if (!g) return;

        // 1. 權限檢查
        const isLeader = (g.leader === socket.id) || (g.leaderName === p.name);
        if (!isLeader) {
            socket.emit('errorMessage', "❌ 只有會長可以執行降職。");
            return;
        }

        // 2. 檢查目標是否真的是副會長 (比對名字)
        if (g.viceLeaderName !== targetName) {
            socket.emit('errorMessage', "該玩家不是副會長。");
            return;
        }

        // 3. 清除職位
        g.viceLeaderName = null;
        g.viceLeader = null;

        // 4. 廣播
        io.to(p.guildId).emit('chatMessage', { name: '公會系統', msg: ` [${targetName}] 已被解除副會長職務。` });

        // 5. 更新介面
        if (typeof broadcastGuildUpdate === 'function') broadcastGuildUpdate(p.guildId);
        if (typeof saveGuilds === 'function') saveGuilds();
    });

///  [測試用] 強制觸發每日福利 (包含：5億資金 + 20人獎勵)
    socket.on('adminTestDaily', () => {
        const p = gameState.players[socket.id];
        if (!p) return;

        // --- 1. 自動搜尋公會 ---
        let targetGid = p.guildId;
        let targetGuild = guildData[targetGid];

        if (!targetGuild) {
            for (let gid in guildData) {
                const g = guildData[gid];
                if (g.members.includes(p.name) || g.leaderName === p.name) {
                    targetGid = gid;
                    targetGuild = g;
                    p.guildId = gid;
                    break;
                }
            }
        }

        if (!targetGuild) {
            socket.emit('errorMessage', "測試失敗：找不到你所在的公會！");
            return;
        }

        console.log(`[Admin] ${p.name} 正在測試每日福利 (資金+人數)...`);

        // ==========================================
        //  欺騙系統的關鍵步驟
        // ==========================================
        
        // 1. 設定資金達標
        targetGuild.gold = 500000000;

        // 2. [關鍵] 暫時備份成員名單，並填充假人直到 20 人
        const originalMembers = [...targetGuild.members]; // 備份
        
        while (targetGuild.members.length < 20) {
            targetGuild.members.push(`Fake_Member_${targetGuild.members.length}`);
        }
        
        // 3. 修改玩家日期 (觸發重置)
        if (!p.dailyQuests) p.dailyQuests = {};
        p.dailyQuests.date = "2000-01-01"; 

        // 4. 執行結算 (這時候系統會以為有 20 人)
        if (typeof checkDailyReset === 'function') {
            checkDailyReset(p);
        }

        // 5. [關鍵] 還原成員名單 (把假人刪掉，以免介面亂掉)
        targetGuild.members = originalMembers;
        saveGuilds(); // 存回乾淨的檔案

        // ==========================================

        // 更新前端
        socket.emit('playerStatsUpdate', p);
        if (typeof broadcastGuildUpdate === 'function') {
            broadcastGuildUpdate(targetGid);
        }

        // 顯示結果
        if (p.pendingNotice) {
            socket.emit('errorMessage', `【測試成功】\n${p.pendingNotice}`);
            p.pendingNotice = ""; 
        } else {
            socket.emit('errorMessage', "測試完成，但未觸發獎勵。\n請檢查 checkDailyReset 的判斷邏輯。");
        }
    });
    
    //  [修正版] 升級技能請求 (加入 Lv.10 上限)
    socket.on('upgradeSkill', (skillId) => {
        const p = gameState.players[socket.id];
        if (!p) return;

        // 1. 檢查是否擁有該技能
        if (!p.skills.includes(skillId)) return;

        // 2. 確保 skillLevels 存在
        if (!p.skillLevels) p.skillLevels = {};
        if (!p.skillLevels[skillId]) p.skillLevels[skillId] = 1;

        const currentLv = p.skillLevels[skillId];
        
        //  [新增] 限制最高等級 Lv.10
        if (currentLv >= 10) {
            socket.emit('errorMessage', "該技能已達最高等級 (Max)！");
            return;
        }

        // 3. 設定升級公式：消耗碎片 = 目前等級 * 5
        const cost = currentLv * 5; 

        // 4. 檢查碎片是否足夠
        if (!p.inventory['skill_shard'] || p.inventory['skill_shard'] < cost) {
            socket.emit('errorMessage', `碎片不足！升級需要 ${cost} 個技能碎片。`);
            return;
        }

        // 5. 扣除碎片並升級
        p.inventory['skill_shard'] -= cost;
        if (p.inventory['skill_shard'] <= 0) delete p.inventory['skill_shard'];
        
        p.skillLevels[skillId]++;
        
        socket.emit('playerStatsUpdate', p);
        saveMyData(socket.id); // 存檔
        
        // 取得技能名稱用於顯示
        const skillName = (SKILL_CONFIG[skillId]) ? SKILL_CONFIG[skillId].name : skillId;
        socket.emit('errorMessage', `【成功】${skillName} 升級至 Lv.${p.skillLevels[skillId]}！`);
    });
    
    //  [修正版] 碎片商店購買 (後端驗證價格)
    socket.on('shardShopBuy', (itemId) => {
        // 1. 頻率限制 (防止連點攻擊)
        if (typeof checkRateLimit === 'function' && !checkRateLimit(socket.id, 'trade', 500)) return;
        
        const p = gameState.players[socket.id];
        if (!p) return;

        // 2. 從 Server 配置讀取價格 (絕對防禦 F12 修改)
        const shopItem = SHARD_SHOP_CONFIG[itemId];
        
        // 如果物品 ID 不在我們的列表中，視為非法請求
        if (!shopItem) {
            socket.emit('errorMessage', "❌ 非法操作：此物品不在商店中！");
            return;
        }

        const cost = shopItem.cost;
        // 讀取玩家身上的技能碎片數量
        const myShards = (p.inventory && p.inventory['skill_shard']) || 0;

        // 3. 檢查餘額
        if (myShards < cost) {
            socket.emit('errorMessage', `❌ 碎片不足！(需要: ${cost}, 擁有: ${myShards})`);
            return;
        }

        // 4. 扣除碎片 & 給予物品
        p.inventory['skill_shard'] -= cost;
        // 如果碎片歸零，刪除該欄位
        if (p.inventory['skill_shard'] <= 0) delete p.inventory['skill_shard'];

        // 給予購買的物品 (數量 +1)
        p.inventory[itemId] = (p.inventory[itemId] || 0) + 1;

        // 5. 存檔與回報
        saveMyData(socket.id);
        socket.emit('playerStatsUpdate', p);
        
        // 傳送成功訊息 (前端需監聽 shopResult)
        socket.emit('shopResult', { success: true, msg: `✅ 成功兌換 [${ITEM_CONFIG[itemId] ? ITEM_CONFIG[itemId].name : itemId}]！` });
        
        // (可選) 廣播恭喜訊息，如果是貴重物品
        if (cost >= 5000) {
            io.emit('chatMessage', { name: '系統', msg: ` 恭喜 ${p.name} 在碎片商店兌換了神話裝備！` });
        }
    });
    
    //  [修正版] 轉生請求 (硬核版：清空背包/裝備，金幣保留上限 1000萬)
    socket.on('playerRebirth', () => {
        const p = gameState.players[socket.id];
        if (!p) return;

        // 1. 檢查等級 (Lv.400)
        if (p.level < 350) {
            socket.emit('errorMessage', "等級不足！需要 Lv.350 才能轉生。");
            return;
        }

        // 2. 檢查轉生上限 (Max +10)
        const currentRebirth = p.rebirth || 0;
        if (currentRebirth >= 10) {
            socket.emit('errorMessage', "你已達到轉生巔峰，無法再轉生！");
            return;
        }

        // 3. 執行轉生 (重置屬性)
        p.level = 1;
        p.exp = 0;
        p.maxExp = getMaxExpByLevel(1);
        p.baseStats = getStatsByLevel(1);
        p.rebirth = currentRebirth + 1;

        //  4. 硬核重置邏輯
        
        // A. 金幣保留上限 10,000,000
        if (p.gold > 10000000) {
            p.gold = 10000000;
        }
        // (如果小於 1000萬 則維持原樣，不變動)

        // B. 清空背包
        //p.inventory = {}; 

        // C. 清空已穿裝備
        //p.equipment = { weapon: null, armor: null, acc: null };

        // D. 清空強化紀錄
        //p.enhancements = { weapon: 0, armor: 0, acc: 0 };

        // (註：技能等級 p.skills 和 p.skillLevels 這裡依然保留，讓轉生者有優勢)

        // 5. 重算數值
        calculateStats(p);
        p.hp = p.maxHp; // 補滿狀態
        p.mp = p.maxMp;

        // 6. 存檔與通知
        saveMyData(socket.id);
        socket.emit('playerStatsUpdate', p);
        socket.emit('rebirthResult', { success: true, count: p.rebirth });
        
        // 全服廣播
        io.emit('chatMessage', { 
            name: '系統', 
            msg: ` 勇者 [${p.name}] 浴火重生！完成第 ${p.rebirth} 次轉生，一切從頭開始！` 
        });
    });
    

    
    
});

function handleMonsterDeath(room, roomId) { 
    if (room.rewardsGiven) return; room.rewardsGiven = true; 
    room.monster.status = 'dead'; 
    const cfg = MONSTER_CONFIG[room.monsterKey] || room.monster; // Fix for random boss

    //  準備強制存檔列表 (每日任務用)
    const playersToSave = [];

    // 先計算所有玩家獎勵，再一次過 emit battleWon
    let totalGoldForBroadcast = Math.floor(cfg.gold || 0);
    let totalExpForBroadcast = Math.floor(cfg.exp || 0);

    room.players.forEach(pid => { 
        const p = gameState.players[pid]; 
        if (p) { 
            // --- 原本的獎勵邏輯 (保持不變) ---
            const baseGoldGain = Math.floor(cfg.gold || 0);
            let ratio = cfg.level / (p.level || 1); if (ratio < 0.1) ratio = 0.1; if (ratio > 3.0) ratio = 3.0;
            const baseExp = Math.floor(cfg.exp * ratio) || 0;

            // 公會遠征營加成
            let guildBonusPct = 0;
            if (p.guildId && guildData[p.guildId]) {
                guildBonusPct = getGuildBonusPct(guildData[p.guildId]);
                const g = guildData[p.guildId];
                console.log(`[GuildBonus] ${p.name} guildId=${p.guildId} facilities=${JSON.stringify(g.facilities)} expeditionLv=${g.facilities && g.facilities.expedition} bonusPct=${guildBonusPct}`);
            } else {
                console.log(`[GuildBonus] ${p.name} guildId=${p.guildId} guildFound=${!!(p.guildId && guildData[p.guildId])}`);
            }
            const bonusMult = 1 + guildBonusPct / 100;
            const goldGain = Math.floor(baseGoldGain * bonusMult);
            const finalExp = Math.floor(baseExp * bonusMult);

            // 用加成後數字 emit battleWon 給該玩家
            io.to(pid).emit('battleWon', { exp: finalExp, gold: goldGain });

            p.gold += goldGain; if (p.gold > 9000000000) p.gold = 9000000000;
            
            // 這裡建議加上檢查，避免上一題的 ReferenceError
            if (typeof gainExp === 'function') gainExp(p, finalExp, pid); 
            else p.exp += finalExp;

            // 公會加成 log
            if (guildBonusPct > 0) {
                const bonusGold = goldGain - baseGoldGain;
                const bonusExp = finalExp - Math.floor(baseExp);
                io.to(pid).emit('battleLog', `<span style="color:#f39c12"> 公會加成 +${guildBonusPct}%：+${bonusGold}G +${bonusExp}EXP</span>`);
            }

            if (cfg.drops) {
                cfg.drops.forEach(drop => { 
                    if (Math.random() < drop.rate) { 
                        p.inventory[drop.id] = (p.inventory[drop.id] || 0) + 1; 
                        let matName = drop.id; 
                        if (typeof ITEM_CONFIG !== 'undefined' && ITEM_CONFIG[drop.id]) matName = ITEM_CONFIG[drop.id].name; 
                        else if (typeof MATERIAL_CONFIG !== 'undefined' && MATERIAL_CONFIG[drop.id]) matName = MATERIAL_CONFIG[drop.id].name;
                        io.to(pid).emit('battleLog', `<span style="color:#e67e22">獲得：${matName}</span>`); 
                    } 
                }); 
            } 

            // ==========================================
            //  [每日任務更新] (傳入怪物等級)
            // ==========================================
            if (typeof updateDailyProgress === 'function') {
                // 1. 更新擊殺數 (關鍵：傳入 { level: ... } 參數)
                updateDailyProgress(p, 'kill', 1, { level: room.monster.level });
                
                // 2. 更新勝場數
                updateDailyProgress(p, 'win', 0);

                // 3. BOSS 任務檢查
                if (room.monsterKey.includes('boss') || cfg.level >= 100) {
                    updateDailyProgress(p, 'kill_boss', 1);
                }
            }

            // 扣除裝備耐久度（傳入怪物等級計算decay）
            const mLvDeath = (room.monster && room.monster.level) ? room.monster.level : (cfg.level || 1);
            applyBattleDurabilityDecay(p, mLvDeath);

            // 通知前端更新耐久度
            io.to(pid).emit('playerStatsUpdate', p);

            // 加入待強制存檔列表
            playersToSave.push(p);

            saveMyData(pid);
        } 
    }); 

    //  [強制存檔] 確保任務進度寫入硬碟
    if (typeof forceSaveDailyQuests === 'function' && playersToSave.length > 0) {
        forceSaveDailyQuests(playersToSave);
    }

    io.to(roomId).emit('roomInfoUpdate', getRoomPublicInfo(room)); broadcastHubData(); 
}

function saveMyData(socketId) { const p = gameState.players[socketId]; if (p && p.token) { DB.savePlayer(p.token, p); } else { console.log(`[Save Failed] 找不到玩家或 Token 無效 (Socket ID: ${socketId})`); } }


//  [修改] 怪物回合 (群體攻擊)
function monsterPhase(room, roomId) { 
    if (!gameState.battleRooms[roomId]) return; 
    
    // 找出所有存活怪物
    const livingMonsters = room.monsters.filter(m => m.hp > 0);
    if (livingMonsters.length === 0) return;

    // 找出活著的玩家
    let alivePlayers = room.players.filter(pid => gameState.players[pid] && gameState.players[pid].hp > 0); 
    if (alivePlayers.length === 0) return;

    // 讓每隻怪輪流攻擊
    livingMonsters.forEach((m, index) => {
        // 設定延遲，讓訊息不要一次跳出來
        setTimeout(() => {
            // 重新確認玩家是否還活著 (可能被前一隻怪打死了)
            alivePlayers = room.players.filter(pid => gameState.players[pid] && gameState.players[pid].hp > 0);
            if (alivePlayers.length === 0) return;

            // 隨機選一個目標
            const targetId = alivePlayers[Math.floor(Math.random() * alivePlayers.length)]; 
            const target = gameState.players[targetId]; 
            
            // 計算傷害
            let dmg = Math.max(1, (m.atk || 10) - (target.def || 0));
            target.hp -= dmg;

            let logMsg = `<span style="color:#e74c3c;">[${m.name}] 攻擊了 ${target.name}！(${dmg}傷)</span>`;
            
            io.to(roomId).emit('battleLog', logMsg);
            io.to(targetId).emit('playerDamaged', { damage: dmg });
            io.to(targetId).emit('playerStatsUpdate', target);

            // 檢查玩家死亡
            if (target.hp <= 0) {
                target.hp = 0;
                // 死亡跌錢 (1–10% 隨機)
                const losePct = (Math.floor(Math.random() * 10) + 1) / 100;
                const loseGold = Math.floor((target.gold || 0) * losePct);
                if (loseGold > 0) {
                    target.gold = Math.max(0, target.gold - loseGold);
                    io.to(targetId).emit('battleLog', `<span style="color:#e74c3c;"> 死亡懲罰：損失 ${loseGold.toLocaleString()} G (${Math.round(losePct*100)}%)</span>`);
                }
                io.to(targetId).emit('playerStatsUpdate', target);
                io.to(targetId).emit('playerDead');
                io.to(roomId).emit('battleLog', `<span style="color:#7f8c8d;">☠️ ${target.name} 力盡倒下了...</span>`);
                saveMyData(targetId);
                // 3秒後踢出房間
                setTimeout(() => leaveRoomLogic(targetId, roomId), 3000);
            }
        }, index * 1000); // 每隻怪間隔 1 秒
    });
}
//  [修正版] 戰鬥勝利結算 (多怪獎勵 + 等級經驗加成 + 每人獨立掉落)
//  [修正版] 戰鬥勝利結算 (含技能碎片掉落)
//  [修正版] 戰鬥勝利結算 (整合死亡無獎勵與任務邏輯)
function handleBattleWin(room, roomId) {
    if (room.rewardsGiven) return; 
    room.rewardsGiven = true; 
    
    // 1. 先計算「固定」的獎勵 (金幣、以及顯示用的基礎經驗總和)
    let totalBaseGold = 0;
    let baseDisplayExp = 0; // 僅供顯示用

    // 收集這場戰鬥中所有怪物的資料
    // 如果是多怪系統，這裡應該要遍歷 room.monsters
    // 但因為怪物已死 (HP=0)，我們可能需要讀取原始 Config 或從 monsterKey 判斷
    let defeatedMonsters = room.monsters;
    
    // 如果 monsters 為空 (例如單體怪系統)，則嘗試從 room.monsterKey 重建一個臨時列表
    if (!defeatedMonsters || defeatedMonsters.length === 0) {
        const cfg = (typeof MONSTER_CONFIG !== 'undefined') ? MONSTER_CONFIG[room.monsterKey] : null;
        if (cfg) {
            defeatedMonsters = [{ ...cfg, hp: 0 }]; // 模擬一隻死掉的怪
        }
    }

    defeatedMonsters.forEach(m => {
        // 因為 m.hp 歸零，可能需要回查 Config 拿錢
        let gold = m.gold || 0;
        let exp = m.exp || 0;
        
        // 如果實例沒資料，回查 Config
        if (gold === 0 && exp === 0) {
             const cfg = (typeof MONSTER_CONFIG !== 'undefined') ? MONSTER_CONFIG[room.monsterKey] : null;
             if (cfg) { gold = cfg.gold || 0; exp = cfg.exp || 0; }
        }

        totalBaseGold += gold;
        baseDisplayExp += exp;
    });

    // 2. 針對「每一位玩家」進行結算
    const playersToSave = [];
    
    room.players.forEach(pid => {
        const p = gameState.players[pid];
        if (!p) return;

        // 扣除裝備耐久度（取最高怪物等級）
        const mLvWin = defeatedMonsters.reduce((max, m) => {
            const lv = m.level || (MONSTER_CONFIG[room.monsterKey] && MONSTER_CONFIG[room.monsterKey].level) || 1;
            return Math.max(max, lv);
        }, 1);
        applyBattleDurabilityDecay(p, mLvWin);

        //  [核心修正] 檢查是否活著 (HP > 0)
        // 只有活著的人可以領獎、解任務、拿經驗
        if (p.hp > 0) {
            // 公會遠征營加成
            let guildBonusPct = 0;
            console.log(`[GuildBonus-DEBUG] ${p.name} p.guildId="${p.guildId}" guildDataKeys=${Object.keys(guildData).length}`);
            if (p.guildId && guildData[p.guildId]) {
                guildBonusPct = getGuildBonusPct(guildData[p.guildId]);
                console.log(`[GuildBonus] ${p.name} expeditionLv=${guildData[p.guildId].facilities && guildData[p.guildId].facilities.expedition} bonusPct=${guildBonusPct}`);
            }
            const bonusMult = 1 + guildBonusPct / 100;

            // --- A. 發放金幣 ---
            const finalGold = Math.floor(totalBaseGold * bonusMult);
            p.gold = (p.gold || 0) + finalGold;
            if (p.gold > 9000000000) p.gold = 9000000000;
            
            // --- B. 獨立掉落判定 ---
            let myDrops = []; 
            
            // 1. 怪物專屬掉落
            defeatedMonsters.forEach(m => {
                // 回查 Config 確保有掉落表
                let dropsConfig = m.drops;
                if (!dropsConfig) {
                    const cfg = (typeof MONSTER_CONFIG !== 'undefined') ? MONSTER_CONFIG[room.monsterKey] : null;
                    if (cfg) dropsConfig = cfg.drops;
                }

                if (dropsConfig) {
                    dropsConfig.forEach(drop => {
                        if (Math.random() < drop.rate) {
                            // 處理數量 (例如 skill_shard 掉 50 個)
                            const count = drop.count || 1;
                            for(let k=0; k<count; k++) myDrops.push(drop.id);
                        }
                    });
                }
            });

            // 2. 技能碎片全域掉落 (機率 12%)
            if (Math.random() < 0.2) {
                myDrops.push('skill_shard');
            }

            // 3. 發放掉落物
            myDrops.forEach(itemId => {
                if (!p.inventory) p.inventory = {};
                p.inventory[itemId] = (p.inventory[itemId] || 0) + 1;
            });

            // --- C. 經驗值按等級比例計算 ---
            let personalTotalExp = 0;

            defeatedMonsters.forEach(m => {
                // 回查 Config 確保有經驗值和等級
                let mLevel = m.level;
                let mExp = m.exp;
                if (!mLevel || !mExp) {
                    const cfg = (typeof MONSTER_CONFIG !== 'undefined') ? MONSTER_CONFIG[room.monsterKey] : null;
                    if (cfg) { mLevel = cfg.level; mExp = cfg.exp; }
                }
                
                const playerLvl = p.level || 1;
                const monsterLvl = mLevel || 1;
                const baseExp = mExp || 0;

                // 計算等級係數
                let ratio = monsterLvl / playerLvl;
                if (ratio < 0.1) ratio = 0.1; 
                if (ratio > 3.0) ratio = 3.0; 

                personalTotalExp += Math.floor(baseExp * ratio);
            });

            // 給予經驗
            const finalExp = Math.floor(personalTotalExp * bonusMult);
            if (typeof gainExp === 'function') {
                gainExp(p, finalExp, pid);
            } else {
                p.exp += finalExp;
                if (typeof checkLevelUp === 'function') checkLevelUp(p);
            }

            // 公會加成 log
            if (guildBonusPct > 0) {
                const bonusGold = finalGold - totalBaseGold;
                const bonusExp = finalExp - personalTotalExp;
                io.to(pid).emit('battleLog', `<span style="color:#f39c12"> 公會加成 +${guildBonusPct}%：+${bonusGold}G +${bonusExp}EXP</span>`);
            }

            // --- D. 每日任務更新邏輯 ---
            if (typeof updateDailyProgress === 'function') {
                // 擊殺數
                defeatedMonsters.forEach(m => {
                    // 回查等級
                    let mLv = m.level;
                    if(!mLv) {
                         const cfg = (typeof MONSTER_CONFIG !== 'undefined') ? MONSTER_CONFIG[room.monsterKey] : null;
                         if(cfg) mLv = cfg.level;
                    }
                    updateDailyProgress(p, 'kill', 1, { level: mLv || 1 });
                });
                
                // 勝場數
                updateDailyProgress(p, 'win', 1);

                // BOSS 判定
                const hasBoss = defeatedMonsters.some(m => 
                    (m.id && m.id.includes('boss')) || room.monsterKey.includes('boss') || room.monsterKey === 'void_devourer_god'
                );
                if (hasBoss) {
                     updateDailyProgress(p, 'kill_boss', 1);
                }
                
                // 任務提示
                io.to(pid).emit('battleLog', `<span style="color:#2ecc71; font-size:10px;"> 任務進度已更新 (擊殺 +${defeatedMonsters.length})</span>`);
            }

            // 經驗值提示
            io.to(pid).emit('battleLog', `<span style="color:#f1c40f">戰鬥勝利！獲得 ${personalTotalExp} 經驗</span>`);

            playersToSave.push(p);
            io.to(pid).emit('playerStatsUpdate', p);
            
            // 通知勝利 (有獎勵)
            io.to(pid).emit('battleWon', { exp: finalExp, gold: finalGold, drops: myDrops });

        } else {
            //  死亡懲罰：什麼都不給
            // 通知前端：獎勵全是 0
            io.to(pid).emit('battleWon', {
                exp: 0,
                gold: 0,
                drops: [] 
            });

            // 發送額外提示
            io.to(pid).emit('errorMessage', " 你在戰鬥中死亡，無法獲得戰利品...");
            
            // 死亡玩家也需要存檔 (因為可能使用了物品或扣了血)
            playersToSave.push(p);
            io.to(pid).emit('playerStatsUpdate', p);
        }
    });

    // 3. 強制存檔
    if (typeof forceSaveDailyQuests === 'function' && playersToSave.length > 0) {
        // 如果你有針對多人的存檔函式，用這個
        forceSaveDailyQuests(playersToSave);
    } else if (typeof saveMyData === 'function') {
        // 否則逐一存檔
        playersToSave.forEach(p => saveMyData(p.id));
    }
    
    // 4. 標記房間為結束（保留供再戰用），10分鐘後自動清理
    // 勝利後所有玩家離開 socket room，避免收到之後的廣播
    // 注意：restartBattle 時會重新 join
    room.status = 'finished';
    setTimeout(() => {
        if (gameState.battleRooms[roomId] && gameState.battleRooms[roomId].status === 'finished') {
            delete gameState.battleRooms[roomId];
        }
    }, 10 * 60 * 1000);
}


function broadcastTurn(room) { const currentEntityId = room.turnOrder[room.turnIndex]; if (currentEntityId === 'monster') { io.to(room.id).emit('turnUpdate', { currentId: 'monster', name: room.monster.name }); } else { const pid = currentEntityId; const p = gameState.players[pid]; const pName = p ? p.name : 'Unknown'; io.to(room.id).emit('turnUpdate', { currentId: pid, name: pName }); } }


//  [修正版] 處理下一回合 (防卡死強壯版)
function processNextTurn(room, roomId) {
    if (!room || room.status !== 'fighting') return;
    if (!room.turnOrder || room.turnOrder.length === 0) return;

    let loopCount = 0;
    let validTargetFound = false;
    
    // 防止無窮迴圈 (最多跑 30 次查找)
    while (!validTargetFound && loopCount < 30) {
        room.turnIndex++;
        
        // 陣列循環
        if (room.turnIndex >= room.turnOrder.length) {
            room.turnIndex = 0;
        }
        
        const nextEntityId = room.turnOrder[room.turnIndex];

        // --- A. 檢查是否為怪物 ---
        // 嘗試從怪物列表中找到對應 ID 的怪 (例如 'boss' 或 'm_0')
        const monsterAgent = room.monsters.find(m => m.id === nextEntityId);

        if (monsterAgent) {
            // 如果怪物已死，直接跳過
            if (monsterAgent.hp <= 0) {
                loopCount++;
                continue; 
            }

            // 怪物活著，執行動作
            validTargetFound = true;
            
            // 通知前端更新回合 - 統一用 'monster' 讓前端正確鎖掣
            broadcastTurn(room, 'monster', monsterAgent.name);
            
            // 執行怪物攻擊
            // 延遲 800ms 讓玩家看清楚是誰的回合
            setTimeout(() => {
                if (gameState.battleRooms[roomId]) { // 確保房間還在
                    performMonsterTurn(room, roomId, monsterAgent);
                }
            }, 300);
        } 
        // --- B. 檢查是否為玩家 ---
        else {
            const p = gameState.players[nextEntityId];
            
            // 玩家必須在房間內 且 活著
            if (p && room.players.includes(nextEntityId) && p.hp > 0) {
                validTargetFound = true;
                
                // 通知前端輪到玩家 (這會解鎖按鈕)
                broadcastTurn(room, p.id, p.name);
                
                // (選用) 在這裡可以處理 Buff 倒數，例如 p.tempBuffs
                
            } else {
                // 玩家無效 (離線或死亡)，跳過
                // 這裡不做任何事，讓 while 迴圈繼續找下一個
            }
        }
        
        loopCount++;
    }
    
    // [緊急救援] 如果跑了 30 圈都沒人能動 (例如全死光)
    // 強制重置回合給房主，避免卡死
    if (!validTargetFound) {
        console.log(`[系統] 房間 ${roomId} 回合卡死，強制重置給房主`);
        if (room.host && gameState.players[room.host]) {
            room.turnIndex = room.turnOrder.indexOf(room.host);
            broadcastTurn(room, room.host, gameState.players[room.host].name);
        } else {
            // 連房主都不在，可能需要結束戰鬥
            room.status = 'waiting';
        }
    }
}

// 輔助函式：通知前端切換回合
function broadcastTurn(room, currentId, name) {
    // 通知房間內所有人
    io.to(room.id).emit('turnUpdate', {
        currentId: currentId,
        name: name
    });
}


//  [修正] 怪物行動邏輯 (含防負血 & 死亡判定)
function performMonsterTurn(room, roomId, actor) {
    // 1. 尋找活著的玩家目標
    const livingPlayerIds = room.players.filter(pid => {
        const p = gameState.players[pid];
        return p && p.hp > 0;
    });

    if (livingPlayerIds.length === 0) {
        // 全滅，處理戰鬥失敗
        handleBattleDefeat(room, roomId);
        return;
    }

    // 隨機選一個目標
    const targetId = livingPlayerIds[Math.floor(Math.random() * livingPlayerIds.length)];
    const targetPlayer = gameState.players[targetId];

    // 2. 決定使用技能
    let skillToUse = null;
    let skillData = null;
    const monsterKey = room.monsterKey; 
    const availableSkills = (typeof MONSTER_SKILL_MAP !== 'undefined') ? MONSTER_SKILL_MAP[monsterKey] : [];

    if (availableSkills && availableSkills.length > 0) {
        for (let sKey of availableSkills) {
            const sData = MONSTER_SKILL_DATA[sKey];
            if (sData && Math.random() < sData.rate) {
                skillToUse = sKey;
                skillData = sData;
                break; 
            }
        }
    }

    let logMsg = "";

    // 3. 執行傷害計算與扣血 (封裝成函式以避免重複代碼)
    const applyDamage = (pid, damage) => {
        const p = gameState.players[pid];
        if (!p || p.hp <= 0) return; // 已死不鞭屍

        // 扣血 (防負數)
        p.hp -= damage;
        if (p.hp < 0) p.hp = 0;

        // 更新前端血條
        io.to(pid).emit('playerStatsUpdate', p);

        //  死亡判定
        if (p.hp === 0) {
            io.to(roomId).emit('battleLog', `<span style="color:red; font-weight:bold;">☠️ [${p.name}] 力竭倒下了！</span>`);
            io.to(pid).emit('playerDead'); // 通知該玩家死亡畫面
        }
    };

    if (skillToUse && skillData) {
        //console.log(` [Monster] ${actor.name} 使用 ${skillData.name}`);
        const dmgMult = skillData.mult || 1.5;

        if (skillData.type === 'heal') {
            const healAmt = Math.floor(actor.atk * dmgMult);
            actor.hp = Math.min(actor.maxHp, actor.hp + healAmt);
            logMsg = `<span style="color:#2ecc71; font-weight:bold;">♻️ [${actor.name}] 發動 ${skillData.name}！${skillData.msg} (HP +${healAmt.toLocaleString()})</span>`;
        
        } else if (skillData.type === 'aoe') {
            logMsg = `<span style="color:#e74c3c; font-weight:bold;">☄️ [${actor.name}] 發動 ${skillData.name}！${skillData.msg}</span><br>`;
            
            livingPlayerIds.forEach(pid => {
                const p = gameState.players[pid];
                if (p && p.hp > 0) {
                    let dmg = Math.floor((actor.atk * dmgMult) - (p.def * 0.5));
                    if (dmg < 1) dmg = 1;
                    if (p.tempBuffs && p.tempBuffs.def) dmg = Math.floor(dmg * 0.5);
                    
                    logMsg += `<span style="color:#e74c3c; font-size:10px;">.. ${p.name} 受到 ${dmg} 傷害！</span> `;
                    applyDamage(pid, dmg); //  呼叫扣血函式
                }
            });

        } else {
            let dmg = Math.floor((actor.atk * dmgMult) - (targetPlayer.def * 0.5));
            if (dmg < 1) dmg = 1;
            if (targetPlayer.tempBuffs && targetPlayer.tempBuffs.def) dmg = Math.floor(dmg * 0.5);

            logMsg = `<span style="color:#e67e22; font-weight:bold;">⚡ [${actor.name}] 使用 ${skillData.name}！${skillData.msg} 對 ${targetPlayer.name} 造成 ${dmg} 傷害！</span>`;
            applyDamage(targetId, dmg); //  呼叫扣血函式
        }

    } else {
        // ⚔️ 普通攻擊
        let dmg = Math.floor(actor.atk - (targetPlayer.def * 0.5));
        if (dmg < 1) dmg = 1;
        
        if (targetPlayer.tempBuffs && targetPlayer.tempBuffs.def) {
            dmg = Math.floor(dmg * 0.5);
            logMsg = `<span style="color:#aaa;">️ [${actor.name}] 攻擊 ${targetPlayer.name}，但被防禦了！ (-${dmg})</span>`;
        } else {
            logMsg = `<span style="color:#fff;">️ [${actor.name}] 攻擊 ${targetPlayer.name}！造成 ${dmg} 傷害。</span>`;
        }

        applyDamage(targetId, dmg); //  呼叫扣血函式
    }

    // 4. 廣播
    io.to(roomId).emit('battleLog', logMsg);
    io.to(roomId).emit('monstersUpdate', room.monsters);

    // 5. 檢查是否全滅
    const stillAlive = room.players.some(pid => {
        const p = gameState.players[pid];
        return p && p.hp > 0;
    });

    if (!stillAlive) {
        setTimeout(() => handleBattleDefeat(room, roomId), 1000);
        return; // 停止回合循環
    }

    // 6. 下一回合
    setTimeout(() => {
        if (gameState.battleRooms[roomId]) {
            processNextTurn(room, roomId);
        }
    }, 300); 
}

//  [新增] 處理全滅 (如果沒有這個函式，請加上)
function handleBattleDefeat(room, roomId) {
    io.to(roomId).emit('battleLog', `<span style="color:red; font-size:16px; font-weight:bold;">☠️ 隊伍全滅... 戰鬥失敗！</span>`);
    
    // 這裡可以做一些懲罰邏輯 (扣經驗/錢)
    // 簡單起見，直接重置房間或踢人
    
    // 延遲後通知前端
    setTimeout(() => {
        // 通知所有人失敗 (前端可以用 playerDead 處理，或新增 battleDefeat)
        // 這裡我們假設 playerDead 已足夠
        // 或者我們可以清空房間
        delete gameState.battleRooms[roomId];
    }, 2000);
}

function leaveRoomLogic(socketId, roomId) { 
    const room = gameState.battleRooms[roomId]; 
    if (!room) return; 
    
    if (!room.players.includes(socketId)) return;

    const player = gameState.players[socketId]; 
    const name = player ? player.name : 'Unknown';

    if(room.status === 'fighting') { 
        io.to(roomId).emit('battleLog', `<span style="color:#95a5a6">${name} 離開了戰鬥</span>`); 
    }

    room.players = room.players.filter(id => id !== socketId);
    const leavingSocket = io.sockets.sockets.get(socketId);
    if (leavingSocket) leavingSocket.leave(roomId); 
    
    if (room.status === 'fighting' && room.turnOrder) {
        const isCurrentTurnPlayer = (room.turnOrder[room.turnIndex] === socketId);
        room.turnOrder = room.turnOrder.filter(id => id !== socketId);
        
        if (room.players.length === 0) {
            delete gameState.battleRooms[roomId];
            return;
        }

        if (isCurrentTurnPlayer) {
            room.turnIndex--; 
            processNextTurn(room, roomId);
        } 
    } else {
        if (room.players.length === 0) {
             delete gameState.battleRooms[roomId];
             return;
        }
    }

    if (room.host === socketId) room.host = room.players[0]; 
    
    io.to(roomId).emit('roomInfoUpdate', getRoomPublicInfo(room)); 
    broadcastHubData(); 
}

function getRoomPublicInfo(room) { 
    // 過濾掉已斷線的玩家，並確保上限 5 人
    const validPlayers = room.players.filter(pid => gameState.players[pid]).slice(0, 5); 
    room.players = validPlayers; 
    
    // 如果房主斷線，移交房主權限
    if (validPlayers.length > 0 && !validPlayers.includes(room.host)) room.host = validPlayers[0]; 
    
    // 整理玩家資訊列表
    const playerDetails = validPlayers.map(pid => { 
        const p = gameState.players[pid]; 
        return { 
            id: p.id, 
            name: p.name, 
            hp: p.hp, 
            maxHp: p.maxHp, 
            mp: p.mp, 
            maxMp: p.maxMp, 
            level: p.level,
            rebirth: p.rebirth || 0 //  [修改] 加入轉生次數
        }; 
    }); 
    
    // 判斷當前回合是誰
    let currentTurnId = null; 
    if (room.status === 'fighting' && room.turnOrder && room.turnIndex >= 0) { 
        currentTurnId = room.turnOrder[room.turnIndex]; 
    }
    
    return { 
        id: room.id, 
        host: room.host, 
        status: room.status, 
        players: playerDetails, 
        monsterName: room.monster.name, 
        monsterKey: room.monsterKey, 
        monsterMaxHp: room.monster.maxHp, 
        monsterHp: room.monster.hp, 
        currentTurnId: currentTurnId 
    }; 
}

function gainExp(player, amount, socketId) { 
    player.exp += amount; 
    io.to(socketId).emit('battleLog', `獲得 ${amount} 經驗`); 
    
    while (player.exp >= player.maxExp) { 
        player.level++; 
        player.exp -= player.maxExp; 
        
        player.baseStats = getStatsByLevel(player.level);
        player.maxExp = getMaxExpByLevel(player.level);

        calculateStats(player); 
        player.hp = player.maxHp; 
        player.mp = player.maxMp; 

        io.to(socketId).emit('battleLog', `<span style="color:#f1c40f; font-weight:bold;">升級！LV.${player.level}</span>`); 
        
        if(!player.skills) player.skills = ['fireball'];
        Object.keys(SKILL_CONFIG).forEach(skillId => {
            const skill = SKILL_CONFIG[skillId];
            if (player.level >= skill.level && !player.skills.includes(skillId)) {
                player.skills.push(skillId);
                io.to(socketId).emit('battleLog', `<span style="color:#3498db; font-weight:bold;">學會技能：${skill.name}！</span>`);
            }
        });
    } 
    
    io.to(socketId).emit('playerStatsUpdate', player); 
    saveMyData(socketId); 
}

function shuffleArray(array) { for (let i = array.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [array[i], array[j]] = [array[j], array[i]]; } return array; }

function broadcastHubData() { 
    let cityCounts = {}; 
    Object.values(gameState.players).forEach(p => { 
        const loc = p.currentCity || p.mapId;
        if (loc) cityCounts[loc] = (cityCounts[loc] || 0) + 1; 
    }); 
    
    let roomsList = Object.values(gameState.battleRooms).map(r => {
        const hostPlayer = gameState.players[r.host];
        let hostName = 'Unknown';

        if (hostPlayer) {
            hostName = hostPlayer.name;
        } else if (r.hostName) {
            hostName = r.hostName;
        }

        let monsterName = "未知怪物";
        
        if (r.monsterKey === 'chaos_boss' && r.monster) {
            monsterName = r.monster.name;
        } else if (typeof MONSTER_CONFIG !== 'undefined' && MONSTER_CONFIG[r.monsterKey]) {
            monsterName = MONSTER_CONFIG[r.monsterKey].name;
        } else if (r.monster) {
            monsterName = r.monster.name || "Unknown";
        }

        return { 
            id: r.id, 
            monsterKey: r.monsterKey, 
            monsterName: monsterName,
            status: r.status, 
            playerCount: r.players.length,
            hostName: hostName,
            roomType: r.roomType || 'public'  // 'solo' | 'public' | 'private'
        };
    }); 
    
    io.emit('hubDataUpdate', { cityCounts, roomsList }); 
}

function getBossData() {
    let ranking = [];
    for (let sid in WORLD_BOSS.damageLog) {
        const pName = gameState.players[sid] ? gameState.players[sid].name : "未知";
        ranking.push({ name: pName, dmg: WORLD_BOSS.damageLog[sid] });
    }
    ranking.sort((a, b) => b.dmg - a.dmg); 
    
    let timeLeft = 0;
    if (WORLD_BOSS.active) {
        const elapsedTime = Date.now() - WORLD_BOSS.startTime;
        timeLeft = Math.max(0, BOSS_TIME_LIMIT - elapsedTime);
    }

    return {
        active: WORLD_BOSS.active,
        name: WORLD_BOSS.name,
        hp: WORLD_BOSS.hp,
        maxHp: WORLD_BOSS.maxHp,
        top5: ranking.slice(0, 5),
        remainingTime: timeLeft 
    };
}




function drawLottery() {
    console.log("[彩票] 正在進行攪珠...");

    try {
        // 1. 呼叫模組開獎
        // 這個 drawResult 是從 lottery.js 回傳的 { result, winners }
        // 注意：lottery.js 必須已經修改過，回傳的 winners 裡要有 items 陣列
        const drawResult = LotterySystem.draw(); 
        
        console.log("[Debug] LotterySystem 回傳:", JSON.stringify(drawResult));

        if (!drawResult || !drawResult.result) {
            console.error("❌ 開獎失敗：LotterySystem 回傳了無效的數據");
            return;
        }

        const { result, winners } = drawResult;

        // 2. 廣播開獎號碼
        if (typeof io !== 'undefined') {
            io.emit('chatMessage', { name: '彩票', msg: ` 開獎結果: [ ${result.join(', ')} ]` });
        }

        // 3. 發獎給中獎者
        let winnerNames = [];

        if (winners && winners.length > 0) {
            winners.forEach(w => {
                console.log(`[彩票] 處理中獎者: ${w.name}`);

                // 尋找該玩家的 Socket ID (如果在線)
                const targetSocketId = Object.keys(gameState.players).find(
                    sid => gameState.players[sid].name === w.name
                );

                // 無論在線或離線，都要發獎
                if (targetSocketId) {
                    // --- 在線玩家 ---
                    const p = gameState.players[targetSocketId];
                    let msg = ` 彩票中獎！(${w.hits}星)`;

                    // 給錢
                    if (w.prize > 0) {
                        p.gold += w.prize;
                        if (p.gold > 9000000000) p.gold = 9000000000;
                        msg += ` 獲得 $${w.prize.toLocaleString()}`;
                    }

                    // 給物品 (新增的部分)
                    if (w.items && w.items.length > 0) {
                        let itemNames = [];
                        w.items.forEach(reward => {
                            if (!p.inventory[reward.id]) p.inventory[reward.id] = 0;
                            p.inventory[reward.id] += reward.count;
                            
                            // 取得物品中文名稱 (顯示用)
                            let iName = reward.id;
                            if (ITEM_CONFIG[reward.id]) iName = ITEM_CONFIG[reward.id].name;
                            else if (MATERIAL_CONFIG[reward.id]) iName = MATERIAL_CONFIG[reward.id].name;
                            
                            itemNames.push(`${iName} x${reward.count}`);
                        });
                        msg += ` 及物品 [${itemNames.join(', ')}]`;
                    }

                    saveMyData(targetSocketId); 
                    
                    if (typeof io !== 'undefined') {
                        io.to(targetSocketId).emit('playerStatsUpdate', p);
                        io.to(targetSocketId).emit('errorMessage', msg); // 用紅色橫幅通知
                        io.to(targetSocketId).emit('battleLog', `<span style="color:#f1c40f">${msg}</span>`);
                    }

                } else {
                    // --- 離線玩家 ---
                    // 必須讀取 DB -> 修改 -> 存回
                    DB.getUserInfo(w.name, (user) => {
                        if (user) {
                            DB.loadPlayer(user.token, (offlineData) => {
                                if (offlineData) {
                                    // 給錢
                                    if (w.prize > 0) {
                                        offlineData.gold = (offlineData.gold || 0) + w.prize;
                                        if (offlineData.gold > 9000000000) offlineData.gold = 9000000000;
                                    }
                                    
                                    // 給物品
                                    if (w.items && w.items.length > 0) {
                                        if (!offlineData.inventory) offlineData.inventory = {};
                                        w.items.forEach(reward => {
                                            offlineData.inventory[reward.id] = (offlineData.inventory[reward.id] || 0) + reward.count;
                                        });
                                    }

                                    DB.savePlayer(user.token, offlineData);
                                    console.log(`[Lottery] 已發獎給離線玩家 ${w.name}`);
                                }
                            });
                        }
                    });
                }

                // 收集名單 (只收集 3 星以上)
                if (w.hits >= 3) {
                    let title = w.hits === 6 ? '頭獎' : (w.hits === 5 ? '二獎' : (w.hits === 4 ? '三獎' : '安慰獎'));
                    winnerNames.push(`${w.name}(${title})`);
                }
            });
        } else {
            console.log("[彩票] 本期無人中獎");
        }

        // 4. 廣播中獎名單
        if (typeof io !== 'undefined') {
            if (winnerNames.length > 0) {
                io.emit('chatMessage', { name: '彩票', msg: ` 恭喜本期幸運兒: ${winnerNames.join(', ')}` });
            } else {
                io.emit('chatMessage', { name: '彩票', msg: ` 本期無人中大獎，獎金累積至下一期！` });
            }

            // 5. 更新全服介面 (重置下注數，更新獎池)
            const info = LotterySystem.getInfo();
            io.emit('lotteryUpdate', { 
                jackpot: info.jackpot, 
                count: 0, 
                lastResult: info.lastDraw,
                isOpen: info.isOpen
            });
        }

        console.log("[彩票] 開獎流程完成！");

    } catch (error) {
        console.error(" [彩票系統嚴重錯誤]:", error);
    }
}

function startWorldBossEvent() {
    if (WORLD_BOSS.active) {
        console.log("[系統] BOSS 已經存在，跳過召喚");
        return;
    }

    console.log("[系統] 正在召喚世界 BOSS...");

    WORLD_BOSS.active = true;
    WORLD_BOSS.hp = WORLD_BOSS.maxHp;
    WORLD_BOSS.damageLog = {};
    WORLD_BOSS.players = [];
    WORLD_BOSS.startTime = Date.now();

    if (WORLD_BOSS.wipeTimer) clearTimeout(WORLD_BOSS.wipeTimer);
    if (WORLD_BOSS.attackInterval) clearInterval(WORLD_BOSS.attackInterval);

    WORLD_BOSS.wipeTimer = setTimeout(() => {
        handleBossWipe();
    }, BOSS_TIME_LIMIT);

    startBossAI();

    io.emit('chatMessage', { name: '系統', msg: `⚠️ [${WORLD_BOSS.name}] 降臨！限時 9 分鐘，否則將毀滅世界！` });
    io.emit('worldBossUpdate', getBossData());
}

function handleBossWipe() {
    if (!WORLD_BOSS.active) return;

    WORLD_BOSS.active = false;
    if (WORLD_BOSS.attackInterval) clearInterval(WORLD_BOSS.attackInterval);

    io.emit('chatMessage', { name: '系統', msg: `☠️ 時間到！[${WORLD_BOSS.name}] 釋放了「虛空大崩塌」！全服討伐失敗！` });

    WORLD_BOSS.players.forEach(sid => {
        const p = gameState.players[sid];
        if (p) {
            p.hp = 0; 
            io.to(sid).emit('playerStatsUpdate', p);
            io.to(sid).emit('playerDead'); 
            io.to(sid).emit('battleLog', `<span style="color:red; font-weight:bold; font-size:20px;">☠️ 滅團！你受到了 999999999 點傷害！</span>`);
        }
    });

    announceRanking(false); 

    io.emit('worldBossUpdate', { active: false });
    saveAllData();
}

function startBossAI() {
    if (WORLD_BOSS.attackInterval) clearInterval(WORLD_BOSS.attackInterval);

    console.log("✅ [系統] BOSS AI 已啟動，準備攻擊...");

    WORLD_BOSS.attackInterval = setInterval(() => {
        if (!WORLD_BOSS.active || WORLD_BOSS.hp <= 0) {
            clearInterval(WORLD_BOSS.attackInterval);
            return;
        }

        WORLD_BOSS.players = WORLD_BOSS.players.filter(sid => gameState.players[sid]);

        let validTargets = WORLD_BOSS.players.filter(sid => {
            const p = gameState.players[sid];
            return p && p.hp > 0;
        });

        if (validTargets.length > 0) {
            let targets = [];
            let tempPool = [...validTargets];
            let hitCount = Math.min(3, tempPool.length); 

            for (let i = 0; i < hitCount; i++) {
                const rIdx = Math.floor(Math.random() * tempPool.length);
                targets.push(tempPool[rIdx]);
                tempPool.splice(rIdx, 1);
            }

            targets.forEach(sid => {
                const victim = gameState.players[sid];
                if (!victim) return;

                const dmg = 150000 + Math.floor(Math.random() * 50000); 

                victim.hp -= dmg;
                if (victim.hp < 0) victim.hp = 0;

                io.to(sid).emit('playerDamaged', { damage: dmg });
                io.to(sid).emit('playerStatsUpdate', victim);

                const logMsg = `<span style="color:#c0392b; font-weight:bold;">☠️ 虛空滅世者 攻擊了 ${victim.name}! (${dmg})</span>`;
                io.to('world_boss_room').emit('battleLog', logMsg);

                if (victim.hp === 0) {
                    io.to(sid).emit('playerDead');
                    io.to('world_boss_room').emit('battleLog', `<span style="color:#7f8c8d;"> ${victim.name} 力盡倒下了...</span>`);
                }
            });
        }
        
        saveAllData();
        io.emit('worldBossUpdate', getBossData());

    }, 3000); 
}

function endWorldBoss() {
    WORLD_BOSS.active = false;
    
    if (WORLD_BOSS.wipeTimer) clearTimeout(WORLD_BOSS.wipeTimer);
    if (WORLD_BOSS.attackInterval) clearInterval(WORLD_BOSS.attackInterval);

    io.emit('chatMessage', { name: '系統', msg: ` [${WORLD_BOSS.name}] 已被討伐！感謝各位勇者的付出！` });
    
    let ranking = [];
    for (let sid in WORLD_BOSS.damageLog) {
        let pName = "未知勇者";
        if (gameState.players[sid]) {
            pName = gameState.players[sid].name;
        }
        
        ranking.push({ 
            id: sid, 
            name: pName, 
            dmg: WORLD_BOSS.damageLog[sid] 
        });
    }
    ranking.sort((a, b) => b.dmg - a.dmg);

    let top5 = ranking.slice(0, 5);

    LAST_BOSS_RANKING = top5;
    io.emit('updateHubRanking', LAST_BOSS_RANKING);

    let rankMsg = `<div style="border: 2px solid #f1c40f; padding: 5px; margin: 5px 0; background: rgba(0,0,0,0.5);">`;
    rankMsg += `<b style="color:#f1c40f; font-size:12px;"> 討伐成功！輸出名單</b><br>`;
    top5.forEach((r, i) => {
        let medal = i===0 ? '' : (i===1 ? '' : (i===2 ? '' : `#${i+1}`));
        let dmgText = (r.dmg / 100000000).toFixed(2) + "億";
        if (r.dmg < 100000000) dmgText = (r.dmg / 10000).toFixed(0) + "萬";
        let rowStyle = i < 3 ? "color:#fff; font-weight:bold;" : "color:#ccc;";
        rankMsg += `<span style="${rowStyle}">${medal} ${r.name}: ${dmgText}</span><br>`;
    });
    rankMsg += `</div>`;
    io.to('world_boss_room').emit('battleLog', rankMsg);

    ranking.forEach((entry, index) => {
        const p = gameState.players[entry.id];
        if (!p) return;

        let rewardMsg = "";
        let goldReward = 0;
        
        if (index === 0) { 
            goldReward = 300000000; 
            rewardMsg = "3億 金幣"; 
        } 
        else if (index < 10) { 
            goldReward = 100000000; 
            rewardMsg = "1億 金幣"; 
        } 
        else { 
            goldReward = 20000000; 
            rewardMsg = "2000萬 金幣"; 
        }

        p.gold += goldReward;
        if (p.gold > 9000000000) p.gold = 9000000000;

        const socket = io.sockets.sockets.get(entry.id);
        if (socket) {
            socket.emit('battleWon', { 
                gold: goldReward, 
                ranking: top5 
            }); 
            
            socket.emit('errorMessage', ` 討伐獎勵：${rewardMsg}`);
            socket.emit('playerStatsUpdate', p);
        }
    });
    
    io.emit('worldBossUpdate', { active: false });
    saveAllData();
}

function announceRanking(isVictory) {
    let ranking = [];
    for (let sid in WORLD_BOSS.damageLog) {
        let pName = "未知勇者";
        if (gameState.players[sid]) {
            pName = gameState.players[sid].name;
        } 
        
        ranking.push({ 
            id: sid, 
            name: pName, 
            dmg: WORLD_BOSS.damageLog[sid] 
        });
    }
    ranking.sort((a, b) => b.dmg - a.dmg);
    
    let top5 = ranking.slice(0, 5);

    LAST_BOSS_RANKING = top5;
    io.emit('updateHubRanking', LAST_BOSS_RANKING);

    let title = isVictory ? " 討伐成功！輸出名單" : "☠️ 討伐失敗... 輸出名單";
    let titleColor = isVictory ? "#f1c40f" : "#95a5a6";

    let rankMsg = `<div style="border: 2px solid ${titleColor}; padding: 5px; margin: 5px 0; background: rgba(0,0,0,0.5);">`;
    rankMsg += `<b style="color:${titleColor}; font-size:12px;">${title}</b><br>`;
    
    top5.forEach((r, i) => {
        let medal = i===0 ? '' : (i===1 ? '' : (i===2 ? '' : `#${i+1}`));
        let dmgText = (r.dmg / 100000000).toFixed(2) + "億";
        if (r.dmg < 100000000) dmgText = (r.dmg / 10000).toFixed(0) + "萬";
        let rowStyle = i < 3 ? "color:#fff; font-weight:bold;" : "color:#ccc;";
        rankMsg += `<span style="${rowStyle}">${medal} ${r.name}: ${dmgText}</span><br>`;
    });
    rankMsg += `</div>`;

    io.to('world_boss_room').emit('battleLog', rankMsg);

    if (isVictory) {
        ranking.forEach((entry, index) => {
            const p = gameState.players[entry.id];
            if (!p) return; 

            let rewardMsg = "";
            let goldReward = 0;

            if (index === 0) { goldReward = 300000000; rewardMsg = " MVP獎勵: 3億 金幣"; } 
            else if (index < 10) { goldReward = 100000000; rewardMsg = " 前十獎勵: 1億 金幣"; } 
            else { goldReward = 20000000; rewardMsg = " 參加獎: 2000萬 金幣"; }

            p.gold += goldReward;

            const socket = io.sockets.sockets.get(entry.id);
            if (socket) {
                socket.emit('battleWon', { 
                    gold: 0, 
                    ranking: top5 
                }); 
                
                socket.emit('errorMessage', rewardMsg); 
                socket.emit('playerStatsUpdate', p);
            }
        });
    } else {
        WORLD_BOSS.players.forEach(sid => {
            const socket = io.sockets.sockets.get(sid);
            if (socket) {
                socket.emit('battleWon', { 
                    gold: 0, 
                    ranking: top5 
                }); 
            }
        });
    }
}

function saveAllData() {
    Object.values(gameState.players).forEach(p => {
        if (p.token) {
            if (!p.enhancements) {
                p.enhancements = { weapon: 0, armor: 0, acc: 0 };
            }
            DB.savePlayer(p.token, p);
        }
    });
}

// ==========================================
//  僱員探險完成檢查 (自動更新狀態)
// ==========================================
function checkExpeditionCompletion(p) {
    if (!p || !p.hirelings) return;
    const now = Date.now();
    p.hirelings.forEach(h => {
        // 休息結束 → 回到空閒
        if (h.status === 'resting' && h.restUntil && now >= h.restUntil) {
            h.status = 'idle';
            h.restUntil = null;
        }
    });
}

function checkLotteryLimit(p, amountToBuy) {
        const MAX_DAILY_LOTTERY = 10;

        // ==========================================
        //  [修正] 從 LotterySystem 讀取真實已購買數量
        //  而非依賴記憶體中的 p.lotteryCount (F5 會重置)
        // ==========================================
        let actualCount = 0;
        if (typeof LotterySystem !== 'undefined' && typeof LotterySystem.getPlayerBets === 'function') {
            const myBets = LotterySystem.getPlayerBets(p.name);
            actualCount = Array.isArray(myBets) ? myBets.length : 0;
        }

        // 同步 p.lotteryCount 為真實數字 (修正 F5 重置問題)
        p.lotteryCount = actualCount;

        // 檢查
        if (p.lotteryCount >= MAX_DAILY_LOTTERY) {
            return { pass: false, msg: `❌ 今日購買上限已達 (${MAX_DAILY_LOTTERY} 張)！` };
        }
        
        if (p.lotteryCount + amountToBuy > MAX_DAILY_LOTTERY) {
            const remaining = MAX_DAILY_LOTTERY - p.lotteryCount;
            return { pass: false, msg: `⚠️ 超過今日限額！你只能再買 ${remaining} 張。` };
        }

        return { pass: true };
    }
    

// ==========================================
//  [修正版] 存檔系統 (改用 Username 存任務)
// ==========================================
// ==========================================
//  [新增] 升級檢查函式 (放在 server.js 任何地方皆可，建議放底部)
// ==========================================
function checkLevelUp(player) {
    if (!player) return;
    let isLevelUp = false;

    // 使用 while 迴圈，支援一次升多級 (例如任務經驗很多時)
    while (player.exp >= player.maxExp) {
        player.exp -= player.maxExp;
        player.level++;
        isLevelUp = true;

        // 1. 更新下一級所需的經驗值
        // (假設你有 getMaxExpByLevel 函式，如果沒有，請用你的邏輯替換)
        if (typeof getMaxExpByLevel === 'function') {
            player.maxExp = getMaxExpByLevel(player.level);
        } else {
            player.maxExp = Math.floor(player.maxExp * 1.2); // 備用邏輯
        }

        // 2. 更新基礎數值
        // (假設你有 getStatsByLevel 函式)
        if (typeof getStatsByLevel === 'function') {
            player.baseStats = getStatsByLevel(player.level);
        }

        // 3. 重新計算詳細屬性並 "回滿血"
        if (typeof calculateStats === 'function') {
            calculateStats(player);
        }
        player.hp = player.maxHp;
        player.mp = player.maxMp;
    }

    // 如果真的有升級，通知前端
    if (isLevelUp) {
        console.log(`[LevelUp] 玩家 ${player.name} 升到了 Lv.${player.level}`);
        
        const s = io.sockets.sockets.get(player.id);
        if (s) {
            s.emit('battleLog', `<span style="color:#f1c40f; font-weight:bold;"> 恭喜升級！等級提升至 ${player.level}</span>`);
            s.emit('playerStatsUpdate', player);
        }
    }
}

function saveData() {
    try {
        // 1. 先讀取舊的存檔 (以免覆蓋掉不在線上的人)
        let persistentData = {};
        if (fs.existsSync('daily_quests.json')) {
            try {
                persistentData = JSON.parse(fs.readFileSync('daily_quests.json', 'utf8'));
            } catch (e) { persistentData = {}; }
        }

        // 2. 更新目前線上玩家的進度
        if (gameState && gameState.players) {
            Object.values(gameState.players).forEach(p => {
                if (p.name && p.dailyQuests) {
                    // 以 "名稱" 為 Key 存入
                    persistentData[p.name] = p.dailyQuests;
                }
            });
        }

        // 3. 寫入檔案
        fs.writeFileSync('daily_quests.json', JSON.stringify(persistentData, null, 2));
        // console.log("[System] 每日任務資料已保存 (By Name)");
    } catch (err) {
        console.error("❌ 存檔失敗:", err);
    }
}

// ==========================================
//  [新增] 強制儲存指定玩家的每日任務
// ==========================================
function forceSaveDailyQuests(playersToSave) {
    try {
        const fs = require('fs');
        let diskData = {};

        // 1. 先讀取舊檔案 (避免覆蓋其他人的資料)
        if (fs.existsSync('daily_quests.json')) {
            try {
                diskData = JSON.parse(fs.readFileSync('daily_quests.json', 'utf8'));
            } catch (e) { diskData = {}; }
        }

        // 2. 更新這些玩家的資料
        let count = 0;
        playersToSave.forEach(p => {
            if (p && p.name && p.dailyQuests) {
                diskData[p.name] = p.dailyQuests; // 用名字當 Key
                count++;
            }
        });

        // 3. 寫入硬碟
        if (count > 0) {
            fs.writeFileSync('daily_quests.json', JSON.stringify(diskData, null, 2));
            console.log(`[Daily] 已強制寫入 ${count} 名玩家的任務進度到硬碟`);
        }
    } catch (err) {
        console.error("❌ 強制存檔失敗:", err);
    }
}

// ==========================================
//  [新增] 公會資料更新廣播
// ==========================================
function broadcastGuildUpdate(guildId) {
    if (!guildId) return;
    
    // 遍歷所有在線玩家
    Object.values(gameState.players).forEach(p => {
        // 如果玩家屬於這個公會
        if (p.guildId === guildId) {
            const s = io.sockets.sockets.get(p.id);
            if (s) {
                // 發送一個信號，叫前端重新索取資料
                s.emit('refreshGuildUI');
            }
        }
    });
}

function calculateStats(p) {
    if (!p.baseStats) return;
    
    // 1. 重置為基礎數值 (來自等級)
    p.maxHp = p.baseStats.hp;
    p.maxMp = p.baseStats.mp;
    p.atk = p.baseStats.atk;
    p.def = p.baseStats.def;

    if (!p.enhancements || typeof p.enhancements !== 'object') {
        p.enhancements = {};
    }

    // 2. 加上裝備加成 (使用指數公式，並套用耐久度衰減)
    if (!p.durability) p.durability = {};
    Object.keys(p.equipment).forEach(slot => {
        const itemId = p.equipment[slot]; 
        
        if (itemId && ITEM_CONFIG[itemId]) {
            const item = ITEM_CONFIG[itemId];
            const lv = p.enhancements[itemId] || 0; 

            let multiplier = 1;
            if (lv > 0) {
                multiplier = Math.pow(1.1, lv); 
            }

            // 耐久度衰減：屬性 × (耐久/最大耐久)
            const maxDur = DURABILITY_CONFIG.maxDurability;
            const curDur = (p.durability[itemId] !== undefined) ? p.durability[itemId] : maxDur;
            const durRatio = Math.max(0, curDur) / maxDur;

            if (item.hp) p.maxHp += Math.floor(item.hp * multiplier * durRatio);
            if (item.mp) p.maxMp += Math.floor(item.mp * multiplier * durRatio);
            if (item.atk) p.atk += Math.floor(item.atk * multiplier * durRatio);
            if (item.def) p.def += Math.floor(item.def * multiplier * durRatio);
        }
    });

    // 3. 加上轉生加成 (最後乘算)
    // 每次轉生全屬性 +20%
    const rebirthCount = p.rebirth || 0;
    if (rebirthCount > 0) {
        const bonusMult = 1 + (rebirthCount * 0.2); 
        
        p.maxHp = Math.floor(p.maxHp * bonusMult);
        p.maxMp = Math.floor(p.maxMp * bonusMult);
        p.atk = Math.floor(p.atk * bonusMult);
        p.def = Math.floor(p.def * bonusMult);
    }

    // 4. 確保當前血量不超過上限
    if (p.hp > p.maxHp) p.hp = p.maxHp;
    if (p.mp > p.maxMp) p.mp = p.maxMp;
}

// ==========================================
// ⏰ 伺服器核心排程 (每 10 秒執行一次)
// ==========================================
setInterval(() => { 
    const now = Date.now(); 

    // 1. 清理閒置房間
    Object.keys(gameState.battleRooms).forEach(roomId => { 
        const room = gameState.battleRooms[roomId]; 
        // 戰鬥中的房間不清理；空房間立即清理；閒置30分鐘才清理
        const isIdle = room.status !== 'fighting' && (now - (room.updatedAt || now) > 30 * 60 * 1000);
        if (room.players.length === 0 || isIdle) { 
            delete gameState.battleRooms[roomId]; 
        } 
    }); 

    // 2. 廣播大廳數據 (在線人數、房間列表)
    broadcastHubData(); 

    // 3. 獲取香港時間
    const hkTime = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Hong_Kong"}));
    const dateStr = hkTime.getDate();     
    const hour = hkTime.getHours();       
    const minute = hkTime.getMinutes(); 

    // 生成唯一的時間 Key (例如: "15-22-0" 代表 15號 22點 00分)
    const timeKey = `${dateStr}-${hour}-${minute}`;

    // ==========================================
    // 6.  [新增] 每日跨日重置檢查 (檢查所有線上玩家)
    // ==========================================
    // 因為此迴圈每 10 秒跑一次，所以跨日後的 10 秒內玩家就會收到通知
    const onlinePlayers = Object.values(gameState.players);
    if (onlinePlayers.length > 0) {
	//  Debug 用：印出第一位玩家的日期檢查狀況
    const p = onlinePlayers[0];
    const hkNow = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Hong_Kong"}));
    const todayStr = `${hkNow.getFullYear()}-${hkNow.getMonth()+1}-${hkNow.getDate()}`;
    console.log(`[Debug] 現在香港日期: ${todayStr}, 玩家上次日期: ${p.dailyQuests?.date}`);
        onlinePlayers.forEach(p => {
            // 呼叫 checkDailyReset (它會回傳 true/false)
            // 如果剛好跨日，這裡會自動重置任務並回傳 true
            const isReset = checkDailyReset(p); 
            
            if (isReset) {
                // 1. 更新玩家數據 (任務列表變更)
                io.to(p.id).emit('playerStatsUpdate', p);
                
                // 2. 通知玩家
                io.to(p.id).emit('errorMessage', " 新的一天開始了！每日任務與公會福利已重置！");
                
                // 3. 刷新公會介面 (如果玩家正開著公會視窗，按鈕會變亮)
                io.to(p.id).emit('refreshGuildUI');
            }
        });
    }
    // ==========================================

    // 4. ☠️ 世界 BOSS 排程 (15:00, 19:00, 23:00)
    const bossHours = [15, 19, 23]; 
    if (bossHours.includes(hour) && minute === 0) {
        if (lastAutoSpawnTime !== timeKey && !WORLD_BOSS.active) {
            console.log(`[排程] 時間已到 (${hour}:${minute} HKT)，自動召喚 BOSS！`);
            
            // 呼叫召喚函式
            if (typeof startWorldBossEvent === 'function') {
                startWorldBossEvent(); 
            } else {
                // 相容舊代碼
                if (typeof adminSpawnWorldBoss === 'function') adminSpawnWorldBoss();
            }
            
            lastAutoSpawnTime = timeKey; 
        }
    }

    // 5.  六合彩開獎排程 (22:00)
    if (hour === 22 && minute === 0) {
        if (lastLotteryTime !== timeKey) {
            console.log(`[排程] 時間已到 (${hour}:${minute} HKT)，六合彩開獎！`);
            
            if (typeof drawLottery === 'function') {
                drawLottery();
            }
            lastLotteryTime = timeKey; 
        }
    }

}, 10000);

const PORT = 3001; 
http.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });