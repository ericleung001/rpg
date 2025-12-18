const mysql = require('mysql2');

const pool = mysql.createPool({
    host: '127.0.0.1',
    port: 3307,
    user: 'root',
    password: '35076400TTc!',
    database: 'rpg_game',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// 1. 註冊 (存入加密密碼)
function createAccount(user, passHash, token, callback) {
    const sql = 'INSERT INTO accounts (username, password, token) VALUES (?, ?, ?)';
    pool.execute(sql, [user, passHash, token], (err) => {
        if (err) {
            console.error("註冊失敗 SQL Error:", err.message);
            if (err.errno === 1062) callback(false, "帳號已存在");
            else if (err.code === 'ER_DATA_TOO_LONG') callback(false, "資料過長");
            else callback(false, "資料庫錯誤");
        } else {
            callback(true, "註冊成功");
        }
    });
}

// 2. 獲取使用者資訊 (用來登入比對) -  注意這裡叫 getUserInfo
function getUserInfo(user, callback) {
    pool.execute('SELECT password, token FROM accounts WHERE username = ?', [user], (err, rows) => {
        if (err || rows.length === 0) callback(null);
        else callback(rows[0]); 
    });
}

// ... (中間的 loadPlayer, savePlayer, market 等功能保持不變，直接複製舊的即可) ...
// 為了版面簡潔，這裡省略中間部分，請確保你有保留

function loadPlayer(token, callback) {
    pool.execute('SELECT data FROM players WHERE token = ?', [token], (err, rows) => {
        if (err || rows.length === 0) callback(null);
        else try { callback(JSON.parse(rows[0].data)); } catch { callback(null); }
    });
}

function savePlayer(token, playerData) {
    const jsonStr = JSON.stringify(playerData);
    pool.execute('INSERT INTO players (token, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data)', [token, jsonStr], (err) => { if(err) console.error("存檔失敗:", err); });
}

function addListing(token, name, itemKey, price, callback) {
    pool.execute('INSERT INTO market_listings (seller_token, seller_name, item_key, price) VALUES (?, ?, ?, ?)', [token, name, itemKey, price], (err) => callback(!err));
}

function getListings(callback) {
    pool.execute('SELECT * FROM market_listings ORDER BY created_at DESC', (err, rows) => callback(err ? [] : rows));
}

function buyListing(listingId, callback) {
    pool.execute('SELECT * FROM market_listings WHERE id = ?', [listingId], (err, rows) => {
        if (err || rows.length === 0) callback(null);
        else pool.execute('DELETE FROM market_listings WHERE id = ?', [listingId], (delErr) => callback(delErr ? null : rows[0]));
    });
}

function cancelListing(listingId, sellerToken, callback) {
    pool.execute('SELECT * FROM market_listings WHERE id = ? AND seller_token = ?', [listingId, sellerToken], (err, rows) => {
        if (err || rows.length === 0) { callback(null); } 
        else {
            const listing = rows[0];
            pool.execute('DELETE FROM market_listings WHERE id = ?', [listingId], (delErr) => {
                if (delErr) callback(null); else callback(listing);
            });
        }
    });
}

function logChat(name, msg) {
    pool.execute('INSERT INTO chat_logs (sender_name, message) VALUES (?, ?)', [name, msg], (err) => { if(err) console.error("聊天記錄失敗:", err); });
}

function getChatHistory(limit, callback) {
    pool.execute(`SELECT * FROM (SELECT * FROM chat_logs ORDER BY created_at DESC LIMIT ?) sub ORDER BY created_at ASC`, [limit], (err, rows) => { callback(err ? [] : rows); });
}

//  確保這裡匯出的是 getUserInfo，而不是 loginAccount
module.exports = { 
    createAccount, getUserInfo, 
    loadPlayer, savePlayer, 
    addListing, getListings, buyListing, cancelListing,
    logChat, getChatHistory 
};