require('dotenv').config();
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const jwt = require('jsonwebtoken'); 

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

// 全局變數定義
let LUCKY_BAG_STOCK = 0; // 設定福袋限量
let LAST_BOSS_RANKING = [];
let LOTTERY_JACKPOT = 5000000; // 起底獎金 500萬
let LOTTERY_BETS = []; // 暫存投注紀錄
let LAST_ROUND_BETS = [];
let LAST_DRAW_RESULT = null; // 上期結果
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

app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); next(); });
app.use(express.static(__dirname));

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_key_change_me_in_prod';
const JWT_EXPIRES_IN = '7d'; 

let disconnectTimers = {}; 
let MAINTENANCE_MODE = false; 
const MAINTENANCE_WHITELIST = ['test9', 'admin']; 

// [技能設定]
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
    'meteor':       { name: "隕石術",   level: 60, mp: 80, type: 'dmg',    val: 3.5, desc: "毀滅性打擊 (3.5倍傷害)" },
    'heal_all':     { name: "聖光普照", level: 100, mp: 100, type: 'heal_all', val: 1.0, desc: "全隊生命值完全恢復" },
    'divine_slash': { name: "次元斬",   level: 100, mp: 150, type: 'dmg',  val: 5.0, desc: "撕裂空間 (5倍傷害)" },
    'full_heal':    { name: "大天使之息",level: 120, mp: 200, type: 'heal', val: 1.0, desc: "生命值完全恢復" },
    'god_mode':     { name: "天神下凡", level: 150, mp: 300, type: 'god',  val: 3.0, desc: "攻防變為 3倍 (3回合)" },
    'void_crush':   { name: "虛空碎擊", level: 200, mp: 1000, type: 'dmg', val: 10.0, desc: "凝聚虛空之力，造成 10倍 傷害" },
    'entropy_decay':{ name: "熱寂·衰變", level: 240, mp: 2500, type: 'percent_dmg', val: 0.05, desc: "無視防禦，造成敵人最大生命 5% 的真實傷害 (上限ATK x50)" },
    'big_bang':     { name: "宇宙大爆炸", level: 280, mp: 5000, type: 'dmg', val: 25.0, desc: "引爆奇異點，造成 25倍 毀滅性傷害" }
};

const NPC_SHOP_ALLOW_LIST = [
    'potion_hp', 'potion_mid', 'potion_high', 'potion_max', 'elixir',
    'potion_mp', 'potion_mp_mid', 'potion_mp_high',
    'grilled_carp', 'salmon_sushi', 'tuna_steak', 'eel_rice', 'void_soup', 'sushi_plate',
    'wood_sword', 'copper_dagger', 'iron_sword', 'silver_blade',
    'oak_bow', 'maple_staff',
    'cloth_armor', 'leather_armor', 'chain_mail', 'iron_armor',
    'ring_str', 'bracelet_def', 'necklace_hp', 'necklace_mp','lucky_bag','enhance_stone'
];

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
    'ring_galaxy': '銀河指環', 'genesis_weapon': '創世·終焉之劍', 'genesis_armor': '創世·神之庇護'
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
    'pearl':        { name: "珍珠", cost: 500 }
};

const ENHANCE_RATES = {
    // === +1 ~ +10 (原本的) ===
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

    // ===  [新增] +11 ~ +15 (地獄級) ===
    11:{ rate: 0.5, cost: 2000000, risk: 'drop'}, // 15% 成功
    12:{ rate: 0.4, cost: 3000000, risk: 'drop'},
    13:{ rate: 0.4, cost: 5000000, risk: 'drop'}, // 10% 成功
    14:{ rate: 0.3, cost: 8000000, risk: 'drop'},
    15:{ rate: 0.3, cost: 10000000,risk: 'drop'}, // 5% 成功

    // ===  [新增] +16 ~ +20 (神話級 - 幾乎不可能) ===
    16:{ rate: 0.1, cost: 20000000, risk: 'break'}, 
    17:{ rate: 0.07, cost: 30000000, risk: 'break'},
    18:{ rate: 0.05, cost: 50000000, risk: 'break'}, // 1% 成功
    19:{ rate: 0.03,cost: 80000000, risk: 'break'}, // 0.5% 成功
    20:{ rate: 0.005,cost: 100000000,risk: 'break'}  // 0.1% 成功 (1億G)
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
    'lucky_bag': { name: "奇蹟福袋", type: 'consumable', cost: 1000000000, desc: "隨機開出價值連城的稀有材料！" }
};

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
    'entropy_god_armor':{ materials: { 'nebula_plate': 1, 'entropy_origin': 1, 'time_sand': 20, 'god_blood': 50 }, gold: 800000000 }
};

const MON_SKILLS = {
    'def_up':    { name: '️ 硬化皮膚', desc: '防禦力大幅提升！', type: 'buff', stat: 'def', val: 1.5 },
    'atk_up':    { name: '⚔️ 狂暴怒吼', desc: '攻擊力大幅提升！', type: 'buff', stat: 'atk', val: 1.5 },
    'heal':      { name: ' 自我再生', desc: '傷口正在癒合...', type: 'heal', val: 0.05 }, 
    'water':     { name: ' 水流破', desc: '噴射出高壓水柱！', type: 'magic', rate: 1.2, color: '#3498db' },
    'fire':      { name: ' 火球術', desc: '吐出了灼熱火球！', type: 'magic', rate: 1.4, color: '#e74c3c' },
    'ice':       { name: '❄️ 冰凍術', desc: '釋放寒冰氣息！',   type: 'magic', rate: 1.3, color: '#00d2d3' },
    'aoe_magic': { name: '☄️ 毀滅流星', desc: '對全隊造成傷害！', type: 'aoe', rate: 0.8, color: '#8e44ad' },
    'paralyze':  { name: '⚡ 麻痺電擊', desc: '身體麻痺了！(無法行動)', type: 'debuff', effect: 'stun' },
    'lifesteal': { name: ' 鮮血汲取', desc: '吸取了玩家的生命！', type: 'drain_hp', rate: 1.0 }, 
    'manadrain': { name: ' 魔力吞噬', desc: '吸取了玩家的魔力！', type: 'drain_mp', val: 100 }
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
    'slime': { name: "史萊姆", level: 1, hp: 100, exp: 10, gold: 5, atk: 10, drops: [{id:'slime_gel', rate:0.5}] },
    'rat': { name: "大老鼠", level: 3, hp: 200, exp: 20, gold: 10, atk: 15, drops: [{id:'soft_fur', rate:0.4}] },
    'bee': { name: "殺人蜂", level: 5, hp: 300, exp: 35, gold: 15, atk: 25, drops: [{id:'beast_fang', rate:0.3}, {id:'potion_hp', rate:0.1}] },
    'boar': { name: "野豬", level: 8, hp: 600, exp: 60, gold: 25, atk: 35, drops: [{id:'soft_fur', rate:0.5}, {id:'beast_fang', rate:0.3}] },
    'thief': { name: "盜賊", level: 12, hp: 1000, exp: 100, gold: 100, atk: 50, drops: [{id:'copper_ore', rate:0.4}, {id:'copper_dagger', rate:0.05}] },
    'wolf_king': { name: "狼王", level: 15, hp: 2500, exp: 300, gold: 300, atk: 80, drops: [{id:'bone_ring', rate:0.1}, {id:'soft_fur', rate:1.0}] },
    'snake': { name: "毒蛇", level: 22, hp: 3500, exp: 400, gold: 50, atk: 100, drops: [{id:'poison_sac', rate:0.4}, {id:'tough_hide', rate:0.2}] },
    'zombie': { name: "腐屍", level: 25, hp: 5000, exp: 500, gold: 60, atk: 110, drops: [{id:'bone_shard', rate:0.5}, {id:'cloth_armor', rate:0.1}] },
    'skeleton': { name: "骷髏兵", level: 28, hp: 4500, exp: 600, gold: 70, atk: 130, drops: [{id:'iron_ore', rate:0.4}, {id:'bone_shard', rate:0.4}] },
    'ghoul': { name: "食屍鬼", level: 32, hp: 7000, exp: 800, gold: 90, atk: 150, drops: [{id:'tough_hide', rate:0.5}] },
    'witch': { name: "沼澤女巫", level: 35, hp: 6000, exp: 1000, gold: 150, atk: 200, drops: [{id:'poison_sac', rate:0.5}, {id:'potion_mid', rate:0.2}] },
    'hydra': { name: "九頭蛇", level: 40, hp: 20000, exp: 3000, gold: 1000, atk: 300, drops: [{id:'snake_boots', rate:0.1}, {id:'poison_sac', rate:1.0}] },
    'fire_imp': { name: "火焰小鬼", level: 42, hp: 15000, exp: 1500, gold: 200, atk: 350, drops: [{id:'fire_core', rate:0.3}] },
    'lava_golem': { name: "熔岩戈侖", level: 45, hp: 30000, exp: 2000, gold: 250, atk: 400, drops: [{id:'lava_rock', rate:0.6}, {id:'iron_ore', rate:0.5}] },
    'salamander': { name: "火蜥蜴", level: 48, hp: 25000, exp: 2500, gold: 300, atk: 450, drops: [{id:'tough_hide', rate:0.4}, {id:'fire_core', rate:0.2}] },
    'fire_mage': { name: "烈焰法師", level: 52, hp: 20000, exp: 3000, gold: 400, atk: 600, drops: [{id:'silver_ore', rate:0.4}, {id:'potion_mid', rate:0.3}] },
    'dragon_hatchling': { name: "幼龍", level: 55, hp: 40000, exp: 4000, gold: 500, atk: 700, drops: [{id:'dragon_scale', rate:0.2}, {id:'fire_core', rate:0.4}] },
    'balrog': { name: "炎魔", level: 60, hp: 100000, exp: 10000, gold: 3000, atk: 1000, drops: [{id:'magma_plate', rate:0.01}, {id:'fire_core', rate:0.5}] },
    'snow_wolf': { name: "雪原狼", level: 62, hp: 60000, exp: 5000, gold: 600, atk: 1200, drops: [{id:'soft_fur', rate:0.5}, {id:'ice_crystal', rate:0.2}] },
    'yeti': { name: "雪人", level: 65, hp: 120000, exp: 6000, gold: 700, atk: 1500, drops: [{id:'yeti_fur', rate:0.6}, {id:'gold_ore', rate:0.2}] },
    'ice_spirit': { name: "冰精靈", level: 68, hp: 80000, exp: 7000, gold: 800, atk: 1800, drops: [{id:'ice_crystal', rate:0.5}, {id:'spirit_dust', rate:0.3}] },
    'frost_knight': { name: "寒霜騎士", level: 72, hp: 150000, exp: 9000, gold: 1000, atk: 2000, drops: [{id:'gold_ore', rate:0.4}, {id:'ice_crystal', rate:0.3}] },
    'ice_dragon': { name: "冰霜龍", level: 75, hp: 200000, exp: 12000, gold: 1500, atk: 2500, drops: [{id:'dragon_scale', rate:0.5}, {id:'potion_high', rate:0.2}] },
    'lich_king': { name: "巫妖王", level: 80, hp: 500000, exp: 30000, gold: 10000, atk: 3500, drops: [{id:'amulet_soul', rate:0.05}, {id:'spirit_dust', rate:0.05}] },
    'void_eye': { name: "虛空之眼", level: 82, hp: 300000, exp: 15000, gold: 2000, atk: 4000, drops: [{id:'void_dust', rate:0.1}] },
    'shadow_assassin': { name: "暗影刺客", level: 85, hp: 400000, exp: 18000, gold: 2500, atk: 5000, drops: [{id:'mithril', rate:0.1}, {id:'dark_essence', rate:0.2}] },
    'dark_paladin': { name: "墮落聖騎", level: 88, hp: 600000, exp: 22000, gold: 3000, atk: 6000, drops: [{id:'mithril', rate:0.5}, {id:'void_dust', rate:0.4}] },
    'demon_guard': { name: "惡魔守衛", level: 92, hp: 800000, exp: 28000, gold: 4000, atk: 7500, drops: [{id:'demon_horn', rate:0.4}, {id:'dragon_scale', rate:0.2}] },
    'succubus': { name: "魅魔", level: 95, hp: 700000, exp: 35000, gold: 5000, atk: 8500, drops: [{id:'dark_essence', rate:0.5}, {id:'potion_max', rate:0.1}] },
    'void_lord': { name: "虛空領主", level: 99, hp: 2000000, exp: 100000, gold: 50000, atk: 12000, drops: [{id:'void_reaper', rate:0.05}, {id:'dark_essence', rate:0.2}] },
    'chaos_beast': { name: "混沌巨獸", level: 105, hp: 3000000, exp: 150000, gold: 10000, atk: 15000, drops: [{id:'chaos_orb', rate:0.2}, {id:'adamantite', rate:0.2}] },
    'fallen_angel': { name: "墮天使", level: 110, hp: 4000000, exp: 200000, gold: 20000, atk: 18000, drops: [{id:'angel_feather', rate:0.2}, {id:'god_blood', rate:0.1}] },
    'demon_king': { name: "魔王撒旦", level: 150, hp: 7000000, exp: 2000000, gold: 2000000, atk: 25000, drops: [{id:'god_slayer', rate:0.1}, {id:'chaos_orb', rate:0.8}, {id:'angel_feather', rate:0.8}] },
    'void_walker':  { name: "虛空行者", level: 160, hp: 8000000, exp: 3000000, gold: 15000, atk: 35000, drops: [{id:'void_dust', rate:0.5}, {id:'mithril', rate:0.3}, {id:'potion_max', rate:0.2}] },
    'chaos_knight': { name: "混沌騎士", level: 170, hp: 12000000, exp: 5000000, gold: 25000, atk: 45000, drops: [{id:'chaos_orb', rate:0.4}, {id:'adamantite', rate:0.3}, {id:'dark_essence', rate:0.3}] },
    'abyss_dragon': { name: "深淵魔龍", level: 180, hp: 20000000, exp: 12000000, gold: 50000, atk: 55000, drops: [{id:'dragon_scale', rate:0.8}, {id:'god_blood', rate:0.2}, {id:'void_reaper', rate:0.02}] },
    'fallen_titan': { name: "墮落泰坦", level: 190, hp: 35000000, exp: 25000000, gold: 100000, atk: 65000, drops: [{id:'titan_steel', rate:0.3}, {id:'star_fragment', rate:0.3}, {id:'elixir', rate:0.2}] },
    'genesis_god':  { name: "創世破壞神", level: 200, hp: 50000000, exp: 1000000000, gold: 500000, atk: 75000, drops: [ {id:'titan_steel', rate:0.5}, {id:'god_blood', rate:0.5}, {id:'elixir', rate:0.5}] },
    'void_worm': { 
        name: "虛空吞噬蟲", level: 210, 
        hp: 80000000, maxHp: 80000000, 
        exp: 2000000000, gold: 3000000, 
        atk: 85000, def: 40000, 
        drops: [{id:'void_shard', rate:0.5}, {id:'mithril', rate:0.5}, {id:'potion_max', rate:0.3}] 
    },
    'shadow_phantom': { 
        name: "虚影夢魘", level: 225, 
        hp: 90000000, maxHp: 150000000, 
        exp: 3500000000, gold: 4000000, 
        atk: 100000, def: 50000, 
        drops: [{id:'dark_matter', rate:0.4}, {id:'void_shard', rate:0.4}, {id:'elixir', rate:0.1}] 
    },
    'star_eater': { 
        name: "吞星巨獸", level: 245, 
        hp: 300000000, maxHp: 300000000, 
        exp: 6000000000, gold: 5000000, 
        atk: 130000, def: 75000, 
        drops: [{id:'cosmic_steel', rate:0.3}, {id:'titan_steel', rate:0.5}, {id:'star_fragment', rate:0.2}] 
    },
    'nebula_dragon': { 
        name: "星雲幻龍", level: 260, 
        hp: 600000000, maxHp: 600000000, 
        exp: 10000000000, gold: 6000000, 
        atk: 160000, def: 90000, 
        drops: [{id:'star_core', rate:0.2}, {id:'dragon_scale', rate:0.8}, {id:'god_blood', rate:0.3}] 
    },
    'time_keeper': { 
        name: "時空裁決者", level: 280, 
        hp: 1500000000, maxHp: 1500000000, 
        exp: 25000000000, gold: 7000000, 
        atk: 250000, def: 120000, 
        drops: [{id:'time_sand', rate:0.3}, {id:'chaos_orb', rate:0.5}, {id:'elixir', rate:0.5}] 
    },
    'dimension_breaker': { 
        name: "維度粉碎者", level: 290, 
        hp: 3000000000, maxHp: 3000000000, 
        exp: 50000000000, gold: 8000000, 
        atk: 350000, def: 140000, 
        drops: [{id:'dimension_gem', rate:0.2}, {id:'god_blood', rate:0.5}] 
    },
    'entropy_god': { 
        name: "終焉·熱寂之神", level: 300, 
        hp: 3500000000, maxHp: 10000000000, 
        exp: 90000000000, gold: 10000000, 
        atk: 800000, def: 180000, 
        drops: [{id:'entropy_origin', rate:1.0}, {id:'elixir', rate:0.7}] 
    }
};

//  [修改] 隨機生成 Lv.350 - Lv.500 的混沌 Boss (含掉落物)
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

    // 3.  定義掉落物 (包含 Lv.200 ~ Lv.300 的稀有材料)
    // 越高等級的 Boss，掉落率稍微高一點 (可選邏輯，這裡先用固定機率)
    const drops = [
        // --- 必掉/高機率 ---
        { id: 'void_shard', rate: 1.0 },       // 100% 掉落虛空碎片
        { id: 'dark_matter', rate: 0.8 },      // 80% 暗物質
        { id: 'cosmic_steel', rate: 0.6 },     // 60% 宇宙鋼
        
        // --- 中機率 ---
        { id: 'star_core', rate: 0.7 },        // 40% 恆星核心
        { id: 'time_sand', rate: 1.0 },        // 30% 時光之沙
        { id: 'dimension_gem', rate: 0.5 },    // 20% 維度寶石
        
        // --- 稀有 ---
        { id: 'entropy_origin', rate: 0.05 },  // 5% 熱寂原點 (超稀有)
        { id: 'lucky_bag', rate: 0.05 },        // 10% 奇蹟福袋
        { id: 'elixir', rate: 0.15 }           // 15% 神之甘露
    ];

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
        
        //  將掉落清單加入物件
        drops: drops 
    };
}

let gameState = { players: {}, battleRooms: {} };

let WORLD_BOSS = {
    active: false,
    hp: 0,
    maxHp: 50000000000, 
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

io.on('connection', (socket) => {
    console.log(`[連線] ID: ${socket.id}`);

    DB.getChatHistory(50, (rows) => {
        const history = rows.map(r => ({ name: r.sender_name, msg: r.message }));
        socket.emit('chatHistory', history);
    });

    socket.on('register', (data) => { 
        const { user, pass } = data; 
        if (!user || user.length < 5) { socket.emit('authResult', { success: false, msg: "帳號至少需 5 字元" }); return; }
        if (!isStrongPassword(pass)) { socket.emit('authResult', { success: false, msg: "密碼需8位以上，含大寫、小寫及數字" }); return; }
        const salt = bcrypt.genSaltSync(10);
        const hash = bcrypt.hashSync(pass, salt); 
        const newToken = jwt.sign({ username: user }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
        DB.createAccount(user, hash, newToken, (success, msg) => { 
            const finalMsg = msg || (success ? "註冊成功！" : "帳號已存在");
            socket.emit('authResult', { success, msg: finalMsg }); 
        }); 
    });

    socket.on('login', (data) => { 
        const { user, pass } = data; 
        if (!user || user.length < 5) { socket.emit('authResult', { success: false, msg: "帳號長度不足" }); return; }
        DB.getUserInfo(user, (info) => {
            if (!info) { socket.emit('authResult', { success: false, msg: "帳號不存在" }); } 
            else {
                if (bcrypt.compareSync(pass, info.password)) {
                    const newToken = jwt.sign({ username: user }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
                    DB.updateUserToken(user, newToken, (updateSuccess) => {
                        if (updateSuccess) { socket.emit('authResult', { success: true, msg: "登入成功", token: newToken }); } 
                        else { socket.emit('authResult', { success: false, msg: "系統錯誤 (Token 更新失敗)" }); }
                    });
                } else { socket.emit('authResult', { success: false, msg: "密碼錯誤" }); }
            }
        }); 
    });

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

    socket.on('joinGame', (token) => { 
        if (!token) return; 
        if (disconnectTimers[token]) { clearTimeout(disconnectTimers[token]); delete disconnectTimers[token]; }

        jwt.verify(token, JWT_SECRET, (err, decoded) => {
            if (err) { console.log(`[JWT] 驗證失敗: ${err.message}`); socket.emit('tokenExpired'); socket.disconnect(true); return; }
            const username = decoded.username;
            const existingSocketIds = Object.keys(gameState.players).filter(sid => gameState.players[sid].name === username && sid !== socket.id);
            existingSocketIds.forEach(oldSid => {
                delete gameState.players[oldSid];
                const oldSocket = io.sockets.sockets.get(oldSid);
                if (oldSocket) oldSocket.disconnect(true);
            });

            DB.loadPlayer(token, (savedData) => { 
                if (savedData) { 
                    if (savedData.username !== username) { socket.emit('errorMessage', "Token 資訊不符"); socket.disconnect(true); return; }
                    if (MAINTENANCE_MODE) {
                        if (!MAINTENANCE_WHITELIST.includes(savedData.username)) { socket.emit('errorMessage', " 伺服器維護中，只有管理員可進入！"); socket.disconnect(true); return; } 
                        else { socket.emit('battleLog', `<span style="color:#e74c3c; font-weight:bold;">⚠️ 警告：目前處於維護模式</span>`); }
                    }

                    let p = savedData; 
                    p.name = savedData.username; 

                    p.baseStats = getStatsByLevel(p.level);
                    p.maxExp = getMaxExpByLevel(p.level);

                    if (!p.equipment) p.equipment = { weapon: null, armor: null, acc: null }; 
                    if (!p.inventory) p.inventory = {}; 
                    if (!p.enhancements) p.enhancements = { weapon: 0, armor: 0, acc: 0 };
                    if (!p.skills) p.skills = ['fireball'];
 

                    Object.keys(SKILL_CONFIG).forEach(skillId => {
                        const skill = SKILL_CONFIG[skillId];
                        if (p.level >= skill.level && !p.skills.includes(skillId)) {
                            p.skills.push(skillId);
                        }
                    });

                    p.id = socket.id; 
                    p.token = token; 
                    gameState.players[socket.id] = p; 
                    
                    calculateStats(p); 
                    
                    socket.emit('playerStatsUpdate', gameState.players[socket.id]); 
                    broadcastHubData(); 
                    socket.emit('updateHubRanking', LAST_BOSS_RANKING);

                    const myBets = LOTTERY_BETS.filter(b => b.name === p.name).map(b => b.nums);
                    const myLastBets = LAST_ROUND_BETS.filter(b => b.name === p.name);
                    
                    socket.emit('lotteryUpdate', { 
                        jackpot: LOTTERY_JACKPOT, 
                        count: LOTTERY_BETS.length, 
                        lastResult: LAST_DRAW_RESULT,
                        myBets: myBets,
                        myLastBets: myLastBets 
                    });

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

    // 5. 私訊功能 (修正版：支援未讀提示 + 時間戳記)
    socket.on('privateMessage', (data) => {
        const player = gameState.players[socket.id];
        if (!player) return;

        const targetName = data.targetName;
        const msg = data.msg;
        
        //  1. 產生伺服器時間戳 (這是關鍵，確保雙方時間一致)
        const timestamp = Date.now();
        
        // 2. 存入資料庫 (儲存到 private_messages 表，預設 is_read=0)
        // 注意：資料庫通常會自己記錄寫入時間，但這裡主要處理即時顯示
        DB.logPrivateMessage(player.name, targetName, msg);

        // 3. 傳送給自己 (讓自己的對話框馬上顯示)
        socket.emit('privateMessageUpdate', {
            sender: player.name,
            receiver: targetName,
            msg: msg,
            isSelf: true,
            timestamp: timestamp //  加入時間
        });

        // 4. 傳送給對方 (如果在線)
        const targetId = Object.keys(gameState.players).find(id => gameState.players[id].name === targetName);
        
        if (targetId) {
            // 傳送私訊內容給對方
            io.to(targetId).emit('privateMessageUpdate', {
                sender: player.name, 
                receiver: targetName,
                msg: msg,
                isSelf: false,
                timestamp: timestamp //  加入同樣的時間
            });
            
            //  通知對方刷新好友列表 (更新紅點)
            io.to(targetId).emit('updateFriendListRequest'); 
            io.to(targetId).emit('pmNotification', player.name);
        } else {
            socket.emit('errorMessage', `玩家 [${targetName}] 目前不在線，但他上線後可以在紀錄中看到。`);
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

    socket.on('enhanceItem', (slot) => {
        const p = gameState.players[socket.id];
        if (!p) return;
        
        const itemId = p.equipment[slot]; 
        if (!itemId) { socket.emit('errorMessage', "該部位沒有裝備！"); return; }

        if (!p.enhancements) p.enhancements = {};
        
        const currentLv = p.enhancements[itemId] || 0;
        const nextLv = currentLv + 1;

        if (nextLv > 20) { socket.emit('errorMessage', "已達強化上限 (+20)！"); return; }

        const config = ENHANCE_RATES[nextLv];
        if (!p.inventory['enhance_stone'] || p.inventory['enhance_stone'] < 1) { socket.emit('errorMessage', "缺少強化石！"); return; }
        if (p.gold < config.cost) { socket.emit('errorMessage', `金幣不足 (需要 ${config.cost})`); return; }

        p.gold -= config.cost;
        p.inventory['enhance_stone']--;
        if (p.inventory['enhance_stone'] <= 0) delete p.inventory['enhance_stone'];

        const roll = Math.random();
        const itemName = ITEM_CONFIG[itemId].name;

        if (roll < config.rate) {
            p.enhancements[itemId] = nextLv;
            socket.emit('enhanceResult', { success: true, msg: ` 強化成功！[${itemName}] 升級至 +${nextLv}`, lv: nextLv });
            if (nextLv >= 7) { io.emit('chatMessage', { name: '系統', msg: `✨ 恭喜 [${p.name}] 將 [${itemName}] 強化至 +${nextLv}！戰力大增！` }); }
        } 
        else {
            if (config.risk === 'drop') {
                const dropLv = Math.max(0, currentLv - 1);
                p.enhancements[itemId] = dropLv;
                socket.emit('enhanceResult', { success: false, msg: ` 強化失敗.. 等級倒退至 +${dropLv}`, lv: dropLv });
            } 
            else if (config.risk === 'break') {
                p.equipment[slot] = null;
                p.enhancements[itemId] = 0; 
                socket.emit('enhanceResult', { success: false, msg: `☠️ 強化失敗！[${itemName}] 承受不住力量而破碎了...`, lv: 0, broken: true });
                io.emit('chatMessage', { name: '系統', msg: ` 悲報.. [${p.name}] 在強化 +${nextLv} 時失敗，[${itemName}] 化為了粉塵...` });
            } 
            else {
                socket.emit('enhanceResult', { success: false, msg: "強化失敗，但裝備安然無恙。", lv: currentLv });
            }
        }

        calculateStats(p);
        socket.emit('playerStatsUpdate', p);
        saveMyData(socket.id);
    });

    socket.on('adminSpawnWorldBoss', (data) => {
        if (data.password !== process.env.ADMIN_PASSWORD) return;
        startWorldBossEvent();
    });

    socket.on('joinWorldBoss', () => {
        const p = gameState.players[socket.id];
        if (!p) return;
        if (!WORLD_BOSS.active) { socket.emit('errorMessage', "BOSS 已經被擊敗或尚未出現！"); return; }
        if (!WORLD_BOSS.players.includes(socket.id)) { WORLD_BOSS.players.push(socket.id); }
        socket.emit('roomJoined', { roomId: 'world_boss' });
    });

    socket.on('worldBossAction', (data) => {
        if (!checkRateLimit(socket.id, 'combat', 500)) return;
        if (!WORLD_BOSS.active) return;
        const p = gameState.players[socket.id];
        if (!p) return;
        if (p.hp <= 0) return; 

        let damage = 0;
        let logMsg = "";
        let effectiveAtk = p.atk;
        if (p.tempBuffs) {
            if (p.tempBuffs.berserk) effectiveAtk *= 2;
            if (p.tempBuffs.god) effectiveAtk *= 3;
        }

        if (data.type === 'attack') {
            damage = Math.floor(effectiveAtk * (1.0 + Math.random() * 0.2)); 
            WORLD_BOSS.hp -= damage;
            logMsg = `<span style="color:#f1c40f">你攻擊了 BOSS，造成 ${damage.toLocaleString()} 傷害！</span>`;
        } 
        else if (data.type === 'skill') {
            const skill = SKILL_CONFIG[data.skillId];
            if (!skill || !p.skills.includes(data.skillId)) return;
            if (p.mp < skill.mp) { socket.emit('battleLog', `<span style="color:#aaa;">MP 不足...</span>`); return; }
            p.mp -= skill.mp;

            if (skill.type === 'dmg' || skill.type === 'dot' || skill.type === 'stun' || skill.type === 'debuff') {
                damage = Math.floor(effectiveAtk * skill.val);
                WORLD_BOSS.hp -= damage;
                let color = "#3498db";
                if (skill.val >= 10) color = "#9b59b6"; 
                if (skill.val >= 20) color = "#e74c3c"; 
                logMsg = `<span style="color:${color}; font-weight:bold;">${p.name} 施放 ${skill.name}! 轟出 ${damage.toLocaleString()} 傷害!</span>`;
            }
            else if (skill.type === 'percent_dmg') {
                let rawDmg = Math.floor(WORLD_BOSS.maxHp * skill.val);
                let cap = effectiveAtk * 50; 
                if (rawDmg > cap) rawDmg = cap;
                damage = rawDmg;
                WORLD_BOSS.hp -= damage;
                logMsg = `<span style="color:#e67e22; font-weight:bold;">${p.name} 施放 ${skill.name}! 造成 ${damage.toLocaleString()} 真實傷害!</span>`;
            }
            else if (skill.type === 'heal') {
                let healAmount = Math.floor(p.maxHp * skill.val);
                p.hp = Math.min(p.maxHp, p.hp + healAmount);
                logMsg = `<span style="color:#2ecc71">你施放了 ${skill.name}，恢復 ${healAmount} HP</span>`;
            }
            else if (skill.type === 'heal_all' || skill.type === 'full_heal') {
                p.hp = p.maxHp;
                logMsg = `<span style="color:#2ecc71; font-weight:bold;">✨ ${skill.name}! 你的狀態已完全恢復!</span>`;
            }
            else if (skill.type === 'drain') {
                damage = Math.floor(effectiveAtk * skill.val);
                WORLD_BOSS.hp -= damage;
                let heal = Math.floor(damage * 0.5); 
                p.hp = Math.min(p.maxHp, p.hp + heal);
                logMsg = `<span style="color:#e74c3c">你吸取了 BOSS 生命! (${damage}傷, +${heal}HP)</span>`;
            }
            else if (skill.type === 'buff') {
                if (!p.tempBuffs) p.tempBuffs = {};
                p.tempBuffs.def = 5; 
                logMsg = `<span style="color:#f1c40f">聖光守護! 防禦力大幅提升!</span>`;
            }
            else if (skill.type === 'buff_atk') {
                if (!p.tempBuffs) p.tempBuffs = {};
                p.tempBuffs.berserk = 5; 
                p.hp = Math.floor(p.hp * 0.8); 
                logMsg = `<span style="color:#c0392b">狂暴狀態! 攻擊力倍增，但犧牲了生命!</span>`;
            }
            else if (skill.type === 'god') {
                if (!p.tempBuffs) p.tempBuffs = {};
                p.tempBuffs.god = 5; 
                p.hp = p.maxHp; 
                logMsg = `<span style="color:#f1c40f; font-weight:bold;">天神下凡! 狀態全滿，攻防一體!</span>`;
            }
        }

        if (WORLD_BOSS.hp < 0) WORLD_BOSS.hp = 0;
        if (damage > 0) {
            if (!WORLD_BOSS.damageLog[socket.id]) WORLD_BOSS.damageLog[socket.id] = 0;
            WORLD_BOSS.damageLog[socket.id] += damage;
        }

        socket.emit('battleLog', logMsg);
        socket.emit('playerStatsUpdate', p);
        io.to('world_boss_room').emit('worldBossSync', getBossData());

        if (WORLD_BOSS.hp <= 0) { endWorldBoss(); }
    });

    socket.on('connectToBossRoom', () => {
        socket.join('world_boss_room');
        if (WORLD_BOSS.active && !WORLD_BOSS.players.includes(socket.id)) {
            WORLD_BOSS.players.push(socket.id);
        }
        socket.emit('worldBossSync', getBossData());
    });

    socket.on('sendChat', (msg) => {
        if (!checkRateLimit(socket.id, 'chat', 1000)) { socket.emit('errorMessage', "發言速度太快，請稍歇。"); return; }
        const player = gameState.players[socket.id];
        if (player && msg && msg.trim().length > 0) {
            const name = player.name;
            let content = msg.substring(0, 50);
            content = content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
            DB.logChat(name, content);
            io.emit('chatMessage', { id: player.id, name: name, msg: content });
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
                S: [
                    { id: 'entropy_origin', value: 10000000, name: '熱寂原點' },
                    { id: 'dimension_gem',  value: 300000,   name: '維度寶石' },
                    { id: 'time_sand',      value: 150000,   name: '時光之沙' }
                ],
                A: [
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
                B: [
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

    socket.on('craftItem', (targetItemId) => { 
        const p = gameState.players[socket.id]; const recipe = RECIPE_CONFIG[targetItemId]; const targetItem = ITEM_CONFIG[targetItemId]; if (!p || !recipe || !targetItem) return; 
        if (p.gold < recipe.gold) { socket.emit('craftResult', { success: false, msg: "金幣不足！" }); return; } 
        for (let matId in recipe.materials) { 
            const needed = recipe.materials[matId]; const has = p.inventory[matId] || 0; 
            if (has < needed) { const matName = MATERIAL_CONFIG[matId] ? MATERIAL_CONFIG[matId].name : matId; socket.emit('craftResult', { success: false, msg: `材料不足：${matName}` }); return; } 
        } 
        p.gold -= recipe.gold; 
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

	socket.on('combatAction', (data) => { 
        // 1. 頻率限制
        if (!checkRateLimit(socket.id, 'combat', 500)) return;

        const { roomId, type, skillId } = data; 
        const room = gameState.battleRooms[roomId]; 
        const player = gameState.players[socket.id]; 
        
        if (!room || !player || room.status !== 'fighting') return; 
        if (room.monster.hp <= 0 || room.monster.status === 'dead' || room.rewardsGiven) return;
        
        const currentEntityId = room.turnOrder[room.turnIndex]; 
        if (socket.id !== currentEntityId) return; 
        
        // 麻痺檢查 (如果被怪物暈了，跳過回合)
        if (player.isStunned) {
            io.to(roomId).emit('battleLog', `<span style="color:#f39c12; font-weight:bold;">⚡ ${player.name} 身體麻痺，無法動彈！(跳過回合)</span>`);
            player.isStunned = false; // 解除麻痺 (只暈一回合)
            socket.emit('playerStatsUpdate', player);
            processNextTurn(room, roomId); // 直接跳下一位
            return;
        }

        const pName = player.name;
        let effectiveAtk = player.atk;

        // Buff 判定 (攻擊加成)
        if (player.tempBuffs && player.tempBuffs.berserk) { 
            effectiveAtk = Math.floor(player.atk * 2.0); 
            player.tempBuffs.berserk--; 
            if(player.tempBuffs.berserk <= 0) delete player.tempBuffs.berserk; 
        }
        if (player.tempBuffs && player.tempBuffs.god) { 
            effectiveAtk = Math.floor(player.atk * 3.0); 
        }

        // [關鍵修正] 讀取怪物防禦力 (支援隨機 Boss)
        let baseMonDef = 0;

        if (room.monsterKey === 'chaos_boss') {
            baseMonDef = room.monster.def;
        } else if (MONSTER_CONFIG[room.monsterKey]) {
            const cfg = MONSTER_CONFIG[room.monsterKey];
            baseMonDef = cfg.def || (cfg.level * 2);
        } else {
            baseMonDef = room.monster.def || 10;
        }
        
        // 如果怪物有防禦 Buff，防禦力 x 2.0
        if (room.monsterBuffs && room.monsterBuffs.defTurns > 0) {
            baseMonDef = Math.floor(baseMonDef * 2.0);
        }

        let damage = 0; 
        let logMsg = "";

        if (type === 'attack') { 
            damage = Math.floor(effectiveAtk + Math.floor(Math.random() * 5) - (baseMonDef * 0.5)); 
            if (damage < 1) damage = 1; 

            logMsg = `<span style="color:#f1c40f">${pName} 攻擊! 造成 ${damage} 傷害</span>`; 
            if (room.monsterBuffs && room.monsterBuffs.defTurns > 0) logMsg += ` <span style="font-size:10px; color:#aaa;">(怪物防禦中)</span>`;
            
            room.monster.hp -= damage; 
        } 
        else if (type === 'skill') { 
            const skill = SKILL_CONFIG[skillId];
            if (!skill || (player.skills && !player.skills.includes(skillId))) return; 
            
            if (player.mp < skill.mp) { return; }
            player.mp -= skill.mp; 
            
            if (skill.type === 'dmg') { 
                let rawDmg = Math.floor(effectiveAtk * skill.val);
                damage = Math.floor(rawDmg - (baseMonDef * 0.5));
                if (damage < 1) damage = 1;

                room.monster.hp -= damage; 
                let color = skill.val >= 10 ? "#9b59b6" : (skill.val >= 20 ? "#e74c3c" : "#3498db");
                logMsg = `<span style="color:${color}; font-weight:bold;">${pName} 施放 ${skill.name}! 轟出 ${damage} 傷害!</span>`; 
                if (room.monsterBuffs && room.monsterBuffs.defTurns > 0) logMsg += ` <span style="font-size:10px; color:#aaa;">(怪物防禦中)</span>`;
            }
            else if (skill.type === 'percent_dmg') {
                let rawDmg = Math.floor(room.monster.maxHp * skill.val);
                let cap = effectiveAtk * 50; 
                if (rawDmg > cap) rawDmg = cap;
                damage = rawDmg;
                room.monster.hp -= damage; 
                logMsg = `<span style="color:#e67e22; font-weight:bold;">${pName} 施放 ${skill.name}! 造成 ${damage} 點真實傷害!</span>`;
            }
            else if (skill.type === 'heal') { 
                let healAmount = Math.floor(player.maxHp * skill.val); 
                player.hp = Math.min(player.hp + healAmount, player.maxHp); 
                logMsg = `<span style="color:#2ecc71">${pName} 施放 ${skill.name}! 恢復了 ${healAmount} HP</span>`; 
            }
            else if (skill.type === 'heal_all') {
                room.players.forEach(pid => {
                    const teammate = gameState.players[pid];
                    if (teammate) { teammate.hp = teammate.maxHp; io.to(pid).emit('playerStatsUpdate', teammate); }
                });
                logMsg = `<span style="color:#2ecc71; font-weight:bold;">✨ ${pName} 施放 ${skill.name}! 全隊完全恢復!</span>`;
            }
            else if (skill.type === 'stun') { 
                let rawDmg = Math.floor(effectiveAtk * skill.val);
                damage = Math.floor(rawDmg - (baseMonDef * 0.5));
                if(damage < 1) damage = 1;

                room.monster.hp -= damage; 
                if (Math.random() < 0.4) { 
                    room.monster.isStunned = true; 
                    logMsg = `<span style="color:#9b59b6">${pName} 施放 ${skill.name}! (${damage}傷) ⚡ 怪物暈眩了!</span>`; 
                } else { 
                    logMsg = `<span style="color:#95a5a6">${pName} 施放 ${skill.name}! (${damage}傷) 但怪物抵抗了暈眩...</span>`; 
                } 
            }
            else if (skill.type === 'drain') { 
                let rawDmg = Math.floor(effectiveAtk * skill.val);
                damage = Math.floor(rawDmg - (baseMonDef * 0.5));
                if(damage < 1) damage = 1;

                room.monster.hp -= damage; 
                let heal = Math.floor(damage * 0.5); 
                player.hp = Math.min(player.hp + heal, player.maxHp); 
                logMsg = `<span style="color:#e74c3c">${pName} 吸取生命! (${damage}傷, +${heal}HP)</span>`; 
            }
            else if (skill.type === 'debuff') { 
                let rawDmg = Math.floor(effectiveAtk * skill.val);
                damage = Math.floor(rawDmg - (baseMonDef * 0.5));
                if(damage < 1) damage = 1;

                room.monster.hp -= damage; 
                let extraDmg = Math.floor(damage * 0.3); 
                room.monster.hp -= extraDmg; 
                logMsg = `<span style="color:#3498db">${pName} 施放 ${skill.name}! 破防追擊 (${damage}+${extraDmg}傷)</span>`; 
            }
            else if (skill.type === 'dot') { 
                let rawDmg = Math.floor(effectiveAtk * skill.val);
                damage = Math.floor(rawDmg - (baseMonDef * 0.5));
                if(damage < 1) damage = 1;

                room.monster.hp -= damage; 
                logMsg = `<span style="color:#27ae60">${pName} 施放 ${skill.name}! 毒素爆發 (${damage}傷)</span>`; 
            }
            else if (skill.type === 'buff') { 
                if (!player.tempBuffs) player.tempBuffs = {}; 
                player.tempBuffs.def = 3; 
                logMsg = `<span style="color:#f1c40f">${pName} 施放 ${skill.name}! 防禦大幅提升</span>`; 
            }
            else if (skill.type === 'buff_atk') { 
                if (!player.tempBuffs) player.tempBuffs = {}; 
                player.tempBuffs.berserk = 3; 
                player.hp = Math.floor(player.hp * 0.8); 
                logMsg = `<span style="color:#c0392b">${pName} 進入狂暴狀態! (攻擊 x2.0)</span>`; 
            }
            else if (skill.type === 'god') {
                if (!player.tempBuffs) player.tempBuffs = {}; 
                player.tempBuffs.god = 3; 
                logMsg = `<span style="color:#f1c40f; font-weight:bold; font-size:14px;">${pName} 開啟 ${skill.name}! 攻防變為3倍!</span>`;
            }
        } 
        else if (type === 'item') {
            const itemId = data.itemId;
            if (!player.inventory[itemId] || player.inventory[itemId] <= 0) return;
            player.inventory[itemId]--; if (player.inventory[itemId] === 0) delete player.inventory[itemId];
            
            const item = ITEM_CONFIG[itemId];
            let effectMsg = "使用了物品";
            
            if (item.type === 'consumable') {
                
                if (itemId === 'void_soup' || itemId === 'elixir') {
                    player.hp = player.maxHp;
                    player.mp = player.maxMp;
                    effectMsg = "全身發光，HP/MP 完全恢復！";
                }
                else if (itemId === 'eel_rice') {
                    player.hp = Math.min(player.hp + 300, player.maxHp);
                    player.mp = Math.min(player.mp + 100, player.maxMp);
                    effectMsg = "食用鰻魚飯，恢復 300 HP 和 100 MP";
                }
                else if (['potion_hp', 'potion_mid', 'potion_high', 'potion_max', 'grilled_carp', 'tuna_steak', 'sushi_plate'].includes(itemId)) {
                    let h = 0;
                    if (itemId === 'potion_hp') h = 50;
                    else if (itemId === 'potion_mid') h = 500;
                    else if (itemId === 'potion_high') h = 2000;
                    else if (itemId === 'potion_max') h = 10000;
                    else if (itemId === 'grilled_carp') h = 100;
                    else if (itemId === 'tuna_steak') h = 500;
                    else if (itemId === 'sushi_plate') h = 500;

                    player.hp = Math.min(player.hp + h, player.maxHp);
                    effectMsg = `恢復 ${h} HP`;
                }
                else if (['potion_mp', 'potion_mp_mid', 'potion_mp_high', 'salmon_sushi'].includes(itemId)) {
                    let m = 0;
                    if (itemId === 'potion_mp') m = 30;
                    else if (itemId === 'potion_mp_mid') m = 100;
                    else if (itemId === 'potion_mp_high') m = 500;
                    else if (itemId === 'salmon_sushi') m = 50;

                    player.mp = Math.min(player.mp + m, player.maxMp);
                    effectMsg = `恢復 ${m} MP`;
                }
            }
            logMsg = `<span style="color:#e67e22">${pName} 使用了 ${item.name}! ${effectMsg}</span>`; 
            damage = 0;
        }
        
        if (room.monster.hp < 0) room.monster.hp = 0; 
        io.to(roomId).emit('battleLog', logMsg); 
        io.to(roomId).emit('monsterUpdate', room.monster); 
        socket.emit('playerStatsUpdate', player); 
        saveMyData(socket.id); 

        //  [秒殺偵測邏輯整合在這裡]
        if (room.monster.hp === 0) { 
            
            //  偵測開始
            const now = Date.now();
            const startTime = room.battleStartTime || now; 
            const duration = now - startTime; // 戰鬥耗時 (毫秒)

            // 條件：Lv.200 以上 & 60秒內打完
            if (room.monster.level >= 280 && duration < 60000) { 
                const durationSec = (duration / 1000).toFixed(1);
                const playerNames = room.players.map(p => gameState.players[p]?.name).join(', '); // 確保取得最新名字

                const logMsg = `⚡ 高難度秒殺異常: Lv.${room.monster.level} ${room.monster.name} 在 ${durationSec}秒 內被擊殺 (玩家: ${playerNames})`;

                if (typeof logSuspicion === 'function') {
                    logSuspicion(`Team: ${room.hostName}`, logMsg);
                }
                console.log(`[BattleBot] 異常擊殺: Lv.${room.monster.level} / ${durationSec}s`);
            }
            //  偵測結束

            handleMonsterDeath(room, roomId); 
            return; 
        } 
        
        processNextTurn(room, roomId);
    });

    socket.on('marketSell', (data) => {
        if (typeof checkRateLimit === 'function' && !checkRateLimit(socket.id, 'trade', 500)) return;

        let { itemId, price, amount } = data;
        const p = gameState.players[socket.id];
        price = parseInt(price);
        
        let countToSell = parseInt(amount) || 1;
        if (countToSell < 1) countToSell = 1;
        if (countToSell > 30) countToSell = 30; 

        if (!p || !price || price <= 0) return;
        if (price > 999999999) { socket.emit('errorMessage', "價格過高 (上限 9.9億)"); return; }

        const NON_TRADABLE_ITEMS = [
            'lucky_bag',
            'genesis_weapon', 'genesis_armor', 'void_reaper_dark', 'ring_galaxy',
            'void_blade', 'void_armor',
            'galaxy_saber', 'nebula_plate',
            'dimension_ring',
            'entropy_sword', 'entropy_god_armor'
        ];

        if (NON_TRADABLE_ITEMS.includes(itemId)) { socket.emit('errorMessage', "此為傳說/神話級綁定裝備，無法在市集交易！"); return; }

        if (!p.inventory[itemId] || p.inventory[itemId] < countToSell) { socket.emit('errorMessage', `你沒有足夠的數量 (擁有: ${p.inventory[itemId] || 0})`); return; }

        let successCount = 0;
        
        function processBatchSell(remaining) {
            if (remaining <= 0) { finishBatch(); return; }

            DB.getPlayerListingCount(p.token, (currentCount) => {
                if (currentCount >= 90) { finishBatch("已達上架上限 (最多90個)"); return; }

                if (p.inventory[itemId] > 0) {
                    p.inventory[itemId]--;
                    
                    if (p.inventory[itemId] === 0) {
                        delete p.inventory[itemId];
                        if (p.enhancements && p.enhancements[itemId]) { delete p.enhancements[itemId]; }
                    }

                    const name = p.name || p.id.substr(0, 4);

                    DB.addListing(p.token, name, itemId, price, (success) => {
                        if (success) {
                            successCount++;
                            processBatchSell(remaining - 1); 
                        } else {
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
                setTimeout(() => { io.emit('marketRefresh'); }, 2000);
            } else {
                socket.emit('marketResult', { success: false, msg: errorMsg || "上架失敗" });
            }
        }

        processBatchSell(countToSell);
    });

    socket.on('dismantleItem', (itemId) => {
        const p = gameState.players[socket.id];
        if (!p) return;

        if (!p.inventory[itemId] || p.inventory[itemId] <= 0) { socket.emit('errorMessage', "你沒有這個物品！"); return; }

        const recipe = RECIPE_CONFIG[itemId];
        if (!recipe) { socket.emit('errorMessage', "此物品無法分解 (不是由配方製作)"); return; }

        if (Object.values(p.equipment).includes(itemId)) { socket.emit('errorMessage', "無法分解已裝備的物品，請先卸下！"); return; }

        let refundMsg = [];
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

        p.inventory[itemId]--;
        
        if (p.inventory[itemId] <= 0) {
            delete p.inventory[itemId];
            if (p.enhancements && p.enhancements[itemId]) { delete p.enhancements[itemId]; }
        }

        socket.emit('playerStatsUpdate', p);
        socket.emit('bagResult', { success: true, msg: `分解成功！獲得：${refundMsg.join(', ')}` });
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

        // 3. 呼叫資料庫進行交易
        DB.buyListing(listingId, buyer.gold, (result) => {
            if (!result.success) {
                socket.emit('marketResult', { success: false, msg: result.msg });
                socket.emit('marketRefresh'); 
                return;
            }

            // --- 交易成功，取得物品資料 ---
            const listing = result.listing;

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

            // 4. 更新買家數據
            buyer.gold -= listing.price;
            
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

    socket.on('npcSell', (itemId) => { 
        const p = gameState.players[socket.id]; 
        const item = ITEM_CONFIG[itemId] || MATERIAL_CONFIG[itemId]; 
        
        if (!p || !item) return; 
        if (!p.inventory[itemId] || p.inventory[itemId] <= 0) return; 

        let baseCost = item.cost || 10; 
        let sellPrice = Math.floor(baseCost * 0.2); 
        if (sellPrice < 1) sellPrice = 1; 

        p.inventory[itemId]--; 

        if (p.inventory[itemId] === 0) { 
            delete p.inventory[itemId]; 
            if (p.enhancements && p.enhancements[itemId]) {
                delete p.enhancements[itemId];
            }
        } 

        p.gold += sellPrice; 
        if (p.gold > 9000000000) p.gold = 9000000000; 

        socket.emit('bagResult', { success: true, msg: ` 已賣給商人，獲得 ${sellPrice} G` }); 
        socket.emit('playerStatsUpdate', p); 
        saveMyData(socket.id); 
    });

    socket.on('playerBuy', (id) => { 
        if (typeof checkRateLimit === 'function' && !checkRateLimit(socket.id, 'trade', 500)) return;

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

        if(p.gold >= cost) { 
            p.gold -= cost; 
            p.inventory[id] = (p.inventory[id]||0)+1; 
            
            if (id === 'lucky_bag') {
                LUCKY_BAG_STOCK--;
                io.emit('stockUpdate', { itemId: 'lucky_bag', count: LUCKY_BAG_STOCK });
                io.emit('chatMessage', { name: '系統', msg: ` 恭喜 ${p.name} 搶購了 1 個奇蹟福袋！(剩餘: ${LUCKY_BAG_STOCK})` });
            }

            socket.emit('buyResult', {success:true, message:`✅ 購買 ${item.name} 成功`, cost:cost}); 
            socket.emit('playerStatsUpdate', p); 
            saveMyData(socket.id); 
        } else { 
            socket.emit('errorMessage', "❌ 金錢不足！"); 
        } 
    });

    socket.on('equipItem', (itemId) => { 
        let p = gameState.players[socket.id]; if(!p) { socket.emit('errorMessage', "請重新登入"); return; } const item = ITEM_CONFIG[itemId]; if(!item) { socket.emit('errorMessage', "物品錯誤"); return; } if(!p.inventory[itemId]) { socket.emit('errorMessage', "無此物品"); return; } const slot = item.type; if(!['weapon','armor','acc'].includes(slot)) { socket.emit('errorMessage', "無法裝備"); return; } 
        if(p.equipment[slot]) { const oldItemId = p.equipment[slot]; p.inventory[oldItemId] = (p.inventory[oldItemId] || 0) + 1; }
        p.equipment[slot] = itemId; p.inventory[itemId]--; if(p.inventory[itemId] <= 0) delete p.inventory[itemId]; 
        calculateStats(p); socket.emit('equipResult', `✅ 已裝備 ${item.name}`); socket.emit('playerStatsUpdate', p); saveMyData(socket.id); 
    });

    socket.on('unequipItem', (slot) => { 
        let p = gameState.players[socket.id]; if(!p || !p.equipment[slot]) return; const itemId = p.equipment[slot]; p.inventory[itemId] = (p.inventory[itemId]||0)+1; p.equipment[slot] = null; calculateStats(p); socket.emit('equipResult', "已卸下！"); socket.emit('playerStatsUpdate', p); saveMyData(socket.id); 
    });

    socket.on('enterCity', (cityId) => { if (gameState.players[socket.id]) { gameState.players[socket.id].currentCity = cityId; broadcastHubData(); saveMyData(socket.id); } });
    
    // 建立房間 (含 Chaos Boss 生成)
    socket.on('createRoom', (monsterKey) => { 
        if (!checkRateLimit(socket.id, 'createRoom', 3000)) {
            socket.emit('errorMessage', "⏳ 操作太快，請稍後再試！");
            return; 
        }

        try { 
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
            
            let monsterData;

            if (monsterKey === 'chaos_boss') {
                monsterData = generateChaosBoss(); 
                monsterData.status = 'alive';
                monsterData.isStunned = false;
            } 
            else {
                const cfg = MONSTER_CONFIG[monsterKey]; 
                if (!cfg) { socket.emit('errorMessage', `找不到怪物數據`); return; } 
                monsterData = { ...cfg, maxHp: cfg.hp, status: 'alive', isStunned: false };
            }

            const roomId = 'room_' + Math.random().toString(36).substr(2, 5); 
            
            gameState.battleRooms[roomId] = { 
                id: roomId, 
                monsterKey: monsterKey, 
                monster: monsterData, 
                status: 'waiting', 
                players: [socket.id], 
                host: socket.id, 
                hostName: p.name, 
                updatedAt: Date.now(), 
                turnIndex: 0, 
                turnOrder: [],
                logs: [],
                rewardsGiven: false,
                playerCount: 1 
            }; 
            
            p.currentRoom = roomId;
            p.state = 'waiting';

            socket.emit('roomJoined', { roomId: roomId, isHost: true }); 
            broadcastHubData(); 
            
        } catch (e) { 
            console.error("Create Room Error:", e); 
            socket.emit('errorMessage', "系統錯誤，無法建立房間");
        } 
    });

    socket.on('joinRoom', (roomId) => { const p = gameState.players[socket.id]; if (!p) return; if (p.hp <= 0) { socket.emit('errorMessage', " 你已經死亡！請先去旅館復活。"); return; } const room = gameState.battleRooms[roomId]; if (room && room.status === 'waiting') { if (room.players.length >= 6) { socket.emit('errorMessage', '房間已滿'); return; } if (!room.players.includes(socket.id)) room.players.push(socket.id); socket.emit('roomJoined', { roomId: roomId, isHost: false }); io.to(roomId).emit('roomInfoUpdate', getRoomPublicInfo(room)); broadcastHubData(); } else { socket.emit('errorMessage', '無法加入'); } });
    
    socket.on('connectToRoom', (roomId) => { 
        const p = gameState.players[socket.id]; 
        if (!p) return; 
        
        const room = gameState.battleRooms[roomId]; 
        
        if (room) { 
            if (room.monster.hp <= 0 || room.monster.status === 'dead' || room.rewardsGiven) { 
                socket.emit('roomLeft'); 
                return; 
            }

            const existingIdx = room.players.findIndex(pid => { 
                const targetP = gameState.players[pid]; 
                return targetP && targetP.token === p.token; 
            });

            if (existingIdx !== -1) { 
                const oldSocketId = room.players[existingIdx]; 

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

                if (room.players.length < 6) { 
                    if (!room.players.includes(socket.id)) {
                        socket.join(roomId);
                        room.players.push(socket.id); 
                    }
                    if (!room.players.includes(room.host)) room.host = room.players[0]; 
                    io.to(roomId).emit('roomInfoUpdate', getRoomPublicInfo(room)); 
                } else { 
                    socket.emit('errorMessage', '房間已滿'); 
                    socket.emit('roomLeft');
                } 
            }
        } else { 
            socket.emit('roomLeft'); 
        } 
    });
    
    socket.on('kickMember', (targetId) => {
        const p = gameState.players[socket.id];
        if (!p) return;

        let roomId = null;
        let room = null;
        for (let rid in gameState.battleRooms) {
            if (gameState.battleRooms[rid].players.includes(socket.id)) {
                roomId = rid;
                room = gameState.battleRooms[rid];
                break;
            }
        }

        if (room && roomId) {
            if (room.host !== socket.id) { socket.emit('errorMessage', "只有房主可以踢人！"); return; }
            if (targetId === socket.id) { socket.emit('errorMessage', "你不能踢自己 (請直接離開房間)"); return; }

            leaveRoomLogic(targetId, roomId);

            const targetName = gameState.players[targetId] ? gameState.players[targetId].name : "玩家";
            io.to(roomId).emit('battleLog', `<span style="color:#e74c3c; font-weight:bold;"> ${targetName} 被房主踢出了隊伍！</span>`);
            io.to(targetId).emit('roomLeft');
        }
    });

    // 開始戰鬥 (含 Chaos Boss 重生邏輯)
    socket.on('startBattle', (data) => {
        // =======================================================
        // CASE A: Single Player Direct Challenge (單人直接挑戰)
        // =======================================================
        if (data === 'chaos_boss') {
            const p = gameState.players[socket.id];
            if (!p) return;

            const monster = generateChaosBoss();
            const roomId = 'room_' + socket.id;
            
            gameState.battleRooms[roomId] = {
                id: roomId,
                host: socket.id,
                hostName: p.name,
                players: [socket.id],
                monster: monster,
                monsterKey: 'chaos_boss',
                status: 'fighting', 
                playerCount: 1,
                turnOrder: shuffleArray([socket.id, 'monster']),
                turnIndex: -1,
                logs: [],
                rewardsGiven: false,
                
                //  1. 加入這行：記錄單人房開始時間
                battleStartTime: Date.now() 
            };

            p.state = 'fighting';
            p.currentRoom = roomId;

            const room = gameState.battleRooms[roomId];
            if (room.enrageTimer) clearTimeout(room.enrageTimer);
            room.enrageTimer = setTimeout(() => {
                if (gameState.battleRooms[roomId] && room.status === 'fighting') {
                    io.to(roomId).emit('battleLog', `<span style="color:red; font-size:16px; font-weight:bold;">☠️ 9 Minutes Passed! ${room.monster.name} cast [World End]!</span>`);
                    room.players.forEach(pid => {
                        io.to(roomId).emit('playerDamaged', { id: pid, damage: 999999999 });
                        io.to(pid).emit('playerDead');
                    });
                }
            }, 9 * 60 * 1000);

            socket.emit('roomJoined', roomId);
            return; 
        }

        // =======================================================
        // CASE B: Host Starting a Lobby (房主開始多人戰鬥)
        // =======================================================
        const roomId = data;
        const room = gameState.battleRooms[roomId];

        if (room && room.host === socket.id && room.status === 'waiting') {
            room.status = 'fighting';
            
            //  2. 加入這行：記錄多人房開始時間
            room.battleStartTime = Date.now(); 
            
            if (room.monsterKey === 'chaos_boss') {
                room.monster = generateChaosBoss();
                room.monster.status = 'alive';
                room.monster.isStunned = false;
                room.rewardsGiven = false;
            } else {
                if (room.monster.hp <= 0) { 
                    room.monster.hp = room.monster.maxHp; 
                    room.monster.status = 'alive'; 
                    room.monster.isStunned = false; 
                    room.rewardsGiven = false; 
                }
            }
            
            let order = [...room.players, 'monster']; 
            room.turnOrder = shuffleArray(order); 
            room.turnIndex = -1; 
            
            io.to(roomId).emit('battleStarted'); 
            io.to(roomId).emit('monsterUpdate', room.monster);
            
            let orderNames = room.turnOrder.map(id => id === 'monster' ? '怪物' : (gameState.players[id] ? gameState.players[id].name : 'Unknown')).join(' → ');
            io.to(roomId).emit('battleLog', `<span style="color:#aaa; font-size:10px;">Order: ${orderNames}</span>`);
            
            if (room.enrageTimer) { clearTimeout(room.enrageTimer); room.enrageTimer = null; }

            room.enrageTimer = setTimeout(() => {
                if (gameState.battleRooms[roomId] && room.status === 'fighting') {
                    io.to(roomId).emit('battleLog', `<span style="color:red; font-size:16px; font-weight:bold;">☠️ 9 Minutes Passed! ${room.monster.name} cast [World End]!</span>`);
                    room.players.forEach(pid => {
                        const p = gameState.players[pid];
                        if (p) {
                            p.hp = 0; 
                            io.to(pid).emit('playerStatsUpdate', p);
                            io.to(roomId).emit('playerDamaged', { id: pid, damage: 999999999 });
                            io.to(pid).emit('playerDead');
                        }
                    });
                }
            }, 9 * 60 * 1000); 

            broadcastHubData(); 
            processNextTurn(room, roomId);
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
            saveMyData(socket.id); 
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

    socket.on('buyLottery', (numbers) => {
        const p = gameState.players[socket.id];
        if (!p) return;

        if (!Array.isArray(numbers) || numbers.length !== 6) { socket.emit('errorMessage', "❌ 請選擇 6 個號碼！"); return; }
        const cost = 10000;
        if (p.gold < cost) { socket.emit('errorMessage', "❌ 金錢不足 (每注 1萬 G)"); return; }

        p.gold -= cost;
        LOTTERY_JACKPOT += 5000;
        
        LOTTERY_BETS.push({
            id: socket.id, 
            name: p.name,  
            nums: numbers.sort((a,b) => a-b)
        });

        saveMyData(socket.id);
        socket.emit('playerStatsUpdate', p);
        socket.emit('lotteryResult', { success: true, msg: `✅ 投注成功！` });
        
        const myBets = LOTTERY_BETS.filter(b => b.name === p.name).map(b => b.nums);
        const myLastBets = LAST_ROUND_BETS.filter(b => b.name === p.name);

        socket.emit('lotteryUpdate', { 
            jackpot: LOTTERY_JACKPOT, 
            count: LOTTERY_BETS.length, 
            myBets: myBets,
            myLastBets: myLastBets,
            lastResult: LAST_DRAW_RESULT 
        });

        socket.broadcast.emit('lotteryUpdate', { 
            jackpot: LOTTERY_JACKPOT, 
            count: LOTTERY_BETS.length 
        });
    });

    socket.on('getLotteryInfo', () => {
        const p = gameState.players[socket.id];
        let myBets = [];
        let myLastBets = [];

        if (p) {
            myBets = LOTTERY_BETS.filter(b => b.name === p.name).map(b => b.nums);
            myLastBets = LAST_ROUND_BETS.filter(b => b.name === p.name);
        }

        socket.emit('lotteryUpdate', { 
            jackpot: LOTTERY_JACKPOT, 
            count: LOTTERY_BETS.length,
            lastResult: LAST_DRAW_RESULT,
            myBets: myBets,
            myLastBets: myLastBets 
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
});

function handleMonsterDeath(room, roomId) { 
    if (room.rewardsGiven) return; room.rewardsGiven = true; 
    room.monster.status = 'dead'; 
    const cfg = MONSTER_CONFIG[room.monsterKey] || room.monster; // Fix for random boss
    io.to(roomId).emit('battleWon', { exp: cfg.exp, gold: cfg.gold }); 
    
    room.players.forEach(pid => { 
        const p = gameState.players[pid]; 
        if (p) { 
            const goldGain = Math.floor(cfg.gold || 0); p.gold += goldGain; if (p.gold > 9000000000) p.gold = 9000000000;
            let ratio = cfg.level / (p.level || 1); if (ratio < 0.1) ratio = 0.1; if (ratio > 3.0) ratio = 3.0; 
            const finalExp = Math.floor(cfg.exp * ratio) || 0; 
            gainExp(p, finalExp, pid); 
            if (cfg.drops) { 
                cfg.drops.forEach(drop => { 
                    if (Math.random() < drop.rate) { 
                        p.inventory[drop.id] = (p.inventory[drop.id] || 0) + 1; 
                        let matName = drop.id; if (ITEM_CONFIG[drop.id]) matName = ITEM_CONFIG[drop.id].name; else if (MATERIAL_CONFIG[drop.id]) matName = MATERIAL_CONFIG[drop.id].name;
                        io.to(pid).emit('battleLog', `<span style="color:#e67e22">獲得：${matName}</span>`); 
                    } 
                }); 
            } 
            saveMyData(pid);
        } 
    }); 
    io.to(roomId).emit('roomInfoUpdate', getRoomPublicInfo(room)); broadcastHubData(); 
}

function saveMyData(socketId) { const p = gameState.players[socketId]; if (p && p.token) { DB.savePlayer(p.token, p); } else { console.log(`[Save Failed] 找不到玩家或 Token 無效 (Socket ID: ${socketId})`); } }

function calculateStats(p) {
    if (!p.baseStats) return;
    
    p.maxHp = p.baseStats.hp;
    p.maxMp = p.baseStats.mp;
    p.atk = p.baseStats.atk;
    p.def = p.baseStats.def;

    if (!p.enhancements || typeof p.enhancements !== 'object') {
        p.enhancements = {};
    }

    Object.keys(p.equipment).forEach(slot => {
        const itemId = p.equipment[slot]; 
        
        if (itemId && ITEM_CONFIG[itemId]) {
            const item = ITEM_CONFIG[itemId];
            const lv = p.enhancements[itemId] || 0; 
            const multiplier = 1 + (lv * 0.1); 

            if (item.hp) p.maxHp += Math.floor(item.hp * multiplier);
            if (item.mp) p.maxMp += Math.floor(item.mp * multiplier);
            if (item.atk) {
                const bonus = Math.floor(item.atk * multiplier);
                p.atk += bonus;
            }
            if (item.def) {
                const bonus = Math.floor(item.def * multiplier);
                p.def += bonus;
            }
        }
    });

    if (p.hp > p.maxHp) p.hp = p.maxHp;
    if (p.mp > p.maxMp) p.mp = p.maxMp;
}

function monsterPhase(room, roomId) { 
    if (!gameState.battleRooms[roomId]) return; 
    if (room.players.length === 0) return; 
    if (room.monster.hp <= 0) return; 

    if (!room.monsterBuffs) room.monsterBuffs = { atkTurns: 0, defTurns: 0 };

    if (room.monsterBuffs.atkTurns > 0) {
        room.monsterBuffs.atkTurns--;
        if (room.monsterBuffs.atkTurns === 0) io.to(roomId).emit('battleLog', `<span style="color:#aaa;"> ${room.monster.name} 的攻擊力恢復正常。</span>`);
    }
    if (room.monsterBuffs.defTurns > 0) {
        room.monsterBuffs.defTurns--;
        if (room.monsterBuffs.defTurns === 0) io.to(roomId).emit('battleLog', `<span style="color:#aaa;"> ${room.monster.name} 的防禦力恢復正常。</span>`);
    }

    if (room.monster.isStunned) { 
        io.to(roomId).emit('battleLog', `<span style="color:#9b59b6">⚡ 怪物麻痺無法動彈！</span>`); 
        room.monster.isStunned = false; 
        processNextTurn(room, roomId); 
        return; 
    }

    let alivePlayers = room.players.filter(pid => gameState.players[pid] && gameState.players[pid].hp > 0); 
    if (alivePlayers.length === 0) { console.log(`[戰鬥] 房間 ${roomId} 全員陣亡`); return; }
    
    const targetId = alivePlayers[Math.floor(Math.random() * alivePlayers.length)]; 
    const target = gameState.players[targetId]; 
    const targetName = target.name; 
    const monsterName = room.monster.name;

    const skillPool = getMonsterSkillSet(room.monster.level);
    const skillKey = skillPool[Math.floor(Math.random() * skillPool.length)];
    
    let logMsg = "";
    let atkMult = room.monsterBuffs.atkTurns > 0 ? 2.0 : 1.0;
    let effectiveMonsterAtk = Math.floor(room.monster.atk * atkMult);

    if (skillKey === 'attack') {
        let effectiveDef = target.def; 
        
        if (target.tempBuffs && target.tempBuffs.def) { 
            effectiveDef *= 2; target.tempBuffs.def--; 
            if(target.tempBuffs.def<=0) delete target.tempBuffs.def; 
        }
        if (target.tempBuffs && target.tempBuffs.god) {
            effectiveDef *= 3; target.tempBuffs.god--;
            if(target.tempBuffs.god<=0) delete target.tempBuffs.god;
        }

        let dmg = Math.floor(effectiveMonsterAtk - (effectiveDef * 0.5)); 
        if (dmg < 1) dmg = 1; 
        
        target.hp -= dmg;
        logMsg = `<span style="color:#e74c3c;">${monsterName} 攻擊了 ${targetName}！(${dmg}傷)</span>`;
        io.to(targetId).emit('playerDamaged', { damage: dmg });

    } else {
        const skill = MON_SKILLS[skillKey];
        
        if (skill.type === 'buff') {
            if (skill.stat === 'atk') {
                room.monsterBuffs.atkTurns = 3;
                logMsg = `<span style="color:#c0392b; font-weight:bold;">⚔️ ${skill.name}！${monsterName} 攻擊力變為 2 倍！(3回合)</span>`;
            } else if (skill.stat === 'def') {
                room.monsterBuffs.defTurns = 3;
                logMsg = `<span style="color:#f1c40f; font-weight:bold;">️ ${skill.name}！${monsterName} 防禦力變為 2 倍！(3回合)</span>`;
            }
        
        } else if (skill.type === 'heal') {
            let percent = 0.02; // 2%
            let healAmt = Math.floor(room.monster.maxHp * percent);
            if (healAmt < 1) healAmt = 1;
            room.monster.hp = Math.min(room.monster.maxHp, room.monster.hp + healAmt);
            
            let percentText = Math.floor(percent * 100);
            logMsg = `<span style="color:#2ecc71;"><b>${skill.name}</b>！${monsterName} 恢復了 ${percentText}% 生命 (+${healAmt})！</span>`;
        
        } else if (skill.type === 'magic') {
            let dmg = Math.floor((effectiveMonsterAtk * skill.rate) - (target.def * 0.2));
            if (dmg < 1) dmg = 1;
            target.hp -= dmg;
            logMsg = `<span style="color:${skill.color};"><b>${skill.name}</b>！${targetName} 受到 ${dmg} 魔法傷害！</span>`;
            io.to(targetId).emit('playerDamaged', { damage: dmg });
        
        } else if (skill.type === 'aoe') {
            logMsg = `<span style="color:#8e44ad;"><b>${skill.name}</b>！對全隊造成重創！</span><br>`;
            alivePlayers.forEach(pid => {
                let p = gameState.players[pid];
                let dmg = Math.floor((effectiveMonsterAtk * skill.rate) - (p.def * 0.3));
                if (dmg < 1) dmg = 1;
                p.hp -= dmg;
                io.to(pid).emit('playerDamaged', { damage: dmg });
                io.to(pid).emit('playerStatsUpdate', p);
                logMsg += `<span style="font-size:10px; color:#aaa;">.. ${p.name} -${dmg}</span> `;
            });

        } else if (skill.type === 'debuff') {
            if (Math.random() < 0.45) {
                target.isStunned = true; 
                logMsg = `<span style="color:#f39c12;"><b>${skill.name}</b>！${targetName} ${skill.desc}</span>`;
                io.to(targetId).emit('errorMessage', "⚡ 你被麻痺了！下一回合無法行動！");
            } else {
                logMsg = `<span style="color:#95a5a6;"><b>${skill.name}</b>！${monsterName} 試圖麻痺 ${targetName}，但被抵抗了！</span>`;
            }

        } else if (skill.type === 'drain_hp') {
            let dmg = Math.floor(effectiveMonsterAtk * skill.rate);
            if(dmg < 1) dmg = 1;
            target.hp -= dmg;
            let heal = Math.floor(dmg * 0.5); 
            room.monster.hp = Math.min(room.monster.maxHp, room.monster.hp + heal);
            logMsg = `<span style="color:#c0392b;"><b>${skill.name}</b>！對 ${targetName} 造成 ${dmg} 傷害並回復生命！</span>`;
            io.to(targetId).emit('playerDamaged', { damage: dmg });

        } else if (skill.type === 'drain_mp') {
            let drain = skill.val;
            if (target.mp < drain) drain = target.mp;
            target.mp -= drain;
            room.monster.hp = Math.min(room.monster.maxHp, room.monster.hp + drain*10); 
            logMsg = `<span style="color:#9b59b6;"><b>${skill.name}</b>！${targetName} 失去了 ${drain} MP！</span>`;
            io.to(targetId).emit('playerStatsUpdate', target);
        }
    }

    if (target.hp <= 0) { 
        target.hp = 0; 
        io.to(targetId).emit('playerDead'); 
        io.to(roomId).emit('battleLog', `<span style="color:#7f8c8d;">☠️ ${targetName} 力盡倒下了... (3秒後回城)</span>`); 
        setTimeout(() => { 
            const currentRoom = gameState.battleRooms[roomId]; 
            if (currentRoom && currentRoom.players.includes(targetId)) { 
                leaveRoomLogic(targetId, roomId); 
                io.to(targetId).emit('roomLeft'); 
            } 
        }, 3000);
    } 
    
    saveMyData(targetId); 
    io.to(targetId).emit('playerStatsUpdate', target); 
    io.to(roomId).emit('battleLog', logMsg); 
    io.to(roomId).emit('monsterUpdate', room.monster); 
    io.to(roomId).emit('roomInfoUpdate', getRoomPublicInfo(room)); 
    
    processNextTurn(room, roomId);
}

function broadcastTurn(room) { const currentEntityId = room.turnOrder[room.turnIndex]; if (currentEntityId === 'monster') { io.to(room.id).emit('turnUpdate', { currentId: 'monster', name: room.monster.name }); } else { const pid = currentEntityId; const p = gameState.players[pid]; const pName = p ? p.name : 'Unknown'; io.to(room.id).emit('turnUpdate', { currentId: pid, name: pName }); } }

function processNextTurn(room, roomId) {
    if (room.status !== 'fighting') return;

    let loopCount = 0; 
    let validTargetFound = false;
    
    while (!validTargetFound && loopCount < 10) {
        room.turnIndex++; 
        if (room.turnIndex >= room.turnOrder.length) { 
            room.turnIndex = 0; 
        }
        
        const nextEntityId = room.turnOrder[room.turnIndex];

        if (nextEntityId === 'monster') { 
            if (room.monster.hp > 0) { 
                validTargetFound = true; 
                broadcastTurn(room); 
                setTimeout(() => monsterPhase(room, roomId), 1000); 
            } 
        } 
        else { 
            const p = gameState.players[nextEntityId];
            if (p && room.players.includes(nextEntityId) && p.hp > 0) { 
                validTargetFound = true; 
                broadcastTurn(room); 
            } else {
                console.log(`[系統] 跳過無效玩家回合: ${nextEntityId}`);
            }
        }
        loopCount++;
    }
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
    const validPlayers = room.players.filter(pid => gameState.players[pid]); room.players = validPlayers; 
    if (validPlayers.length > 0 && !validPlayers.includes(room.host)) room.host = validPlayers[0]; 
    const playerDetails = validPlayers.map(pid => { const p = gameState.players[pid]; return { id: p.id, name: p.name, hp: p.hp, maxHp: p.maxHp, mp: p.mp, maxMp: p.maxMp, level: p.level }; }); 
    let currentTurnId = null; if (room.status === 'fighting' && room.turnOrder && room.turnIndex >= 0) { currentTurnId = room.turnOrder[room.turnIndex]; }
    return { id: room.id, host: room.host, status: room.status, players: playerDetails, monsterName: room.monster.name, monsterKey: room.monsterKey, monsterMaxHp: room.monster.maxHp, monsterHp: room.monster.hp, currentTurnId: currentTurnId }; 
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
            hostName: hostName 
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
    
    let drawNumbers = [];
    while(drawNumbers.length < 6) {
        let n = Math.floor(Math.random() * 49) + 1;
        if(!drawNumbers.includes(n)) drawNumbers.push(n);
    }
    drawNumbers.sort((a,b) => a-b);
    LAST_DRAW_RESULT = drawNumbers;

    io.emit('chatMessage', { name: '彩票', msg: ` 彩票攪珠結果: [ ${drawNumbers.join(' , ')} ]` });

    let winners = [];
    let processedBets = [];

    LOTTERY_BETS.forEach(bet => {
        let hits = bet.nums.filter(n => drawNumbers.includes(n)).length;
        let prize = 0;
        let msg = "";

        if (hits === 6) { 
            prize = Math.floor(LOTTERY_JACKPOT * 0.8); 
            msg = "頭獎";
            winners.push(`${bet.name} (頭獎)`);
            LOTTERY_JACKPOT -= prize; 
        } else if (hits === 5) { 
            prize = 500000; 
            msg = "二獎";
            winners.push(`${bet.name} (二獎)`);
        } else if (hits === 4) { 
            prize = 50000; 
            msg = "三獎";
        } else if (hits === 3) { 
            prize = 20000; 
            msg = "安慰獎";
        }

        if (prize > 0) {
            const socket = io.sockets.sockets.get(bet.id);
            if (socket) {
                const p = gameState.players[bet.id];
                if (p) {
                    p.gold += prize;
                    socket.emit('errorMessage', ` 彩票中獎！${msg} (+${prize.toLocaleString()})`);
                    socket.emit('playerStatsUpdate', p);
                    saveMyData(bet.id);
                }
            }
        }

        processedBets.push({
            id: bet.id,
            name: bet.name,
            nums: bet.nums,
            hits: hits,      
            prize: prize,    
            winMsg: msg      
        });
    });

    if (winners.length > 0) {
        io.emit('chatMessage', { name: '彩票', msg: ` 本期幸運兒: ${winners.join(', ')}` });
    } else {
        io.emit('chatMessage', { name: '彩票', msg: ` 本期頭獎無人中，獎金累積至下一期！` });
    }

    if (LOTTERY_JACKPOT < 1000000) LOTTERY_JACKPOT = 1000000;
    
    LAST_ROUND_BETS = processedBets; 
    LOTTERY_BETS = []; 

    io.emit('lotteryUpdate', { 
        jackpot: LOTTERY_JACKPOT, 
        count: 0, 
        lastResult: drawNumbers 
    });
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

setInterval(() => { 
    const now = Date.now(); 

    Object.keys(gameState.battleRooms).forEach(roomId => { 
        const room = gameState.battleRooms[roomId]; 
        if (room.players.length === 0 || (now - (room.updatedAt || now) > 10 * 60 * 1000)) { 
            delete gameState.battleRooms[roomId]; 
        } 
    }); 

    broadcastHubData(); 

    const hkTime = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Hong_Kong"}));
    const dateStr = hkTime.getDate();   
    const hour = hkTime.getHours();     
    const minute = hkTime.getMinutes(); 

    const bossHours = [15, 19, 23]; 
    
    if (bossHours.includes(hour) && minute === 0) {
        const bossTimeKey = `${dateStr}-${hour}-${minute}`;
        if (lastAutoSpawnTime !== bossTimeKey && !WORLD_BOSS.active) {
            console.log(`[排程] 時間已到 (${hour}:${minute} HKT)，自動召喚 BOSS！`);
            startWorldBossEvent(); 
            lastAutoSpawnTime = bossTimeKey; 
        }
    }

    if (hour === 22 && minute === 0) {
        const lotTimeKey = `${dateStr}-${hour}-${minute}`;
        if (lastLotteryTime !== lotTimeKey) {
            console.log(`[排程] 時間已到 (${hour}:${minute} HKT)，六合彩開獎！`);
            drawLottery();
            lastLotteryTime = lotTimeKey; 
        }
    }

}, 10000); 

const PORT = 3001; 
http.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });