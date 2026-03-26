const mysql = require('mysql');

// ⚠️ 請填入你的資料庫連線資訊
const db = mysql.createConnection({
    host: '127.0.0.1',
    user: 'root',
    password: '001105418aA!', // 🟢 請改成你的 DB 密碼 (例如 001105418aA!)
    database: 'rpg_game'
});

db.connect();

console.log("開始遷移資料...");

// 1. 讀取所有玩家的 ID 和 背包 JSON
const sql = "SELECT id, inventory FROM player_stats";

db.query(sql, (err, players) => {
    if (err) throw err;

    let processed = 0;
    let totalItems = 0;

    if (players.length === 0) {
        console.log("沒有玩家資料需要遷移。");
        process.exit();
    }

    players.forEach(p => {
        if (!p.inventory) {
            processed++;
            return;
        }

        let inv = {};
        try {
            // 嘗試解析 JSON，如果已經是物件就不用解析
            inv = (typeof p.inventory === 'string') ? JSON.parse(p.inventory) : p.inventory;
        } catch (e) {
            console.log(`玩家 ID ${p.id} 背包資料損壞，跳過`);
            return;
        }

        // 遍歷背包裡的每個物品
        if (inv) {
            for (let [itemId, count] of Object.entries(inv)) {
                if (count > 0) {
                    // 插入到新表格
                    const insertSql = "INSERT IGNORE INTO player_items (player_id, item_id, count) VALUES (?, ?, ?)";
                    db.query(insertSql, [p.id, itemId, count]);
                    totalItems++;
                }
            }
        }
        processed++;
        
        // 顯示進度
        if (processed % 100 === 0) {
            console.log(`已處理 ${processed} / ${players.length} 位玩家...`);
        }
    });

    // 等待一小段時間讓最後的 query 跑完 (簡單做法)
    setTimeout(() => {
        console.log(`✅ 遷移完成！共處理 ${processed} 位玩家，搬運了 ${totalItems} 個物品紀錄。`);
        console.log("請按 Ctrl + C 離開");
        process.exit();
    }, 3000);
});