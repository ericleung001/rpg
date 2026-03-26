const mysql = require('mysql2/promise');

// 🟢 資料庫設定 (請確認密碼)
const dbConfig = {
    host: '127.0.0.1',
    user: 'root',
    password: '001105418aA!', 
    database: 'rpg_game'
};

async function fixAllPlayers() {
    const conn = await mysql.createConnection(dbConfig);
    console.log("🚀 開始全伺服器數值【標準】校正...");

    try {
        // 1. 抓取所有玩家資料
        const [players] = await conn.execute('SELECT id, user_id, token, level, gold FROM player_stats');
        console.log(`📊 掃描到 ${players.length} 位玩家，開始計算數值...`);

        for (const p of players) {
            // 2. 根據等級計算「理論上」該有的數值
            // ⚠️ 這裡必須與 server.js 的 gainExp 保持一致！
            // 當前設定：HP+20, MP+10, ATK+3, DEF+1
            const lv = p.level || 1;
            
            const newStats = {
                hp: 100 + (lv - 1) * 20,
                mp: 50  + (lv - 1) * 10,
                atk: 10 + (lv - 1) * 3,
                def: 5  + (lv - 1) * 1
            };

            // 確保滿血滿魔
            const currentHp = newStats.hp;
            const currentMp = newStats.mp;

            // 3. 準備 JSON
            const baseStatsStr = JSON.stringify(newStats);
            
            // 4. 自動補齊所有技能 (根據等級解鎖)
            let skills = ['fireball'];
            if (lv >= 5) skills.push('heal_light');
            if (lv >= 10) skills.push('thunder');
            if (lv >= 15) skills.push('drain');
            if (lv >= 20) skills.push('god_light');
            if (lv >= 25) skills.push('frost_nova');
            if (lv >= 30) skills.push('poison_touch');
            if (lv >= 35) skills.push('holy_shield');
            if (lv >= 40) skills.push('berserk');
            
            const skillsStr = JSON.stringify(skills);

            // 5. 更新資料庫
            await conn.execute(`
                UPDATE player_stats 
                SET 
                    hp = ?, maxHp = ?,
                    mp = ?, maxMp = ?,
                    atk = ?, def = ?,
                    baseStats = ?,
                    skills = ?
                WHERE id = ?
            `, [
                currentHp, newStats.hp,     // hp, maxHp
                currentMp, newStats.mp,     // mp, maxMp
                newStats.atk, newStats.def, // atk, def
                baseStatsStr,               // baseStats JSON
                skillsStr,                  // skills JSON
                p.id                        // WHERE id
            ]);

            console.log(`✅ 已修正 User ID: ${p.user_id} (Lv.${lv}) -> HP:${newStats.hp} / ATK:${newStats.atk}`);
        }

        console.log("\n🎉 全伺服器玩家數值同步完成！");

    } catch (err) {
        console.error("❌ 發生錯誤:", err);
    } finally {
        await conn.end();
    }
}

fixAllPlayers();