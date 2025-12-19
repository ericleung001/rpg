const express = require('express');
const app = express();
const http = require('http').createServer(app);

//  CORS 設定
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

// =========================================================================
// 1. 遊戲設定資料
// =========================================================================

//  斷線緩衝計時器
let disconnectTimers = {}; 

const SKILL_CONFIG = {
    'fireball':   { name: "火球術", level: 1,  mp: 5,  type: 'dmg',  val: 1.5, desc: "1.5倍傷害" },
    'heal_light': { name: "小回復", level: 5,  mp: 10, type: 'heal', val: 50,  desc: "恢復 50 HP" },
    'thunder':    { name: "雷擊",   level: 10, mp: 15, type: 'stun', val: 1.2, desc: "傷害+暈眩" },
    'drain':      { name: "吸血",   level: 15, mp: 20, type: 'drain',val: 1.0, desc: "吸取敵人生命" },
    'god_light':  { name: "神之光", level: 20, mp: 50, type: 'heal', val: 500, desc: "恢復 500 HP" }
};

//  採集點設定
const GATHER_CONFIG = {
    // ===  伐木點 ===
    'forest_1': { name: "迷霧森林 (Lv.1)", type: 'wood', reqLv: 1, time: 3000, 
        drops: [{id:'oak_log', rate:0.7}, {id:'soft_fur', rate:0.2}, {id:'potion_hp', rate:0.1}] },
    'forest_2': { name: "精靈之森 (Lv.20)", type: 'wood', reqLv: 20, time: 4000, 
        drops: [{id:'maple_log', rate:0.6}, {id:'oak_log', rate:0.2}, {id:'slime_gel', rate:0.1}, {id:'magic_dust', rate:0.1}] },
    'forest_3': { name: "巨木之森 (Lv.40)", type: 'wood', reqLv: 40, time: 5000, 
        drops: [{id:'yew_log', rate:0.5}, {id:'maple_log', rate:0.3}, {id:'poison_sac', rate:0.1}, {id:'potion_mp', rate:0.1}] },
    'forest_4': { name: "靈魂樹海 (Lv.60)", type: 'wood', reqLv: 60, time: 6000, 
        drops: [{id:'spirit_wood', rate:0.4}, {id:'yew_log', rate:0.3}, {id:'spirit_dust', rate:0.2}, {id:'amulet_soul', rate:0.05}] },
    'forest_5': { name: "龍棲之森 (Lv.80)", type: 'wood', reqLv: 80, time: 7000, 
        drops: [{id:'dragon_wood', rate:0.4}, {id:'dragon_scale', rate:0.2}, {id:'fire_core', rate:0.2}, {id:'potion_high', rate:0.1}] },
    'forest_6': { name: "混沌樹界 (Lv.100)", type: 'wood', reqLv: 100, time: 8000, 
        drops: [{id:'chaos_wood', rate:0.3}, {id:'void_wood', rate:0.3}, {id:'dark_essence', rate:0.2}, {id:'elixir', rate:0.05}] },

    // ===  釣魚點 ===
    'lake_1':   { name: "寧靜湖泊 (Lv.1)", type: 'fish', reqLv: 1, time: 3000, 
        drops: [{id:'carp', rate:0.6}, {id:'salmon', rate:0.3}, {id:'leather', rate:0.1}] },
    'lake_2':   { name: "神秘深潭 (Lv.20)", type: 'fish', reqLv: 20, time: 4000, 
        drops: [{id:'magic_fish', rate:0.4}, {id:'pearl', rate:0.1}, {id:'koi', rate:0.3}, {id:'slime_gel', rate:0.1}, {id:'potion_mid', rate:0.1}] },
    'lake_3':   { name: "暴風海灣 (Lv.40)", type: 'fish', reqLv: 40, time: 5000, 
        drops: [{id:'tuna', rate:0.5}, {id:'shark', rate:0.3}, {id:'bone_shard', rate:0.1}, {id:'snake_boots', rate:0.05}] },
    'lake_4':   { name: "熔岩之河 (Lv.60)", type: 'fish', reqLv: 60, time: 6000, 
        drops: [{id:'lava_eel', rate:0.5}, {id:'fire_core', rate:0.3}, {id:'coal', rate:0.1}, {id:'magma_plate', rate:0.02}] },
    'lake_5':   { name: "虛空之海 (Lv.80)", type: 'fish', reqLv: 80, time: 7000, 
        drops: [{id:'void_squid', rate:0.4}, {id:'void_dust', rate:0.3}, {id:'demon_horn', rate:0.1}, {id:'potion_max', rate:0.1}] },
    'lake_6':   { name: "神之天池 (Lv.100)", type: 'fish', reqLv: 100, time: 8000, 
        drops: [{id:'god_carp', rate:0.3}, {id:'angel_feather', rate:0.3}, {id:'diamond', rate:0.2}, {id:'god_blood', rate:0.1}] },

    // === ⛏️ 礦區 ===
    'mine_1':   { name: "廢棄礦坑 (Lv.10)", type: 'mine', reqLv: 10, time: 3500, 
        drops: [{id:'copper_ore', rate:0.5}, {id:'iron_ore', rate:0.3}, {id:'coal', rate:0.2}] },
    'mine_2':   { name: "水晶洞窟 (Lv.50)", type: 'mine', reqLv: 50, time: 5500, 
        drops: [{id:'silver_ore', rate:0.4}, {id:'ruby', rate:0.3}, {id:'ice_crystal', rate:0.2}, {id:'gold_ore', rate:0.1}] },
    'mine_3':   { name: "隕石坑 (Lv.90)", type: 'mine', reqLv: 90, time: 7500, 
        drops: [{id:'mithril', rate:0.4}, {id:'adamantite', rate:0.3}, {id:'star_fragment', rate:0.2}, {id:'chaos_orb', rate:0.1}] }
};

const MATERIAL_CONFIG = {
    'copper_ore':   { name: "銅礦石", desc: "泛著紅光的低階礦石" },
    'soft_fur':     { name: "柔軟皮毛", desc: "小型野獸的毛皮" },
    'beast_fang':   { name: "野獸尖牙", desc: "鋒利的牙齒，可用於武器" },
    'slime_gel':    { name: "黏液", desc: "史萊姆的核心物質" },
    'iron_ore':     { name: "鐵礦石", desc: "標準的鍛造金屬" },
    'tough_hide':   { name: "硬皮革", desc: "經過處理的堅韌獸皮" },
    'poison_sac':   { name: "毒囊", desc: "含有致命毒素" },
    'bone_shard':   { name: "碎骨片", desc: "充滿亡靈氣息的骨頭" },
    'silver_ore':   { name: "銀礦石", desc: "對魔物有特效的金屬" },
    'fire_core':    { name: "火焰核心", desc: "燃燒著不滅的火焰" },
    'lava_rock':    { name: "熔岩石", desc: "極高溫的石頭" },
    'dragon_scale': { name: "龍鱗", desc: "堅不可摧的鱗片" },
    'gold_ore':     { name: "金礦石", desc: "延展性極佳的高級金屬" },
    'ice_crystal':  { name: "永恆冰晶", desc: "永不融化的冰塊" },
    'yeti_fur':     { name: "雪怪毛皮", desc: "極度保暖的高級皮草" },
    'spirit_dust':  { name: "靈魂粉末", desc: "亡靈死後留下的能量" },
    'mithril':      { name: "秘銀", desc: "傳說中的魔法金屬" },
    'void_dust':    { name: "虛空之塵", desc: "來自異次元的塵埃" },
    'demon_horn':   { name: "惡魔之角", desc: "蘊含強大黑暗力量" },
    'dark_essence': { name: "暗之精華", desc: "純粹的黑暗能量" },
    'adamantite':   { name: "精金", desc: "世上最堅硬的物質" },
    'god_blood':    { name: "神之血", desc: "散發著神聖光芒的液體" },
    'chaos_orb':    { name: "混沌寶珠", desc: "創造與毀滅的核心" },
    'angel_feather':{ name: "天使之羽", desc: "墮天使掉落的黑色羽毛" },
    // 採集材料
    'oak_log':      { name: "橡木原木", desc: "普通的木材" },
    'maple_log':    { name: "楓木原木", desc: "質地堅硬的木材" },
    'yew_log':      { name: "紫杉原木", desc: "蘊含魔力的木材" },
    'ancient_log':  { name: "遠古神木", desc: "傳說中的神木" },
    'spirit_wood':  { name: "靈木", desc: "充滿靈氣的木材" },
    'dragon_wood':  { name: "龍骨木", desc: "堅硬如龍骨" },
    'void_wood':    { name: "虛空木", desc: "來自虛空的黑色木材" },
    'chaos_wood':   { name: "混沌神木", desc: "蘊含混沌之力的神木" },
    'carp':         { name: "鯉魚", desc: "普通的淡水魚" },
    'salmon':       { name: "鮭魚", desc: "富含油脂的魚" },
    'koi':          { name: "錦鯉", desc: "幸運的象徵" },
    'magic_fish':   { name: "魔力魚", desc: "發著藍光的魚" },
    'tuna':         { name: "黑鮪魚", desc: "頂級的美味" },
    'shark':        { name: "大白鯊", desc: "海中的獵食者" },
    'lava_eel':     { name: "熔岩鰻", desc: "生活在岩漿中的鰻魚" },
    'void_squid':   { name: "虛空烏賊", desc: "觸手散發著微光" },
    'god_carp':     { name: "神之鯉", desc: "傳說中能躍過龍門的魚" },
    'pearl':        { name: "珍珠", desc: "製作飾品的珍貴材料" },
    'coal':         { name: "煤炭", desc: "燃燒的燃料" },
    'ruby':         { name: "紅寶石", desc: "稀有的寶石" },
    'diamond':      { name: "鑽石", desc: "最堅硬的寶石" },
    'star_fragment':{ name: "星之碎片", desc: "從天而降的隕石" },
    'leather':      { name: "皮革", desc: "基礎皮革" },
    'magic_dust':   { name: "魔粉", desc: "閃閃發光的粉末" }
};

const ITEM_CONFIG = {
    'potion_hp':    { name: "小紅藥水", type: 'consumable', cost: 50, desc: "恢復 50 HP" },
    'potion_mid':   { name: "中紅藥水", type: 'consumable', cost: 200, desc: "恢復 500 HP" },
    'potion_high':  { name: "大紅藥水", type: 'consumable', cost: 1000, desc: "恢復 2000 HP" },
    'potion_max':   { name: "特級秘藥", type: 'consumable', cost: 5000, desc: "恢復 10000 HP" },
    'elixir':       { name: "神之甘露", type: 'consumable', cost: 20000, desc: "恢復 50000 HP" },
    'potion_mp':    { name: "小藍藥水", type: 'consumable', cost: 80, desc: "恢復 30 MP" },
    'potion_mp_mid':{ name: "中藍藥水", type: 'consumable', cost: 300, desc: "恢復 100 MP" },
    'potion_mp_high':{ name: "大藍藥水", type: 'consumable', cost: 1500, desc: "恢復 500 MP" },
    
    // ===  料理 (新增) ===
    'grilled_carp':   { name: "烤鯉魚", type: 'consumable', cost: 30, desc: "香氣四溢 (HP+100)" },
    'salmon_sushi':   { name: "鮭魚壽司", type: 'consumable', cost: 50, desc: "新鮮美味 (MP+50)" },
    'tuna_steak':     { name: "煎鮪魚排", type: 'consumable', cost: 200, desc: "高級口感 (HP+500)" },
    'eel_rice':       { name: "鰻魚飯", type: 'consumable', cost: 300, desc: "精力充沛 (HP+300, MP+100)" },
    'void_soup':      { name: "虛空海鮮湯", type: 'consumable', cost: 1000, desc: "來自深淵的滋味 (HP/MP 全滿)" },

    'wood_sword':   { name: "木劍", type: 'weapon', atk: 10, cost: 100, desc: "訓練用武器" },
    'copper_dagger':{ name: "銅匕首", type: 'weapon', atk: 15, cost: 200, desc: "輕便的短刀" },
    'cloth_armor':  { name: "布衣", type: 'armor', def: 5, hp: 50, cost: 100, desc: "普通的衣服" },
    'hunt_vest':    { name: "獵人背心", type: 'armor', def: 8, hp: 80, cost: 0, desc: "【合成】適合野外行動" },
    'bone_ring':    { name: "骨戒", type: 'acc', atk: 2, cost: 0, desc: "【合成】野獸骨頭製成" },
    'iron_sword':   { name: "鐵劍", type: 'weapon', atk: 40, cost: 500, desc: "標準冒險者裝備" },
    'spike_club':   { name: "狼牙棒", type: 'weapon', atk: 55, cost: 0, desc: "【合成】破壞力強大" },
    'leather_armor':{ name: "皮甲", type: 'armor', def: 20, hp: 200, cost: 400, desc: "防禦力不錯" },
    'snake_boots':  { name: "蛇皮長靴", type: 'acc', def: 10, hp: 100, cost: 0, desc: "【合成】用毒蛇皮製成" },
    'poison_dag':   { name: "劇毒匕首", type: 'weapon', atk: 60, cost: 0, desc: "【合成】塗滿毒液" },
    'silver_blade': { name: "銀刃", type: 'weapon', atk: 150, cost: 2000, desc: "對不死族有效" },
    'flame_staff':  { name: "火焰法杖", type: 'weapon', atk: 200, cost: 0, desc: "【合成】燃燒魔力" },
    'chain_mail':   { name: "鎖子甲", type: 'armor', def: 60, hp: 800, cost: 1500, desc: "金屬環編織而成" },
    'magma_plate':  { name: "熔岩胸甲", type: 'armor', def: 100, hp: 1500, cost: 0, desc: "【合成】灼熱的防禦" },
    'ring_str':     { name: "力量戒指", type: 'acc', atk: 30, cost: 3000, desc: "增加攻擊力" },
    'gold_axe':     { name: "黃金巨斧", type: 'weapon', atk: 500, cost: 10000, desc: "華麗且致命" },
    'frost_bow':    { name: "寒冰弓", type: 'weapon', atk: 650, cost: 0, desc: "【合成】射出冰箭" },
    'ice_robe':     { name: "冰霜法袍", type: 'armor', def: 200, mp: 500, cost: 0, desc: "【合成】魔力護盾" },
    'yeti_cloak':   { name: "雪怪斗篷", type: 'armor', def: 250, hp: 3000, cost: 0, desc: "【合成】極度抗寒" },
    'amulet_soul':  { name: "靈魂護符", type: 'acc', mp: 300, hp: 1000, cost: 0, desc: "【合成】守護靈魂" },
    'mithril_saber':{ name: "秘銀軍刀", type: 'weapon', atk: 2000, cost: 50000, desc: "削鐵如泥" },
    'void_reaper':  { name: "虛空收割者", type: 'weapon', atk: 3500, cost: 0, desc: "【合成】來自深淵的武器" },
    'demon_armor':  { name: "惡魔戰甲", type: 'armor', def: 1000, hp: 10000, cost: 0, desc: "【合成】散發著邪氣" },
    'ring_lord':    { name: "領主指環", type: 'acc', atk: 500, def: 500, cost: 0, desc: "【合成】統治者的象徵" },
    'god_slayer':   { name: "弒神劍", type: 'weapon', atk: 20000, cost: 0, desc: "【合成】連神都能斬殺" },
    'chaos_staff':  { name: "混沌法杖", type: 'weapon', atk: 25000, cost: 0, desc: "【合成】掌控混沌之力" },
    'angel_armor':  { name: "熾天使鎧甲", type: 'armor', def: 5000, hp: 50000, cost: 0, desc: "【合成】神聖不可侵犯" },
    'crown_chaos':  { name: "混沌之冠", type: 'acc', atk: 2000, def: 2000, hp: 20000, cost: 0, desc: "【合成】萬物的主宰" },
    
    // 採集製作成品
    'oak_bow':      { name: "橡木弓", type: 'weapon', atk: 25, cost: 200, desc: "【合成】使用橡木製成的弓" },
    'maple_staff':  { name: "楓木法杖", type: 'weapon', atk: 50, cost: 500, desc: "【合成】堅硬的法杖" },
    'fish_ring':    { name: "魚鱗戒指", type: 'acc', def: 8, hp: 50, cost: 400, desc: "【合成】發出微弱的光" },
    'shark_tooth':  { name: "鯊魚牙匕首", type: 'weapon', atk: 80, cost: 800, desc: "【合成】撕裂傷口" },
    'pearl_necklace':{ name: "珍珠項鍊", type: 'acc', mp: 100, def: 20, cost: 2000, desc: "【合成】優雅的飾品" },
    'emerald_staff':{ name: "翡翠法杖", type: 'weapon', atk: 300, cost: 5000, desc: "【合成】鑲嵌綠寶石" },
    'obsidian_blade':{ name: "黑曜石之劍", type: 'weapon', atk: 600, cost: 8000, desc: "【合成】極度鋒利" },
    'dragon_spear': { name: "龍骨長槍", type: 'weapon', atk: 1200, cost: 15000, desc: "【合成】貫穿龍鱗" }
};

//  3. 大量新增配方 (含料理)
const RECIPE_CONFIG = {
    'hunt_vest':    { materials: {'soft_fur': 5, 'copper_ore': 2}, gold: 200 },
    'bone_ring':    { materials: {'beast_fang': 3, 'slime_gel': 5}, gold: 100 },
    'spike_club':   { materials: {'iron_ore': 10, 'bone_shard': 5}, gold: 800 },
    'snake_boots':  { materials: {'tough_hide': 8, 'poison_sac': 2}, gold: 600 },
    'poison_dag':   { materials: {'iron_ore': 5, 'poison_sac': 5}, gold: 1000 },
    'flame_staff':  { materials: {'silver_ore': 5, 'fire_core': 3}, gold: 3000 },
    'magma_plate':  { materials: {'iron_ore': 20, 'lava_rock': 10}, gold: 4000 },
    'frost_bow':    { materials: {'gold_ore': 5, 'ice_crystal': 5}, gold: 10000 },
    'ice_robe':     { materials: {'yeti_fur': 10, 'ice_crystal': 8}, gold: 12000 },
    'yeti_cloak':   { materials: {'yeti_fur': 15, 'spirit_dust': 5}, gold: 10000 },
    'amulet_soul':  { materials: {'gold_ore': 3, 'spirit_dust': 10}, gold: 8000 },
    'void_reaper':  { materials: {'mithril': 10, 'void_dust': 20}, gold: 50000 },
    'demon_armor':  { materials: {'mithril': 15, 'demon_horn': 10}, gold: 60000 },
    'ring_lord':    { materials: {'dark_essence': 5, 'gold_ore': 20}, gold: 40000 },
    'god_slayer':   { materials: {'adamantite': 10, 'god_blood': 5, 'dragon_scale': 20}, gold: 1000000 },
    'chaos_staff':  { materials: {'adamantite': 10, 'chaos_orb': 5, 'void_dust': 50}, gold: 1200000 },
    'angel_armor':  { materials: {'adamantite': 20, 'angel_feather': 10, 'god_blood': 5}, gold: 1500000 },
    'crown_chaos':  { materials: {'chaos_orb': 3, 'angel_feather': 5, 'dark_essence': 50}, gold: 2000000 },
    
    // 採集配方
    'oak_bow':      { materials: {'oak_log': 5, 'soft_fur': 2}, gold: 100 }, 
    'maple_staff':  { materials: {'maple_log': 5, 'fire_core': 1}, gold: 500 },
    'fish_ring':    { materials: {'pearl': 1, 'gold_ore': 2}, gold: 1000 }, 
    'shark_tooth':  { materials: {'shark': 2, 'iron_ore': 5}, gold: 800 },
    'pearl_necklace':{ materials: {'pearl': 3, 'silver_ore': 5}, gold: 2000 },
    'emerald_staff':{ materials: {'yew_log': 10, 'magic_dust': 5, 'magic_fish': 2}, gold: 5000 },
    'obsidian_blade':{ materials: {'lava_rock': 10, 'coal': 20, 'iron_ore': 10}, gold: 8000 },
    'dragon_spear': { materials: {'dragon_wood': 5, 'dragon_scale': 3, 'mithril': 5}, gold: 15000 },
    
    // ===  烹飪食譜 (新增) ===
    'grilled_carp':   { materials: {'carp': 1, 'coal': 1}, gold: 10 },
    'salmon_sushi':   { materials: {'salmon': 1}, gold: 20 }, 
    'tuna_steak':     { materials: {'tuna': 1, 'fire_core': 1}, gold: 50 }, 
    'eel_rice':       { materials: {'lava_eel': 1, 'coal': 2}, gold: 100 },
    'void_soup':      { materials: {'void_squid': 1, 'magic_fish': 2, 'dark_essence': 1}, gold: 500 }
};

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
    'balrog': { name: "炎魔", level: 60, hp: 100000, exp: 10000, gold: 3000, atk: 1000, drops: [{id:'magma_plate', rate:0.05}, {id:'fire_core', rate:1.0}] },
    'snow_wolf': { name: "雪原狼", level: 62, hp: 60000, exp: 5000, gold: 600, atk: 1200, drops: [{id:'soft_fur', rate:0.5}, {id:'ice_crystal', rate:0.2}] },
    'yeti': { name: "雪人", level: 65, hp: 120000, exp: 6000, gold: 700, atk: 1500, drops: [{id:'yeti_fur', rate:0.6}, {id:'gold_ore', rate:0.2}] },
    'ice_spirit': { name: "冰精靈", level: 68, hp: 80000, exp: 7000, gold: 800, atk: 1800, drops: [{id:'ice_crystal', rate:0.5}, {id:'spirit_dust', rate:0.3}] },
    'frost_knight': { name: "寒霜騎士", level: 72, hp: 150000, exp: 9000, gold: 1000, atk: 2000, drops: [{id:'gold_ore', rate:0.4}, {id:'ice_crystal', rate:0.3}] },
    'ice_dragon': { name: "冰霜龍", level: 75, hp: 200000, exp: 12000, gold: 1500, atk: 2500, drops: [{id:'dragon_scale', rate:0.5}, {id:'potion_high', rate:0.2}] },
    'lich_king': { name: "巫妖王", level: 80, hp: 500000, exp: 30000, gold: 10000, atk: 3500, drops: [{id:'amulet_soul', rate:0.1}, {id:'spirit_dust', rate:1.0}] },
    'void_eye': { name: "虛空之眼", level: 82, hp: 300000, exp: 15000, gold: 2000, atk: 4000, drops: [{id:'void_dust', rate:0.5}] },
    'shadow_assassin': { name: "暗影刺客", level: 85, hp: 400000, exp: 18000, gold: 2500, atk: 5000, drops: [{id:'mithril', rate:0.3}, {id:'dark_essence', rate:0.2}] },
    'dark_paladin': { name: "墮落聖騎", level: 88, hp: 600000, exp: 22000, gold: 3000, atk: 6000, drops: [{id:'mithril', rate:0.5}, {id:'void_dust', rate:0.4}] },
    'demon_guard': { name: "惡魔守衛", level: 92, hp: 800000, exp: 28000, gold: 4000, atk: 7500, drops: [{id:'demon_horn', rate:0.4}, {id:'dragon_scale', rate:0.2}] },
    'succubus': { name: "魅魔", level: 95, hp: 700000, exp: 35000, gold: 5000, atk: 8500, drops: [{id:'dark_essence', rate:0.5}, {id:'potion_max', rate:0.1}] },
    'void_lord': { name: "虛空領主", level: 99, hp: 2000000, exp: 100000, gold: 50000, atk: 12000, drops: [{id:'void_reaper', rate:0.05}, {id:'dark_essence', rate:1.0}] },
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

    socket.on('register', (data) => { 
        const { user, pass } = data; 
        if (!user || user.length < 5) { socket.emit('authResult', { success: false, msg: "帳號至少需 5 字元" }); return; }
        if (!pass || pass.length < 5) { socket.emit('authResult', { success: false, msg: "密碼至少需 5 字元" }); return; }

        const salt = bcrypt.genSaltSync(10);
        const hash = bcrypt.hashSync(pass, salt); 
        const newToken = 'user_' + Math.random().toString(36).substr(2); 
        
        DB.createAccount(user, hash, newToken, (success, msg) => { 
            const finalMsg = msg || (success ? "註冊成功！" : "帳號已存在");
            socket.emit('authResult', { success, msg: finalMsg }); 
        }); 
    });

    socket.on('login', (data) => { 
        const { user, pass } = data; 
        if (!user || user.length < 5) { socket.emit('authResult', { success: false, msg: "帳號長度不足" }); return; }
        
        DB.getUserInfo(user, (info) => {
            if (!info) {
                socket.emit('authResult', { success: false, msg: "帳號不存在" });
            } else {
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
        
        if (disconnectTimers[token]) {
            clearTimeout(disconnectTimers[token]);
            delete disconnectTimers[token];
            console.log(`[重連成功] Token: ${token} (取消斷線判定)`);
        }

        Object.keys(gameState.players).forEach(sid => { 
            if (gameState.players[sid].token === token && sid !== socket.id) {
                delete gameState.players[sid]; 
            }
        }); 

        DB.loadPlayer(token, (savedData) => { 
            if (savedData) { 
                let p = savedData; 
                if (!p.baseStats) p.baseStats = { hp: 100, mp: 50, atk: 10, def: 5 }; 
                if (!p.equipment) p.equipment = { weapon: null, armor: null, acc: null }; 
                if (!p.inventory) p.inventory = {}; 
                if (!p.currentCity) p.currentCity = 'city_1'; 
                if (!p.skills) p.skills = ['fireball'];

                const oldSocketId = p.id; 
                p.id = socket.id; 
                p.token = token; 
                gameState.players[socket.id] = p; 
                calculateStats(p); 
                
                Object.values(gameState.battleRooms).forEach(room => { 
                    const idx = room.players.indexOf(oldSocketId); 
                    if (idx !== -1) { 
                        room.players[idx] = socket.id; 
                        if (room.host === oldSocketId) room.host = socket.id; 
                        
                        if(room.turnOrder) {
                            const tIdx = room.turnOrder.indexOf(oldSocketId);
                            if(tIdx !== -1) room.turnOrder[tIdx] = socket.id;
                        }

                        socket.join(room.id); 
                        io.to(room.id).emit('roomInfoUpdate', getRoomPublicInfo(room));
                    } 
                }); 
            } else { 
                let newPlayer = { id: socket.id, token: token, gold: 1000, level: 1, exp: 0, maxExp: 100, baseStats: { hp: 100, mp: 50, atk: 10, def: 5 }, hp: 100, maxHp: 100, mp: 50, maxMp: 50, atk: 10, def: 5, currentCity: 'city_1', inventory: {}, equipment: { weapon: null, armor: null, acc: null }, skills: ['fireball'] }; 
                gameState.players[socket.id] = newPlayer; 
                DB.savePlayer(token, newPlayer); 
            } 
            socket.emit('playerStatsUpdate', gameState.players[socket.id]); 
            broadcastHubData(); 
        }); 
    });

    socket.on('sendChat', (msg) => {
        const player = gameState.players[socket.id];
        if (player && msg && msg.trim().length > 0) {
            const name = player.id.substr(0, 4);
            let content = msg.substring(0, 50);
            content = content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
            DB.logChat(name, content);
            io.emit('chatMessage', { id: player.id, name: name, msg: content });
        }
    });

    socket.on('getGatherNodes', () => {
        socket.emit('gatherNodeList', GATHER_CONFIG);
    });

    socket.on('gatherAction', (nodeId) => {
        const p = gameState.players[socket.id];
        const node = GATHER_CONFIG[nodeId];
        
        if (!p || !node) return;
        if (p.level < node.reqLv) {
            socket.emit('gatherResult', { success: false, msg: `等級不足 (需 Lv.${node.reqLv})` });
            return;
        }

        if (!p.gatherExp) p.gatherExp = 0;
        if (!p.gatherLevel) p.gatherLevel = 1;

        let gainedItem = null;
        const rand = Math.random();
        let cumulativeRate = 0;

        for (let drop of node.drops) {
            cumulativeRate += drop.rate;
            if (rand < cumulativeRate) {
                gainedItem = drop.id;
                break;
            }
        }

        if (gainedItem) {
            if (!p.inventory[gainedItem]) p.inventory[gainedItem] = 0;
            p.inventory[gainedItem]++;
            
            // 經驗值懲罰機制
            let charExp = 5 + (node.reqLv * 2);
            let gatherExpGain = 10 + (node.reqLv * 5);
            const currentGatherLv = p.gatherLevel || 1;
            const levelDiff = currentGatherLv - node.reqLv;

            if (levelDiff > 20) {
                gatherExpGain = 1;
                charExp = 1;
            } else if (levelDiff > 10) {
                gatherExpGain = Math.floor(gatherExpGain * 0.5);
                charExp = Math.floor(charExp * 0.5);
            }
            
            gainExp(p, charExp, socket.id);
            p.gatherExp += gatherExpGain;
            
            const nextLevelExp = (p.gatherLevel || 1) * 500;
            let levelUpMsg = "";
            if (p.gatherExp >= nextLevelExp) {
                p.gatherLevel++;
                p.gatherExp -= nextLevelExp;
                levelUpMsg = "  採集等級上升！";
            }

            let itemName = gainedItem;
            if (MATERIAL_CONFIG[gainedItem]) itemName = MATERIAL_CONFIG[gainedItem].name;
            else if (ITEM_CONFIG[gainedItem]) itemName = ITEM_CONFIG[gainedItem].name;

            saveMyData(socket.id);
            socket.emit('playerStatsUpdate', p);
            socket.emit('gatherResult', { 
                success: true, 
                msg: `獲得：${itemName} (+${gatherExpGain} 熟練度)${levelUpMsg}`,
                gatherExp: p.gatherExp,
                gatherLevel: p.gatherLevel,
                gatherMaxExp: nextLevelExp
            });
        } else {
            socket.emit('gatherResult', { success: false, msg: "什麼都沒找到..." });
        }
    });

    socket.on('getRecipes', () => { const recipes = Object.keys(RECIPE_CONFIG).map(key => { const item = ITEM_CONFIG[key]; const req = RECIPE_CONFIG[key]; const matList = Object.keys(req.materials).map(matId => ({ id: matId, name: MATERIAL_CONFIG[matId] ? MATERIAL_CONFIG[matId].name : matId, count: req.materials[matId] })); let statsInfo = []; if (item.atk) statsInfo.push(`⚔️ATK+${item.atk}`); if (item.def) statsInfo.push(`️DEF+${item.def}`); if (item.hp) statsInfo.push(`❤️HP+${item.hp}`); if (item.mp) statsInfo.push(`MP+${item.mp}`); return { itemId: key, itemName: item.name, itemDesc: item.desc, itemStats: statsInfo.join(' '), goldCost: req.gold, materials: matList }; }); socket.emit('recipeList', recipes); });
    socket.on('craftItem', (targetItemId) => { const p = gameState.players[socket.id]; const recipe = RECIPE_CONFIG[targetItemId]; const targetItem = ITEM_CONFIG[targetItemId]; if (!p || !recipe || !targetItem) return; if (p.gold < recipe.gold) { socket.emit('craftResult', { success: false, msg: "金幣不足！" }); return; } for (let matId in recipe.materials) { const needed = recipe.materials[matId]; const has = p.inventory[matId] || 0; if (has < needed) { const matName = MATERIAL_CONFIG[matId] ? MATERIAL_CONFIG[matId].name : matId; socket.emit('craftResult', { success: false, msg: `材料不足：${matName}` }); return; } } p.gold -= recipe.gold; for (let matId in recipe.materials) { p.inventory[matId] -= recipe.materials[matId]; if (p.inventory[matId] <= 0) delete p.inventory[matId]; } p.inventory[targetItemId] = (p.inventory[targetItemId] || 0) + 1; socket.emit('craftResult', { success: true, msg: `成功打造：${targetItem.name}` }); socket.emit('playerStatsUpdate', p); saveMyData(socket.id); });
    
    socket.on('getMarket', () => { 
        DB.getListings((rows) => { 
            const listings = rows.map(r => {
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

    socket.on('npcSell', (itemId) => { const p = gameState.players[socket.id]; const item = ITEM_CONFIG[itemId] || MATERIAL_CONFIG[itemId]; if (!p || !item) return; if (!p.inventory[itemId] || p.inventory[itemId] <= 0) return; let baseCost = item.cost || 10; let sellPrice = Math.floor(baseCost * 0.2); if (sellPrice < 1) sellPrice = 1; p.inventory[itemId]--; if (p.inventory[itemId] === 0) delete p.inventory[itemId]; p.gold += sellPrice; socket.emit('bagResult', { success: true, msg: ` 已賣給商人，獲得 ${sellPrice} G` }); socket.emit('playerStatsUpdate', p); saveMyData(socket.id); });
    socket.on('playerBuy', (id) => { let p = gameState.players[socket.id]; if(!p) { socket.emit('errorMessage', "請重新登入"); return; } const item = ITEM_CONFIG[id]; if(!item) { socket.emit('errorMessage', "商品不存在"); return; } if(p.gold >= item.cost) { p.gold -= item.cost; p.inventory[id] = (p.inventory[id]||0)+1; socket.emit('buyResult', {success:true, message:`✅ 購買 ${item.name} 成功`, cost:0}); socket.emit('playerStatsUpdate', p); saveMyData(socket.id); } else { socket.emit('errorMessage', "❌ 金錢不足！"); } });

    socket.on('equipItem', (itemId) => { let p = gameState.players[socket.id]; if(!p) { socket.emit('errorMessage', "請重新登入"); return; } const item = ITEM_CONFIG[itemId]; if(!item) { socket.emit('errorMessage', "物品錯誤"); return; } if(!p.inventory[itemId]) { socket.emit('errorMessage', "無此物品"); return; } const slot = item.type; if(!['weapon','armor','acc'].includes(slot)) { socket.emit('errorMessage', "無法裝備"); return; } if(p.equipment[slot]) p.inventory[p.equipment[slot]] = (p.inventory[p.equipment[slot]]||0)+1; p.equipment[slot] = itemId; p.inventory[itemId]--; if(p.inventory[itemId]<=0) delete p.inventory[itemId]; calculateStats(p); socket.emit('equipResult', "✅ 裝備成功！"); socket.emit('playerStatsUpdate', p); saveMyData(socket.id); });
    socket.on('unequipItem', (slot) => { let p = gameState.players[socket.id]; if(!p || !p.equipment[slot]) return; const itemId = p.equipment[slot]; p.inventory[itemId] = (p.inventory[itemId]||0)+1; p.equipment[slot] = null; calculateStats(p); socket.emit('equipResult', "已卸下！"); socket.emit('playerStatsUpdate', p); saveMyData(socket.id); });

    socket.on('enterCity', (cityId) => { if (gameState.players[socket.id]) { gameState.players[socket.id].currentCity = cityId; broadcastHubData(); saveMyData(socket.id); } });
    socket.on('createRoom', (monsterKey) => { try { const p = gameState.players[socket.id]; if (!p) return; if (p.hp <= 0) { socket.emit('errorMessage', " 你已經死亡！請先去旅館復活。"); return; } const cfg = MONSTER_CONFIG[monsterKey]; if (!cfg) { socket.emit('errorMessage', `找不到怪物`); return; } const roomId = 'room_' + Math.random().toString(36).substr(2, 5); gameState.battleRooms[roomId] = { id: roomId, monsterKey: monsterKey, monster: { ...cfg, maxHp: cfg.hp, status: 'alive', isStunned: false }, status: 'waiting', players: [socket.id], host: socket.id, updatedAt: Date.now(), turnIndex: 0 }; socket.emit('roomJoined', { roomId: roomId, isHost: true }); broadcastHubData(); } catch (e) { console.error(e); } });
    socket.on('joinRoom', (roomId) => { const p = gameState.players[socket.id]; if (!p) return; if (p.hp <= 0) { socket.emit('errorMessage', " 你已經死亡！請先去旅館復活。"); return; } const room = gameState.battleRooms[roomId]; if (room && room.status === 'waiting') { if (room.players.length >= 5) { socket.emit('errorMessage', '房間已滿'); return; } if (!room.players.includes(socket.id)) room.players.push(socket.id); socket.emit('roomJoined', { roomId: roomId, isHost: false }); io.to(roomId).emit('roomInfoUpdate', getRoomPublicInfo(room)); broadcastHubData(); } else { socket.emit('errorMessage', '無法加入'); } });
    
    // 4. 關鍵修正：當玩家連線到戰鬥頁面時，強制廣播「我來了」給所有人
    socket.on('connectToRoom', (roomId) => { 
        const p = gameState.players[socket.id]; 
        if (!p) return; 
        const room = gameState.battleRooms[roomId]; 
        
        if (room) { 
            socket.join(roomId); 
            if (!room.players.includes(socket.id)) { 
                if(room.players.length < 5) room.players.push(socket.id); 
                else { socket.emit('errorMessage', '房間已滿'); return; } 
            } 
            if (!room.players.includes(room.host)) room.host = room.players[0]; 
            
            // 改用 io.to() 廣播，而不是 socket.emit
            io.to(roomId).emit('roomInfoUpdate', getRoomPublicInfo(room)); 
            
            if (room.status === 'fighting') { 
                socket.emit('battleStarted'); 
                socket.emit('monsterUpdate', room.monster); 
                broadcastTurn(room); 
            } 
        } else { 
            socket.emit('errorMessage', '房間已失效'); 
        } 
    });
    
    socket.on('startBattle', (roomId) => {
        const room = gameState.battleRooms[roomId];
        if (room && room.host === socket.id && room.status === 'waiting') {
            room.status = 'fighting';
            let order = [...room.players, 'monster'];
            room.turnOrder = shuffleArray(order);
            room.turnIndex = -1; 
            
            io.to(roomId).emit('battleStarted');
            io.to(roomId).emit('monsterUpdate', room.monster);
            let orderNames = room.turnOrder.map(id => 
                id === 'monster' ? '怪物' : (gameState.players[id] ? gameState.players[id].id.substr(0,4) : 'Unknown')
            ).join(' → ');
            io.to(roomId).emit('battleLog', `<span style="color:#aaa; font-size:10px;">順序: ${orderNames}</span>`);

            broadcastHubData();
            processNextTurn(room, roomId);
        }
    });
    
    socket.on('combatAction', (data) => { 
        const { roomId, type, skillId } = data;
        const room = gameState.battleRooms[roomId]; 
        const player = gameState.players[socket.id]; 
        
        if (!room || !player || room.status !== 'fighting') return; 
        const currentEntityId = room.turnOrder[room.turnIndex];
        if (socket.id !== currentEntityId) return; 
        
        let damage = 0; 
        let logMsg = "";

        if (type === 'attack') {
            damage = player.atk + Math.floor(Math.random() * 5); 
            logMsg = `<span style="color:#f1c40f">${player.id.substr(0,4)} 攻擊! 造成 ${damage} 傷害</span>`;
            room.monster.hp -= damage;
        } 
        else if (type === 'skill') { 
            const skill = SKILL_CONFIG[skillId];
            if (!skill || (player.skills && !player.skills.includes(skillId))) return; 
            if (player.mp < skill.mp) return; 
            player.mp -= skill.mp; 
            if (skill.type === 'dmg') {
                damage = Math.floor(player.atk * skill.val);
                room.monster.hp -= damage;
                logMsg = `<span style="color:#3498db">${player.id.substr(0,4)} 施放 ${skill.name}! (${damage}傷)</span>`;
            }
            else if (skill.type === 'heal') {
                let heal = skill.val;
                player.hp = Math.min(player.hp + heal, player.maxHp);
                logMsg = `<span style="color:#2ecc71">${player.id.substr(0,4)} 施放 ${skill.name}! 恢復 ${heal} HP</span>`;
                damage = 0; 
            }
            else if (skill.type === 'stun') {
                damage = Math.floor(player.atk * skill.val);
                room.monster.hp -= damage;
                
                //  加入暈眩機率 (例如 60% 成功)
                const stunChance = 0.6; 
                const isSuccess = Math.random() < stunChance;

                if (isSuccess) {
                    room.monster.isStunned = true; 
                    logMsg = `<span style="color:#9b59b6">${player.id.substr(0,4)} 施放 ${skill.name}! ⚡ 怪物暈眩了!</span>`;
                } else {
                    room.monster.isStunned = false; // 確保狀態沒變
                    logMsg = `<span style="color:#95a5a6">${player.id.substr(0,4)} 施放 ${skill.name}! (抵抗) 怪物沒有暈眩...</span>`;
                }
            }
            else if (skill.type === 'drain') {
                damage = Math.floor(player.atk * skill.val);
                room.monster.hp -= damage;
                let heal = Math.floor(damage * 0.5); 
                player.hp = Math.min(player.hp + heal, player.maxHp);
                logMsg = `<span style="color:#e74c3c">${player.id.substr(0,4)} 吸取生命! (${damage}傷, +${heal}HP)</span>`;
            }
        } 
        
        if (room.monster.hp < 0) room.monster.hp = 0; 
        io.to(roomId).emit('battleLog', logMsg); 
        io.to(roomId).emit('monsterUpdate', room.monster); 
        socket.emit('playerStatsUpdate', player); 
        if (room.monster.hp === 0) { handleMonsterDeath(room, roomId); return; } 
        processNextTurn(room, roomId);
    });

    socket.on('useItem', (data) => { 
        const { roomId, itemId } = data; 
        const player = gameState.players[socket.id]; 
        if (player && player.inventory && player.inventory[itemId] > 0) { 
            let used = false;
            // HP 藥水
            if (itemId === 'potion_hp') { player.hp += 50; used = true; }
            else if (itemId === 'potion_mid') { player.hp += 500; used = true; }
            else if (itemId === 'potion_high') { player.hp += 2000; used = true; }
            else if (itemId === 'potion_max') { player.hp += 10000; used = true; }
            else if (itemId === 'elixir') { player.hp += 50000; used = true; }
            // MP 藥水
            else if (itemId === 'potion_mp') { player.mp += 30; used = true; }
            else if (itemId === 'potion_mp_mid') { player.mp += 100; used = true; }
            else if (itemId === 'potion_mp_high') { player.mp += 500; used = true; }
            
            //  新增：料理食用效果
            else if (itemId === 'grilled_carp') { player.hp += 100; used = true; }
            else if (itemId === 'salmon_sushi') { player.mp += 50; used = true; }
            else if (itemId === 'tuna_steak') { player.hp += 500; used = true; }
            else if (itemId === 'eel_rice') { player.hp += 300; player.mp += 100; used = true; }
            else if (itemId === 'void_soup') { player.hp = player.maxHp; player.mp = player.maxMp; used = true; }

            if (used) {
                player.inventory[itemId]--; 
                if (player.inventory[itemId] === 0) delete player.inventory[itemId]; 
                if (player.hp > player.maxHp) player.hp = player.maxHp;
                if (player.mp > player.maxMp) player.mp = player.maxMp;
                const item = ITEM_CONFIG[itemId];
                if(roomId) io.to(roomId).emit('battleLog', `<span style="color:#2ecc71">${player.id.substr(0,4)} 使用 ${item.name}</span>`);
                socket.emit('playerStatsUpdate', player); 
                if (roomId && gameState.battleRooms[roomId]) {
                    io.to(roomId).emit('roomInfoUpdate', getRoomPublicInfo(gameState.battleRooms[roomId])); 
                }
                saveMyData(socket.id); 
            }
        } 
    });

    socket.on('leaveRoom', (roomId) => leaveRoomLogic(socket.id, roomId));
    
    socket.on('disconnect', () => { 
        console.log(`[離線] ID: ${socket.id}`);
        const p = gameState.players[socket.id];
        if (p && p.token) {
            saveMyData(socket.id); 
            disconnectTimers[p.token] = setTimeout(() => {
                console.log(`[超時移除] ${socket.id}`);
                for (let rid in gameState.battleRooms) {
                    let room = gameState.battleRooms[rid];
                    if (room.players.includes(socket.id)) {
                        leaveRoomLogic(socket.id, rid);
                    }
                }
                delete gameState.players[socket.id]; 
                broadcastHubData();
                delete disconnectTimers[p.token]; 
            }, 5000); // 5秒
        } else {
            delete gameState.players[socket.id];
        }
    });

    socket.on('playerRest', () => { 
        let p = gameState.players[socket.id]; 
        if(!p) return; 

        for (let rid in gameState.battleRooms) {
            let room = gameState.battleRooms[rid];
            if (room.players.includes(socket.id)) {
                leaveRoomLogic(socket.id, rid);
            }
        }

        p.hp = p.maxHp; 
        p.mp = p.maxMp; 
        socket.emit('restResult', "恢復！"); 
        socket.emit('playerStatsUpdate', p); 
        saveMyData(socket.id); 
    });
});

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
    setTimeout(() => { if (gameState.battleRooms[roomId]) { room.status = 'waiting'; room.monster.hp = room.monster.maxHp; room.monster.status = 'alive'; room.monster.isStunned = false; room.turnIndex = 0; io.to(roomId).emit('battleReset'); io.to(roomId).emit('roomInfoUpdate', getRoomPublicInfo(room)); broadcastHubData(); } }, 3000); 
}

function saveMyData(socketId) { const p = gameState.players[socketId]; if (p && p.token) DB.savePlayer(p.token, p); }
function calculateStats(p) { if (!p.baseStats) return; p.maxHp = p.baseStats.hp; p.maxMp = p.baseStats.mp; p.atk = p.baseStats.atk; p.def = p.baseStats.def; Object.values(p.equipment).forEach(itemId => { if (itemId && ITEM_CONFIG[itemId]) { const item = ITEM_CONFIG[itemId]; if (item.hp) p.maxHp += item.hp; if (item.mp) p.maxMp += item.mp; if (item.atk) p.atk += item.atk; if (item.def) p.def += item.def; } }); if (p.hp > p.maxHp) p.hp = p.maxHp; if (p.mp > p.maxMp) p.mp = p.maxMp; }

function monsterPhase(room, roomId) { 
    if (!gameState.battleRooms[roomId]) return;
    if (room.players.length === 0) return; 
    if (room.monster.hp <= 0) return; 
    
    // 全軍覆沒檢查
    let alivePlayers = room.players.filter(pid => gameState.players[pid] && gameState.players[pid].hp > 0); 
    
    if (alivePlayers.length === 0) {
        room.status = 'waiting';
        room.monster.hp = room.monster.maxHp;
        io.to(roomId).emit('battleLog', `<span style="color:red; font-weight:bold;">全軍覆沒...戰鬥結束</span>`);
        io.to(roomId).emit('battleReset'); 
        io.to(roomId).emit('roomInfoUpdate', getRoomPublicInfo(room));
        return; 
    }

    if (room.monster.isStunned) {
        io.to(roomId).emit('battleLog', `<span style="color:#9b59b6">⚡ 怪物麻痺無法動彈！</span>`);
        room.monster.isStunned = false; 
        processNextTurn(room, roomId); 
        return; 
    }

    const targetId = alivePlayers[Math.floor(Math.random() * alivePlayers.length)]; 
    const target = gameState.players[targetId]; 
    const cfg = MONSTER_CONFIG[room.monsterKey]; 
    let dmg = (cfg.atk - target.def) + Math.floor(Math.random() * 5); 
    if (dmg < 1) dmg = 1; 
    target.hp -= dmg; 
    if (target.hp <= 0) { 
        target.hp = 0; 
        io.to(targetId).emit('playerDead'); 
        io.to(roomId).emit('battleLog', ` ${target.id.substr(0,4)} 倒下了...`);
    } else { 
        io.to(targetId).emit('playerDamaged', { damage: dmg }); 
    } 
    io.to(targetId).emit('playerStatsUpdate', target); 
    io.to(roomId).emit('battleLog', `<span style="color:#e74c3c; font-weight:bold;">怪物重擊 ${target.id.substr(0,4)} ! (${dmg}傷)</span>`); 
    io.to(roomId).emit('roomInfoUpdate', getRoomPublicInfo(room)); 
    
    processNextTurn(room, roomId);
}

function broadcastTurn(room) { 
    const currentEntityId = room.turnOrder[room.turnIndex];
    if (currentEntityId === 'monster') {
        io.to(room.id).emit('turnUpdate', { currentId: 'monster', name: room.monster.name });
    } else {
        const pid = currentEntityId;
        const p = gameState.players[pid];
        const pName = p ? p.id.substr(0, 4) : 'Unknown';
        io.to(room.id).emit('turnUpdate', { currentId: pid, name: pName });
    }
}

function processNextTurn(room, roomId) {
    if (room.status !== 'fighting') return;
    let loopCount = 0;
    let validTargetFound = false;
    while (!validTargetFound && loopCount < room.turnOrder.length * 2) {
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
        } else {
            const p = gameState.players[nextEntityId];
            if (p && p.hp > 0) { 
                validTargetFound = true;
                broadcastTurn(room);
            }
        }
        loopCount++;
    }
}

function leaveRoomLogic(socketId, roomId) { 
    const room = gameState.battleRooms[roomId]; 
    if (!room) return; 
    const player = gameState.players[socketId]; 
    const name = player ? player.id.substr(0, 4) : 'Unknown'; 
    if(room.status === 'fighting') {
        io.to(roomId).emit('battleLog', `<span style="color:#95a5a6">${name} 離開了戰鬥</span>`); 
    }
    room.players = room.players.filter(id => id !== socketId); 
    if (room.turnOrder) {
        room.turnOrder = room.turnOrder.filter(id => id !== socketId);
    }
    if (room.players.length === 0) { 
        const now = Date.now();
        if (room.status === 'waiting' && (now - (room.updatedAt || 0) < 10000)) {
            return; 
        }
        delete gameState.battleRooms[roomId]; 
        return; 
    } 
    if (room.host === socketId) room.host = room.players[0]; 
    io.to(roomId).emit('roomInfoUpdate', getRoomPublicInfo(room)); 
    broadcastHubData(); 
    if(room.status === 'fighting') {
        processNextTurn(room, roomId);
    }
}

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
    let currentTurnId = null;
    if (room.status === 'fighting' && room.turnOrder && room.turnIndex >= 0) {
        currentTurnId = room.turnOrder[room.turnIndex];
    }
    return { 
        id: room.id, 
        host: room.host, 
        status: room.status, 
        players: playerDetails, 
        monsterName: MONSTER_CONFIG[room.monsterKey].name,
        monsterKey: room.monsterKey, 
        monsterMaxHp: room.monster.maxHp, 
        monsterHp: room.monster.hp,
        currentTurnId: currentTurnId
    }; 
}

function gainExp(player, amount, socketId) { 
    player.exp += amount; 
    io.to(socketId).emit('battleLog', `獲得 ${amount} 經驗`); 
    if (player.exp >= player.maxExp) { 
        player.level++; 
        player.exp -= player.maxExp; 
        player.maxExp = Math.floor(player.maxExp * 1.5); 
        player.baseStats.hp += 20; 
        player.baseStats.mp += 10; 
        player.baseStats.atk += 3; 
        player.baseStats.def += 1; 
        calculateStats(player); 
        player.hp = player.maxHp; 
        player.mp = player.maxMp; 
        io.to(socketId).emit('battleLog', `<span style="color:#f1c40f">升級！LV.${player.level}</span>`); 
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
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

function broadcastHubData() { let cityCounts = {}; Object.values(gameState.players).forEach(p => { if (p.currentCity) cityCounts[p.currentCity] = (cityCounts[p.currentCity] || 0) + 1; }); let roomsList = Object.values(gameState.battleRooms).map(r => ({ id: r.id, monsterKey: r.monsterKey, monsterName: MONSTER_CONFIG[r.monsterKey].name, status: r.status, playerCount: r.players.length })); io.emit('hubDataUpdate', { cityCounts, roomsList }); }

setInterval(() => { const now = Date.now(); Object.keys(gameState.battleRooms).forEach(roomId => { const room = gameState.battleRooms[roomId]; if (room.players.length === 0 || (now - (room.updatedAt || now) > 10 * 60 * 1000)) { delete gameState.battleRooms[roomId]; io.emit('hubDataUpdate', { cityCounts: {}, roomsList: [] }); } }); Object.values(gameState.players).forEach(p => { if (p.token) DB.savePlayer(p.token, p); }); console.log("自動存檔"); }, 30000);

const PORT = 3001; 
http.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });