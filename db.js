require('dotenv').config();
const mysql = require('mysql2');

const pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS,
    database: process.env.DB_NAME || 'rpg_game',
    port: 3307,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: 'utf8mb4'
});

const promisePool = pool.promise();

const DB = {
    // 1. 建立帳號 (新增 email 參數)
    createAccount: async (username, passwordHash, token, callback, email = null) => {
        let conn;
        try {
            conn = await promisePool.getConnection();
            await conn.beginTransaction();

            const [rows] = await conn.execute('SELECT id FROM users WHERE username = ?', [username]);
            if (rows.length > 0) {
                await conn.rollback();
                return callback(false, "帳號已存在");
            }

            // [新增] 檢查 email 是否已被使用
            if (email) {
                const [emailRows] = await conn.execute('SELECT id FROM users WHERE email = ?', [email]);
                if (emailRows.length > 0) {
                    await conn.rollback();
                    return callback(false, "此 Email 已被其他帳號使用");
                }
            }

            // 寫入 users 表 (新增 email 欄位)
            await conn.execute(
                'INSERT INTO users (username, password, token, email) VALUES (?, ?, ?, ?)',
                [username, passwordHash, token, email]
            );

            // 準備預設數據 (包含 skill_levels)
            const defaultBaseStats = JSON.stringify({ hp: 100, mp: 50, atk: 10, def: 5 });
            const defaultInventory = JSON.stringify({});
            const defaultEquipment = JSON.stringify({ weapon: null, armor: null, acc: null });
            const defaultSkills = JSON.stringify(['fireball']);
            const defaultSkillLevels = JSON.stringify({ 'fireball': 1 }); // 預設技能等級
            const defaultEnhancements = JSON.stringify({ weapon: 0, armor: 0, acc: 0 });
            const defaultFriends = JSON.stringify([]);
            const defaultFriendRequests = JSON.stringify([]);

            //  [修改] INSERT 加入 rebirth
            await conn.execute(
                `INSERT INTO player_stats 
                (username, gold, hp, maxHp, mp, maxMp, level, exp, maxExp, atk, def, 
                 inventory, equipment, skills, skill_levels, baseStats, enhancements, friends, friend_requests, rebirth) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
                [
                    username, 
                    1000,    // gold
                    100, 100, // hp, maxHp
                    50, 50,   // mp, maxMp
                    1,       // level
                    0,       // exp
                    100,     // maxExp
                    10, 5,   // atk, def
                    defaultInventory, 
                    defaultEquipment, 
                    defaultSkills, 
                    defaultSkillLevels,
                    defaultBaseStats,
                    defaultEnhancements,
                    defaultFriends,
                    defaultFriendRequests,
                    0        //  rebirth (預設 0)
                ]
            );

            await conn.commit();
            callback(true, "註冊成功");
        } catch (err) {
            if (conn) await conn.rollback();
            console.error(err);
            callback(false, "資料庫錯誤");
        } finally {
            if (conn) conn.release();
        }
    },

    // 2. 取得使用者資訊
    getUserInfo: async (username, callback) => {
        try {
            const [rows] = await promisePool.execute('SELECT * FROM users WHERE username = ?', [username]);
            callback(rows.length > 0 ? rows[0] : null);
        } catch (err) {
            console.error(err);
            callback(null);
        }
    },

    // 3. 更新 Token
    updateUserToken: async (username, newToken, callback) => {
        try {
            await promisePool.execute(
                'UPDATE users SET token = ? WHERE username = ?', 
                [newToken, username]
            );
            if (callback) callback(true);
        } catch (e) {
            console.error(e);
            if (callback) callback(false);
        }
    },

    // 4. 修改密碼
    changeUserPassword: async (username, newHash, newToken, callback) => {
        try {
            const [result] = await promisePool.execute(
                'UPDATE users SET password = ?, token = ? WHERE username = ?', 
                [newHash, newToken, username]
            );
            if (typeof callback === 'function') {
                callback(result.affectedRows > 0);
            }
        } catch (e) {
            console.error(e);
            if (typeof callback === 'function') callback(false);
        }
    },

    // 5. 讀取玩家存檔
    loadPlayer: async (token, callback) => {
        try {
            const sql = `
                SELECT ps.*, u.username, u.token
                FROM users u
                LEFT JOIN player_stats ps ON u.username = ps.username 
                WHERE u.token = ?
            `;
            const [rows] = await promisePool.execute(sql, [token]);
            
            if (rows.length > 0) {
                let data = rows[0];
                
                const parseJSON = (str) => {
                    if (!str) return null;
                    if (typeof str === 'object') return str; 
                    try { return JSON.parse(str); } catch (e) { return null; }
                };

                data.inventory = parseJSON(data.inventory) || {};
                data.equipment = parseJSON(data.equipment) || { weapon: null, armor: null, acc: null };
                data.skills = parseJSON(data.skills) || ['fireball'];
                // 讀取 skill_levels
                data.skillLevels = parseJSON(data.skill_levels) || { 'fireball': 1 }; 
                
                data.baseStats = parseJSON(data.baseStats) || { hp: 100, mp: 50, atk: 10, def: 5 };
                data.enhancements = parseJSON(data.enhancements) || { weapon: 0, armor: 0, acc: 0 };
                data.friends = parseJSON(data.friends) || [];
                data.friendRequests = parseJSON(data.friend_requests) || [];

                data.hp = data.hp !== null ? data.hp : 100;
                data.gold = data.gold !== null ? data.gold : 1000;
                data.level = data.level !== null ? data.level : 1;
                
                //  確保讀取 rebirth
                data.rebirth = (data.rebirth !== null && data.rebirth !== undefined) ? data.rebirth : 0;
                data.durability = parseJSON(data.durability) || {};
                data.hirelings = parseJSON(data.hirelings) || [];

                callback(data);
            } else {
                callback(null);
            }
        } catch (err) {
            console.error("LoadPlayer Error:", err);
            callback(null);
        }
    },

    // 6. 儲存玩家存檔
    savePlayer: async (token, p) => {
        try {
            const [users] = await promisePool.execute('SELECT username FROM users WHERE token = ?', [token]);
            if (users.length === 0) return; 
            
            const username = users[0].username;

            const safeInt = (val, def = 0) => { const num = parseInt(val); return isNaN(num) ? def : num; };
            const safeStr = (val) => val ? JSON.stringify(val) : '{}';

            const baseStats = safeStr(p.baseStats);
            const equipment = safeStr(p.equipment);
            const skills = safeStr(p.skills);
            const skillLevels = safeStr(p.skillLevels || { 'fireball': 1 }); 
            const inventoryStr = safeStr(p.inventory); 
            const enhancementsStr = safeStr(p.enhancements || { weapon: 0, armor: 0, acc: 0 });
            const friendsStr = p.friends ? JSON.stringify(p.friends) : '[]';
            const requestsStr = p.friendRequests ? JSON.stringify(p.friendRequests) : '[]';

            //  [修改] UPDATE 加入 rebirth
            const durabilityStr = p.durability ? JSON.stringify(p.durability) : '{}';
            const hirelingsStr = p.hirelings ? JSON.stringify(p.hirelings) : '[]';

            const sqlStats = `
                UPDATE player_stats SET
                gold=?, level=?, exp=?, maxExp=?, 
                hp=?, maxHp=?, mp=?, maxMp=?, 
                atk=?, def=?, gatherExp=?, gatherLevel=?, 
                currentCity=?, baseStats=?, 
                equipment=?, skills=?, skill_levels=?, 
                inventory=?, enhancements=?, 
                friends=?, friend_requests=?,
                rebirth=?, durability=?, hirelings=?
                WHERE username=?
            `;

            const values = [
                safeInt(p.gold, 0), safeInt(p.level, 1), safeInt(p.exp, 0), safeInt(p.maxExp, 100), 
                safeInt(p.hp, 100), safeInt(p.maxHp, 100), safeInt(p.mp, 50), safeInt(p.maxMp, 50), 
                safeInt(p.atk, 10), safeInt(p.def, 5), safeInt(p.gatherExp, 0), safeInt(p.gatherLevel, 1), 
                p.currentCity || 'city_1', baseStats, 
                equipment, skills, skillLevels, 
                inventoryStr, enhancementsStr,
                friendsStr, requestsStr, 
                safeInt(p.rebirth, 0),
                durabilityStr,
                hirelingsStr,
                username 
            ];

            await promisePool.execute(sqlStats, values);

        } catch (err) {
            console.error(`❌ SavePlayer 失敗:`, err.message);
        }
    },

    // 7. 市集功能
    getListingsBySeller: async (token, callback) => {
        try {
            const [u] = await promisePool.execute('SELECT username FROM users WHERE token = ?', [token]);
            if(u.length === 0) return callback([]);

            const username = u[0].username;
            const sql = 'SELECT * FROM market WHERE seller_username = ? AND status = "active" ORDER BY id DESC';
            const [rows] = await promisePool.execute(sql, [username]);
            callback(rows);
        } catch (e) { 
            console.error(e);
            callback([]); 
        }
    },

    getPlayerListingCount: async (token, callback) => {
        try {
            const [u] = await promisePool.execute('SELECT username FROM users WHERE token = ?', [token]);
            if(u.length === 0) return callback(999);

            const [rows] = await promisePool.execute(
                'SELECT COUNT(*) as count FROM market WHERE seller_username = ? AND status = "active"', 
                [u[0].username]
            );
            callback(rows[0].count);
        } catch (e) {
            console.error(e);
            callback(999); 
        }
    },

    addListing: async (token, name, itemKey, price, callback) => {
        try {
            const [u] = await promisePool.execute('SELECT username FROM users WHERE token = ?', [token]);
            if(u.length === 0) return callback(false);
            
            const username = u[0].username;

            await promisePool.execute(
                'INSERT INTO market (seller_username, seller_name, item_key, price, status, created_at) VALUES (?, ?, ?, ?, "active", NOW())', 
                [username, name, itemKey, price]
            );
            callback(true);
        } catch (e) { 
            console.error("AddListing Error:", e.message);
            callback(false); 
        }
    },

    getListingsByItem: async (itemKey, limit, offset, callback) => {
        try {
            const [countRows] = await promisePool.execute(
                'SELECT COUNT(*) as total FROM market WHERE item_key = ? AND status = "active"',
                [itemKey]
            );
            const total = countRows[0].total;

            const sql = 'SELECT * FROM market WHERE item_key = ? AND status = "active" ORDER BY price ASC LIMIT ? OFFSET ?';
            const [rows] = await promisePool.execute(sql, [itemKey, parseInt(limit), parseInt(offset)]);
            
            callback({ listings: rows, total: total });
        } catch (e) {
            console.error("GetListingsByItem Error:", e);
            callback({ listings: [], total: 0 });
        }
    },

    // 安全交易版本
    buyListing: async (listingId, buyerGold, callback) => {
        let conn;
        try {
            conn = await pool.promise().getConnection();
            await conn.beginTransaction();

            const [rows] = await conn.execute('SELECT * FROM market WHERE id = ? AND status = "active" FOR UPDATE', [listingId]);
            
            if (rows.length === 0) {
                await conn.rollback(); conn.release();
                return callback({ success: false, msg: "物品不存在或已被賣出" });
            }

            const listing = rows[0];

            if (buyerGold < listing.price) {
                await conn.rollback(); conn.release();
                return callback({ success: false, msg: "金幣不足！" });
            }

            const [updateResult] = await conn.execute(
                'UPDATE player_stats SET gold = gold + ? WHERE username = ?',
                [listing.price, listing.seller_username]
            );

            if (updateResult.affectedRows === 0) {
                console.error(`[BuyListing] 錯誤：找不到賣家 ${listing.seller_username}，交易取消`);
                await conn.rollback(); conn.release();
                return callback({ success: false, msg: "賣家資料異常，無法交易" });
            }

            await conn.execute('UPDATE market SET status = "sold" WHERE id = ?', [listingId]);
            
            await conn.commit();
            conn.release();
            
            callback({ success: true, listing: listing });

        } catch (e) { 
            console.error("[BuyListing Error]:", e); 
            if (conn) { try { await conn.rollback(); } catch(err) {} conn.release(); }
            callback({ success: false, msg: "系統繁忙，請稍後再試" }); 
        }
    },

    cancelListing: async (listingId, token, callback) => {
        try {
            const [u] = await promisePool.execute('SELECT username FROM users WHERE token = ?', [token]);
            if(u.length === 0) return callback(null);
            const username = u[0].username;

            const [rows] = await promisePool.execute('SELECT * FROM market WHERE id = ? AND seller_username = ? AND status = "active"', [listingId, username]);
            if (rows.length > 0) {
                await promisePool.execute('DELETE FROM market WHERE id = ? LIMIT 1', [listingId]);
                callback(rows[0]);
            } else {
                callback(null);
            }
        } catch (e) { callback(null); }
    },

    logChat: async (name, msg) => { 
        try {
            await promisePool.execute('INSERT INTO chat_logs (sender_name, message) VALUES (?, ?)', [name, msg]);
        } catch(e) { } 
    },
    
    getChatHistory: async (limit, cb) => { 
        try {
            const [rows] = await promisePool.execute(`SELECT * FROM (SELECT * FROM chat_logs ORDER BY id DESC LIMIT ${limit}) sub ORDER BY id ASC`);
            cb(rows);
        } catch(e) { 
            cb([]); 
        } 
    },

    addGoldToUser: async (username, amount) => {
        try {
            await promisePool.execute('UPDATE player_stats SET gold = gold + ? WHERE username = ?', [amount, username]);
        } catch(e) { console.error(e); }
    },

    // 8. 私訊系統
    logPrivateMessage: async (sender, receiver, msg) => {
        try {
            await promisePool.execute(
                'INSERT INTO private_messages (sender, receiver, message, is_read) VALUES (?, ?, ?, 0)', 
                [sender, receiver, msg]
            );
        } catch (e) { console.error("LogPM Error:", e); }
    },

    getPrivateHistory: async (user1, user2) => {
        try {
            const [rows] = await promisePool.execute(
                `SELECT sender, message, created_at 
                 FROM private_messages 
                 WHERE (sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?)
                 ORDER BY created_at DESC 
                 LIMIT 50`,
                [user1, user2, user2, user1]
            );
            return rows;
        } catch (e) {
            console.error("GetPM History Error:", e);
            return [];
        }
    },

    getUnreadCounts: async (username, cb) => {
        try {
            const sql = `
                SELECT sender, COUNT(*) as count 
                FROM private_messages 
                WHERE receiver = ? AND is_read = 0 
                GROUP BY sender
            `;
            const [rows] = await promisePool.execute(sql, [username]);
            cb(rows);
        } catch (e) {
            console.error("GetUnread Error:", e);
            cb([]);
        }
    },

    markMessagesAsRead: async (me, sender) => {
        try {
            await promisePool.execute(
                'UPDATE private_messages SET is_read = 1 WHERE receiver = ? AND sender = ?',
                [me, sender]
            );
        } catch (e) { console.error("MarkRead Error:", e); }
    },

    addOfflineFriendRequest: async (senderName, targetName, callback) => {
        try {
            const [rows] = await promisePool.execute(
                'SELECT username, friends, friend_requests FROM player_stats WHERE username = ?', 
                [targetName]
            );

            if (rows.length === 0) {
                return callback({ success: false, msg: "找不到該玩家 (無此帳號)" });
            }

            const targetData = rows[0];
            
            let friends = [];
            let requests = [];
            try { friends = JSON.parse(targetData.friends || '[]'); } catch(e){}
            try { requests = JSON.parse(targetData.friend_requests || '[]'); } catch(e){}

            if (friends.includes(senderName)) {
                return callback({ success: false, msg: "你們已經是好友了！" });
            }
            if (requests.includes(senderName)) {
                return callback({ success: false, msg: "你已經發送過申請了！" });
            }

            requests.push(senderName);
            await promisePool.execute(
                'UPDATE player_stats SET friend_requests = ? WHERE username = ?',
                [JSON.stringify(requests), targetName]
            );

            callback({ success: true, msg: `已發送好友申請給 [${targetName}] (對方目前離線)` });

        } catch (e) {
            console.error("OfflineReq Error:", e);
            callback({ success: false, msg: "資料庫錯誤" });
        }
    },

    // ==========================================
    //  [新增] Email 相關功能
    // ==========================================

    // 用 Email 查詢帳號
    getUserByEmail: async (email, callback) => {
        try {
            const [rows] = await promisePool.execute('SELECT * FROM users WHERE email = ?', [email]);
            callback(rows.length > 0 ? rows[0] : null);
        } catch (err) {
            console.error("GetUserByEmail Error:", err);
            callback(null);
        }
    },

    // 綁定 Email (已有帳號後補綁定)
    bindEmail: async (username, email, callback) => {
        try {
            // 1. 檢查 email 是否已被其他帳號使用
            const [emailRows] = await promisePool.execute(
                'SELECT username FROM users WHERE email = ? AND username != ?', 
                [email, username]
            );
            if (emailRows.length > 0) {
                return callback({ success: false, msg: "此 Email 已被其他帳號使用" });
            }

            // 2. 更新 email
            const [result] = await promisePool.execute(
                'UPDATE users SET email = ? WHERE username = ?',
                [email, username]
            );

            if (result.affectedRows > 0) {
                callback({ success: true, msg: "Email 綁定成功！" });
            } else {
                callback({ success: false, msg: "找不到此帳號" });
            }
        } catch (err) {
            console.error("BindEmail Error:", err);
            callback({ success: false, msg: "資料庫錯誤" });
        }
    },

    // 設定 Email 驗證狀態
    setEmailVerified: async (username, verified, callback) => {
        try {
            await promisePool.execute(
                'UPDATE users SET email_verified = ? WHERE username = ?',
                [verified ? 1 : 0, username]
            );
            if (callback) callback(true);
        } catch (err) {
            console.error("SetEmailVerified Error:", err);
            if (callback) callback(false);
        }
    },

    // 查詢帳號是否已綁定 Email
    getUserEmail: async (username, callback) => {
        try {
            const [rows] = await promisePool.execute('SELECT email, email_verified FROM users WHERE username = ?', [username]);
            if (rows.length > 0) {
                callback(rows[0].email || null);
            } else {
                callback(null);
            }
        } catch (err) {
            console.error("GetUserEmail Error:", err);
            callback(null);
        }
    }
};

module.exports = DB;