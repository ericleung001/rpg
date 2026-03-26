const mysql = require('mysql2/promise');

// ⚙️ 資料庫設定 (請修改這裡)
const dbConfig = {
    host: 'localhost',
    user: 'root',      // 你的資料庫帳號
    password: '35076400TTc!',      // 你的資料庫密碼
    database: 'rpg_game', // 你的資料庫名稱
    port: '3307'
};

// 獲取命令行參數
const args = process.argv.slice(2);
if (args.length < 2) {
    console.log("❌ 用法: node copy_user.js <來源玩家A> <目標玩家B>");
    console.log("   範例: node copy_user.js PlayerA PlayerB");
    process.exit(1);
}

const sourceUser = args[0]; // User A
const targetUser = args[1]; // User B

async function copyUserData() {
    let connection;
    try {
        // 1. 連接資料庫
        connection = await mysql.createConnection(dbConfig);
        console.log("✅ 資料庫連線成功");

        // 2. 讀取 User A (來源) 的數據
        const [rows] = await connection.execute(
            'SELECT * FROM player_stats WHERE username = ?',
            [sourceUser]
        );

        if (rows.length === 0) {
            throw new Error(`找不到來源玩家: ${sourceUser}`);
        }

        const sourceData = rows[0];
        console.log(` 已讀取 [${sourceUser}] 的數據 (LV.${sourceData.level})`);

        // 3. 檢查 User B (目標) 是否存在
        const [targetRows] = await connection.execute(
            'SELECT username FROM player_stats WHERE username = ?',
            [targetUser]
        );

        if (targetRows.length === 0) {
            throw new Error(`找不到目標玩家: ${targetUser} (請先建立該帳號)`);
        }

        // =====================================================
        //  開始複製程序 (依照你指定的次序)
        // =====================================================

        console.log(`\n⏳ 開始將數據由 [${sourceUser}] 複製到 [${targetUser}]...`);

        // 步驟 1: 複製 Equipment (裝備)
        const newEquipment = sourceData.equipment; 
        console.log("   1. 裝備 (Equipment) ... 準備覆蓋");

        // 步驟 2: 複製 Inventory (物品欄)
        const newInventory = sourceData.inventory;
        console.log("   2. 物品 (Inventory) ... 準備覆蓋");

        // 步驟 3: 複製 Enhancements (強化數據)
        const newEnhancements = sourceData.enhancements;
        console.log("   3. 強化 (Enhancements) ... 準備覆蓋");

        // 步驟 4: 複製 Gold (金幣)
        const newGold = sourceData.gold;
        console.log(`   4. 金幣 (Gold: ${newGold}) ... 準備覆蓋`);

        // 額外步驟: 複製 Level (等級) - 你提到 "lv比b user"
        const newLevel = sourceData.level;
        const newExp = sourceData.exp; // 通常等級跟經驗值是一組的，建議一起複製
        const newHp = sourceData.maxHp; // 建議連血量上限一起複製
        const newMp = sourceData.maxMp;
        console.log(`   5. 等級 (Level: ${newLevel}) ... 準備覆蓋`);

        // 4. 執行 SQL 更新 (一次性寫入以確保原子性)
        const updateQuery = `
            UPDATE player_stats 
            SET 
                equipment = ?,
                inventory = ?,
                enhancements = ?,
                gold = ?,
                level = ?,
                exp = ?,
                maxHp = ?,
                hp = ?,
                maxMp = ?,
                mp = ?
            WHERE username = ?
        `;

        // 注意：這裡假設 inventory 等欄位在資料庫是 JSON 字串格式 (String/Text)
        // 如果你的資料庫是 JSON 類型，mysql2 會自動處理
        await connection.execute(updateQuery, [
            newEquipment,
            newInventory,
            newEnhancements,
            newGold,
            newLevel,
            newExp,        // 順便複製經驗
            newHp,         // 順便複製最大HP
            newHp,         // 補滿血
            newMp,         // 順便複製最大MP
            newMp,         // 補滿魔
            targetUser     // WHERE 條件
        ]);

        console.log(`\n✨ 成功！[${targetUser}] 的數據已完全被 [${sourceUser}] 覆蓋。`);

    } catch (err) {
        console.error("\n❌ 發生錯誤:", err.message);
    } finally {
        if (connection) {
            await connection.end();
            console.log(" 資料庫連線已關閉");
        }
    }
}

copyUserData();