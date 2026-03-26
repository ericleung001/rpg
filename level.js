const mysql = require('mysql2/promise');

// 🟢 資料庫設定 (已填入你的密碼)
const dbConfig = {
    host: '127.0.0.1:3306',
    user: 'root',
    password: '001105418aA!', 
    database: 'rpg_game'
};

// 🟢⚠️ 請在這裡輸入你要升級的帳號名稱！(例如 'test01')
const TARGET_USERNAME = 'test1'; 

async function boostCharacter() {
    const conn = await mysql.createConnection(dbConfig);
    console.log(`🔌 連線資料庫成功，正在尋找玩家: ${TARGET_USERNAME}...`);

    try {
        // 1. 找 User ID
        const [users] = await conn.execute('SELECT id FROM users WHERE username = ?', [TARGET_USERNAME]);
        if (users.length === 0) {
            console.error("❌ 找不到此帳號，請確認名稱是否正確 (有分大小寫)。");
            return;
        }
        const userId = users[0].id;

        // 2. 設定 99 等數據 & 全部技能
        const allSkills = JSON.stringify([
            'fireball', 'heal_light', 'thunder', 'drain', 'god_light', 
            'frost_nova', 'poison_touch', 'holy_shield', 'berserk'
        ]);
        
        // 設定超強數值
        const godStats = JSON.stringify({ hp: 99999, mp: 99999, atk: 5000, def: 2000 });

        const sql = `
            UPDATE player_stats 
            SET 
                level = 99, 
                exp = 0, maxExp = 1000000,
                hp = 99999, maxHp = 99999,
                mp = 99999, maxMp = 99999,
                atk = 5000, def = 2000,
                gold = 9999999,
                skills = ?,
                baseStats = ?
            WHERE user_id = ?
        `;

        await conn.execute(sql, [allSkills, godStats, userId]);

        console.log(`
        ✅ 成功！玩家 [${TARGET_USERNAME}] 已升級為 LV.99 神級角色！
        -------------------------------------------
        ❤️ HP/MP: 99999
        ⚔️ ATK:   5000
        🛡️ DEF:   2000
        💰 Gold:  9,999,999
        ✨ 技能:  全技能解鎖 (含新魔法)
        -------------------------------------------
        ⚠️ 請讓該玩家 [登出再登入] 即可生效。
        `);

    } catch (err) {
        console.error("❌ 錯誤:", err);
    } finally {
        await conn.end();
    }
}

boostCharacter();