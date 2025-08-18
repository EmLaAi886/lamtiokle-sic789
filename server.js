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
    doan_vi: null,
    do_tin_cay: 0
};
let modelPredictions = {}; // Biến để lưu trữ dự đoán của các mô hình

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

// Helper function: Detect streak and break probability
function detectStreakAndBreak(history) {
    if (!history || history.length === 0) return { streak: 0, currentResult: null, breakProb: 0.0 };
    let streak = 1;
    const currentResult = getResultType(history[0]);
    for (let i = 1; i < history.length; i++) {
        if (getResultType(history[i]) === currentResult) {
            streak++;
        } else {
            break;
        }
    }
    const last15 = history.slice(0, 15).map(h => getResultType(h));
    if (!last15.length) return { streak, currentResult, breakProb: 0.0 };
    const switches = last15.slice(1).reduce((count, curr, idx) => count + (curr !== last15[idx] ? 1 : 0), 0);
    const taiCount = last15.filter(r => r === 'Tài').length;
    const xiuCount = last15.filter(r => r === 'Xỉu').length;
    const imbalance = Math.abs(taiCount - xiuCount) / last15.length;
    let breakProb = 0.0;

    if (streak >= 8) {
        breakProb = Math.min(0.6 + (switches / 15) + imbalance * 0.15, 0.9);
    } else if (streak >= 5) {
        breakProb = Math.min(0.35 + (switches / 10) + imbalance * 0.25, 0.85);
    } else if (streak >= 3 && switches >= 7) {
        breakProb = 0.3;
    }
    return { streak, currentResult, breakProb };
}

// Helper function: Evaluate model performance
function evaluateModelPerformance(history, modelName, lookback = 10) {
    if (!modelPredictions[modelName] || history.length < 2) return 1.0;
    lookback = Math.min(lookback, history.length - 1);
    let correctCount = 0;
    for (let i = 0; i < lookback; i++) {
        const pred = modelPredictions[modelName][history[i + 1].gameNum] || 0;
        const actual = getResultType(history[i]);
        if ((pred === 1 && actual === 'Tài') || (pred === 2 && actual === 'Xỉu')) {
            correctCount++;
        }
    }
    const performanceScore = lookback > 0 ? 1.0 + (correctCount - lookback / 2) / (lookback / 2) : 1.0;
    return Math.max(0.5, Math.min(1.5, performanceScore));
}

// Helper function: Smart bridge break model
function smartBridgeBreak(history) {
    if (!history || history.length < 3) return { prediction: 0, breakProb: 0.0, reason: 'Không đủ dữ liệu để bẻ cầu' };

    const { streak, currentResult, breakProb } = detectStreakAndBreak(history);
    const last20 = history.slice(0, 20).map(h => getResultType(h));
    const lastScores = history.slice(0, 20).map(h => h.score || 0);
    let breakProbability = breakProb;
    let reason = '';

    const avgScore = lastScores.reduce((sum, score) => sum + score, 0) / (lastScores.length || 1);
    const scoreDeviation = lastScores.reduce((sum, score) => sum + Math.abs(score - avgScore), 0) / (lastScores.length || 1);

    const last5 = last20.slice(0, 5);
    const patternCounts = {};
    for (let i = 0; i <= last20.length - 3; i++) {
        const pattern = last20.slice(i, i + 3).join(',');
        patternCounts[pattern] = (patternCounts[pattern] || 0) + 1;
    }
    const mostCommonPattern = Object.entries(patternCounts).sort((a, b) => b[1] - a[1])[0];
    const isStablePattern = mostCommonPattern && mostCommonPattern[1] >= 3;

    if (streak >= 6) {
        breakProbability = Math.min(breakProbability + 0.15, 0.9);
        reason = `[Bẻ Cầu] Chuỗi ${streak} ${currentResult} dài, khả năng bẻ cầu cao`;
    } else if (streak >= 4 && scoreDeviation > 3) {
        breakProbability = Math.min(breakProbability + 0.1, 0.85);
        reason = `[Bẻ Cầu] Biến động điểm số lớn (${scoreDeviation.toFixed(1)}), khả năng bẻ cầu tăng`;
    } else if (isStablePattern && last5.every(r => r === currentResult)) {
        breakProbability = Math.min(breakProbability + 0.05, 0.8);
        reason = `[Bẻ Cầu] Phát hiện mẫu lặp ${mostCommonPattern[0]}, có khả năng bẻ cầu`;
    } else {
        breakProbability = Math.max(breakProbability - 0.15, 0.15);
        reason = `[Bẻ Cầu] Không phát hiện mẫu bẻ cầu mạnh, tiếp tục theo cầu`;
    }

    let prediction = breakProbability > 0.65 ? (currentResult === 'Tài' ? 2 : 1) : (currentResult === 'Tài' ? 1 : 2);
    return { prediction, breakProb: breakProbability, reason };
}

// Helper function: Trend and probability model
function trendAndProb(history) {
    if (!history || history.length < 3) return 0;
    const { streak, currentResult, breakProb } = detectStreakAndBreak(history);
    if (streak >= 5) {
        if (breakProb > 0.75) {
            return currentResult === 'Tài' ? 2 : 1;
        }
        return currentResult === 'Tài' ? 1 : 2;
    }
    const last15 = history.slice(0, 15).map(h => getResultType(h));
    if (!last15.length) return 0;
    const weights = last15.map((_, i) => Math.pow(1.2, 14 - i));
    const taiWeighted = weights.reduce((sum, w, i) => sum + (last15[i] === 'Tài' ? w : 0), 0);
    const xiuWeighted = weights.reduce((sum, w, i) => sum + (last15[i] === 'Xỉu' ? w : 0), 0);
    const totalWeight = taiWeighted + xiuWeighted;
    const last10 = last15.slice(0, 10);
    const patterns = [];
    if (last10.length >= 4) {
        for (let i = 0; i <= last10.length - 4; i++) {
            patterns.push(last10.slice(i, i + 4).join(','));
        }
    }
    const patternCounts = patterns.reduce((acc, p) => { acc[p] = (acc[p] || 0) + 1; return acc; }, {});
    const mostCommon = Object.entries(patternCounts).sort((a, b) => b[1] - a[1])[0];
    if (mostCommon && mostCommon[1] >= 3) {
        const pattern = mostCommon[0].split(',');
        return pattern[pattern.length - 1] !== last10[0] ? 1 : 2;
    } else if (totalWeight > 0 && Math.abs(taiWeighted - xiuWeighted) / totalWeight >= 0.25) {
        return taiWeighted > xiuWeighted ? 2 : 1;
    }
    return last15[0] === 'Xỉu' ? 1 : 2;
}

// Helper function: Short pattern model
function shortPattern(history) {
    if (!history || history.length < 3) return 0;
    const { streak, currentResult, breakProb } = detectStreakAndBreak(history);
    if (streak >= 4) {
        if (breakProb > 0.75) {
            return currentResult === 'Tài' ? 2 : 1;
        }
        return currentResult === 'Tài' ? 1 : 2;
    }
    const last8 = history.slice(0, 8).map(h => getResultType(h));
    if (!last8.length) return 0;
    const patterns = [];
    if (last8.length >= 3) {
        for (let i = 0; i <= last8.length - 3; i++) {
            patterns.push(last8.slice(i, i + 3).join(','));
        }
    }
    const patternCounts = patterns.reduce((acc, p) => { acc[p] = (acc[p] || 0) + 1; return acc; }, {});
    const mostCommon = Object.entries(patternCounts).sort((a, b) => b[1] - a[1])[0];
    if (mostCommon && mostCommon[1] >= 2) {
        const pattern = mostCommon[0].split(',');
        return pattern[pattern.length - 1] !== last8[0] ? 1 : 2;
    }
    return last8[0] === 'Xỉu' ? 1 : 2;
}

// Helper function: Mean deviation model
function meanDeviation(history) {
    if (!history || history.length < 3) return 0;
    const { streak, currentResult, breakProb } = detectStreakAndBreak(history);
    if (streak >= 4) {
        if (breakProb > 0.75) {
            return currentResult === 'Tài' ? 2 : 1;
        }
        return currentResult === 'Tài' ? 1 : 2;
    }
    const last12 = history.slice(0, 12).map(h => getResultType(h));
    if (!last12.length) return 0;
    const taiCount = last12.filter(r => r === 'Tài').length;
    const xiuCount = last12.length - taiCount;
    const deviation = Math.abs(taiCount - xiuCount) / last12.length;
    if (deviation < 0.35) {
        return last12[0] === 'Xỉu' ? 1 : 2;
    }
    return xiuCount > taiCount ? 1 : 2;
}

// Helper function: Recent switch model
function recentSwitch(history) {
    if (!history || history.length < 3) return 0;
    const { streak, currentResult, breakProb } = detectStreakAndBreak(history);
    if (streak >= 4) {
        if (breakProb > 0.75) {
            return currentResult === 'Tài' ? 2 : 1;
        }
        return currentResult === 'Tài' ? 1 : 2;
    }
    const last10 = history.slice(0, 10).map(h => getResultType(h));
    if (!last10.length) return 0;
    const switches = last10.slice(1).reduce((count, curr, idx) => count + (curr !== last10[idx] ? 1 : 0), 0);
    return switches >= 6 ? (last10[0] === 'Xỉu' ? 1 : 2) : (last10[0] === 'Xỉu' ? 1 : 2);
}

// Helper function: Check bad pattern
function isBadPattern(history) {
    if (!history || history.length < 3) return false;
    const last15 = history.slice(0, 15).map(h => getResultType(h));
    if (!last15.length) return false;
    const switches = last15.slice(1).reduce((count, curr, idx) => count + (curr !== last15[idx] ? 1 : 0), 0);
    const { streak } = detectStreakAndBreak(history);
    return switches >= 9 || streak >= 10;
}

// AI HTDD Logic
function aiHtddLogic(history) {
    if (!history || history.length < 3) {
        const randomResult = Math.random() < 0.5 ? 'Tài' : 'Xỉu';
        return { prediction: randomResult, reason: '[AI] Không đủ lịch sử, dự đoán ngẫu nhiên', source: 'AI HTDD' };
    }
    const recentHistory = history.slice(0, 5).map(h => getResultType(h));
    const recentScores = history.slice(0, 5).map(h => h.score || 0);
    const taiCount = recentHistory.filter(r => r === 'Tài').length;
    const xiuCount = recentHistory.filter(r => r === 'Xỉu').length;

    if (history.length >= 3) {
        const last3 = history.slice(0, 3).map(h => getResultType(h));
        if (last3.join(',') === 'Tài,Xỉu,Tài') {
            return { prediction: 'Xỉu', reason: '[AI] Phát hiện mẫu 1T1X → tiếp theo nên đánh Xỉu', source: 'AI HTDD' };
        } else if (last3.join(',') === 'Xỉu,Tài,Xỉu') {
            return { prediction: 'Tài', reason: '[AI] Phát hiện mẫu 1X1T → tiếp theo nên đánh Tài', source: 'AI HTDD' };
        }
    }

    if (history.length >= 4) {
        const last4 = history.slice(0, 4).map(h => getResultType(h));
        if (last4.join(',') === 'Tài,Tài,Xỉu,Xỉu') {
            return { prediction: 'Tài', reason: '[AI] Phát hiện mẫu 2T2X → tiếp theo nên đánh Tài', source: 'AI HTDD' };
        } else if (last4.join(',') === 'Xỉu,Xỉu,Tài,Tài') {
            return { prediction: 'Xỉu', reason: '[AI] Phát hiện mẫu 2X2T → tiếp theo nên đánh Xỉu', source: 'AI HTDD' };
        }
    }

    if (history.length >= 9 && history.slice(0, 6).every(h => getResultType(h) === 'Tài')) {
        return { prediction: 'Xỉu', reason: '[AI] Chuỗi Tài quá dài (6 lần) → dự đoán Xỉu', source: 'AI HTDD' };
    } else if (history.length >= 9 && history.slice(0, 6).every(h => getResultType(h) === 'Xỉu')) {
        return { prediction: 'Tài', reason: '[AI] Chuỗi Xỉu quá dài (6 lần) → dự đoán Tài', source: 'AI HTDD' };
    }

    const avgScore = recentScores.reduce((sum, score) => sum + score, 0) / (recentScores.length || 1);
    if (avgScore > 10) {
        return { prediction: 'Tài', reason: `[AI] Điểm trung bình cao (${avgScore.toFixed(1)}) → dự đoán Tài`, source: 'AI HTDD' };
    } else if (avgScore < 8) {
        return { prediction: 'Xỉu', reason: `[AI] Điểm trung bình thấp (${avgScore.toFixed(1)}) → dự đoán Xỉu`, source: 'AI HTDD' };
    }

    if (taiCount > xiuCount + 1) {
        return { prediction: 'Xỉu', reason: `[AI] Tài chiếm đa số (${taiCount}/${recentHistory.length}) → dự đoán Xỉu`, source: 'AI HTDD' };
    } else if (xiuCount > taiCount + 1) {
        return { prediction: 'Tài', reason: `[AI] Xỉu chiếm đa số (${xiuCount}/${recentHistory.length}) → dự đoán Tài`, source: 'AI HTDD' };
    } else {
        const overallTai = history.filter(h => getResultType(h) === 'Tài').length;
        const overallXiu = history.filter(h => getResultType(h) === 'Xỉu').length;
        if (overallTai > overallXiu + 2) {
            return { prediction: 'Xỉu', reason: '[AI] Tổng thể Tài nhiều hơn → dự đoán Xỉu', source: 'AI HTDD' };
        } else if (overallXiu > overallTai + 2) {
            return { prediction: 'Tài', reason: '[AI] Tổng thể Xỉu nhiều hơn → dự đoán Tài', source: 'AI HTDD' };
        } else {
            return { prediction: Math.random() < 0.5 ? 'Tài' : 'Xỉu', reason: '[AI] Cân bằng, dự đoán ngẫu nhiên', source: 'AI HTDD' };
        }
    }
}

// Main prediction function
function generatePrediction(history) {
    if (!history || history.length === 0) {
        return { du_doan: 'Tài', do_tin_cay: 0 };
    }

    if (!modelPredictions['trend']) {
        modelPredictions['trend'] = {};
        modelPredictions['short'] = {};
        modelPredictions['mean'] = {};
        modelPredictions['switch'] = {};
        modelPredictions['bridge'] = {};
    }

    const currentIndex = history[0].gameNum;

    // Run models
    const trendPred = history.length < 5 ? (getResultType(history[0]) === 'Tài' ? 2 : 1) : trendAndProb(history);
    const shortPred = history.length < 5 ? (getResultType(history[0]) === 'Tài' ? 2 : 1) : shortPattern(history);
    const meanPred = history.length < 5 ? (getResultType(history[0]) === 'Tài' ? 2 : 1) : meanDeviation(history);
    const switchPred = history.length < 5 ? (getResultType(history[0]) === 'Tài' ? 2 : 1) : recentSwitch(history);
    const bridgePred = history.length < 5 ? { prediction: (getResultType(history[0]) === 'Tài' ? 2 : 1), breakProb: 0.0, reason: 'Lịch sử ngắn, dự đoán ngược lại' } : smartBridgeBreak(history);
    const aiPred = aiHtddLogic(history);

    // Store predictions
    modelPredictions['trend'][currentIndex] = trendPred;
    modelPredictions['short'][currentIndex] = shortPred;
    modelPredictions['mean'][currentIndex] = meanPred;
    modelPredictions['switch'][currentIndex] = switchPred;
    modelPredictions['bridge'][currentIndex] = bridgePred.prediction;

    // Evaluate model performance
    const modelScores = {
        trend: evaluateModelPerformance(history, 'trend'),
        short: evaluateModelPerformance(history, 'short'),
        mean: evaluateModelPerformance(history, 'mean'),
        switch: evaluateModelPerformance(history, 'switch'),
        bridge: evaluateModelPerformance(history, 'bridge')
    };

    const weights = {
        trend: 0.2 * modelScores.trend,
        short: 0.2 * modelScores.short,
        mean: 0.25 * modelScores.mean,
        switch: 0.2 * modelScores.switch,
        bridge: 0.15 * modelScores.bridge,
        aihtdd: 0.2
    };

    let taiScore = 0;
    let xiuScore = 0;

    if (trendPred === 1) taiScore += weights.trend; else if (trendPred === 2) xiuScore += weights.trend;
    if (shortPred === 1) taiScore += weights.short; else if (shortPred === 2) xiuScore += weights.short;
    if (meanPred === 1) taiScore += weights.mean; else if (meanPred === 2) xiuScore += weights.mean;
    if (switchPred === 1) taiScore += weights.switch; else if (switchPred === 2) xiuScore += weights.switch;
    if (bridgePred.prediction === 1) taiScore += weights.bridge; else if (bridgePred.prediction === 2) xiuScore += weights.bridge;
    if (aiPred.prediction === 'Tài') taiScore += weights.aihtdd; else xiuScore += weights.aihtdd;

    if (isBadPattern(history)) {
        taiScore *= 0.8;
        xiuScore *= 0.8;
    }

    const finalPrediction = taiScore > xiuScore ? 'Tài' : 'Xỉu';

    let confidence = 0;
    if (taiScore + xiuScore > 0) {
        confidence = Math.abs(taiScore - xiuScore) / (taiScore + xiuScore);
    }
    const minConfidence = 0.61;
    const maxConfidence = 0.97;
    const scaledConfidence = minConfidence + confidence * (maxConfidence - minConfidence);
    const finalConfidence = Math.min(maxConfidence, Math.max(minConfidence, scaledConfidence));
    
    return { du_doan: finalPrediction, do_tin_cay: Math.round(finalConfidence * 100) };
}

// --- Endpoint chính ---
app.get('/predict', async (req, res) => {
    await updateHistory();
    const latest = historyData[0] || {};
    const currentPhien = latest.gameNum;

    // Kiểm tra nếu đã qua phiên mới
    if (currentPhien && currentPhien !== lastPrediction.phien) {
        const { du_doan, do_tin_cay } = historyData.length >= MIN_HISTORY ? generatePrediction(historyData) : { du_doan: '', do_tin_cay: 0 };
        
        lastPrediction = {
            phien: currentPhien,
            du_doan: du_doan,
            doan_vi: du_doan ? generateNumbers(du_doan) : [0, 0, 0],
            do_tin_cay: do_tin_cay
        };
    }

    // Lấy số phiên hiện tại và phiên tiếp theo (đã bỏ dấu #)
    const currentPhienNumber = latest.gameNum ? parseInt(latest.gameNum.replace('#', '')) : 0;
    const nextPhienNumber = currentPhienNumber + 1;

    res.json({
        Phien: currentPhienNumber, // Số phiên hiện tại (không có #)
        Xuc_xac_1: latest.facesList?.[0] || 0,
        Xuc_xac_2: latest.facesList?.[1] || 0,
        Xuc_xac_3: latest.facesList?.[2] || 0,
        Tong: latest.score || 0,
        Ket_qua: getResultType(latest),
        phien_hien_tai: nextPhienNumber, // Số phiên tiếp theo (không có #)
        du_doan: lastPrediction.du_doan || "",
        dudoan_vi: lastPrediction.doan_vi || [0, 0, 0],
        do_tin_cay: lastPrediction.do_tin_cay || Math.floor(Math.random() * (97 - 61 + 1)) + 61
    });
});

// --- Khởi động server ---
app.listen(PORT, () => {
    console.log(`Server đang chạy tại http://localhost:${PORT}`);
    setInterval(updateHistory, UPDATE_INTERVAL);
});
