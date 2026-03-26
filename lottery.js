const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'lottery_data.json');

const DEFAULT_DATA = {
    jackpot: 10000000, 
    bets: [],
    lastRoundBets: [], 
    lastDraw: null,
    isOpen: true
};

let lotteryData = { ...DEFAULT_DATA };

function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const raw = fs.readFileSync(DATA_FILE, 'utf8');
            lotteryData = JSON.parse(raw);
            if (lotteryData.isOpen === undefined) lotteryData.isOpen = true; 
            if (!lotteryData.lastRoundBets) lotteryData.lastRoundBets = []; 
        } else {
            saveData();
        }
    } catch (e) {
        console.error('[Lottery] 讀取錯誤:', e);
        lotteryData = { ...DEFAULT_DATA };
    }
}

//  這個函式必須被匯出
function saveData() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(lotteryData, null, 2), 'utf8');
    } catch (e) { console.error('[Lottery] 存檔失敗:', e); }
}

loadData();

module.exports = {
    getInfo: () => {
        return {
            jackpot: lotteryData.jackpot,
            totalBets: lotteryData.bets.length,
            lastDraw: lotteryData.lastDraw,
            isOpen: lotteryData.isOpen
        };
    },
    getPlayerBets: (username) => lotteryData.bets.filter(b => b.name === username),
    
    getPlayerLastBets: (username) => lotteryData.lastRoundBets.filter(b => b.name === username),

    setState: (isOpen) => {
        lotteryData.isOpen = !!isOpen;
        saveData();
        return lotteryData.isOpen;
    },

    buyTicket: (username, numbers, price) => {
        if (!lotteryData.isOpen) return false; 
        lotteryData.jackpot += (price * 0.8);
        lotteryData.bets.push({ name: username, nums: numbers, time: Date.now() });
        saveData();
        return true;
    },

    //  [關鍵修正] 必須匯出 saveData，讓 server.js 可以強制存檔
    saveData: saveData,

    draw: () => {
        let result = [];
        while(result.length < 6) {
            let r = Math.floor(Math.random() * 49) + 1;
            if(result.indexOf(r) === -1) result.push(r);
        }
        result.sort((a,b) => a - b);

        let winners = [];
        let totalPrizeOut = 0;

        lotteryData.bets.forEach(bet => {
            let hits = bet.nums.filter(n => result.includes(n)).length;
            let prize = 0;
            let items = []; 

            // 6個字：頭獎 + 神裝
            if (hits === 6) {
                prize = Math.floor(lotteryData.jackpot * 0.5); 
                items = [
                    { id: 'lucky_bag', count: 1 },
                    { id: 'singularity_weapon', count: 1 }, 
                    { id: 'singularity_armor', count: 1 },  
                    { id: 'singularity_acc', count: 1 }     
                ];
            } 
            // 5個字：50萬 + Lv.450 神話裝備
            else if (hits === 5) {
                prize = 500000;
                items = [
                    { id: 'lucky_bag', count: 1 },
                    { id: 'infinity_blade', count: 1 },     
                    { id: 'event_horizon', count: 1 },      
                    { id: 'mobius_ring', count: 1 }         
                ];
            } 
            // 4個字：1萬 + 時光沙x30
            else if (hits === 4) {
                prize = 10000; 
                items = [
                    { id: 'time_sand', count: 30 }
                ];
            } 
            // 3個字：500元 + 強化石x30
            else if (hits === 3) {
                prize = 500;   
                items = [
                    { id: 'enhance_stone', count: 30 }
                ];
            }
            // 2個字：無錢 + 強化石x20
            else if (hits === 2) {
                prize = 0;
                items = [
                    { id: 'enhance_stone', count: 20 }
                ];
            }
            // 1個字：無錢 + 強化石x10
            else if (hits === 1) {
                prize = 0;
                items = [
                    { id: 'enhance_stone', count: 10 }
                ];
            }

            if (prize > 0 || items.length > 0) {
                winners.push({ 
                    name: bet.name, 
                    prize: prize, 
                    hits: hits, 
                    items: items 
                });
                totalPrizeOut += prize;
            }
        });

        const drawInfo = { numbers: result, time: Date.now(), winnerCount: winners.length };

        // 簡單邏輯：如果有中頭獎，獎池扣除總發出金額 (防止變負數)
        if (winners.some(w => w.hits === 6)) {
             lotteryData.jackpot = Math.max(1000000, lotteryData.jackpot - totalPrizeOut);
        }

        lotteryData.lastDraw = drawInfo;
        
        lotteryData.lastRoundBets = [...lotteryData.bets]; 
        lotteryData.bets = [];
        
        saveData();

        return { result, winners };
    }
};