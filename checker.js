const fs = require('fs');

const INPUT_FILE = 'whales.json';
const OUTPUT_FILE = 'results.jsonl';
const API_URL = 'https://api.hyperliquid.xyz/info';

const TIMEOUT_MS = 10000; 

const DELAY_BETWEEN_WALLETS = 150; 

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchWithTimeout(url, body) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal
        });
        clearTimeout(id);
        if (!response.ok) return null;
        return await response.json();
    } catch (e) {
        clearTimeout(id);
        return null;
    }
}

async function processWallet(wallet, index, total) {
    const [webData, userFills] = await Promise.all([
        fetchWithTimeout(API_URL, { type: "webData2", user: wallet }),
        fetchWithTimeout(API_URL, { type: "userFills", user: wallet })
    ]);

    let accountValue = null;
    let totalRawUsd = null;
    let marginUsed = null;
    let totalVolumeAllTokens = 0;
    let totalPnLAllTokens = 0;

    
    let statusLog = "OK";

    if (webData && webData.clearinghouseState && webData.clearinghouseState.marginSummary) {
        const summary = webData.clearinghouseState.marginSummary;
        accountValue = summary.accountValue ? Math.round(parseFloat(summary.accountValue) * 100) / 100 : null;
        totalRawUsd = summary.totalRawUsd ? Math.round(parseFloat(summary.totalRawUsd) * 100) / 100 : null;
        marginUsed = summary.totalMarginUsed ? Math.round(parseFloat(summary.totalMarginUsed) * 100) / 100 : null;
    } else if (!webData) {
        statusLog = "LIMIT_EXCEEDED/DROP";
    }

    if (Array.isArray(userFills)) {
        let rawVol = 0;
        let rawPnl = 0;
        for (const fill of userFills) {
            rawVol += (parseFloat(fill.px) || 0) * (parseFloat(fill.sz) || 0);
            rawPnl += parseFloat(fill.closedPnl) || 0;
        }
        totalVolumeAllTokens = Math.round(rawVol * 100) / 100;
        totalPnLAllTokens = Math.round(rawPnl * 100) / 100;
    }

    const result = {
        wallet,
        accountValue,
        totalRawUsd,
        marginUsed,
        totalVolumeAllTokens,
        totalPnLAllTokens
    };

  
    fs.appendFileSync(OUTPUT_FILE, JSON.stringify(result) + '\n');
    
    
    console.log(`[${index}/${total}] Кошелек: ${wallet} | Статус API: ${statusLog} | Объем: $${totalVolumeAllTokens}`);
    
    return result;
}

async function main() {
    if (!fs.existsSync(INPUT_FILE)) {
        console.error(`Ошибка: Файл ${INPUT_FILE} не найден.`);
        process.exit(1);
    }

   
    fs.writeFileSync(OUTPUT_FILE, '');

    const wallets = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
    const total = wallets.length;
    
    console.log(`Запуск безопасной обработки. Всего кошельков: ${total}`);
    console.log(`--------------------------------------------------------`);

    const allResults = [];

  
    for (let i = 0; i < total; i++) {
        const wallet = wallets[i];
        const res = await processWallet(wallet, i + 1, total);
        allResults.push(res);
        
        if (i < total - 1) {
            await sleep(DELAY_BETWEEN_WALLETS);
        }
    }

    console.log(`--------------------------------------------------------`);
    console.log(`Все данные собраны. Начинаю сортировку файла...`);

    
    allResults.sort((a, b) => a.totalVolumeAllTokens - b.totalVolumeAllTokens);

    
    const writeStream = fs.createWriteStream(OUTPUT_FILE);
    for (const item of allResults) {
        writeStream.write(JSON.stringify(item) + '\n');
    }
    writeStream.end();

    console.log(`Готово! Данные в файле ${OUTPUT_FILE} успешно отсортированы по возрастанию объема.`);
}

main().catch(console.error);