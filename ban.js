// ban.js
const fs = require('fs');
const path = require('path');

const FILE_IP = path.join(__dirname, 'banned_ips.json');
const FILE_ACC = path.join(__dirname, 'banned_accounts.json');

let bannedIPs = {};
let bannedAccounts = {};

// 初始化
function loadBans() {
    try {
        if (fs.existsSync(FILE_IP)) bannedIPs = JSON.parse(fs.readFileSync(FILE_IP, 'utf8'));
        if (fs.existsSync(FILE_ACC)) bannedAccounts = JSON.parse(fs.readFileSync(FILE_ACC, 'utf8'));
    } catch (e) {
        console.error('[BanSystem] 讀取封鎖列表失敗:', e);
    }
}

function saveBans() {
    try {
        fs.writeFileSync(FILE_IP, JSON.stringify(bannedIPs, null, 2), 'utf8');
        fs.writeFileSync(FILE_ACC, JSON.stringify(bannedAccounts, null, 2), 'utf8');
    } catch (e) { console.error('[BanSystem] 存檔失敗:', e); }
}

loadBans();

module.exports = {
    // --- IP 相關 ---
    isIpBanned: (ip) => {
        if (!ip || !bannedIPs[ip]) return false;
        const rec = bannedIPs[ip];
        if (rec.expiresAt && Date.now() > rec.expiresAt) { delete bannedIPs[ip]; saveBans(); return false; }
        return rec;
    },
    banIp: (ip, reason, duration) => {
        let exp = duration > 0 ? Date.now() + (duration * 3600000) : null;
        bannedIPs[ip] = { reason: reason || "違規", expiresAt: exp, bannedAt: Date.now() };
        saveBans();
    },
    unbanIp: (ip) => {
        if (bannedIPs[ip]) { delete bannedIPs[ip]; saveBans(); return true; }
        return false;
    },
    getAllIpBans: () => bannedIPs,

    // --- 帳號相關 ---
    isAccountBanned: (username) => {
        if (!username || !bannedAccounts[username]) return false;
        const rec = bannedAccounts[username];
        if (rec.expiresAt && Date.now() > rec.expiresAt) { delete bannedAccounts[username]; saveBans(); return false; }
        return rec;
    },
    banAccount: (username, reason, duration) => {
        let exp = duration > 0 ? Date.now() + (duration * 3600000) : null;
        bannedAccounts[username] = { reason: reason || "違規", expiresAt: exp, bannedAt: Date.now() };
        saveBans();
    },
    unbanAccount: (username) => {
        if (bannedAccounts[username]) { delete bannedAccounts[username]; saveBans(); return true; }
        return false;
    },
    getAllAccountBans: () => bannedAccounts
};