const express = require('express');
const cors = require('cors');
const { neon } = require('@neondatabase/serverless');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// --- CONFIGURAÇÃO ---
const sql = neon(process.env.DATABASE_URL);
const JWT_SECRET = process.env.JWT_SECRET || 'seu-segredo-super-secreto';
const MY_PUSHINPAY_ACCOUNT_ID = process.env.MY_PUSHINPAY_ACCOUNT_ID;

// --- MIDDLEWARE DE AUTENTICAÇÃO ---
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
    } catch (error) {
        console.error("Erro no registro:", error);
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
});

app.post('/api/sellers/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Email e senha são obrigatórios.' });
    try {
        const sellerResult = await sql`SELECT * FROM sellers WHERE email = ${email}`;
        if (sellerResult.length === 0) return res.status(404).json({ message: 'Usuário não encontrado.' });
        
        const seller = sellerResult[0];
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

// --- ROTA DE DADOS DO PAINEL ---
app.get('/api/dashboard/data', authenticateJwt, async (req, res) => {
    try {
        const sellerId = req.user.id;
        const settingsPromise = sql`SELECT api_key, pushinpay_token FROM sellers WHERE id = ${sellerId}`;
        const pixelsPromise = sql`SELECT * FROM pixel_configurations WHERE seller_id = ${sellerId} ORDER BY created_at DESC`;
        const presselsPromise = sql`
            SELECT p.*, COALESCE(px.pixel_ids, ARRAY[]::integer[]) as pixel_ids
            FROM pressels p
            LEFT JOIN (
                SELECT pressel_id, array_agg(pixel_config_id) as pixel_ids FROM pressel_pixels GROUP BY pressel_id
            ) px ON p.id = px.pressel_id
            WHERE p.seller_id = ${sellerId} ORDER BY p.created_at DESC`;
        const botsPromise = sql`SELECT * FROM telegram_bots WHERE seller_id = ${sellerId} ORDER BY created_at DESC`;

        const [settings, pixels, pressels, bots] = await Promise.all([settingsPromise, pixelsPromise, presselsPromise, botsPromise]);

        res.json({
            settings: settings[0] || { api_key: null, pushinpay_token: null },
            pixels: pixels || [],
            pressels: pressels || [],
            bots: bots || [],
        });
    } catch (error) { 
        console.error("Erro ao buscar dados do dashboard:", error);
        res.status(500).json({ message: 'Erro ao buscar dados.' }); 
    }
});

// --- ROTAS DE GERENCIAMENTO (CRUD) ---
app.post('/api/pixels', authenticateJwt, async (req, res) => {
    const { account_name, pixel_id, meta_api_token } = req.body;
    if (!account_name || !pixel_id || !meta_api_token) return res.status(400).json({ message: 'Todos os campos são obrigatórios.' });
    try {
        const newPixel = await sql`INSERT INTO pixel_configurations (seller_id, account_name, pixel_id, meta_api_token) VALUES (${req.user.id}, ${account_name}, ${pixel_id}, ${meta_api_token}) RETURNING *;`;
        res.status(201).json(newPixel[0]);
    } catch (error) { 
        console.error("Erro ao salvar pixel:", error);
        res.status(500).json({ message: 'Erro ao salvar o pixel.' }); 
    }
});

app.delete('/api/pixels/:id', authenticateJwt, async (req, res) => {
    const { id } = req.params;
    try {
        await sql`DELETE FROM pixel_configurations WHERE id = ${id} AND seller_id = ${req.user.id}`;
        res.status(204).send();
    } catch (error) { res.status(500).json({ message: 'Erro ao excluir o pixel.' }); }
});

app.post('/api/bots', authenticateJwt, async (req, res) => {
    const { bot_name, bot_token } = req.body;
    if(!bot_name || !bot_token) return res.status(400).json({ message: 'Nome e token são obrigatórios.' });
    try {
        const newBot = await sql`INSERT INTO telegram_bots (seller_id, bot_name, bot_token) VALUES (${req.user.id}, ${bot_name}, ${bot_token}) RETURNING *;`;
        res.status(201).json(newBot[0]);
    } catch (error) { 
        console.error("Erro ao salvar bot:", error);
        if (error.code === '23505') {
            return res.status(409).json({ message: 'Um bot com este nome já existe.' });
        }
        res.status(500).json({ message: 'Erro ao salvar o bot.' }); 
    }
});

app.delete('/api/bots/:id', authenticateJwt, async (req, res) => {
    const { id } = req.params;
    try {
        await sql`DELETE FROM telegram_bots WHERE id = ${id} AND seller_id = ${req.user.id}`;
        res.status(204).send();
    } catch (error) { res.status(500).json({ message: 'Erro ao excluir o bot.' }); }
});

app.post('/api/pressels', authenticateJwt, async (req, res) => {
    const { name, bot_id, white_page_url, pixel_ids } = req.body;
    if (!name || !bot_id || !white_page_url || !pixel_ids || pixel_ids.length === 0) {
        return res.status(400).json({ message: 'Todos os campos são obrigatórios.' });
    }
    try {
        const numeric_bot_id = parseInt(bot_id, 10);
        const numeric_pixel_ids = pixel_ids.map(id => parseInt(id, 10));

        const botResult = await sql`SELECT bot_name FROM telegram_bots WHERE id = ${numeric_bot_id} AND seller_id = ${req.user.id}`;
        if (botResult.length === 0) return res.status(404).json({ message: 'Bot não encontrado.' });
        
        const bot_name = botResult[0].bot_name;
        
        const newPresselResult = await sql`INSERT INTO pressels (seller_id, name, bot_id, bot_name, white_page_url) VALUES (${req.user.id}, ${name}, ${numeric_bot_id}, ${bot_name}, ${white_page_url}) RETURNING *;`;
        const newPressel = newPresselResult[0];
        const presselId = newPressel.id;

        if (numeric_pixel_ids.length > 0) {
            const pixelLinks = numeric_pixel_ids.map(pixelId => ({ pressel_id: presselId, pixel_config_id: pixelId }));
            await sql`INSERT INTO pressel_pixels ${sql(pixelLinks, 'pressel_id', 'pixel_config_id')}`;
        }

        const finalPressel = { ...newPressel, pixel_ids: numeric_pixel_ids };
        res.status(201).json(finalPressel);
    } catch (error) {
        console.error("Erro detalhado ao salvar pressel:", error);
        res.status(500).json({ message: 'Erro ao salvar a pressel.' });
    }
});

app.delete('/api/pressels/:id', authenticateJwt, async (req, res) => {
    const { id } = req.params;
    try {
        await sql`DELETE FROM pressels WHERE id = ${id} AND seller_id = ${req.user.id}`;
        res.status(204).send();
    } catch (error) { res.status(500).json({ message: 'Erro ao excluir a pressel.' }); }
});

app.post('/api/settings/pushinpay', authenticateJwt, async (req, res) => {
    const { token } = req.body;
    if (typeof token !== 'string') return res.status(400).json({ message: 'Token é obrigatório.' });
    try {
        await sql`UPDATE sellers SET pushinpay_token = ${token} WHERE id = ${req.user.id}`;
        res.status(200).json({ message: 'Token salvo com sucesso.' });
    } catch (error) { res.status(500).json({ message: 'Erro ao salvar o token.' }); }
});

// --- ROTA DE RASTREAMENTO ---
app.post('/api/registerClick', async (req, res) => {
    const { sellerApiKey, presselId, referer, fbclid, fbp, fbc, user_agent } = req.body;
    if (!sellerApiKey || !presselId) return res.status(400).json({ message: 'Dados insuficientes.' });
    
    const ip_address = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
    let city = 'Desconhecida', state = 'Desconhecido';
    try {
        if (ip_address && ip_address !== '::1') {
            const geo = await axios.get(`http://ip-api.com/json/${ip_address}?fields=city,regionName`);
            city = geo.data.city || city;
            state = geo.data.regionName || state;
        }
    } catch (e) { console.error("Erro ao buscar geolocalização"); }

    try {
        const result = await sql`INSERT INTO clicks (seller_id, pressel_id, ip_address, user_agent, referer, city, state, fbclid, fbp, fbc) SELECT s.id, ${presselId}, ${ip_address}, ${user_agent}, ${referer}, ${city}, ${state}, ${fbclid}, ${fbp}, ${fbc} FROM sellers s WHERE s.api_key = ${sellerApiKey} RETURNING id;`;
        if (result.length === 0) return res.status(404).json({ message: 'API Key ou Pressel inválida.' });

        const click_record_id = result[0].id;
        const click_id_string = `click_${click_record_id}_${Date.now()}`;
        await sql`UPDATE clicks SET click_id = ${click_id_string} WHERE id = ${click_record_id}`;
        res.status(200).json({ status: 'success', click_id: click_id_string });
    } catch (error) {
        console.error("Erro ao registrar clique:", error);
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
});

// --- ROTAS DE PIX E CONVERSÃO ---
app.post('/api/pix/generate', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    const { click_id, value_cents } = req.body;
    if (!apiKey || !click_id || !value_cents) return res.status(400).json({ message: 'API Key, click_id e value_cents são obrigatórios.' });
    try {
        const sellerResult = await sql`SELECT id, pushinpay_token FROM sellers WHERE api_key = ${apiKey}`;
        const seller = sellerResult[0];
        if (!seller?.pushinpay_token) return res.status(400).json({ message: 'API PIX não configurada pelo vendedor.' });

        const clickResult = await sql`SELECT id FROM clicks WHERE click_id = ${click_id}`;
        if (clickResult.length === 0) return res.status(404).json({ message: 'Click ID não encontrado.' });
        const click_id_internal = clickResult[0].id;

        const COMMISSION_RATE = 0.0499;
        const commission_cents = Math.floor(value_cents * COMMISSION_RATE);
        const split_rules = commission_cents > 0 ? [{ value: commission_cents, account_id: MY_PUSHINPAY_ACCOUNT_ID }] : [];
        const webhook_url = `https://${req.headers.host}/api/webhook/pushinpay`;

        const payload = { value: value_cents, webhook_url, split_rules };
        const pushinpayResponse = await axios.post('https://api.pushinpay.com.br/api/pix/cashIn', payload, { headers: { Authorization: `Bearer ${seller.pushinpay_token}` }});
        const pixData = pushinpayResponse.data;

        await sql`INSERT INTO pix_transactions (click_id_internal, pix_id, pix_value, qr_code_text, qr_code_base64) VALUES (${click_id_internal}, ${pixData.id}, ${value_cents / 100}, ${pixData.qr_code}, ${pixData.qr_code_base64})`;
        res.status(200).json({ qr_code_text: pixData.qr_code, qr_code_base64: pixData.qr_code_base64 });
    } catch (error) {
        console.error("Erro ao gerar PIX:", error.response?.data || error.message);
        res.status(500).json({ message: 'Erro ao gerar cobrança PIX.' });
    }
});

app.post('/api/pix/check-status', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    const { click_id } = req.body;
    if (!apiKey || !click_id) return res.status(400).json({ message: 'API Key e click_id são obrigatórios.' });
    try {
        const transactions = await sql`
            SELECT pt.status, pt.pix_value 
            FROM pix_transactions pt
            JOIN clicks c ON pt.click_id_internal = c.id
            WHERE c.click_id = ${click_id}`;
        if (transactions.length === 0) return res.status(200).json({ status: 'not_found', message: 'Nenhuma cobrança PIX encontrada.' });
        
        const paidTransaction = transactions.find(t => t.status === 'paid');
        if (paidTransaction) {
            return res.status(200).json({ status: 'paid', value: paidTransaction.pix_value, all_transactions: transactions });
        } else {
            return res.status(200).json({ status: 'pending', all_transactions: transactions });
        }
    } catch (error) {
        console.error("Erro ao consultar status do PIX:", error);
        res.status(500).json({ message: 'Erro ao consultar status.' });
    }
});

app.post('/api/webhook/pushinpay', async (req, res) => {
    const { id, status } = req.body;
    if (status === 'paid') {
        try {
            const updatedTx = await sql`UPDATE pix_transactions SET status = 'paid', paid_at = NOW() WHERE pix_id = ${id} AND status != 'paid' RETURNING *`;
            if (updatedTx.length > 0) {
                const click = await sql`SELECT * FROM clicks WHERE id = ${updatedTx[0].click_id_internal}`;
                await sendConversionToMeta(click[0], updatedTx[0]);
            }
        } catch (error) { console.error("Erro no webhook:", error); }
    }
    res.sendStatus(200);
});

async function sendConversionToMeta(clickData, pixData) {
    try {
        const presselPixels = await sql`SELECT pixel_config_id FROM pressel_pixels WHERE pressel_id = ${clickData.pressel_id}`;
        if (presselPixels.length === 0) return;
        for (const { pixel_config_id } of presselPixels) {
            const pixelConfig = await sql`SELECT pixel_id, meta_api_token FROM pixel_configurations WHERE id = ${pixel_config_id}`;
            if (pixelConfig.length > 0) {
                const { pixel_id, meta_api_token } = pixelConfig[0];
                const event_id = `pix.${pixData.id}.${pixel_id}`;
                const payload = {
                    data: [{
                        event_name: 'Purchase',
                        event_time: Math.floor(Date.now() / 1000),
                        event_id: event_id,
                        user_data: { fbp: clickData.fbp, fbc: clickData.fbc, client_ip_address: clickData.ip_address, client_user_agent: clickData.user_agent },
                        custom_data: { currency: 'BRL', value: pixData.pix_value },
                    }],
                };
                await axios.post(`https://graph.facebook.com/v18.0/${pixel_id}/events`, payload, { params: { access_token: meta_api_token } });
                await sql`UPDATE pix_transactions SET meta_event_id = ${event_id} WHERE id = ${pixData.id}`;
            }
        }
    } catch (error) {
        console.error('Erro ao enviar conversão para a Meta:', error.response?.data || error.message);
    }
}

module.exports = app;
