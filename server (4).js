const express = require('express');
const axios = require('axios');

const app = express();
const PORT = 3000;

// --- Cấu hình ---
const API_URL = 'https://api.xeuigogo.info/v2/history/getLastResult?gameId=ktrng_3986&size=100&tableId=39861215743193&curPage=1';
const UPDATE_INTERVAL = 5000;
const MIN_HISTORY = 5;

// --- Biến toàn cục ---
let historyData = [];
let lastPrediction = {
    phien: null,
    du_doan: null,
    doan_vi: null
};

// --- Hàm hỗ trợ ---
async function updateHistory() {
    try {
        const { data } = await axios.get(API_URL);
        if (data?.data?.resultList) {
            historyData = data.data.resultList;
        }
    } catch (error) {
        console.error('Lỗi cập nhật:', error.message);
    }
}

function getResultType(session) {
    if (!session) return "";
    const [d1, d2, d3] = session.facesList;
    if (d1 === d2 && d2 === d3) return "Bão";
    return session.score >= 11 ? "Tài" : "Xỉu";
}

function generatePattern(history, length = 10) {
    return history.slice(0, length)
        .map(s => getResultType(s).charAt(0))
        .reverse()
        .join('');
}

function predictMain(history) {
    if (history.length < 3) return "Tài";
    const pattern = generatePattern(history, 5);
    if (pattern.startsWith("TTT")) return "Xỉu";
    if (pattern.startsWith("XXX")) return "Tài";
    return history[0].score >= 11 ? "Xỉu" : "Tài";
}

function generateNumbers(prediction) {
    if (prediction === "Xỉu") {
        const numbers = [];
        while (numbers.length < 3) {
            const num = 4 + Math.floor(Math.random() * 7);
            if (!numbers.includes(num)) numbers.push(num);
        }
        return numbers.sort((a, b) => a - b);
    } else {
        const numbers = [];
        while (numbers.length < 3) {
            const num = 11 + Math.floor(Math.random() * 7);
            if (!numbers.includes(num)) numbers.push(num);
        }
        return numbers.sort((a, b) => a - b);
    }
}

// --- Endpoint chính ---
app.get('/predict', async (req, res) => {
    await updateHistory();
    const latest = historyData[0] || {};
    const currentPhien = latest.gameNum;

    // Kiểm tra nếu đã qua phiên mới
    if (currentPhien !== lastPrediction.phien) {
        const mainPred = historyData.length >= MIN_HISTORY ? predictMain(historyData) : "";
        lastPrediction = {
            phien: currentPhien,
            du_doan: mainPred,
            doan_vi: mainPred ? generateNumbers(mainPred) : [0, 0, 0]
        };
    }

    res.json({
        Id: "binhtool90",
        Phien: currentPhien ? parseInt(currentPhien.replace('#', '')) + 1 : 0,
        Xuc_xac_1: latest.facesList?.[0] || 0,
        Xuc_xac_2: latest.facesList?.[1] || 0,
        Xuc_xac_3: latest.facesList?.[2] || 0,
        Tong: latest.score || 0,
        Ket_qua: getResultType(latest),
        Pattern: generatePattern(historyData),
        Du_doan: lastPrediction.du_doan || "",
        doan_vi: lastPrediction.doan_vi || [0, 0, 0]
    });
});

// --- Khởi động server ---
app.listen(PORT, () => {
    console.log(`Server đang chạy tại http://localhost:${PORT}`);
    setInterval(updateHistory, UPDATE_INTERVAL);
});
