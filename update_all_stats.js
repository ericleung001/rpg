require('dotenv').config();
const mysql = require('mysql');

// 1. 資料庫連線設定
const connection = mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS,
    database: process.env.DB_NAME || 'rpg_game',
});

// 👈 請確認你的玩家資料表名稱 (users 或 player_stats)
const TABLE_NAME = 'player_stats'; 

connection.connect();

console.log("🚀 開始根據 Level 重算所有玩家數值...");

// =========================================================================
// 🟢 1. 能力值計算公式 (4人副本強化版 - 累加法)
// =========================================================================
function getStatsByLevel(lv) {
    // Lv.1 初始值
    let stats = { hp: 100, mp: 50, atk: 10, def: 5 }; 
    
    // 模擬從 Lv.2 升到目前 Lv 的過程
    for (let i = 2; i <= lv; i++) {
        stats.hp += 100 + (i * 3);          // HP 大幅成長
        stats.mp += 20 + Math.floor(i * 0.5);
        stats.atk += 5 + Math.floor(i / 5);
        stats.def += 3 + Math.floor(i / 15);
    }
    return stats;
}

// =========================================================================
// 🟢 2. 經驗值上限計算 (方案 C - 分段倍率)
// =========================================================================
function getMaxExpByLevel(lv) {
    let exp = 100; // Lv.1 初始值
    for (let i = 2; i <= lv; i++) {
        if (i < 20) exp = Math.floor(exp * 1.5);
        else if (i < 50) exp = Math.floor(exp * 1.2);
        else exp = Math.floor(exp * 1.05);
    }
    return exp;
}

// =========================================================================
// 🟢 執行更新邏輯
// =========================================================================

// 1. 抓取所有玩家的 ID 和 Level
const query = `SELECT id, username, level FROM ${TABLE_NAME}`;

connection.query(query, (err, rows) => {
    if (err) {
        console.error("❌ 讀取失敗:", err);
        connection.end();
        return;
    }

    console.log(`📊 找到 ${rows.length} 位玩家，開始更新...`);

    let processedCount = 0;

    if (rows.length === 0) {
        console.log("⚠️ 沒有玩家資料。");
        connection.end();
        return;
    }

    rows.forEach(player => {
        const level = parseInt(player.level) || 1;

        // 計算目標數值
        const newStats = getStatsByLevel(level);
        const newMaxExp = getMaxExpByLevel(level);

        // 準備更新 SQL
        // 我們將 hp/mp 補滿 (等於 maxHp/maxMp)，並將 exp 歸零
        const updateSql = `
            UPDATE ${TABLE_NAME}
            SET 
                maxExp = ?,
                exp = 0,
                maxHp = ?,
                hp = ?,
                maxMp = ?,
                mp = ?,
                atk = ?,
                def = ?
            WHERE id = ?
        `;

        const params = [
            newMaxExp,      // maxExp
            newStats.hp,    // maxHp (基礎值)
            newStats.hp,    // hp (補滿)
            newStats.mp,    // maxMp (基礎值)
            newStats.mp,    // mp (補滿)
            newStats.atk,   // atk (基礎值)
            newStats.def,   // def (基礎值)
            player.id       // WHERE id
        ];

        connection.query(updateSql, params, (updateErr) => {
            if (updateErr) {
                console.error(`❌ 更新玩家 ${player.username} 失敗:`, updateErr.message);
            }

            processedCount++;
            
            // 顯示進度
            if (processedCount % 10 === 0) {
                console.log(`...已處理 ${processedCount} / ${rows.length} 位玩家`);
            }

            if (processedCount === rows.length) {
                console.log("------------------------------------------------");
                console.log("🎉 全部完成！所有玩家數值已重置。");
                console.log("📝 說明: 目前資料庫中的 atk/def 為「基礎數值」。");
                console.log("👉 玩家登入遊戲後，Server 會自動再加上裝備數值。");
                console.log("------------------------------------------------");
                connection.end();
            }
        });
    });
});