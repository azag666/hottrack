const express = require('express');
const cors = require('cors');
const { neon } = require('@neondatabase/serverless');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// --- FUNÇÃO PARA OBTER CONEXÃO COM O BANCO ---
function getDbConnection() {
    return neon(process.env.DATABASE_URL);
}

// --- CONFIGURAÇÃO ---
const PUSHINPAY_SPLIT_ACCOUNT_ID = process.env.PUSHINPAY_SPLIT_ACCOUNT_ID;
const CNPAY_SPLIT_PRODUCER_ID = process.env.CNPAY_SPLIT_PRODUCER_ID;
const OASYFY_SPLIT_PRODUCER_ID = process.env.OASYFY_SPLIT_PRODUCER_ID;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

// --- MIDDLEWARE DE AUTENTICAÇÃO (CORRIGIDO) ---
async function authenticateJwt(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'Token não fornecido.' });
    
    // Lendo a variável de ambiente diretamente aqui para evitar cache
    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) {
            console.error("Erro na verificação do JWT:", err.message);
            return res.status(403).json({ message: 'Token inválido ou expirado.' });
        }
        req.user = user;
        next();
    });
}

// --- MIDDLEWARE DE LOG DE REQUISIÇÕES ---
async function logApiRequest(req, res, next) {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) {
        return next();
    }
    
    try {
        const sql = getDbConnection();
        const sellerResult = await sql`SELECT id FROM sellers WHERE api_key = ${apiKey}`;
        
        if (sellerResult.length > 0) {
            const sellerId = sellerResult[0].id;
            const endpoint = req.path;
            sql`INSERT INTO api_requests (seller_id, endpoint) VALUES (${sellerId}, ${endpoint})`.catch(err => console.error("Falha ao logar requisição:", err));
        }
    } catch (error) {
        console.error("Erro no middleware de log:", error);
    }
    
    next();
}

// --- ROTAS DE AUTENTICAÇÃO (CORRIGIDO) ---
app.post('/api/sellers/register', async (req, res) => {
    const sql = getDbConnection();
    const { name, email, password } = req.body;
    if (!name || !email || !password || password.length < 8) return res.status(400).json({ message: 'Dados inválidos.' });
    try {
        const existingSeller = await sql`SELECT id FROM sellers WHERE email = ${email}`;
        if (existingSeller.length > 0) return res.status(409).json({ message: 'Este email já está em uso.' });
        const hashedPassword = await bcrypt.hash(password, 10);
        const apiKey = uuidv4();
        await sql`INSERT INTO sellers (name, email, password_hash, api_key) VALUES (${name}, ${email}, ${hashedPassword}, ${apiKey})`;
        res.status(201).json({ message: 'Vendedor cadastrado com sucesso!' });
    } catch (error) {
        console.error("Erro no registro:", error);
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
});

app.post('/api/sellers/login', async (req, res) => {
    const sql = getDbConnection();
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Email e senha são obrigatórios.' });
    try {
        const sellerResult = await sql`SELECT * FROM sellers WHERE email = ${email}`;
        if (sellerResult.length === 0) return res.status(404).json({ message: 'Usuário não encontrado.' });
        
        const seller = sellerResult[0];
        
        if (!seller.is_active) {
            return res.status(403).json({ message: 'Este usuário está bloqueado.' });
        }
        
        const isPasswordCorrect = await bcrypt.compare(password, seller.password_hash);
        if (!isPasswordCorrect) return res.status(401).json({ message: 'Senha incorreta.' });
        
        const tokenPayload = { id: seller.id, email: seller.email };
        // Lendo a variável de ambiente diretamente aqui para evitar cache
        const token = jwt.sign(tokenPayload, process.env.JWT_SECRET, { expiresIn: '1d' });
        
        const { password_hash, ...sellerData } = seller;
        res.status(200).json({ message: 'Login bem-sucedido!', token, seller: sellerData });

    } catch (error) {
        console.error("ERRO DETALHADO NO LOGIN:", error); 
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
});

// --- ROTA DE DADOS DO PAINEL ---
app.get('/api/dashboard/data', authenticateJwt, async (req, res) => {
    const sql = getDbConnection();
    try {
        const sellerId = req.user.id;
        const settingsPromise = sql`SELECT api_key, pushinpay_token, cnpay_public_key, cnpay_secret_key, oasyfy_public_key, oasyfy_secret_key, active_pix_provider, utmify_api_token FROM sellers WHERE id = ${sellerId}`;
        const pixelsPromise = sql`SELECT * FROM pixel_configurations WHERE seller_id = ${sellerId} ORDER BY created_at DESC`;
        const presselsPromise = sql`
            SELECT p.*, COALESCE(px.pixel_ids, ARRAY[]::integer[]) as pixel_ids
            FROM pressels p
            LEFT JOIN ( SELECT pressel_id, array_agg(pixel_config_id) as pixel_ids FROM pressel_pixels GROUP BY pressel_id ) px ON p.id = px.pressel_id
            WHERE p.seller_id = ${sellerId} ORDER BY p.created_at DESC`;
        const botsPromise = sql`SELECT * FROM telegram_bots WHERE seller_id = ${sellerId} ORDER BY created_at DESC`;
        const [settingsResult, pixels, pressels, bots] = await Promise.all([settingsPromise, pixelsPromise, presselsPromise, botsPromise]);
        const settings = settingsResult[0] || {};
        res.json({ settings, pixels, pressels, bots });
    } catch (error) {
        console.error("Erro ao buscar dados do dashboard:", error);
        res.status(500).json({ message: 'Erro ao buscar dados.' });
    }
});

// --- ROTAS DE GERENCIAMENTO (CRUD) ---
app.post('/api/pixels', authenticateJwt, async (req, res) => {
    const sql = getDbConnection();
    const { account_name, pixel_id, meta_api_token } = req.body;
    if (!account_name || !pixel_id || !meta_api_token) return res.status(400).json({ message: 'Todos os campos são obrigatórios.' });
    try {
        const newPixel = await sql`INSERT INTO pixel_configurations (seller_id, account_name, pixel_id, meta_api_token) VALUES (${req.user.id}, ${account_name}, ${pixel_id}, ${meta_api_token}) RETURNING *;`;
        res.status(201).json(newPixel[0]);
    } catch (error) {
        if (error.code === '23505') { return res.status(409).json({ message: 'Este ID de Pixel já foi cadastrado.' }); }
        console.error("Erro ao salvar pixel:", error);
        res.status(500).json({ message: 'Erro ao salvar o pixel.' });
    }
});

app.delete('/api/pixels/:id', authenticateJwt, async (req, res) => {
    const sql = getDbConnection();
    try {
        await sql`DELETE FROM pixel_configurations WHERE id = ${req.params.id} AND seller_id = ${req.user.id}`;
        res.status(204).send();
    } catch (error) {
        console.error("Erro ao excluir pixel:", error);
        res.status(500).json({ message: 'Erro ao excluir o pixel.' });
    }
});

app.post('/api/bots', authenticateJwt, async (req, res) => {
    const sql = getDbConnection();
    const { bot_name, bot_token } = req.body;
    if (!bot_name || !bot_token) return res.status(400).json({ message: 'Nome e token são obrigatórios.' });
    try {
        const newBot = await sql`INSERT INTO telegram_bots (seller_id, bot_name, bot_token) VALUES (${req.user.id}, ${bot_name}, ${bot_token}) RETURNING *;`;
        res.status(201).json(newBot[0]);
    } catch (error) {
        if (error.code === '23505') { return res.status(409).json({ message: 'Um bot com este nome já existe.' }); }
        console.error("Erro ao salvar bot:", error);
        res.status(500).json({ message: 'Erro ao salvar o bot.' });
    }
});

app.delete('/api/bots/:id', authenticateJwt, async (req, res) => {
    const sql = getDbConnection();
    try {
        await sql`DELETE FROM telegram_bots WHERE id = ${req.params.id} AND seller_id = ${req.user.id}`;
        res.status(204).send();
    } catch (error) {
        console.error("Erro ao excluir bot:", error);
        res.status(500).json({ message: 'Erro ao excluir o bot.' });
    }
});

app.post('/api/pressels', authenticateJwt, async (req, res) => {
    const sql = getDbConnection();
    const { name, bot_id, white_page_url, pixel_ids } = req.body;
    if (!name || !bot_id || !white_page_url || !Array.isArray(pixel_ids) || pixel_ids.length === 0) return res.status(400).json({ message: 'Todos os campos são obrigatórios.' });
    try {
        const numeric_bot_id = parseInt(bot_id, 10);
        const numeric_pixel_ids = pixel_ids.map(id => parseInt(id, 10));
        const botResult = await sql`SELECT bot_name FROM telegram_bots WHERE id = ${numeric_bot_id} AND seller_id = ${req.user.id}`;
        if (botResult.length === 0) return res.status(404).json({ message: 'Bot não encontrado.' });
        const bot_name = botResult[0].bot_name;
        await sql`BEGIN`;
        try {
            const [newPressel] = await sql`INSERT INTO pressels (seller_id, name, bot_id, bot_name, white_page_url) VALUES (${req.user.id}, ${name}, ${numeric_bot_id}, ${bot_name}, ${white_page_url}) RETURNING *;`;
            for (const pixelId of numeric_pixel_ids) {
                await sql`INSERT INTO pressel_pixels (pressel_id, pixel_config_id) VALUES (${newPressel.id}, ${pixelId})`;
            }
            await sql`COMMIT`;
            res.status(201).json({ ...newPressel, pixel_ids: numeric_pixel_ids });
        } catch (transactionError) {
            await sql`ROLLBACK`;
            throw transactionError;
        }
    } catch (error) {
        console.error("Erro ao salvar pressel:", error);
        res.status(500).json({ message: 'Erro ao salvar a pressel.' });
    }
});

app.delete('/api/pressels/:id', authenticateJwt, async (req, res) => {
    const sql = getDbConnection();
    try {
        await sql`DELETE FROM pressels WHERE id = ${req.params.id} AND seller_id = ${req.user.id}`;
        res.status(204).send();
    } catch (error) {
        console.error("Erro ao excluir pressel:", error);
        res.status(500).json({ message: 'Erro ao excluir a pressel.' });
    }
});

// --- ROTAS DE CONFIGURAÇÃO ---
app.post('/api/settings/pix', authenticateJwt, async (req, res) => {
    const sql = getDbConnection();
    const { active_pix_provider, pushinpay_token, cnpay_public_key, cnpay_secret_key, oasyfy_public_key, oasyfy_secret_key } = req.body;
    try {
        await sql`UPDATE sellers SET 
            active_pix_provider = ${active_pix_provider}, 
            pushinpay_token = ${pushinpay_token || null}, 
            cnpay_public_key = ${cnpay_public_key || null}, 
            cnpay_secret_key = ${cnpay_secret_key || null}, 
            oasyfy_public_key = ${oasyfy_public_key || null}, 
            oasyfy_secret_key = ${oasyfy_secret_key || null} 
            WHERE id = ${req.user.id}`;
        res.status(200).json({ message: 'Configurações de PIX salvas com sucesso.' });
    } catch (error) {
        console.error("Erro ao salvar configurações de PIX:", error);
        res.status(500).json({ message: 'Erro ao salvar as configurações.' });
    }
});

app.post('/api/settings/utmify', authenticateJwt, async (req, res) => {
    const sql = getDbConnection();
    const { utmify_api_token } = req.body;
    try {
        await sql`UPDATE sellers SET 
            utmify_api_token = ${utmify_api_token || null}
            WHERE id = ${req.user.id}`;
        res.status(200).json({ message: 'Token da Utmify salvo com sucesso.' });
    } catch (error) {
        console.error("Erro ao salvar token da Utmify:", error);
        res.status(500).json({ message: 'Erro ao salvar as configurações.' });
    }
});

// --- ROTA DE RASTREAMENTO E CONSULTAS ---
app.post('/api/registerClick', logApiRequest, async (req, res) => {
    const sql = getDbConnection();
    const { sellerApiKey, presselId, referer, fbclid, fbp, fbc, user_agent, utm_source, utm_campaign, utm_medium, utm_content, utm_term } = req.body;
    
    if (!sellerApiKey || !presselId) return res.status(400).json({ message: 'Dados insuficientes.' });
    
    const ip_address = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
    let city = 'Desconhecida', state = 'Desconhecido';
    try {
        if (ip_address && ip_address !== '::1' && !ip_address.startsWith('192.168.')) {
            const geo = await axios.get(`http://ip-api.com/json/${ip_address}?fields=city,regionName`);
            city = geo.data.city || city;
            state = geo.data.regionName || state;
        }
    } catch (e) { console.error("Erro ao buscar geolocalização:", e.message); }
    
    try {
        const result = await sql`INSERT INTO clicks (
            seller_id, pressel_id, ip_address, user_agent, referer, city, state, fbclid, fbp, fbc,
            utm_source, utm_campaign, utm_medium, utm_content, utm_term
        ) 
        SELECT
            s.id, ${presselId}, ${ip_address}, ${user_agent}, ${referer}, ${city}, ${state}, ${fbclid}, ${fbp}, ${fbc},
            ${utm_source || null}, ${utm_campaign || null}, ${utm_medium || null}, ${utm_content || null}, ${utm_term || null}
        FROM sellers s WHERE s.api_key = ${sellerApiKey} RETURNING id;`;
        
        if (result.length === 0) return res.status(404).json({ message: 'API Key ou Pressel inválida.' });
        
        const click_record_id = result[0].id;
        const clean_click_id = `lead${click_record_id.toString().padStart(6, '0')}`;
        const db_click_id = `/start ${clean_click_id}`;
        await sql`UPDATE clicks SET click_id = ${db_click_id} WHERE id = ${click_record_id}`;
        
        res.status(200).json({ status: 'success', click_id: clean_click_id });
    } catch (error) {
        console.error("Erro ao registrar clique:", error);
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
});

app.post('/api/click/info', async (req, res) => {
    const sql = getDbConnection();
    const apiKey = req.headers['x-api-key'];
    const { click_id } = req.body;
    if (!apiKey || !click_id) return res.status(400).json({ message: 'API Key e click_id são obrigatórios.' });
    try {
        const sellerResult = await sql`SELECT id FROM sellers WHERE api_key = ${apiKey}`;
        if (sellerResult.length === 0) return res.status(401).json({ message: 'API Key inválida.' });
        const seller_id = sellerResult[0].id;
        const clickResult = await sql`SELECT city, state FROM clicks WHERE click_id = ${click_id} AND seller_id = ${seller_id}`;
        if (clickResult.length === 0) return res.status(404).json({ message: 'Click ID não encontrado para este vendedor.' });
        const clickInfo = clickResult[0];
        res.status(200).json({ status: 'success', city: clickInfo.city, state: clickInfo.state });
    } catch (error) {
        console.error("Erro ao consultar informações do clique:", error);
        res.status(500).json({ message: 'Erro interno ao consultar informações do clique.' });
    }
});

// --- ROTAS DE DASHBOARD E TRANSAÇÕES ---
app.get('/api/dashboard/metrics', authenticateJwt, async (req, res) => {
    const sql = getDbConnection();
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
        const botsPerformance = await sql`
            SELECT
                tb.bot_name, COUNT(c.id) AS total_clicks,
                COUNT(pt.id) FILTER (WHERE pt.status = 'paid') AS total_pix_paid,
                COALESCE(SUM(pt.pix_value) FILTER (WHERE pt.status = 'paid'), 0) AS paid_revenue
            FROM telegram_bots tb
            LEFT JOIN pressels p ON p.bot_id = tb.id
            LEFT JOIN clicks c ON c.pressel_id = p.id
            LEFT JOIN pix_transactions pt ON pt.click_id_internal = c.id
            WHERE tb.seller_id = ${sellerId}
            GROUP BY tb.bot_name ORDER BY paid_revenue DESC, total_clicks DESC`;
        const clicksByState = await sql`
            SELECT c.state, COUNT(c.id) AS total_clicks
            FROM clicks c WHERE c.seller_id = ${sellerId} AND c.state IS NOT NULL
            GROUP BY c.state ORDER BY total_clicks DESC LIMIT 10`;
        res.status(200).json({
            total_clicks: parseInt(totalClicks),
            total_pix_generated: parseInt(totalPixGenerated),
            total_pix_paid: parseInt(totalPixPaid),
            conversion_rate: parseFloat(conversionRate),
            total_revenue: parseFloat(totalRevenue),
            paid_revenue: parseFloat(paidRevenue),
            bots_performance: botsPerformance.map(b => ({ ...b, total_clicks: parseInt(b.total_clicks), total_pix_paid: parseInt(b.total_pix_paid), paid_revenue: parseFloat(b.paid_revenue) })),
            clicks_by_state: clicksByState.map(s => ({ ...s, total_clicks: parseInt(s.total_clicks) }))
        });
    } catch (error) {
        console.error("Erro ao buscar métricas do dashboard:", error);
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
});

app.get('/api/transactions', authenticateJwt, async (req, res) => {
    const sql = getDbConnection();
    try {
        const sellerId = req.user.id;
        const transactions = await sql`
            SELECT pt.status, pt.pix_value, tb.bot_name, pt.provider, pt.created_at
            FROM pix_transactions pt
            JOIN clicks c ON pt.click_id_internal = c.id
            JOIN pressels p ON c.pressel_id = p.id
            JOIN telegram_bots tb ON p.bot_id = tb.id
            WHERE c.seller_id = ${sellerId}
            ORDER BY pt.created_at DESC;`;
        res.status(200).json(transactions);
    } catch (error) {
        console.error("Erro ao buscar transações:", error);
        res.status(500).json({ message: 'Erro ao buscar dados das transações.' });
    }
});

// --- ROTAS DE GERAÇÃO E CONSULTA DE PIX ---
app.post('/api/pix/generate', logApiRequest, async (req, res) => {
    const sql = getDbConnection();
    const apiKey = req.headers['x-api-key'];
    const { click_id, value_cents, customer, product } = req.body;
    
    if (!apiKey || !click_id || !value_cents) return res.status(400).json({ message: 'API Key, click_id e value_cents são obrigatórios.' });

    let seller;

    try {
        [seller] = await sql`SELECT * FROM sellers WHERE api_key = ${apiKey}`;
        if (!seller) return res.status(401).json({ message: 'API Key inválida.' });

        const [click] = await sql`SELECT * FROM clicks WHERE click_id = ${click_id} AND seller_id = ${seller.id}`;
        if (!click) return res.status(404).json({ message: 'Click ID não encontrado.' });
        const click_id_internal = click.id;

        let pixData;
        
        if (seller.active_pix_provider === 'cnpay' || seller.active_pix_provider === 'oasyfy') {
            const isCnpay = seller.active_pix_provider === 'cnpay';
            const publicKey = isCnpay ? seller.cnpay_public_key : seller.oasyfy_public_key;
            const secretKey = isCnpay ? seller.cnpay_secret_key : seller.oasyfy_secret_key;
            const splitId = isCnpay ? CNPAY_SPLIT_PRODUCER_ID : OASYFY_SPLIT_PRODUCER_ID;
            const apiUrl = isCnpay ? 'https://painel.appcnpay.com/api/v1/gateway/pix/receive' : 'https://app.oasyfy.com/api/v1/gateway/pix/receive';
            const providerName = isCnpay ? 'cnpay' : 'oasyfy';

            if (!publicKey || !secretKey) return res.status(400).json({ message: `Credenciais da ${providerName.toUpperCase()} não configuradas.` });
            
            const commission = parseFloat(((value_cents / 100) * 0.0299).toFixed(2));
            let splits = [];

            if (apiKey !== ADMIN_API_KEY && commission > 0) {
                splits.push({ producerId: splitId, amount: commission });
            }

            const payload = {
                identifier: uuidv4(),
                amount: value_cents / 100,
                client: { 
                    name: customer?.name || "Cliente", email: customer?.email || "cliente@email.com", 
                    document: customer?.document || "21376710773", phone: customer?.phone || "(27) 99531-0370"
                },
                splits: splits,
                callbackUrl: `https://${req.headers.host}/api/webhook/${providerName}`
            };
            
            const response = await axios.post(apiUrl, payload, { headers: { 'x-public-key': publicKey, 'x-secret-key': secretKey } });
            pixData = response.data;
            await sql`INSERT INTO pix_transactions (click_id_internal, pix_value, qr_code_text, qr_code_base64, provider, provider_transaction_id) VALUES (${click_id_internal}, ${value_cents / 100}, ${pixData.pix.code}, ${pixData.pix.base64}, ${providerName}, ${pixData.transactionId})`;

        } else { // Padrão é PushinPay
            if (!seller.pushinpay_token) return res.status(400).json({ message: 'Token da PushinPay não configurado.' });
            
            let pushinpaySplitRules = [];
            const commission_cents = Math.floor(value_cents * 0.0299);
            if (apiKey !== ADMIN_API_KEY && commission_cents > 0) {
                pushinpaySplitRules.push({ value: commission_cents, account_id: PUSHINPAY_SPLIT_ACCOUNT_ID });
            }
            const payload = {
                value: value_cents,
                webhook_url: `https://${req.headers.host}/api/webhook/pushinpay`,
                split_rules: pushinpaySplitRules
            };
            const pushinpayResponse = await axios.post('https://api.pushinpay.com.br/api/pix/cashIn', payload, { headers: { Authorization: `Bearer ${seller.pushinpay_token}` } });
            pixData = pushinpayResponse.data;
            await sql`INSERT INTO pix_transactions (click_id_internal, pix_id, pix_value, qr_code_text, qr_code_base64, provider, provider_transaction_id) VALUES (${click_id_internal}, ${pixData.id}, ${value_cents / 100}, ${pixData.qr_code}, ${pixData.qr_code_base64}, 'pushinpay', ${pixData.id})`;
        }
        
        const customerDataForUtmify = customer || { name: "Cliente Interessado", email: "cliente@email.com" };
        const productDataForUtmify = product || { id: "prod_1", name: "Produto Ofertado" };
        const pixTransactionData = {
            provider_transaction_id: pixData.id || pixData.transactionId,
            pix_value: value_cents / 100,
            created_at: new Date()
        };
        await sendEventToUtmify('waiting_payment', click, pixTransactionData, seller, customerDataForUtmify, productDataForUtmify);
        
        res.status(200).json({ 
            qr_code_text: pixData.qr_code || pixData.pix.code, 
            qr_code_base64: pixData.qr_code_base64 || pixData.pix.base64,
            transaction_id: pixData.id || pixData.transactionId
        });
        
    } catch (error) {
        console.error(
            `[PIX GENERATE ERROR] Seller ID: ${seller?.id}, Email: ${seller?.email} - Erro:`, 
            error.response?.data || error.message
        );
        res.status(500).json({ message: 'Erro ao gerar cobrança PIX.' });
    }
});

app.post('/api/pix/check-status', async (req, res) => {
    const sql = getDbConnection();
    const { click_id } = req.body;
    if (!click_id) return res.status(400).json({ message: 'O click_id é obrigatório.' });

    try {
        const [transaction] = await sql`
            SELECT pt.*, s.pushinpay_token, s.cnpay_public_key, s.cnpay_secret_key, s.oasyfy_public_key, s.oasyfy_secret_key
            FROM pix_transactions pt JOIN clicks c ON pt.click_id_internal = c.id
            JOIN sellers s ON c.seller_id = s.id WHERE c.click_id = ${click_id}
            ORDER BY pt.created_at DESC LIMIT 1`;

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
                await handleSuccessfulPayment(updatedTx.click_id_internal);
            }
            return res.status(200).json({ status: 'paid', value: transaction.pix_value });
        }
        return res.status(200).json({ status: 'pending' });

    } catch (error) {
        console.error("Erro ao consultar status do PIX:", error);
        res.status(500).json({ message: 'Erro interno ao consultar status.' });
    }
});

app.post('/api/pix/test-generate', authenticateJwt, async (req, res) => {
    const sql = getDbConnection();
    const sellerId = req.user.id;

    try {
        const [seller] = await sql`SELECT * FROM sellers WHERE id = ${sellerId}`;
        if (!seller) return res.status(404).json({ message: 'Vendedor não encontrado.' });

        const provider = seller.active_pix_provider || 'pushinpay';
        const value_cents = 1; 
        let pixData;

        console.log(`Iniciando teste de PIX para o vendedor ${seller.id} com o provedor ${provider}`);

        if (provider === 'cnpay' || provider === 'oasyfy') {
            const isCnpay = provider === 'cnpay';
            const publicKey = isCnpay ? seller.cnpay_public_key : seller.oasyfy_public_key;
            const secretKey = isCnpay ? seller.cnpay_secret_key : seller.oasyfy_secret_key;
            if (!publicKey || !secretKey) return res.status(400).json({ message: `Credenciais para ${provider.toUpperCase()} não configuradas.` });

            const apiUrl = isCnpay ? 'https://painel.appcnpay.com/api/v1/gateway/pix/receive' : 'https://app.oasyfy.com/api/v1/gateway/pix/receive';
            const payload = {
                identifier: `test-${uuidv4()}`,
                amount: value_cents / 100,
                client: { name: "Teste HotTrack", email: "teste@hottrack.com", document: "11111111111", phone: "(11) 99999-9999" },
            };
            const response = await axios.post(apiUrl, payload, { headers: { 'x-public-key': publicKey, 'x-secret-key': secretKey } });
            pixData = response.data;
        } else { // Padrão é PushinPay
            if (!seller.pushinpay_token) return res.status(400).json({ message: 'Token da PushinPay não configurado.' });
            
            const payload = { value: value_cents, webhook_url: `https://${req.headers.host}/api/webhook/pushinpay` };
            const pushinpayResponse = await axios.post('https://api.pushinpay.com.br/api/pix/cashIn', payload, { headers: { Authorization: `Bearer ${seller.pushinpay_token}` } });
            pixData = pushinpayResponse.data;
        }

        res.status(200).json({
            provider: provider.toUpperCase(),
            qr_code_base64: pixData.qr_code_base64 || pixData.pix.base64
        });

    } catch (error) {
        console.error(`[PIX TEST ERROR] Seller ID: ${sellerId} - Erro:`, error.response?.data || error.message);
        res.status(500).json({ message: 'Falha ao gerar PIX de teste. Verifique suas credenciais.', details: error.response?.data || error.message });
    }
});

// --- FUNÇÃO PARA CENTRALIZAR EVENTOS DE CONVERSÃO ---
async function handleSuccessfulPayment(click_id_internal) {
    const sql = getDbConnection();
    try {
        const [transaction] = await sql`SELECT * FROM pix_transactions WHERE click_id_internal = ${click_id_internal} AND status = 'paid' ORDER BY paid_at DESC LIMIT 1`;
        if (!transaction) return;

        const [click] = await sql`SELECT * FROM clicks WHERE id = ${transaction.click_id_internal}`;
        const [seller] = await sql`SELECT * FROM sellers WHERE id = ${click.seller_id}`;

        if (click && seller) {
            const customerData = { name: "Cliente Pagante", email: "cliente@email.com", phone: "11912345678", document: "12345678900" };
            const productData = { id: "prod_final", name: "Produto Vendido" };

            await sendEventToUtmify('paid', click, transaction, seller, customerData, productData);
            await sendConversionToMeta(click, transaction);
        }
    } catch(error) {
        console.error("Erro ao lidar com pagamento bem-sucedido:", error);
    }
}

// --- WEBHOOKS ---
app.post('/api/webhook/pushinpay', async (req, res) => {
    const { id, status } = req.body;
    if (status === 'paid') {
        try {
            const sql = getDbConnection();
            const [updatedTx] = await sql`UPDATE pix_transactions SET status = 'paid', paid_at = NOW() WHERE provider_transaction_id = ${id} AND provider = 'pushinpay' AND status != 'paid' RETURNING *`;
            if (updatedTx) {
                await handleSuccessfulPayment(updatedTx.click_id_internal);
            }
        } catch (error) { console.error("Erro no webhook da PushinPay:", error); }
    }
    res.sendStatus(200);
});
app.post('/api/webhook/cnpay', async (req, res) => {
    const { transactionId, status } = req.body;
    if (status === 'COMPLETED') {
        try {
            const sql = getDbConnection();
            const [updatedTx] = await sql`UPDATE pix_transactions SET status = 'paid', paid_at = NOW() WHERE provider_transaction_id = ${transactionId} AND provider = 'cnpay' AND status != 'paid' RETURNING *`;
            if (updatedTx) {
                await handleSuccessfulPayment(updatedTx.click_id_internal);
            }
        } catch (error) { console.error("Erro no webhook da CNPay:", error); }
    }
    res.sendStatus(200);
});
app.post('/api/webhook/oasyfy', async (req, res) => {
    const { transactionId, status } = req.body;
    if (status === 'COMPLETED') {
        try {
            const sql = getDbConnection();
            const [updatedTx] = await sql`UPDATE pix_transactions SET status = 'paid', paid_at = NOW() WHERE provider_transaction_id = ${transactionId} AND provider = 'oasyfy' AND status != 'paid' RETURNING *`;
            if (updatedTx) {
                await handleSuccessfulPayment(updatedTx.click_id_internal);
            }
        } catch (error) { console.error("Erro no webhook da Oasy.fy:", error); }
    }
    res.sendStatus(200);
});

// --- FUNÇÃO DE ENVIO PARA UTIFY ---
async function sendEventToUtmify(status, clickData, pixData, sellerData, customerData, productData) {
    if (!sellerData.utmify_api_token) {
        console.log(`Vendedor ${sellerData.id} não possui token da Utmify configurado.`);
        return;
    }
    const createdAt = (pixData.created_at || new Date()).toISOString().replace('T', ' ').substring(0, 19);
    const approvedDate = status === 'paid' ? (pixData.paid_at || new Date()).toISOString().replace('T', ' ').substring(0, 19) : null;
    const payload = {
        orderId: pixData.provider_transaction_id, platform: "HotTrack", paymentMethod: 'pix',
        status: status, createdAt: createdAt, approvedDate: approvedDate, refundedAt: null,
        customer: {
            name: customerData?.name || "Não informado", email: customerData?.email || "naoinformado@email.com",
            phone: customerData?.phone || null, document: customerData?.document || null,
        },
        products: [{
            id: productData?.id || "default_product", name: productData?.name || "Produto Digital",
            planId: null, planName: null, quantity: 1, priceInCents: Math.round(pixData.pix_value * 100)
        }],
        trackingParameters: {
            src: null, sck: null, utm_source: clickData.utm_source, utm_campaign: clickData.utm_campaign,
            utm_medium: clickData.utm_medium, utm_content: clickData.utm_content, utm_term: clickData.utm_term
        },
        commission: {
            totalPriceInCents: Math.round(pixData.pix_value * 100),
            gatewayFeeInCents: Math.round(pixData.pix_value * 100 * 0.0299),
            userCommissionInCents: Math.round(pixData.pix_value * 100 * (1 - 0.0299))
        },
        isTest: false
    };
    try {
        await axios.post('https://api.utmify.com.br/api-credentials/orders', payload, {
            headers: { 'x-api-token': sellerData.utmify_api_token }
        });
        console.log(`Evento '${status}' do pedido ${payload.orderId} enviado para Utmify.`);
    } catch (error) {
        console.error(`Erro ao enviar evento '${status}' para a Utmify:`, error.response?.data || error.message);
    }
}

// --- FUNÇÃO DE ENVIO PARA META ---
async function sendConversionToMeta(clickData, pixData) {
    const sql = getDbConnection();
    try {
        const presselPixels = await sql`SELECT pixel_config_id FROM pressel_pixels WHERE pressel_id = ${clickData.pressel_id}`;
        if (presselPixels.length === 0) return;
        const externalId = clickData.click_id ? clickData.click_id.replace('/start ', '') : null;
        const city = clickData.city && clickData.city !== 'Desconhecida' ? clickData.city.toLowerCase().replace(/[^a-z]/g, '') : null;
        const state = clickData.state && clickData.state !== 'Desconhecido' ? clickData.state.toLowerCase().replace(/[^a-z]/g, '') : null;
        const gender = 'm';
        for (const { pixel_config_id } of presselPixels) {
            const [pixelConfig] = await sql`SELECT pixel_id, meta_api_token FROM pixel_configurations WHERE id = ${pixel_config_id}`;
            if (pixelConfig) {
                const { pixel_id, meta_api_token } = pixelConfig;
                const event_id = `pix.${pixData.id}.${pixel_id}`;
                const userData = {
                    external_id: externalId, fbp: clickData.fbp, fbc: clickData.fbc,
                    client_ip_address: clickData.ip_address, client_user_agent: clickData.user_agent,
                    ge: crypto.createHash('sha256').update(gender).digest('hex'),
                    ct: city ? crypto.createHash('sha256').update(city).digest('hex') : null,
                    st: state ? crypto.createHash('sha256').update(state).digest('hex') : null,
                };
                Object.keys(userData).forEach(key => (userData[key] === null || userData[key] === undefined) && delete userData[key]);
                const payload = {
                    data: [{
                        event_name: 'Purchase', event_time: Math.floor(Date.now() / 1000),
                        event_id, user_data: userData, custom_data: { currency: 'BRL', value: pixData.pix_value },
                    }]
                };
                await axios.post(`https://graph.facebook.com/v19.0/${pixel_id}/events`, payload, { params: { access_token: meta_api_token } });
                await sql`UPDATE pix_transactions SET meta_event_id = ${event_id} WHERE id = ${pixData.id}`;
            }
        }
    } catch (error) {
        console.error('Erro ao enviar conversão para a Meta:', error.response?.data || error.message);
    }
}

// --- ROTINA DE VERIFICAÇÃO DE TRANSAÇÕES PENDENTES ---
async function checkPendingTransactions() {
    const sql = getDbConnection();
    try {
        const pendingTransactions = await sql`
            SELECT id, provider, provider_transaction_id, click_id_internal
            FROM pix_transactions WHERE status = 'pending' AND created_at > NOW() - INTERVAL '24 hours'`;

        if (pendingTransactions.length === 0) return;
        
        for (const tx of pendingTransactions) {
            try {
                const [seller] = await sql`
                    SELECT pushinpay_token, cnpay_public_key, cnpay_secret_key, oasyfy_public_key, oasyfy_secret_key
                    FROM sellers s JOIN clicks c ON c.seller_id = s.id
                    WHERE c.id = ${tx.click_id_internal}`;
                if (!seller) continue;

                let providerStatus;
                if (tx.provider === 'pushinpay') {
                    const response = await axios.get(`https://api.pushinpay.com.br/api/transactions/${tx.provider_transaction_id}`, { headers: { Authorization: `Bearer ${seller.pushinpay_token}` } });
                    providerStatus = response.data.status;
                } else if (tx.provider === 'cnpay') {
                    const response = await axios.get(`https://painel.appcnpay.com/api/v1/gateway/pix/receive/${tx.provider_transaction_id}`, { headers: { 'x-public-key': seller.cnpay_public_key, 'x-secret-key': seller.cnpay_secret_key } });
                    providerStatus = response.data.status;
                } else if (tx.provider === 'oasyfy') {
                    const response = await axios.get(`https://app.oasyfy.com/api/v1/gateway/pix/receive/${tx.provider_transaction_id}`, { headers: { 'x-public-key': seller.oasyfy_public_key, 'x-secret-key': seller.oasyfy_secret_key } });
                    providerStatus = response.data.status;
                }
                if (providerStatus === 'paid' || providerStatus === 'COMPLETED') {
                    const [updatedTx] = await sql`UPDATE pix_transactions SET status = 'paid', paid_at = NOW() WHERE id = ${tx.id} AND status != 'paid' RETURNING *`;
                    if (updatedTx) {
                        await handleSuccessfulPayment(updatedTx.click_id_internal);
                    }
                }
            } catch (error) {
                console.error(`Erro ao verificar transação ${tx.id}:`, error.response?.data || error.message);
            }
        }
    } catch (error) {
        console.error("Erro na rotina de verificação geral:", error.message);
    }
}
setInterval(checkPendingTransactions, 120000);

// --- ROTAS DO PAINEL ADMINISTRATIVO ---
function authenticateAdmin(req, res, next) {
    const adminKey = req.headers['x-admin-api-key'];
    if (!adminKey || adminKey !== ADMIN_API_KEY) {
        return res.status(403).json({ message: 'Acesso negado. Chave de administrador inválida.' });
    }
    next();
}

app.get('/api/admin/dashboard', authenticateAdmin, async (req, res) => {
    const sql = getDbConnection();
    try {
        const totalSellers = await sql`SELECT COUNT(*) FROM sellers;`;
        const paidTransactions = await sql`SELECT COUNT(*) as count, SUM(pix_value) as total_revenue FROM pix_transactions WHERE status = 'paid';`;
        const total_sellers = parseInt(totalSellers[0].count);
        const total_paid_transactions = parseInt(paidTransactions[0].count);
        const total_revenue = parseFloat(paidTransactions[0].total_revenue || 0);
        const saas_profit = total_revenue * 0.0299;
        res.json({
            total_sellers, total_paid_transactions,
            total_revenue: total_revenue.toFixed(2),
            saas_profit: saas_profit.toFixed(2)
        });
    } catch (error) {
        console.error("Erro no dashboard admin:", error);
        res.status(500).json({ message: 'Erro ao buscar dados do dashboard.' });
    }
});
app.get('/api/admin/ranking', authenticateAdmin, async (req, res) => {
    const sql = getDbConnection();
    try {
        const ranking = await sql`
            SELECT s.id, s.name, s.email, COUNT(pt.id) AS total_sales, COALESCE(SUM(pt.pix_value), 0) AS total_revenue
            FROM sellers s LEFT JOIN clicks c ON s.id = c.seller_id
            LEFT JOIN pix_transactions pt ON c.id = pt.click_id_internal AND pt.status = 'paid'
            GROUP BY s.id, s.name, s.email ORDER BY total_revenue DESC LIMIT 20;`;
        res.json(ranking);
    } catch (error) {
        console.error("Erro no ranking de sellers:", error);
        res.status(500).json({ message: 'Erro ao buscar ranking.' });
    }
});
app.get('/api/admin/sellers', authenticateAdmin, async (req, res) => {
    const sql = getDbConnection();
    try {
        const sellers = await sql`SELECT id, name, email, created_at, is_active FROM sellers ORDER BY created_at DESC;`;
        res.json(sellers);
    } catch (error) {
        res.status(500).json({ message: 'Erro ao listar vendedores.' });
    }
});
app.post('/api/admin/sellers/:id/toggle-active', authenticateAdmin, async (req, res) => {
    const sql = getDbConnection();
    const { id } = req.params;
    const { isActive } = req.body;
    try {
        await sql`UPDATE sellers SET is_active = ${isActive} WHERE id = ${id};`;
        res.status(200).json({ message: `Usuário ${isActive ? 'ativado' : 'bloqueado'} com sucesso.` });
    } catch (error) {
        res.status(500).json({ message: 'Erro ao alterar status do usuário.' });
    }
});
app.put('/api/admin/sellers/:id/password', authenticateAdmin, async (req, res) => {
    const sql = getDbConnection();
    const { id } = req.params;
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) return res.status(400).json({ message: 'A nova senha deve ter pelo menos 8 caracteres.' });
    try {
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await sql`UPDATE sellers SET password_hash = ${hashedPassword} WHERE id = ${id};`;
        res.status(200).json({ message: 'Senha alterada com sucesso.' });
    } catch (error) {
        res.status(500).json({ message: 'Erro ao alterar senha.' });
    }
});
app.put('/api/admin/sellers/:id/credentials', authenticateAdmin, async (req, res) => {
    const sql = getDbConnection();
    const { id } = req.params;
    const { pushinpay_token, cnpay_public_key, cnpay_secret_key } = req.body;
    try {
        await sql`
            UPDATE sellers 
            SET pushinpay_token = ${pushinpay_token}, cnpay_public_key = ${cnpay_public_key}, cnpay_secret_key = ${cnpay_secret_key}
            WHERE id = ${id};`;
        res.status(200).json({ message: 'Credenciais alteradas com sucesso.' });
    } catch (error) {
        res.status(500).json({ message: 'Erro ao alterar credenciais.' });
    }
});
app.get('/api/admin/transactions', authenticateAdmin, async (req, res) => {
    const sql = getDbConnection();
    try {
        const page = parseInt(req.query.page || 1);
        const limit = parseInt(req.query.limit || 20);
        const offset = (page - 1) * limit;
        const transactions = await sql`
            SELECT pt.id, pt.status, pt.pix_value, pt.provider, pt.created_at, s.name as seller_name, s.email as seller_email
            FROM pix_transactions pt JOIN clicks c ON pt.click_id_internal = c.id
            JOIN sellers s ON c.seller_id = s.id ORDER BY pt.created_at DESC
            LIMIT ${limit} OFFSET ${offset};`;
         const totalTransactionsResult = await sql`SELECT COUNT(*) FROM pix_transactions;`;
         const total = parseInt(totalTransactionsResult[0].count);
        res.json({ transactions, total, page, pages: Math.ceil(total / limit), limit });
    } catch (error) {
        console.error("Erro ao buscar transações admin:", error);
        res.status(500).json({ message: 'Erro ao buscar transações.' });
    }
});

app.get('/api/admin/usage-analysis', authenticateAdmin, async (req, res) => {
    const sql = getDbConnection();
    try {
        const usageData = await sql`
            SELECT
                s.id, s.name, s.email,
                COUNT(ar.id) FILTER (WHERE ar.created_at > NOW() - INTERVAL '1 hour') AS requests_last_hour,
                COUNT(ar.id) FILTER (WHERE ar.created_at > NOW() - INTERVAL '24 hours') AS requests_last_24_hours
            FROM sellers s
            LEFT JOIN api_requests ar ON s.id = ar.seller_id
            GROUP BY s.id, s.name, s.email
            ORDER BY requests_last_24_hours DESC, requests_last_hour DESC;
        `;
        res.json(usageData);
    } catch (error) {
        console.error("Erro na análise de uso:", error);
        res.status(500).json({ message: 'Erro ao buscar dados de uso.' });
    }
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

module.exports = app;
