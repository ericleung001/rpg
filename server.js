const express = require('express');
const app = express();
const http = require('http').createServer(app);

//  修改這裡：加入 cors 設定
const io = require('socket.io')(http, {
    cors: {
        origin: "*",  // 允許所有網址連線 (或者改成 "https://你的帳號.github.io")
        methods: ["GET", "POST"]
    }
});
const DB = require('./db'); 
const bcrypt = require('bcryptjs'); //  引入加密套件

app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); next(); });
app.use(express.static(__dirname));

// --- 設定 ---


// --- 怪物設定 (數值膨脹版) ---
// --- 1. 材料設定 (大幅擴充) ---
const MATERIAL_CONFIG = {
    // City 1: 曙光平原 (Lv 1-20)
    'copper_ore':   { name: "銅礦石", desc: "泛著紅光的低階礦石" },
    'soft_fur':     { name: "柔軟皮毛", desc: "小型野獸的毛皮" },
    'beast_fang':   { name: "野獸尖牙", desc: "鋒利的牙齒，可用於武器" },
    'slime_gel':    { name: "黏液", desc: "史萊姆的核心物質" },

    // City 2: 迷霧沼澤 (Lv 20-40)
    'iron_ore':     { name: "鐵礦石", desc: "標準的鍛造金屬" },
    'tough_hide':   { name: "硬皮革", desc: "經過處理的堅韌獸皮" },
    'poison_sac':   { name: "毒囊", desc: "含有致命毒素" },
    'bone_shard':   { name: "碎骨片", desc: "充滿亡靈氣息的骨頭" },

    // City 3: 灼熱峽谷 (Lv 40-60)
    'silver_ore':   { name: "銀礦石", desc: "對魔物有特效的金屬" },
    'fire_core':    { name: "火焰核心", desc: "燃燒著不滅的火焰" },
    'lava_rock':    { name: "熔岩石", desc: "極高溫的石頭" },
    'dragon_scale': { name: "龍鱗", desc: "堅不可摧的鱗片" },

    // City 4: 極寒凍土 (Lv 60-80)
    'gold_ore':     { name: "金礦石", desc: "延展性極佳的高級金屬" },
    'ice_crystal':  { name: "永恆冰晶", desc: "永不融化的冰塊" },
    'yeti_fur':     { name: "雪怪毛皮", desc: "極度保暖的高級皮草" },
    'spirit_dust':  { name: "靈魂粉末", desc: "亡靈死後留下的能量" },

    // City 5: 虛空要塞 (Lv 80-100)
    'mithril':      { name: "秘銀", desc: "傳說中的魔法金屬" },
    'void_dust':    { name: "虛空之塵", desc: "來自異次元的塵埃" },
    'demon_horn':   { name: "惡魔之角", desc: "蘊含強大黑暗力量" },
    'dark_essence': { name: "暗之精華", desc: "純粹的黑暗能量" },

    // City 6: 魔界王座 (Lv 100+)
    'adamantite':   { name: "精金", desc: "世上最堅硬的物質" },
    'god_blood':    { name: "神之血", desc: "散發著神聖光芒的液體" },
    'chaos_orb':    { name: "混沌寶珠", desc: "創造與毀滅的核心" },
    'angel_feather':{ name: "天使之羽", desc: "墮天使掉落的黑色羽毛" }
};

// --- 2. 裝備與道具設定 (多樣化) ---
const ITEM_CONFIG = {
    // === 消耗品 ===
    'potion_hp':    { name: "小紅藥水", type: 'consumable', cost: 50, desc: "恢復 50 HP" },
    'potion_mid':   { name: "中紅藥水", type: 'consumable', cost: 200, desc: "恢復 500 HP" },
    'potion_high':  { name: "大紅藥水", type: 'consumable', cost: 1000, desc: "恢復 2000 HP" },
    'potion_max':   { name: "特級秘藥", type: 'consumable', cost: 5000, desc: "恢復 10000 HP" },
    'elixir':       { name: "神之甘露", type: 'consumable', cost: 20000, desc: "恢復 50000 HP" },

    // === T1: 新手 (Lv 1-20) ===
    'wood_sword':   { name: "木劍", type: 'weapon', atk: 10, cost: 100, desc: "訓練用武器" },
    'copper_dagger':{ name: "銅匕首", type: 'weapon', atk: 15, cost: 200, desc: "輕便的短刀" },
    'cloth_armor':  { name: "布衣", type: 'armor', def: 5, hp: 50, cost: 100, desc: "普通的衣服" },
    'hunt_vest':    { name: "獵人背心", type: 'armor', def: 8, hp: 80, cost: 0, desc: "【合成】適合野外行動" },
    'bone_ring':    { name: "骨戒", type: 'acc', atk: 2, cost: 0, desc: "【合成】野獸骨頭製成" },

    // === T2: 進階 (Lv 20-40) ===
    'iron_sword':   { name: "鐵劍", type: 'weapon', atk: 40, cost: 500, desc: "標準冒險者裝備" },
    'spike_club':   { name: "狼牙棒", type: 'weapon', atk: 55, cost: 0, desc: "【合成】破壞力強大" },
    'leather_armor':{ name: "皮甲", type: 'armor', def: 20, hp: 200, cost: 400, desc: "防禦力不錯" },
    'snake_boots':  { name: "蛇皮長靴", type: 'acc', def: 10, hp: 100, cost: 0, desc: "【合成】用毒蛇皮製成" },
    'poison_dag':   { name: "劇毒匕首", type: 'weapon', atk: 60, cost: 0, desc: "【合成】塗滿毒液" },

    // === T3: 菁英 (Lv 40-60) ===
    'silver_blade': { name: "銀刃", type: 'weapon', atk: 150, cost: 2000, desc: "對不死族有效" },
    'flame_staff':  { name: "火焰法杖", type: 'weapon', atk: 200, cost: 0, desc: "【合成】燃燒魔力" },
    'chain_mail':   { name: "鎖子甲", type: 'armor', def: 60, hp: 800, cost: 1500, desc: "金屬環編織而成" },
    'magma_plate':  { name: "熔岩胸甲", type: 'armor', def: 100, hp: 1500, cost: 0, desc: "【合成】灼熱的防禦" },
    'ring_str':     { name: "力量戒指", type: 'acc', atk: 30, cost: 3000, desc: "增加攻擊力" },

    // === T4: 大師 (Lv 60-80) ===
    'gold_axe':     { name: "黃金巨斧", type: 'weapon', atk: 500, cost: 10000, desc: "華麗且致命" },
    'frost_bow':    { name: "寒冰弓", type: 'weapon', atk: 650, cost: 0, desc: "【合成】射出冰箭" },
    'ice_robe':     { name: "冰霜法袍", type: 'armor', def: 200, mp: 500, cost: 0, desc: "【合成】魔力護盾" },
    'yeti_cloak':   { name: "雪怪斗篷", type: 'armor', def: 250, hp: 3000, cost: 0, desc: "【合成】極度抗寒" },
    'amulet_soul':  { name: "靈魂護符", type: 'acc', mp: 300, hp: 1000, cost: 0, desc: "【合成】守護靈魂" },

    // === T5: 傳說 (Lv 80-100) ===
    'mithril_saber':{ name: "秘銀軍刀", type: 'weapon', atk: 2000, cost: 50000, desc: "削鐵如泥" },
    'void_reaper':  { name: "虛空收割者", type: 'weapon', atk: 3500, cost: 0, desc: "【合成】來自深淵的武器" },
    'demon_armor':  { name: "惡魔戰甲", type: 'armor', def: 1000, hp: 10000, cost: 0, desc: "【合成】散發著邪氣" },
    'ring_lord':    { name: "領主指環", type: 'acc', atk: 500, def: 500, cost: 0, desc: "【合成】統治者的象徵" },

    // === T6: 神話 (Lv 100+) ===
    'god_slayer':   { name: "弒神劍", type: 'weapon', atk: 20000, cost: 0, desc: "【合成】連神都能斬殺" },
    'chaos_staff':  { name: "混沌法杖", type: 'weapon', atk: 25000, cost: 0, desc: "【合成】掌控混沌之力" },
    'angel_armor':  { name: "熾天使鎧甲", type: 'armor', def: 5000, hp: 50000, cost: 0, desc: "【合成】神聖不可侵犯" },
    'crown_chaos':  { name: "混沌之冠", type: 'acc', atk: 2000, def: 2000, hp: 20000, cost: 0, desc: "【合成】萬物的主宰" }
};

// --- 3. 合成配方 (Recipe) ---
const RECIPE_CONFIG = {
    // T1: 曙光平原
    'hunt_vest':    { materials: {'soft_fur': 5, 'copper_ore': 2}, gold: 200 },
    'bone_ring':    { materials: {'beast_fang': 3, 'slime_gel': 5}, gold: 100 },

    // T2: 迷霧沼澤
    'spike_club':   { materials: {'iron_ore': 10, 'bone_shard': 5}, gold: 800 },
    'snake_boots':  { materials: {'tough_hide': 8, 'poison_sac': 2}, gold: 600 },
    'poison_dag':   { materials: {'iron_ore': 5, 'poison_sac': 5}, gold: 1000 },

    // T3: 灼熱峽谷
    'flame_staff':  { materials: {'silver_ore': 5, 'fire_core': 3}, gold: 3000 },
    'magma_plate':  { materials: {'iron_ore': 20, 'lava_rock': 10}, gold: 4000 },

    // T4: 極寒凍土
    'frost_bow':    { materials: {'gold_ore': 5, 'ice_crystal': 5}, gold: 10000 },
    'ice_robe':     { materials: {'yeti_fur': 10, 'ice_crystal': 8}, gold: 12000 },
    'yeti_cloak':   { materials: {'yeti_fur': 15, 'spirit_dust': 5}, gold: 10000 },
    'amulet_soul':  { materials: {'gold_ore': 3, 'spirit_dust': 10}, gold: 8000 },

    // T5: 虛空要塞
    'void_reaper':  { materials: {'mithril': 10, 'void_dust': 20}, gold: 50000 },
    'demon_armor':  { materials: {'mithril': 15, 'demon_horn': 10}, gold: 60000 },
    'ring_lord':    { materials: {'dark_essence': 5, 'gold_ore': 20}, gold: 40000 },

    // T6: 魔界王座 (終極神器)
    'god_slayer':   { materials: {'adamantite': 10, 'god_blood': 5, 'dragon_scale': 20}, gold: 1000000 },
    'chaos_staff':  { materials: {'adamantite': 10, 'chaos_orb': 5, 'void_dust': 50}, gold: 1200000 },
    'angel_armor':  { materials: {'adamantite': 20, 'angel_feather': 10, 'god_blood': 5}, gold: 1500000 },
    'crown_chaos':  { materials: {'chaos_orb': 3, 'angel_feather': 5, 'dark_essence': 50}, gold: 2000000 }
};

// --- 4. 怪物設定 (更新掉落表) ---
const MONSTER_CONFIG = {
    // City 1: 曙光平原
    'slime': { name: "史萊姆", level: 1, hp: 100, exp: 10, gold: 5, atk: 10, drops: [{id:'slime_gel', rate:0.5}] },
    'rat': { name: "大老鼠", level: 3, hp: 200, exp: 20, gold: 10, atk: 15, drops: [{id:'soft_fur', rate:0.4}] },
    'bee': { name: "殺人蜂", level: 5, hp: 300, exp: 35, gold: 15, atk: 25, drops: [{id:'beast_fang', rate:0.3}, {id:'potion_hp', rate:0.1}] },
    'boar': { name: "野豬", level: 8, hp: 600, exp: 60, gold: 25, atk: 35, drops: [{id:'soft_fur', rate:0.5}, {id:'beast_fang', rate:0.3}] },
    'thief': { name: "盜賊", level: 12, hp: 1000, exp: 100, gold: 100, atk: 50, drops: [{id:'copper_ore', rate:0.4}, {id:'copper_dagger', rate:0.05}] },
    'wolf_king': { name: "狼王", level: 15, hp: 2500, exp: 300, gold: 300, atk: 80, drops: [{id:'bone_ring', rate:0.1}, {id:'soft_fur', rate:1.0}] },

    // City 2: 迷霧沼澤
    'snake': { name: "毒蛇", level: 22, hp: 3500, exp: 400, gold: 50, atk: 100, drops: [{id:'poison_sac', rate:0.4}, {id:'tough_hide', rate:0.2}] },
    'zombie': { name: "腐屍", level: 25, hp: 5000, exp: 500, gold: 60, atk: 110, drops: [{id:'bone_shard', rate:0.5}, {id:'cloth_armor', rate:0.1}] },
    'skeleton': { name: "骷髏兵", level: 28, hp: 4500, exp: 600, gold: 70, atk: 130, drops: [{id:'iron_ore', rate:0.4}, {id:'bone_shard', rate:0.4}] },
    'ghoul': { name: "食屍鬼", level: 32, hp: 7000, exp: 800, gold: 90, atk: 150, drops: [{id:'tough_hide', rate:0.5}] },
    'witch': { name: "沼澤女巫", level: 35, hp: 6000, exp: 1000, gold: 150, atk: 200, drops: [{id:'poison_sac', rate:0.5}, {id:'potion_mid', rate:0.2}] },
    'hydra': { name: "九頭蛇", level: 40, hp: 20000, exp: 3000, gold: 1000, atk: 300, drops: [{id:'snake_boots', rate:0.1}, {id:'poison_sac', rate:1.0}] },

    // City 3: 灼熱峽谷
    'fire_imp': { name: "火焰小鬼", level: 42, hp: 15000, exp: 1500, gold: 200, atk: 350, drops: [{id:'fire_core', rate:0.3}] },
    'lava_golem': { name: "熔岩戈侖", level: 45, hp: 30000, exp: 2000, gold: 250, atk: 400, drops: [{id:'lava_rock', rate:0.6}, {id:'iron_ore', rate:0.5}] },
    'salamander': { name: "火蜥蜴", level: 48, hp: 25000, exp: 2500, gold: 300, atk: 450, drops: [{id:'tough_hide', rate:0.4}, {id:'fire_core', rate:0.2}] },
    'fire_mage': { name: "烈焰法師", level: 52, hp: 20000, exp: 3000, gold: 400, atk: 600, drops: [{id:'silver_ore', rate:0.4}, {id:'potion_mid', rate:0.3}] },
    'dragon_hatchling': { name: "幼龍", level: 55, hp: 40000, exp: 4000, gold: 500, atk: 700, drops: [{id:'dragon_scale', rate:0.2}, {id:'fire_core', rate:0.4}] },
    'balrog': { name: "炎魔", level: 60, hp: 100000, exp: 10000, gold: 3000, atk: 1000, drops: [{id:'magma_plate', rate:0.05}, {id:'fire_core', rate:1.0}] },

    // City 4: 極寒凍土
    'snow_wolf': { name: "雪原狼", level: 62, hp: 60000, exp: 5000, gold: 600, atk: 1200, drops: [{id:'soft_fur', rate:0.5}, {id:'ice_crystal', rate:0.2}] },
    'yeti': { name: "雪人", level: 65, hp: 120000, exp: 6000, gold: 700, atk: 1500, drops: [{id:'yeti_fur', rate:0.6}, {id:'gold_ore', rate:0.2}] },
    'ice_spirit': { name: "冰精靈", level: 68, hp: 80000, exp: 7000, gold: 800, atk: 1800, drops: [{id:'ice_crystal', rate:0.5}, {id:'spirit_dust', rate:0.3}] },
    'frost_knight': { name: "寒霜騎士", level: 72, hp: 150000, exp: 9000, gold: 1000, atk: 2000, drops: [{id:'gold_ore', rate:0.4}, {id:'ice_crystal', rate:0.3}] },
    'ice_dragon': { name: "冰霜龍", level: 75, hp: 200000, exp: 12000, gold: 1500, atk: 2500, drops: [{id:'dragon_scale', rate:0.5}, {id:'potion_high', rate:0.2}] },
    'lich_king': { name: "巫妖王", level: 80, hp: 500000, exp: 30000, gold: 10000, atk: 3500, drops: [{id:'amulet_soul', rate:0.1}, {id:'spirit_dust', rate:1.0}] },

    // City 5: 虛空要塞
    'void_eye': { name: "虛空之眼", level: 82, hp: 300000, exp: 15000, gold: 2000, atk: 4000, drops: [{id:'void_dust', rate:0.5}] },
    'shadow_assassin': { name: "暗影刺客", level: 85, hp: 400000, exp: 18000, gold: 2500, atk: 5000, drops: [{id:'mithril', rate:0.3}, {id:'dark_essence', rate:0.2}] },
    'dark_paladin': { name: "墮落聖騎", level: 88, hp: 600000, exp: 22000, gold: 3000, atk: 6000, drops: [{id:'mithril', rate:0.5}, {id:'void_dust', rate:0.4}] },
    'demon_guard': { name: "惡魔守衛", level: 92, hp: 800000, exp: 28000, gold: 4000, atk: 7500, drops: [{id:'demon_horn', rate:0.4}, {id:'dragon_scale', rate:0.2}] },
    'succubus': { name: "魅魔", level: 95, hp: 700000, exp: 35000, gold: 5000, atk: 8500, drops: [{id:'dark_essence', rate:0.5}, {id:'potion_max', rate:0.1}] },
    'void_lord': { name: "虛空領主", level: 99, hp: 2000000, exp: 100000, gold: 50000, atk: 12000, drops: [{id:'void_reaper', rate:0.05}, {id:'dark_essence', rate:1.0}] },

    // City 6: 魔界王座
    'chaos_beast': { name: "混沌巨獸", level: 105, hp: 3000000, exp: 150000, gold: 10000, atk: 15000, drops: [{id:'chaos_orb', rate:0.2}, {id:'adamantite', rate:0.2}] },
    'fallen_angel': { name: "墮天使", level: 110, hp: 4000000, exp: 200000, gold: 20000, atk: 18000, drops: [{id:'angel_feather', rate:0.3}, {id:'god_blood', rate:0.1}] },
    'demon_king': { name: "魔王撒旦", level: 150, hp: 9999999, exp: 1000000, gold: 999999, atk: 99999, drops: [{id:'god_slayer', rate:0.05}, {id:'chaos_orb', rate:1.0}, {id:'angel_feather', rate:1.0}] }
};

let gameState = { players: {}, battleRooms: {} };

io.on('connection', (socket) => {
    console.log(`[連線] ID: ${socket.id}`);

    DB.getChatHistory(50, (rows) => {
        const history = rows.map(r => ({ name: r.sender_name, msg: r.message }));
        socket.emit('chatHistory', history);
    });

    //  註冊：檢查長度 -> 加密 -> 存入
    //  註冊：檢查長度 -> 加密 -> 存入
    socket.on('register', (data) => { 
        const { user, pass } = data; 
        if (!user || user.length < 5) { socket.emit('authResult', { success: false, msg: "帳號至少需 5 字元" }); return; }
        if (!pass || pass.length < 5) { socket.emit('authResult', { success: false, msg: "密碼至少需 5 字元" }); return; }

        const salt = bcrypt.genSaltSync(10);
        const hash = bcrypt.hashSync(pass, salt); 
        const newToken = 'user_' + Math.random().toString(36).substr(2); 
        
        // 修改這裡：接收 msg 參數
        DB.createAccount(user, hash, newToken, (success, msg) => { 
            // 如果沒有傳 msg，預設根據 success 判斷
            const finalMsg = msg || (success ? "註冊成功！" : "帳號已存在");
            socket.emit('authResult', { success, msg: finalMsg }); 
        }); 
    });

    //  登入：取出 -> 比對
    //  登入：取出 -> 比對 (這段要完全取代舊的 DB.loginAccount 寫法)
    socket.on('login', (data) => { 
        const { user, pass } = data; 
        
        // 1. 基本檢查
        if (!user || user.length < 5) { socket.emit('authResult', { success: false, msg: "帳號長度不足" }); return; }
        
        // 2. 呼叫 DB.getUserInfo (千萬不要再寫 loginAccount!)
        DB.getUserInfo(user, (info) => {
            if (!info) {
                // 找不到帳號
                socket.emit('authResult', { success: false, msg: "帳號不存在" });
            } else {
                // 3. 使用 bcrypt 比對密碼
                // pass 是使用者輸入的明碼，info.password 是資料庫裡的加密亂碼
                if (bcrypt.compareSync(pass, info.password)) {
                    socket.emit('authResult', { success: true, msg: "登入成功", token: info.token });
                } else {
                    socket.emit('authResult', { success: false, msg: "密碼錯誤" });
                }
            }
        }); 
    });

    
    socket.on('joinGame', (token) => { 
        if (!token) return; 
        Object.keys(gameState.players).forEach(sid => { if (gameState.players[sid].token === token && sid !== socket.id) delete gameState.players[sid]; }); 
        DB.loadPlayer(token, (savedData) => { 
            if (savedData) { 
                let p = savedData; 
                if (!p.baseStats) p.baseStats = { hp: 100, mp: 50, atk: 10, def: 5 }; 
                if (!p.equipment) p.equipment = { weapon: null, armor: null, acc: null }; 
                if (!p.inventory) p.inventory = {}; 
                if (!p.currentCity) p.currentCity = 'city_1'; 
                const oldSocketId = p.id; 
                p.id = socket.id; 
                p.token = token; 
                gameState.players[socket.id] = p; 
                calculateStats(p); 
                Object.values(gameState.battleRooms).forEach(room => { const idx = room.players.indexOf(oldSocketId); if (idx !== -1) { room.players[idx] = socket.id; if (room.host === oldSocketId) room.host = socket.id; socket.join(room.id); } }); 
            } else { 
                let newPlayer = { id: socket.id, token: token, gold: 1000, level: 1, exp: 0, maxExp: 100, baseStats: { hp: 100, mp: 50, atk: 10, def: 5 }, hp: 100, maxHp: 100, mp: 50, maxMp: 50, atk: 10, def: 5, currentCity: 'city_1', inventory: {}, equipment: { weapon: null, armor: null, acc: null } }; 
                gameState.players[socket.id] = newPlayer; 
                DB.savePlayer(token, newPlayer); 
            } 
            socket.emit('playerStatsUpdate', gameState.players[socket.id]); 
            broadcastHubData(); 
        }); 
    });

// --- 聊天功能 (加入 HTML 過濾) ---
    socket.on('sendChat', (msg) => {
        const player = gameState.players[socket.id];
        
        // 檢查玩家是否存在，且訊息不為空
        if (player && msg && msg.trim().length > 0) {
            const name = player.id.substr(0, 4);
            
            // 1. 截斷長度 (防止過長訊息)
            let content = msg.substring(0, 50);

            // 2.  關鍵修改：將 HTML 特殊符號轉義 (Sanitize)
            // 這會把 "<script>" 變成 "&lt;script&gt;"，瀏覽器會顯示文字但不會執行
            content = content
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#039;");

            // 3. 存入資料庫 (存的是安全文字)
            DB.logChat(name, content);

            // 4. 廣播給所有人
            io.emit('chatMessage', { id: player.id, name: name, msg: content });
        }
    });
    // --- 鍛造 ---
    socket.on('getRecipes', () => { const recipes = Object.keys(RECIPE_CONFIG).map(key => { const item = ITEM_CONFIG[key]; const req = RECIPE_CONFIG[key]; const matList = Object.keys(req.materials).map(matId => ({ id: matId, name: MATERIAL_CONFIG[matId] ? MATERIAL_CONFIG[matId].name : matId, count: req.materials[matId] })); let statsInfo = []; if (item.atk) statsInfo.push(`⚔️ATK+${item.atk}`); if (item.def) statsInfo.push(`️DEF+${item.def}`); if (item.hp) statsInfo.push(`❤️HP+${item.hp}`); if (item.mp) statsInfo.push(`MP+${item.mp}`); return { itemId: key, itemName: item.name, itemDesc: item.desc, itemStats: statsInfo.join(' '), goldCost: req.gold, materials: matList }; }); socket.emit('recipeList', recipes); });
    socket.on('craftItem', (targetItemId) => { const p = gameState.players[socket.id]; const recipe = RECIPE_CONFIG[targetItemId]; const targetItem = ITEM_CONFIG[targetItemId]; if (!p || !recipe || !targetItem) return; if (p.gold < recipe.gold) { socket.emit('craftResult', { success: false, msg: "金幣不足！" }); return; } for (let matId in recipe.materials) { const needed = recipe.materials[matId]; const has = p.inventory[matId] || 0; if (has < needed) { const matName = MATERIAL_CONFIG[matId] ? MATERIAL_CONFIG[matId].name : matId; socket.emit('craftResult', { success: false, msg: `材料不足：${matName}` }); return; } } p.gold -= recipe.gold; for (let matId in recipe.materials) { p.inventory[matId] -= recipe.materials[matId]; if (p.inventory[matId] <= 0) delete p.inventory[matId]; } p.inventory[targetItemId] = (p.inventory[targetItemId] || 0) + 1; socket.emit('craftResult', { success: true, msg: `成功打造：${targetItem.name}` }); socket.emit('playerStatsUpdate', p); saveMyData(socket.id); });
    
    // --- 市集 (修正名稱顯示) ---
    socket.on('getMarket', () => { 
        DB.getListings((rows) => { 
            const listings = rows.map(r => {
                //  修正：同時檢查 ITEM_CONFIG 和 MATERIAL_CONFIG
                let name = r.item_key;
                if (ITEM_CONFIG[r.item_key]) name = ITEM_CONFIG[r.item_key].name;
                else if (MATERIAL_CONFIG[r.item_key]) name = MATERIAL_CONFIG[r.item_key].name;

                return { 
                    id: r.id, 
                    seller: r.seller_name, 
                    itemKey: r.item_key, 
                    itemName: name, 
                    price: r.price, 
                    isMine: (gameState.players[socket.id] && gameState.players[socket.id].token === r.seller_token) 
                };
            }); 
            socket.emit('marketUpdate', listings); 
        }); 
    });

    socket.on('marketSell', (data) => { const { itemId, price } = data; const p = gameState.players[socket.id]; if (!p || !price || price <= 0) return; if (p.inventory[itemId] > 0) { p.inventory[itemId]--; if (p.inventory[itemId] === 0) delete p.inventory[itemId]; const name = p.id.substr(0, 4); DB.addListing(p.token, name, itemId, parseInt(price), (success) => { if (success) { socket.emit('marketResult', { success: true, msg: "上架成功！" }); socket.emit('playerStatsUpdate', p); saveMyData(socket.id); io.emit('marketRefresh'); } else { p.inventory[itemId] = (p.inventory[itemId] || 0) + 1; socket.emit('marketResult', { success: false, msg: "上架失敗" }); } }); } });
    
    socket.on('marketBuy', (listingId) => { 
        const buyer = gameState.players[socket.id]; if (!buyer) return; 
        DB.buyListing(listingId, (listing) => { 
            if (!listing) { socket.emit('marketResult', { success: false, msg: "已被買走" }); return; } 
            if (buyer.gold < listing.price) { socket.emit('marketResult', { success: false, msg: "金幣不足" }); DB.addListing(listing.seller_token, listing.seller_name, listing.item_key, listing.price, ()=>{}); return; } 
            
            buyer.gold -= listing.price; 
            buyer.inventory[listing.item_key] = (buyer.inventory[listing.item_key] || 0) + 1; 
            socket.emit('marketResult', { success: true, msg: "購買成功" }); 
            socket.emit('playerStatsUpdate', buyer); saveMyData(socket.id); 
            
            //  修正：通知名稱檢查
            let itemName = listing.item_key;
            if (ITEM_CONFIG[listing.item_key]) itemName = ITEM_CONFIG[listing.item_key].name;
            else if (MATERIAL_CONFIG[listing.item_key]) itemName = MATERIAL_CONFIG[listing.item_key].name;

            let sellerSocketId = Object.keys(gameState.players).find(sid => gameState.players[sid].token === listing.seller_token); 
            if (sellerSocketId) { 
                let seller = gameState.players[sellerSocketId]; 
                seller.gold += listing.price; 
                io.to(sellerSocketId).emit('marketResult', { success: true, msg: ` 你的【${itemName}】賣出了！獲得 ${listing.price} G` }); 
                io.to(sellerSocketId).emit('playerStatsUpdate', seller); saveMyData(sellerSocketId); 
            } else { 
                DB.loadPlayer(listing.seller_token, (offlineData) => { if (offlineData) { offlineData.gold += listing.price; DB.savePlayer(listing.seller_token, offlineData); } }); 
            } 
            io.emit('marketRefresh'); 
        }); 
    });
    
    socket.on('marketCancel', (listingId) => {
        const p = gameState.players[socket.id];
        if (!p) return;
        DB.cancelListing(listingId, p.token, (listing) => {
            if (!listing) {
                socket.emit('marketResult', { success: false, msg: "取消失敗 (可能已被買走)" });
            } else {
                p.inventory[listing.item_key] = (p.inventory[listing.item_key] || 0) + 1;
                saveMyData(socket.id);
                socket.emit('playerStatsUpdate', p);
                socket.emit('marketResult', { success: true, msg: "✅ 已取回物品" });
                io.emit('marketRefresh');
            }
        });
    });

    socket.on('npcSell', (itemId) => { const p = gameState.players[socket.id]; const item = ITEM_CONFIG[itemId]; if (!p || !item) return; if (!p.inventory[itemId] || p.inventory[itemId] <= 0) return; let baseCost = item.cost || 10; let sellPrice = Math.floor(baseCost * 0.2); if (sellPrice < 1) sellPrice = 1; p.inventory[itemId]--; if (p.inventory[itemId] === 0) delete p.inventory[itemId]; p.gold += sellPrice; socket.emit('bagResult', { success: true, msg: ` 已賣給商人，獲得 ${sellPrice} G` }); socket.emit('playerStatsUpdate', p); saveMyData(socket.id); });
    socket.on('playerBuy', (id) => { let p = gameState.players[socket.id]; if(!p) { socket.emit('errorMessage', "請重新登入"); return; } const item = ITEM_CONFIG[id]; if(!item) { socket.emit('errorMessage', "商品不存在"); return; } if(p.gold >= item.cost) { p.gold -= item.cost; p.inventory[id] = (p.inventory[id]||0)+1; socket.emit('buyResult', {success:true, message:`✅ 購買 ${item.name} 成功`, cost:0}); socket.emit('playerStatsUpdate', p); saveMyData(socket.id); } else { socket.emit('errorMessage', "❌ 金錢不足！"); } });

    // --- 裝備 ---
    socket.on('equipItem', (itemId) => { let p = gameState.players[socket.id]; if(!p) { socket.emit('errorMessage', "請重新登入"); return; } const item = ITEM_CONFIG[itemId]; if(!item) { socket.emit('errorMessage', "物品錯誤"); return; } if(!p.inventory[itemId]) { socket.emit('errorMessage', "無此物品"); return; } const slot = item.type; if(!['weapon','armor','acc'].includes(slot)) { socket.emit('errorMessage', "無法裝備"); return; } if(p.equipment[slot]) p.inventory[p.equipment[slot]] = (p.inventory[p.equipment[slot]]||0)+1; p.equipment[slot] = itemId; p.inventory[itemId]--; if(p.inventory[itemId]<=0) delete p.inventory[itemId]; calculateStats(p); socket.emit('equipResult', "✅ 裝備成功！"); socket.emit('playerStatsUpdate', p); saveMyData(socket.id); });
    socket.on('unequipItem', (slot) => { let p = gameState.players[socket.id]; if(!p || !p.equipment[slot]) return; const itemId = p.equipment[slot]; p.inventory[itemId] = (p.inventory[itemId]||0)+1; p.equipment[slot] = null; calculateStats(p); socket.emit('equipResult', "已卸下！"); socket.emit('playerStatsUpdate', p); saveMyData(socket.id); });

    socket.on('enterCity', (cityId) => { if (gameState.players[socket.id]) { gameState.players[socket.id].currentCity = cityId; broadcastHubData(); saveMyData(socket.id); } });
    socket.on('createRoom', (monsterKey) => { try { const p = gameState.players[socket.id]; if (!p) return; if (p.hp <= 0) { socket.emit('errorMessage', " 你已經死亡！請先去旅館復活。"); return; } const cfg = MONSTER_CONFIG[monsterKey]; if (!cfg) { socket.emit('errorMessage', `找不到怪物`); return; } const roomId = 'room_' + Math.random().toString(36).substr(2, 5); gameState.battleRooms[roomId] = { id: roomId, monsterKey: monsterKey, monster: { ...cfg, maxHp: cfg.hp, status: 'alive' }, status: 'waiting', players: [socket.id], host: socket.id, updatedAt: Date.now(), turnIndex: 0 }; socket.emit('roomJoined', { roomId: roomId, isHost: true }); broadcastHubData(); } catch (e) { console.error(e); } });
    socket.on('joinRoom', (roomId) => { const p = gameState.players[socket.id]; if (!p) return; if (p.hp <= 0) { socket.emit('errorMessage', " 你已經死亡！請先去旅館復活。"); return; } const room = gameState.battleRooms[roomId]; if (room && room.status === 'waiting') { if (room.players.length >= 5) { socket.emit('errorMessage', '房間已滿'); return; } if (!room.players.includes(socket.id)) room.players.push(socket.id); socket.emit('roomJoined', { roomId: roomId, isHost: false }); io.to(roomId).emit('roomInfoUpdate', getRoomPublicInfo(room)); broadcastHubData(); } else { socket.emit('errorMessage', '無法加入'); } });
    socket.on('connectToRoom', (roomId) => { const p = gameState.players[socket.id]; if (!p) return; if (p.hp <= 0) { socket.emit('errorMessage', " 你已經死亡！請先去旅館復活。"); return; } const room = gameState.battleRooms[roomId]; if (room) { socket.join(roomId); if (!room.players.includes(socket.id)) { if(room.players.length < 5) room.players.push(socket.id); else { socket.emit('errorMessage', '房間已滿'); return; } } if (!room.players.includes(room.host)) room.host = room.players[0]; socket.emit('roomInfoUpdate', getRoomPublicInfo(room)); if (room.status === 'fighting') { socket.emit('battleStarted'); socket.emit('monsterUpdate', room.monster); broadcastTurn(room); } } else { socket.emit('errorMessage', '房間已失效'); } });
    socket.on('startBattle', (roomId) => { const room = gameState.battleRooms[roomId]; if (room && room.host === socket.id) { room.status = 'fighting'; room.turnIndex = 0; io.to(roomId).emit('battleStarted'); io.to(roomId).emit('monsterUpdate', room.monster); broadcastTurn(room); broadcastHubData(); } });
    socket.on('combatAction', (data) => { 
        const { roomId, type } = data; 
        const room = gameState.battleRooms[roomId]; 
        const player = gameState.players[socket.id]; 
        if (!room || !player || room.status !== 'fighting') return; 
        if (socket.id !== room.players[room.turnIndex]) return; 
        
        let damage = 0; 
        if (type === 'attack') {
            damage = player.atk + Math.floor(Math.random() * 5); 
            io.to(roomId).emit('battleLog', `<span style="color:#f1c40f">${player.id.substr(0,4)} 攻擊! 造成 ${damage} 傷害</span>`);
        } else if (type === 'skill') { 
            if (player.mp >= 10) { 
                player.mp -= 10; 
                damage = Math.floor(player.atk * 2.5); 
                io.to(roomId).emit('battleLog', `<span style="color:#3498db">${player.id.substr(0,4)} 使用技能! 造成 ${damage} 傷害</span>`); 
            } else return; 
        } 
        room.monster.hp -= damage; 
        if (room.monster.hp < 0) room.monster.hp = 0; 
        io.to(roomId).emit('monsterUpdate', room.monster); 
        socket.emit('playerStatsUpdate', player); 
        io.to(roomId).emit('roomInfoUpdate', getRoomPublicInfo(room)); 
        
        if (room.monster.hp === 0) { handleMonsterDeath(room, roomId); return; } 
        
        do { room.turnIndex++; } while ( room.turnIndex < room.players.length && (!gameState.players[room.players[room.turnIndex]] || gameState.players[room.players[room.turnIndex]].hp <= 0));
        if (room.turnIndex >= room.players.length) { room.turnIndex = -1; broadcastTurn(room); setTimeout(() => monsterPhase(room, roomId), 1000); } else { broadcastTurn(room); } 
    });

    socket.on('useItem', (data) => { 
        const { roomId, itemId } = data; 
        const player = gameState.players[socket.id]; 
        const item = ITEM_CONFIG[itemId];

        if (player && player.inventory && player.inventory[itemId] > 0) { 
            // 判斷是否為藥水 (名稱包含 potion 或 elixir)
            if (item.type === 'consumable') { 
                let healAmount = 0;
                // 根據物品 ID 給予回復量
                if (itemId === 'potion_hp') healAmount = 50;
                else if (itemId === 'potion_mid') healAmount = 500;
                else if (itemId === 'potion_high') healAmount = 2000;
                else if (itemId === 'potion_max') healAmount = 10000;
                else if (itemId === 'elixir') healAmount = 50000;

                player.inventory[itemId]--; 
                player.hp = Math.min(player.hp + healAmount, player.maxHp); 
                
                io.to(roomId).emit('battleLog', `<span style="color:#2ecc71">${player.id.substr(0,4)} 使用 ${item.name} (+${healAmount})</span>`); 
                
                if (player.inventory[itemId] === 0) delete player.inventory[itemId]; 
                socket.emit('playerStatsUpdate', player); 
                io.to(roomId).emit('roomInfoUpdate', getRoomPublicInfo(gameState.battleRooms[roomId])); 
                saveMyData(socket.id); 
            } 
        } 
    });
    socket.on('leaveRoom', (roomId) => leaveRoomLogic(socket.id, roomId));
    socket.on('disconnect', () => { saveMyData(socket.id); delete gameState.players[socket.id]; broadcastHubData(); });
    socket.on('playerRest', () => { let p = gameState.players[socket.id]; if(!p)return; p.hp = p.maxHp; p.mp = p.maxMp; socket.emit('restResult', "恢復！"); socket.emit('playerStatsUpdate', p); saveMyData(socket.id); });
});

//  修正：handleMonsterDeath 也確保材料名字正確 (這裡其實已經有處理，但檢查一次)
function handleMonsterDeath(room, roomId) { 
    room.monster.status = 'dead'; 
    const cfg = MONSTER_CONFIG[room.monsterKey]; 
    io.to(roomId).emit('battleWon', { exp: cfg.exp, gold: cfg.gold }); 
    
    room.players.forEach(pid => { 
        const p = gameState.players[pid]; 
        if (p) { 
            p.gold += cfg.gold; 
            let ratio = cfg.level / p.level; 
            if (ratio < 0.1) ratio = 0.1; if (ratio > 3.0) ratio = 3.0; 
            const finalExp = Math.floor(cfg.exp * ratio); 
            gainExp(p, finalExp, pid); 
            
            if (cfg.drops) { 
                cfg.drops.forEach(drop => { 
                    if (Math.random() < drop.rate) { 
                        p.inventory[drop.id] = (p.inventory[drop.id] || 0) + 1; 
                        // 確保名稱顯示正確
                        let matName = drop.id;
                        if (ITEM_CONFIG[drop.id]) matName = ITEM_CONFIG[drop.id].name;
                        else if (MATERIAL_CONFIG[drop.id]) matName = MATERIAL_CONFIG[drop.id].name;

                        io.to(pid).emit('battleLog', `<span style="color:#e67e22">獲得：${matName}</span>`); 
                    } 
                }); 
            } 
        } 
    }); 
    room.players.forEach(pid => saveMyData(pid)); 
    setTimeout(() => { if (gameState.battleRooms[roomId]) { room.status = 'waiting'; room.monster.hp = room.monster.maxHp; room.monster.status = 'alive'; room.turnIndex = 0; io.to(roomId).emit('battleReset'); io.to(roomId).emit('roomInfoUpdate', getRoomPublicInfo(room)); broadcastHubData(); } }, 3000); 
}

function saveMyData(socketId) { const p = gameState.players[socketId]; if (p && p.token) DB.savePlayer(p.token, p); }
function calculateStats(p) { if (!p.baseStats) return; p.maxHp = p.baseStats.hp; p.maxMp = p.baseStats.mp; p.atk = p.baseStats.atk; p.def = p.baseStats.def; Object.values(p.equipment).forEach(itemId => { if (itemId && ITEM_CONFIG[itemId]) { const item = ITEM_CONFIG[itemId]; if (item.hp) p.maxHp += item.hp; if (item.mp) p.maxMp += item.mp; if (item.atk) p.atk += item.atk; if (item.def) p.def += item.def; } }); if (p.hp > p.maxHp) p.hp = p.maxHp; if (p.mp > p.maxMp) p.mp = p.maxMp; }
function monsterPhase(room, roomId) { 
    if (!gameState.battleRooms[roomId] || room.monster.hp <= 0) return; 
    let alivePlayers = room.players.filter(pid => gameState.players[pid] && gameState.players[pid].hp > 0); 
    if (alivePlayers.length > 0) { 
        const targetId = alivePlayers[Math.floor(Math.random() * alivePlayers.length)]; 
        const target = gameState.players[targetId]; 
        const cfg = MONSTER_CONFIG[room.monsterKey]; 
        let dmg = (cfg.atk - target.def) + Math.floor(Math.random() * 5); if (dmg < 1) dmg = 1; target.hp -= dmg; if (target.hp <= 0) { target.hp = 0; io.to(targetId).emit('playerDead'); } else { io.to(targetId).emit('playerDamaged', { damage: dmg }); } io.to(targetId).emit('playerStatsUpdate', target); io.to(roomId).emit('battleLog', `<span style="color:#e74c3c; font-weight:bold;">怪物重擊 ${target.id.substr(0,4)} ! (${dmg}傷)</span>`); io.to(roomId).emit('roomInfoUpdate', getRoomPublicInfo(room)); 
    } 
    room.turnIndex = 0; 
    while (room.turnIndex < room.players.length && (!gameState.players[room.players[room.turnIndex]] || gameState.players[room.players[room.turnIndex]].hp <= 0)) { room.turnIndex++; }
    broadcastTurn(room); 
}
function broadcastTurn(room) { if (room.turnIndex === -1) io.to(room.id).emit('turnUpdate', { currentId: 'monster', name: '怪物' }); else { const pid = room.players[room.turnIndex]; const pName = gameState.players[pid] ? gameState.players[pid].id.substr(0,4) : 'Unknown'; io.to(room.id).emit('turnUpdate', { currentId: pid, name: pName }); } }
function leaveRoomLogic(socketId, roomId) { const room = gameState.battleRooms[roomId]; if (!room) return; const player = gameState.players[socketId]; const name = player ? player.id.substr(0, 4) : 'Unknown'; io.to(roomId).emit('battleLog', `<span style="color:#95a5a6">${name} 逃跑了...</span>`); room.players = room.players.filter(id => id !== socketId); if (room.players.length === 0) delete gameState.battleRooms[roomId]; else { if (room.host === socketId) room.host = room.players[0]; if (room.turnIndex >= room.players.length) room.turnIndex = 0; } io.to(roomId).emit('roomInfoUpdate', getRoomPublicInfo(room)); broadcastHubData(); if(room.status==='fighting') broadcastTurn(room); }
//  修改 server.js 下方的 getRoomPublicInfo
function getRoomPublicInfo(room) { 
    const validPlayers = room.players.filter(pid => gameState.players[pid]); 
    room.players = validPlayers; 
    if (validPlayers.length > 0 && !validPlayers.includes(room.host)) room.host = validPlayers[0]; 
    
    const playerDetails = validPlayers.map(pid => { 
        const p = gameState.players[pid]; 
        return { 
            id: p.id, 
            name: p.id.substr(0,4), 
            hp: p.hp, maxHp: p.maxHp, 
            mp: p.mp, maxMp: p.maxMp, 
            level: p.level 
        }; 
    }); 

    return { 
        id: room.id, 
        host: room.host, 
        status: room.status, 
        players: playerDetails, 
        monsterName: MONSTER_CONFIG[room.monsterKey].name,
        monsterKey: room.monsterKey,  // <---  加入這一行！(傳送怪物 ID)
        monsterMaxHp: room.monster.maxHp, // 順便傳最大血量方便算比例
        monsterHp: room.monster.hp
    }; 
}
function gainExp(player, amount, socketId) { player.exp += amount; io.to(socketId).emit('battleLog', `獲得 ${amount} 經驗`); if (player.exp >= player.maxExp) { player.level++; player.exp -= player.maxExp; player.maxExp = Math.floor(player.maxExp * 1.5); player.baseStats.hp += 20; player.baseStats.mp += 10; player.baseStats.atk += 3; player.baseStats.def += 1; calculateStats(player); player.hp = player.maxHp; player.mp = player.maxMp; io.to(socketId).emit('battleLog', `<span style="color:#f1c40f">升級！LV.${player.level}</span>`); } io.to(socketId).emit('playerStatsUpdate', player); }
function broadcastHubData() { let cityCounts = {}; Object.values(gameState.players).forEach(p => { if (p.currentCity) cityCounts[p.currentCity] = (cityCounts[p.currentCity] || 0) + 1; }); let roomsList = Object.values(gameState.battleRooms).map(r => ({ id: r.id, monsterKey: r.monsterKey, monsterName: MONSTER_CONFIG[r.monsterKey].name, status: r.status, playerCount: r.players.length })); io.emit('hubDataUpdate', { cityCounts, roomsList }); }

setInterval(() => { const now = Date.now(); Object.keys(gameState.battleRooms).forEach(roomId => { const room = gameState.battleRooms[roomId]; if (room.players.length === 0 || (now - (room.updatedAt || now) > 10 * 60 * 1000)) { delete gameState.battleRooms[roomId]; io.emit('hubDataUpdate', { cityCounts: {}, roomsList: [] }); } }); Object.values(gameState.players).forEach(p => { if (p.token) DB.savePlayer(p.token, p); }); console.log("自動存檔"); }, 30000);

const PORT = 3001; 
http.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });