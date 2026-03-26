const mysql = require('mysql2/promise');

// 🟢 資料庫設定
const dbConfig = {
    host: '127.0.0.1',
    user: 'root',
    password: '001105418aA!', 
    database: 'rpg_game'
};

// 🟢⚠️ 設定你要修改的帳號
const TARGET_USERNAME = 'test2'; 

async function boostCharacter() {
    const conn = await mysql.createConnection(dbConfig);
    console.log(`🔌 連線資料庫成功，正在強化玩家: ${TARGET_USERNAME}...`);

    try {
        // 1. 從 users 表格找 ID
        const [users] = await conn.execute('SELECT id FROM users WHERE username = ?', [TARGET_USERNAME]);
        
        if (users.length === 0) {
            console.error(`❌ 找不到帳號 [${TARGET_USERNAME}]，請確認名稱是否正確。`);
            return;
        }
        const userId = users[0].id;

        // 2. 設定神級數值 (LV.99)
        const GOD_STATS = {
            level: 99,
            gold: 9999999,
            
            // 目標：單挑虛空領主 (HP 200萬)
            hp: 2000000, 
            mp: 500000,
            atk: 30000,  
            def: 12000
        };

        const baseStatsStr = JSON.stringify({
            hp: GOD_STATS.hp,
            mp: GOD_STATS.mp,
            atk: GOD_STATS.atk,
            def: GOD_STATS.def
        });

        // 補滿全技能
        const allSkills = JSON.stringify([
            'fireball', 'heal_light', 'thunder', 'drain', 'god_light', 
            'frost_nova', 'poison_touch', 'holy_shield', 'berserk'
        ]);

        // 3. 更新 player_stats 表
        await conn.execute(`
            UPDATE player_stats 
            SET 
                level = ?,
                gold = ?,
                exp = 0,
                maxExp = 100000,
                
                hp = ?, maxHp = ?,
                mp = ?, maxMp = ?,
                atk = ?, def = ?,
                
                baseStats = ?,
                skills = ?
            WHERE user_id = ?
        `, [
            GOD_STATS.level, GOD_STATS.gold,
            GOD_STATS.hp, GOD_STATS.hp, // hp, maxHp
            GOD_STATS.mp, GOD_STATS.mp, // mp, maxMp
            GOD_STATS.atk, GOD_STATS.def,
            baseStatsStr,
            allSkills,
            userId
        ]);

        console.log(`
        ✅ 成功！玩家 [${TARGET_USERNAME}] 已進化為 LV.99 虛空殺手
        -------------------------------------------
        ❤️ HP:  ${GOD_STATS.hp}
        💧 MP:  ${GOD_STATS.mp}
        ⚔️ ATK: ${GOD_STATS.atk}
        🛡️ DEF: ${GOD_STATS.def}
        💰 Gold: ${GOD_STATS.gold}
        -------------------------------------------
        ⚠️ 請讓該玩家 [重新登入] 即可生效。
        `);

    } catch (err) {
        console.error("❌ 錯誤:", err);
    } finally {
        await conn.end();
    }
}

boostCharacter();