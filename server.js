const express = require('express');
const cors = require('cors');
const { neon } = require('@neondatabase/serverless');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// --- CONFIGURAÇÃO ---
const sql = neon(process.env.DATABASE_URL);
const JWT_SECRET = process.env.JWT_SECRET || 'seu-segredo-super-secreto';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
const PUSHINPAY_SPLIT_ACCOUNT_ID = process.env.PUSHINPAY_SPLIT_ACCOUNT_ID;
const CNPAY_SPLIT_PRODUCER_ID = process.env.CNPAY_SPLIT_PRODUCER_ID;
const OASYFY_SPLIT_PRODUCER_ID = process.env.OASYFY_SPLIT_PRODUCER_ID;

// --- MIDDLEWARES ---
async function authenticateJwt(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'Token não fornecido.' });
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ message: 'Token inválido ou expirado.' });
        req.user = user;
        next();
    });
}

function authenticateAdmin(req, res, next) {
    const adminKey = req.headers['x-admin-api-key'];
    if (!adminKey || adminKey !== ADMIN_API_KEY) {
        return res.status(403).json({ message: 'Acesso negado. Chave de administrador inválida.' });
    }
    next();
}

// --- ROTAS DE AUTENTICAÇÃO ---
app.post('/api/sellers/register', async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password || password.length < 8) return res.status(400).json({ message: 'Dados inválidos.' });
    try {
        const existingSeller = await sql`SELECT id FROM sellers WHERE email = ${email}`;
        if (existingSeller.length > 0) return res.status(409).json({ message: 'Este email já está em uso.' });
        const hashedPassword = await bcrypt.hash(password, 10);
        const apiKey = uuidv4();
        await sql`INSERT INTO sellers (name, email, password_hash, api_key) VALUES (${name}, ${email}, ${hashedPassword}, ${apiKey})`;
        res.status(201).json({ message: 'Vendedor cadastrado com sucesso!' });
    } catch (error) { res.status(500).json({ message: 'Erro interno do servidor.' }); }
});

app.post('/api/sellers/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Email e senha são obrigatórios.' });
    try {
        const sellerResult = await sql`SELECT * FROM sellers WHERE email = ${email}`;
        if (sellerResult.length === 0) return res.status(404).json({ message: 'Usuário não encontrado.' });
        const seller = sellerResult[0];

        if (seller.is_active === false) {
            return res.status(403).json({ message: 'Este usuário está bloqueado.' });
        }
        
        const isPasswordCorrect = await bcrypt.compare(password, seller.password_hash);
        if (!isPasswordCorrect) return res.status(401).json({ message: 'Senha incorreta.' });
        
        const tokenPayload = { id: seller.id, email: seller.email };
        const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '1d' });
        const { password_hash, ...sellerData } = seller;
        res.status(200).json({ message: 'Login bem-sucedido!', token, seller: sellerData });
    } catch (error) {
        console.error("Erro no login:", error);
        res.status(500).json({ message: 'Erro interno do servidor.' }); 
    }
});

// --- ROTA DE DADOS DO PAINEL DO USUÁRIO ---
app.get('/api/dashboard/data', authenticateJwt, async (req, res) => {
    try {
        const sellerId = req.user.id;
        const settingsPromise = sql`SELECT api_key, pushinpay_token, cnpay_public_key, cnpay_secret_key, oasyfy_public_key, oasyfy_secret_key, active_pix_provider FROM sellers WHERE id = ${sellerId}`;
        const pixelsPromise = sql`SELECT * FROM pixel_configurations WHERE seller_id = ${sellerId} ORDER BY created_at DESC`;
        const presselsPromise = sql`
            SELECT p.*, COALESCE(px.pixel_ids, ARRAY[]::integer[]) as pixel_ids
            FROM pressels p
            LEFT JOIN ( SELECT pressel_id, array_agg(pixel_config_id) as pixel_ids FROM pressel_pixels GROUP BY pressel_id ) px ON p.id = px.pressel_id
            WHERE p.seller_id = ${sellerId} ORDER BY p.created_at DESC`;
        const botsPromise = sql`SELECT * FROM telegram_bots WHERE seller_id = ${sellerId} ORDER BY created_at DESC`;
        const [settingsResult, pixels, pressels, bots] = await Promise.all([settingsPromise, pixelsPromise, presselsPromise, botsPromise]);
        const settings = settingsResult[0] || { api_key: null, pushinpay_token: null, cnpay_public_key: null, cnpay_secret_key: null, oasyfy_public_key: null, oasyfy_secret_key: null, active_pix_provider: 'pushinpay' };
        res.json({ settings, pixels, pressels, bots });
    } catch (error) { res.status(500).json({ message: 'Erro ao buscar dados.' }); }
});

// --- ROTAS DE GERENCIAMENTO (CRUD) DO USUÁRIO ---
app.post('/api/pixels', authenticateJwt, async (req, res) => {
    const { account_name, pixel_id, meta_api_token } = req.body;
    if (!account_name || !pixel_id || !meta_api_token) return res.status(400).json({ message: 'Todos os campos são obrigatórios.' });
    try {
        const newPixel = await sql`INSERT INTO pixel_configurations (seller_id, account_name, pixel_id, meta_api_token) VALUES (${req.user.id}, ${account_name}, ${pixel_id}, ${meta_api_token}) RETURNING *;`;
        res.status(201).json(newPixel[0]);
    } catch (error) {
        if (error.code === '23505') { return res.status(409).json({ message: 'Este ID de Pixel já foi cadastrado.' }); }
        res.status(500).json({ message: 'Erro ao salvar o pixel.' });
    }
});
app.delete('/api/pixels/:id', authenticateJwt, async (req, res) => {
    try { await sql`DELETE FROM pixel_configurations WHERE id = ${req.params.id} AND seller_id = ${req.user.id}`; res.status(204).send(); } catch (error) { res.status(500).json({ message: 'Erro ao excluir o pixel.' }); }
});
app.post('/api/bots', authenticateJwt, async (req, res) => {
    const { bot_name, bot_token } = req.body;
    if(!bot_name || !bot_token) return res.status(400).json({ message: 'Nome e token são obrigatórios.' });
    try {
        const newBot = await sql`INSERT INTO telegram_bots (seller_id, bot_name, bot_token) VALUES (${req.user.id}, ${bot_name}, ${bot_token}) RETURNING *;`;
        res.status(201).json(newBot[0]);
    } catch (error) {
        if (error.code === '23505') { return res.status(409).json({ message: 'Um bot com este nome já existe.' });}
        res.status(500).json({ message: 'Erro ao salvar o bot.' });
    }
});
app.delete('/api/bots/:id', authenticateJwt, async (req, res) => {
    try { await sql`DELETE FROM telegram_bots WHERE id = ${req.params.id} AND seller_id = ${req.user.id}`; res.status(204).send(); } catch (error) { res.status(500).json({ message: 'Erro ao excluir o bot.' }); }
});
app.post('/api/pressels', authenticateJwt, async (req, res) => {
    const { name, bot_id, white_page_url, pixel_ids } = req.body;
    if (!name || !bot_id || !white_page_url || !Array.isArray(pixel_ids) || pixel_ids.length === 0) return res.status(400).json({ message: 'Todos os campos são obrigatórios.' });
    try {
        const numeric_bot_id = parseInt(bot_id, 10); const numeric_pixel_ids = pixel_ids.map(id => parseInt(id, 10));
        const botResult = await sql`SELECT bot_name FROM telegram_bots WHERE id = ${numeric_bot_id} AND seller_id = ${req.user.id}`;
        if (botResult.length === 0) return res.status(404).json({ message: 'Bot não encontrado.' });
        const bot_name = botResult[0].bot_name;
        await sql`BEGIN`;
        try {
            const [newPressel] = await sql`INSERT INTO pressels (seller_id, name, bot_id, bot_name, white_page_url) VALUES (${req.user.id}, ${name}, ${numeric_bot_id}, ${bot_name}, ${white_page_url}) RETURNING *;`;
            for (const pixelId of numeric_pixel_ids) { await sql`INSERT INTO pressel_pixels (pressel_id, pixel_config_id) VALUES (${newPressel.id}, ${pixelId})` }
            await sql`COMMIT`;
            res.status(201).json({ ...newPressel, pixel_ids: numeric_pixel_ids });
        } catch (transactionError) { await sql`ROLLBACK`; throw transactionError; }
    } catch (error) { res.status(500).json({ message: 'Erro ao salvar a pressel.' }); }
});
app.delete('/api/pressels/:id', authenticateJwt, async (req, res) => {
    try { await sql`DELETE FROM pressels WHERE id = ${req.params.id} AND seller_id = ${req.user.id}`; res.status(204).send(); } catch (error) { res.status(500).json({ message: 'Erro ao excluir a pressel.' }); }
});
app.post('/api/settings/pix', authenticateJwt, async (req, res) => {
    const { active_pix_provider, pushinpay_token, cnpay_public_key, cnpay_secret_key, oasyfy_public_key, oasyfy_secret_key } = req.body;
    try {
        await sql`UPDATE sellers SET active_pix_provider = ${active_pix_provider}, pushinpay_token = ${pushinpay_token || null}, cnpay_public_key = ${cnpay_public_key || null}, cnpay_secret_key = ${cnpay_secret_key || null}, oasyfy_public_key = ${oasyfy_public_key || null}, oasyfy_secret_key = ${oasyfy_secret_key || null} WHERE id = ${req.user.id}`;
        res.status(200).json({ message: 'Configurações de PIX salvas com sucesso.' });
    } catch (error) { res.status(500).json({ message: 'Erro ao salvar as configurações.' }); }
});

// --- ROTA DE RASTREAMENTO E CONSULTAS DO USUÁRIO ---
app.post('/api/registerClick', async (req, res) => {
    const { sellerApiKey, presselId, referer, fbclid, fbp, fbc, user_agent } = req.body;
    if (!sellerApiKey || !presselId) return res.status(400).json({ message: 'Dados insuficientes.' });
    const ip_address = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
    let city = 'Desconhecida', state = 'Desconhecido';
    try {
        if (ip_address && ip_address !== '::1' && !ip_address.startsWith('192.168.')) {
            const geo = await axios.get(`http://ip-api.com/json/${ip_address}?fields=city,regionName`);
            city = geo.data.city || city; state = geo.data.regionName || state;
        }
    } catch (e) { console.error("Erro ao buscar geolocalização"); }
    try {
        const result = await sql`INSERT INTO clicks (seller_id, pressel_id, ip_address, user_agent, referer, city, state, fbclid, fbp, fbc) SELECT s.id, ${presselId}, ${ip_address}, ${user_agent}, ${referer}, ${city}, ${state}, ${fbclid}, ${fbp}, ${fbc} FROM sellers s WHERE s.api_key = ${sellerApiKey} RETURNING id;`;
        if (result.length === 0) return res.status(404).json({ message: 'API Key ou Pressel inválida.' });
        const click_record_id = result[0].id;
        const clean_click_id = `lead${click_record_id.toString().padStart(6, '0')}`;
        const db_click_id = `/start ${clean_click_id}`;
        await sql`UPDATE clicks SET click_id = ${db_click_id} WHERE id = ${click_record_id}`;
        res.status(200).json({ status: 'success', click_id: clean_click_id });
    } catch (error) { res.status(500).json({ message: 'Erro interno do servidor.' }); }
});
app.post('/api/click/info', async (req, res) => {
    const apiKey = req.headers['x-api-key']; const { click_id } = req.body;
    if (!apiKey || !click_id) return res.status(400).json({ message: 'API Key e click_id são obrigatórios.' });
    try {
        const sellerResult = await sql`SELECT id FROM sellers WHERE api_key = ${apiKey}`;
        if (sellerResult.length === 0) return res.status(401).json({ message: 'API Key inválida.' });
        const seller_id = sellerResult[0].id;
        const clickResult = await sql`SELECT city, state FROM clicks WHERE click_id = ${click_id} AND seller_id = ${seller_id}`;
        if (clickResult.length === 0) return res.status(404).json({ message: 'Click ID não encontrado para este vendedor.' });
        const clickInfo = clickResult[0];
        res.status(200).json({ status: 'success', city: clickInfo.city, state: clickInfo.state });
    } catch (error) { res.status(500).json({ message: 'Erro interno ao consultar informações do clique.' }); }
});

// --- ROTA DE DASHBOARD E TRANSAÇÕES DO USUÁRIO ---
app.get('/api/dashboard/metrics', authenticateJwt, async (req, res) => {
    try {
        const sellerId = req.user.id;
        const totalClicksResult = await sql`SELECT COUNT(*) FROM clicks WHERE seller_id = ${sellerId}`;
        const totalClicks = totalClicksResult[0].count;
        const totalPixGeneratedResult = await sql`
            SELECT COUNT(pt.id) AS total_pix_generated, COALESCE(SUM(pt.pix_value), 0) AS total_revenue
            FROM pix_transactions pt JOIN clicks c ON pt.click_id_internal = c.id
            WHERE c.seller_id = ${sellerId}`;
        const totalPixGenerated = totalPixGeneratedResult[0].total_pix_generated;
        const totalRevenue = totalPixGeneratedResult[0].total_revenue;
        const totalPixPaidResult = await sql`
            SELECT COUNT(pt.id) AS total_pix_paid, COALESCE(SUM(pt.pix_value), 0) AS paid_revenue
            FROM pix_transactions pt JOIN clicks c ON pt.click_id_internal = c.id
            WHERE c.seller_id = ${sellerId} AND pt.status = 'paid'`;
        const totalPixPaid = totalPixPaidResult[0].total_pix_paid;
        const paidRevenue = totalPixPaidResult[0].paid_revenue;
        const conversionRate = totalClicks > 0 ? ((totalPixPaid / totalClicks) * 100).toFixed(2) : 0;
        res.status(200).json({
            total_clicks: parseInt(totalClicks),
            total_pix_generated: parseInt(totalPixGenerated),
            total_pix_paid: parseInt(totalPixPaid),
            conversion_rate: parseFloat(conversionRate),
            total_revenue: parseFloat(totalRevenue),
            paid_revenue: parseFloat(paidRevenue),
        });
    } catch (error) {
        res.status(500).json({ message: 'Erro ao buscar métricas do dashboard.' });
    }
});
app.get('/api/transactions', authenticateJwt, async (req, res) => {
    try {
        const sellerId = req.user.id;
        const transactions = await sql`
            SELECT pt.status, pt.pix_value, tb.bot_name, pt.provider, pt.created_at
            FROM pix_transactions pt
            JOIN clicks c ON pt.click_id_internal = c.id
            JOIN pressels p ON c.pressel_id = p.id
            JOIN telegram_bots tb ON p.bot_id = tb.id
            WHERE c.seller_id = ${sellerId} ORDER BY pt.created_at DESC;
        `;
        res.status(200).json(transactions);
    } catch (error) {
        res.status(500).json({ message: 'Erro ao buscar dados das transações.' });
    }
});

// --- ROTAS DE GERAÇÃO E CONSULTA DE PIX DO USUÁRIO ---
app.post('/api/pix/generate', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    const { click_id, value_cents } = req.body;
    if (!apiKey || !click_id || !value_cents) return res.status(400).json({ message: 'API Key, click_id e value_cents são obrigatórios.' });

    try {
        const [seller] = await sql`
            SELECT id, is_active, active_pix_provider, pushinpay_token, cnpay_public_key, cnpay_secret_key, oasyfy_public_key, oasyfy_secret_key,
                   commission_percentage, commission_fixed_brl
            FROM sellers WHERE api_key = ${apiKey}
        `;
        if (!seller) return res.status(401).json({ message: 'API Key inválida.' });
        if (seller.is_active === false) return res.status(403).json({ message: 'Usuário bloqueado.' });

        const [click] = await sql`SELECT id FROM clicks WHERE click_id = ${click_id} AND seller_id = ${seller.id}`;
        if (!click) return res.status(404).json({ message: 'Click ID não encontrado.' });
        const click_id_internal = click.id;

        let commission = 0;
        const value_brl = value_cents / 100;
        if (seller.commission_fixed_brl && seller.commission_fixed_brl > 0) {
            commission = seller.commission_fixed_brl;
        } else if (seller.commission_percentage && seller.commission_percentage > 0) {
            commission = parseFloat((value_brl * (seller.commission_percentage / 100)).toFixed(2));
        } else {
            commission = parseFloat((value_brl * 0.0299).toFixed(2));
        }
        
        let pixDataResponse;

        if (seller.active_pix_provider === 'cnpay' || seller.active_pix_provider === 'oasyfy') {
            const isCnpay = seller.active_pix_provider === 'cnpay';
            const publicKey = isCnpay ? seller.cnpay_public_key : seller.oasyfy_public_key;
            const secretKey = isCnpay ? seller.cnpay_secret_key : seller.oasyfy_secret_key;
            const providerName = isCnpay ? 'cnpay' : 'oasyfy';
            if (!publicKey || !secretKey) return res.status(400).json({ message: `Credenciais da ${providerName.toUpperCase()} não configuradas.` });
            
            let splits = [];
            if (apiKey !== ADMIN_API_KEY && commission > 0) {
                const splitId = isCnpay ? CNPAY_SPLIT_PRODUCER_ID : OASYFY_SPLIT_PRODUCER_ID;
                splits.push({ producerId: splitId, amount: commission });
            }
            const payload = {
                identifier: uuidv4(), amount: value_brl,
                client: { name: "Cliente", email: "cliente@email.com", document: "21376710773" },
                splits: splits, callbackUrl: `https://${req.headers.host}/api/webhook/${providerName}`
            };
            const response = await axios.post(isCnpay ? 'https://painel.appcnpay.com/api/v1/gateway/pix/receive' : 'https://app.oasyfy.com/api/v1/gateway/pix/receive', payload, { headers: { 'x-public-key': publicKey, 'x-secret-key': secretKey }});
            const pixData = response.data;
            await sql`INSERT INTO pix_transactions (click_id_internal, pix_value, qr_code_text, qr_code_base64, provider, provider_transaction_id) VALUES (${click_id_internal}, ${value_brl}, ${pixData.pix.code}, ${pixData.pix.base64}, ${providerName}, ${pixData.transactionId})`;
            pixDataResponse = { qr_code_text: pixData.pix.code, qr_code_base64: pixData.pix.base64, transaction_id: pixData.transactionId };

        } else { // Padrão é PushinPay
            if (!seller.pushinpay_token) return res.status(400).json({ message: 'Token da PushinPay não configurado.' });
            let pushinpaySplitRules = [];
            const commission_cents = Math.round(commission * 100);
            if (apiKey !== ADMIN_API_KEY && commission_cents > 0) {
                pushinpaySplitRules.push({ value: commission_cents, account_id: PUSHINPAY_SPLIT_ACCOUNT_ID });
            }
            const payload = { value: value_cents, webhook_url: `https://${req.headers.host}/api/webhook/pushinpay`, split_rules: pushinpaySplitRules };
            const pushinpayResponse = await axios.post('https://api.pushinpay.com.br/api/pix/cashIn', payload, { headers: { Authorization: `Bearer ${seller.pushinpay_token}` } });
            const pixData = pushinpayResponse.data;
            await sql`INSERT INTO pix_transactions (click_id_internal, pix_value, qr_code_text, qr_code_base64, provider, provider_transaction_id) VALUES (${click_id_internal}, ${value_brl}, ${pixData.qr_code}, ${pixData.qr_code_base64}, 'pushinpay', ${pixData.id})`;
            pixDataResponse = { qr_code_text: pixData.qr_code, qr_code_base64: pixData.qr_code_base64, transaction_id: pixData.id };
        }
        res.status(200).json(pixDataResponse);
    } catch (error) {
        console.error("Erro ao gerar PIX:", error.response?.data || error.message);
        res.status(500).json({ message: 'Erro ao gerar cobrança PIX.' });
    }
});

app.post('/api/pix/check-status', async (req, res) => {
    const { click_id } = req.body;
    if (!click_id) return res.status(400).json({ message: 'O click_id é obrigatório.' });
    try {
        const [transaction] = await sql`
            SELECT pt.id, pt.status, pt.pix_value, pt.provider, pt.provider_transaction_id,
                   s.pushinpay_token, s.cnpay_public_key, s.cnpay_secret_key, s.oasyfy_public_key, s.oasyfy_secret_key
            FROM pix_transactions pt JOIN clicks c ON pt.click_id_internal = c.id
            JOIN sellers s ON c.seller_id = s.id
            WHERE c.click_id = ${click_id} ORDER BY pt.created_at DESC LIMIT 1
        `;
        if (!transaction) return res.status(200).json({ status: 'not_found', message: 'Nenhuma cobrança PIX encontrada.' });
        if (transaction.status === 'paid') return res.status(200).json({ status: 'paid', value: transaction.pix_value });

        let providerStatus;
        try {
            if (transaction.provider === 'pushinpay') {
                const response = await axios.get(`https://api.pushinpay.com.br/api/transactions/${transaction.provider_transaction_id}`, { headers: { Authorization: `Bearer ${transaction.pushinpay_token}` } });
                providerStatus = response.data.status;
            } else if (transaction.provider === 'cnpay') {
                const response = await axios.get(`https://painel.appcnpay.com/api/v1/gateway/pix/receive/${transaction.provider_transaction_id}`, { headers: { 'x-public-key': transaction.cnpay_public_key, 'x-secret-key': transaction.cnpay_secret_key } });
                providerStatus = response.data.status;
            } else if (transaction.provider === 'oasyfy') {
                const response = await axios.get(`https://app.oasyfy.com/api/v1/gateway/pix/receive/${transaction.provider_transaction_id}`, { headers: { 'x-public-key': transaction.oasyfy_public_key, 'x-secret-key': transaction.oasyfy_secret_key } });
                providerStatus = response.data.status;
            }
        } catch (error) {
            console.error(`Falha ao consultar o provedor ${transaction.provider} para a transação ${transaction.id}:`, error.message);
            return res.status(200).json({ status: 'pending' });
        }
        
        if (providerStatus === 'paid' || providerStatus === 'COMPLETED') {
            const [updatedTx] = await sql`UPDATE pix_transactions SET status = 'paid', paid_at = NOW() WHERE id = ${transaction.id} AND status != 'paid' RETURNING *`;
            if (updatedTx) {
                const [click] = await sql`SELECT * FROM clicks WHERE click_id = ${click_id}`;
                if(click) await sendConversionToMeta(click, updatedTx);
            }
            return res.status(200).json({ status: 'paid', value: transaction.pix_value });
        }
        return res.status(200).json({ status: 'pending' });
    } catch (error) {
        console.error("Erro ao consultar status do PIX:", error);
        res.status(500).json({ message: 'Erro interno ao consultar status.' });
    }
});

// --- WEBHOOKS E FUNÇÕES AUXILIARES ---
// (Cole aqui as suas funções de webhook e a função sendConversionToMeta)
// ...

// --- FUNÇÃO DE CONSULTA PERIÓDICA ---
// (Cole aqui a sua função checkPendingTransactions e o setInterval)
// ...


// ######################################################################
// ### ROTAS DO PAINEL ADMINISTRATIVO (VERSÃO PROFISSIONAL)           ###
// ######################################################################

const calculateTrend = (current, previous) => {
    if (previous === 0) return current > 0 ? 100.0 : 0.0;
    return parseFloat((((current - previous) / previous) * 100).toFixed(2));
};

app.get('/api/admin/dashboard', authenticateAdmin, async (req, res) => {
    try {
        const days = parseInt(req.query.days || 30);
        const now = new Date();
        const currentStartDate = new Date(now);
        currentStartDate.setDate(now.getDate() - days);
        const previousStartDate = new Date(currentStartDate);
        previousStartDate.setDate(currentStartDate.getDate() - days);
        
        const currentPeriodPromise = sql`
            SELECT COALESCE(SUM(pix_value), 0) as revenue, COUNT(*) as sales
            FROM pix_transactions WHERE status = 'paid' AND created_at >= ${currentStartDate} AND created_at <= ${now}`;
        const previousPeriodPromise = sql`
            SELECT COALESCE(SUM(pix_value), 0) as revenue, COUNT(*) as sales
            FROM pix_transactions WHERE status = 'paid' AND created_at >= ${previousStartDate} AND created_at < ${currentStartDate}`;
        const newSellersCurrentPromise = sql`SELECT COUNT(*) FROM sellers WHERE created_at >= ${currentStartDate} AND created_at <= ${now}`;
        const newSellersPreviousPromise = sql`SELECT COUNT(*) FROM sellers WHERE created_at >= ${previousStartDate} AND created_at < ${currentStartDate}`;
        const chartDataPromise = sql`
            SELECT DATE(created_at) as date, SUM(pix_value) as daily_revenue FROM pix_transactions
            WHERE status = 'paid' AND created_at >= ${currentStartDate} GROUP BY DATE(created_at) ORDER BY DATE(created_at) ASC;`;
        const leaderboardPromise = sql`
            SELECT s.name, COALESCE(SUM(pt.pix_value), 0) AS total_revenue FROM sellers s
            LEFT JOIN clicks c ON s.id = c.seller_id
            LEFT JOIN pix_transactions pt ON c.id = pt.click_id_internal AND pt.status = 'paid'
            GROUP BY s.id, s.name ORDER BY total_revenue DESC LIMIT 5;`;
        
        const [[currentMetrics], [previousMetrics], [newSellersCurrent], [newSellersPrevious], chartData, leaderboard] = await Promise.all([
            currentPeriodPromise, previousPeriodPromise, newSellersCurrentPromise, newSellersPreviousPromise, chartDataPromise, leaderboardPromise
        ]);
        
        const revenue = parseFloat(currentMetrics.revenue);
        const profit = revenue * 0.0299;
        const response = {
            kpis: {
                revenue: { value: revenue, trend: calculateTrend(revenue, parseFloat(previousMetrics.revenue)) },
                profit: { value: profit, trend: calculateTrend(revenue, parseFloat(previousMetrics.revenue)) },
                newSellers: { value: parseInt(newSellersCurrent.count), trend: calculateTrend(parseInt(newSellersCurrent.count), parseInt(newSellersPrevious.count)) },
                sales: { value: parseInt(currentMetrics.sales), trend: calculateTrend(parseInt(currentMetrics.sales), parseInt(previousMetrics.sales)) }
            },
            chart: {
                labels: chartData.map(row => row.date.toISOString().split('T')[0]),
                revenueData: chartData.map(row => parseFloat(row.daily_revenue))
            },
            leaderboard: leaderboard.map(s => ({ name: s.name, revenue: parseFloat(s.total_revenue) }))
        };
        res.json(response);
    } catch (error) {
        console.error("Erro no dashboard admin:", error);
        res.status(500).json({ message: 'Erro ao buscar dados do dashboard.' });
    }
});

app.get('/api/admin/sellers', authenticateAdmin, async (req, res) => {
    try {
        const sellers = await sql`
            SELECT 
                s.id, s.name, s.email, s.created_at, s.is_active,
                s.commission_percentage, s.commission_fixed_brl,
                (SELECT COALESCE(SUM(pt.pix_value), 0) FROM pix_transactions pt JOIN clicks c ON pt.click_id_internal = c.id WHERE c.seller_id = s.id AND pt.status = 'paid') as total_revenue
            FROM sellers s ORDER BY s.created_at DESC;`;
        res.json(sellers.map(s => ({...s, total_revenue: parseFloat(s.total_revenue)})));
    } catch (error) {
        console.error("Erro ao listar vendedores:", error);
        res.status(500).json({ message: 'Erro ao listar vendedores.' });
    }
});

app.put('/api/admin/sellers/:id/commission', authenticateAdmin, async (req, res) => {
    const { id } = req.params;
    const { percentage, fixed } = req.body;
    try {
        await sql`UPDATE sellers SET commission_percentage = ${percentage || null}, commission_fixed_brl = ${fixed || null} WHERE id = ${id};`;
        res.status(200).json({ message: 'Comissão atualizada com sucesso.' });
    } catch (error) { res.status(500).json({ message: 'Erro ao atualizar comissão.' }); }
});

app.post('/api/admin/sellers/:id/toggle-active', authenticateAdmin, async (req, res) => {
    const { id } = req.params;
    const { isActive } = req.body;
    try {
        await sql`UPDATE sellers SET is_active = ${isActive} WHERE id = ${id};`;
        res.status(200).json({ message: `Usuário ${isActive ? 'ativado' : 'bloqueado'} com sucesso.` });
    } catch (error) { res.status(500).json({ message: 'Erro ao alterar status do usuário.' }); }
});

app.put('/api/admin/sellers/:id/password', authenticateAdmin, async (req, res) => {
    const { id } = req.params;
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) return res.status(400).json({ message: 'A nova senha deve ter pelo menos 8 caracteres.' });
    try {
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await sql`UPDATE sellers SET password_hash = ${hashedPassword} WHERE id = ${id};`;
        res.status(200).json({ message: 'Senha alterada com sucesso.' });
    } catch (error) { res.status(500).json({ message: 'Erro ao alterar senha.' }); }
});

// Rota para servir o arquivo HTML do painel admin
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

module.exports = app;
