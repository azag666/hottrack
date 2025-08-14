const express = require('express');
const cors = require('cors');
const { neon } = require('@neondatabase/serverless');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json());

const sql = neon(process.env.DATABASE_URL);
const JWT_SECRET = process.env.JWT_SECRET || 'seu-segredo-jwt-super-secreto-padrao';
const PUSHINPAY_API_URL = 'https://api.pushinpay.com.br';
const YOUR_PUSHINPAY_ACCOUNT_ID = '9F49A790-2C45-4413-9974-451D657314AF';
const SPLIT_VALUE_CENTS = 30;

// Função de Hashing para a Meta
function sha256(value) {
    if (!value) return null;
    return crypto.createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');
}

// Função para obter geolocalização por IP
async function getGeoFromIp(ip) {
    if (!ip || ip === '::1') return { city: 'Local', state: 'Local' };
    try {
        const response = await axios.get(`http://ip-api.com/json/${ip}?fields=status,city,regionName`);
        if (response.data && response.data.status === 'success') {
            return { city: response.data.city || 'Desconhecida', state: response.data.regionName || 'Desconhecido' };
        }
        return { city: 'Desconhecida', state: 'Desconhecido' };
    } catch (error) {
        console.error('Erro ao obter geolocalização:', error.message);
        return { city: 'Erro', state: 'Erro' };
    }
}

// Middlewares de Autenticação
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
async function authenticateApiKey(req, res, next) {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ message: 'Chave de API não fornecida.' });
    try {
        const sellerResult = await sql`SELECT id, pushinpay_token FROM sellers WHERE api_key = ${apiKey}`;
        if (sellerResult.length === 0) return res.status(403).json({ message: 'Chave de API inválida.' });
        req.seller = sellerResult[0];
        next();
    } catch (error) { res.status(500).json({ message: 'Erro interno do servidor.' }); }
}

// Rotas de Autenticação
app.post('/api/sellers/register', async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ message: 'Nome, email e senha são obrigatórios.' });
    if (password.length < 8) return res.status(400).json({ message: 'A senha deve ter no mínimo 8 caracteres.' });
    try {
        const existingSeller = await sql`SELECT id FROM sellers WHERE email = ${email}`;
        if (existingSeller.length > 0) return res.status(409).json({ message: 'Este email já está em uso.' });
        const hashedPassword = await bcrypt.hash(password, 10);
        const apiKey = uuidv4();
        const newSeller = await sql`INSERT INTO sellers (name, email, password_hash, api_key) VALUES (${name}, ${email}, ${hashedPassword}, ${apiKey}) RETURNING id, name, email, api_key;`;
        res.status(201).json({ message: 'Vendedor cadastrado com sucesso!', seller: newSeller[0] });
    } catch (error) { res.status(500).json({ message: 'Erro interno do servidor.' }); }
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
        const tokenPayload = { id: seller.id, email: seller.email, name: seller.name };
        const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '1d' });
        const { password_hash, ...sellerData } = seller;
        res.status(200).json({ message: 'Login bem-sucedido!', token, seller: sellerData });
    } catch (error) { res.status(500).json({ message: 'Erro interno do servidor.' }); }
});

// Rotas do Dashboard
app.get('/api/dashboard/data', authenticateJwt, async (req, res) => {
    try {
        const settingsPromise = sql`SELECT name, email, pushinpay_token FROM sellers WHERE id = ${req.user.id}`;
        const pixelsPromise = sql`SELECT * FROM pixel_configurations WHERE seller_id = ${req.user.id} ORDER BY created_at DESC`;
        
        const statsPromise = sql`
            SELECT 
                COUNT(pt.id) AS pix_generated,
                COUNT(pt.id) FILTER (WHERE pt.status = 'paid') AS pix_paid
            FROM pix_transactions pt
            JOIN clicks c ON pt.click_id_internal = c.id
            WHERE c.seller_id = ${req.user.id} AND pt.created_at >= NOW() - INTERVAL '30 days'
        `;
        
        const topStatesPromise = sql`SELECT state, COUNT(*) as count FROM clicks WHERE seller_id = ${req.user.id} AND state IS NOT NULL AND state != 'Desconhecido' AND state != 'Local' GROUP BY state ORDER BY count DESC LIMIT 5`;

        const [settingsResult, pixelsResult, statsResult, topStatesResult] = await Promise.all([settingsPromise, pixelsPromise, statsPromise, topStatesPromise]);

        res.json({
            settings: settingsResult[0] || {},
            pixels: pixelsResult || [],
            stats: statsResult[0] || { pix_generated: 0, pix_paid: 0 },
            topStates: topStatesResult || []
        });
    } catch (error) { 
        console.error("Dashboard Data Error:", error);
        res.status(500).json({ message: 'Erro ao buscar dados do dashboard.' }); 
    }
});

app.put('/api/sellers/update-settings', authenticateJwt, async (req, res) => {
    const { pushinpay_token } = req.body;
    try {
        await sql`UPDATE sellers SET pushinpay_token = ${pushinpay_token} WHERE id = ${req.user.id}`;
        res.status(200).json({ message: 'Configurações atualizadas com sucesso.' });
    } catch (error) { res.status(500).json({ message: 'Erro ao atualizar configurações.' }); }
});

// Rotas de PIXELS
app.post('/api/pixels', authenticateJwt, async (req, res) => {
    const { account_name, pixel_id, meta_api_token } = req.body;
    if (!account_name || !pixel_id || !meta_api_token) return res.status(400).json({ message: 'Todos os campos são obrigatórios.' });
    try {
        const newPixel = await sql`INSERT INTO pixel_configurations (seller_id, account_name, pixel_id, meta_api_token) VALUES (${req.user.id}, ${account_name}, ${pixel_id}, ${meta_api_token}) RETURNING *;`;
        res.status(201).json(newPixel[0]);
    } catch (error) { res.status(500).json({ message: 'Erro ao adicionar conta de pixel.' }); }
});
app.put('/api/pixels/:id', authenticateJwt, async (req, res) => {
    const { id } = req.params;
    const { account_name, pixel_id, meta_api_token } = req.body;
    try {
        const updated = await sql`UPDATE pixel_configurations SET account_name = ${account_name}, pixel_id = ${pixel_id}, meta_api_token = ${meta_api_token} WHERE id = ${id} AND seller_id = ${req.user.id} RETURNING *;`;
        if (updated.length === 0) return res.status(404).json({ message: 'Conta de pixel não encontrada.' });
        res.status(200).json(updated[0]);
    } catch (error) { res.status(500).json({ message: 'Erro ao atualizar conta de pixel.' }); }
});
app.delete('/api/pixels/:id', authenticateJwt, async (req, res) => {
    const { id } = req.params;
    try {
        const deleted = await sql`DELETE FROM pixel_configurations WHERE id = ${id} AND seller_id = ${req.user.id} RETURNING id;`;
        if (deleted.length === 0) return res.status(404).json({ message: 'Conta de pixel não encontrada.' });
        res.status(204).send();
    } catch (error) { res.status(500).json({ message: 'Erro ao excluir conta de pixel.' }); }
});

// Rota de Registro de Clique
app.post('/api/registerClick', async (req, res) => {
    const { sellerApiKey, referer, fbclid, fbp } = req.body;
    if (!sellerApiKey) return res.status(400).json({ message: 'Identificação do vendedor é necessária.' });
    try {
        const sellerResult = await sql`SELECT id FROM sellers WHERE api_key = ${sellerApiKey}`;
        if (sellerResult.length === 0) return res.status(404).json({ message: 'Vendedor não encontrado.' });
        
        const seller_id = sellerResult[0].id;
        const ip_address = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        const user_agent = req.headers['user-agent'];
        const { city, state } = await getGeoFromIp(ip_address.split(',')[0].trim());

        const result = await sql`INSERT INTO clicks (seller_id, ip_address, user_agent, referer, city, state, fbclid, fbp) VALUES (${seller_id}, ${ip_address}, ${user_agent}, ${referer}, ${city}, ${state}, ${fbclid}, ${fbp}) RETURNING id;`;
        
        const generatedId = result[0].id;
        const cleanClickId = `lead${generatedId.toString().padStart(6, '0')}`;
        const clickIdForDb = `/start ${cleanClickId}`;
        await sql`UPDATE clicks SET click_id = ${clickIdForDb} WHERE id = ${generatedId}`;

        res.status(200).json({ status: 'success', message: 'Click registrado', click_id: cleanClickId });
    } catch (error) {
        console.error("Register Click Error:", error);
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
});

// Rotas do ManyChat
app.post('/api/manychat/get-city', authenticateApiKey, async (req, res) => {
    let { click_id } = req.body;
    if (!click_id) return res.status(400).json({ message: 'O campo click_id é obrigatório.' });
    if (!click_id.startsWith('/start ')) { click_id = `/start ${click_id}`; }
    try {
        const result = await sql`SELECT city FROM clicks WHERE click_id = ${click_id} AND seller_id = ${req.seller.id}`;
        if (result.length > 0) { res.status(200).json({ city: result[0].city || 'N/A' }); } 
        else { res.status(404).json({ message: 'Click ID não encontrado.' }); }
    } catch (error) { res.status(500).json({ message: 'Erro interno do servidor.' }); }
});

app.post('/api/manychat/update-customer-data', authenticateApiKey, async (req, res) => {
    let { click_id, email, first_name, last_name, phone } = req.body;
    if (!click_id) return res.status(400).json({ message: 'O campo click_id é obrigatório.' });
    if (!click_id.startsWith('/start ')) { click_id = `/start ${click_id}`; }
    try {
        const result = await sql`UPDATE clicks SET email = COALESCE(${email}, email), first_name = COALESCE(${first_name}, first_name), last_name = COALESCE(${last_name}, last_name), phone = COALESCE(${phone}, phone) WHERE click_id = ${click_id} AND seller_id = ${req.seller.id} RETURNING id;`;
        if (result.length === 0) return res.status(404).json({ message: 'Click ID não encontrado.' });
        res.status(200).json({ status: 'success', message: 'Dados do cliente atualizados.' });
    } catch (error) { res.status(500).json({ message: 'Erro interno do servidor.' }); }
});

app.post('/api/manychat/generate-pix', authenticateApiKey, async (req, res) => {
    const { pushinpay_token } = req.seller;
    let { click_id, value_cents } = req.body;
    if (!pushinpay_token) return res.status(400).json({ message: 'Vendedor sem token da PushinPay configurado.' });
    if (!click_id || !value_cents) return res.status(400).json({ message: 'click_id e value_cents são obrigatórios.' });
    if (!click_id.startsWith('/start ')) { click_id = `/start ${click_id}`; }
    try {
        const clickResult = await sql`SELECT id FROM clicks WHERE click_id = ${click_id} AND seller_id = ${req.seller.id}`;
        if (clickResult.length === 0) return res.status(404).json({ message: 'Click ID não encontrado.' });
        const click_id_internal = clickResult[0].id;

        const payload = {
            value: value_cents,
            webhook_url: `https://hottrack.vercel.app/api/webhooks/pushinpay`,
            split_rules: [{ value: SPLIT_VALUE_CENTS, account_id: YOUR_PUSHINPAY_ACCOUNT_ID }]
        };
        const response = await axios.post(`${PUSHINPAY_API_URL}/api/pix/cashIn`, payload, {
            headers: { 'Authorization': `Bearer ${pushinpay_token}`, 'Content-Type': 'application/json' }
        });
        const { id: pix_id, qr_code, qr_code_base64 } = response.data;
        await sql`INSERT INTO pix_transactions (click_id_internal, pix_id, value_cents) VALUES (${click_id_internal}, ${pix_id}, ${value_cents})`;
        res.status(200).json({ pix_id, qr_code, qr_code_base64 });
    } catch (error) { res.status(500).json({ message: 'Erro ao se comunicar com a PushinPay.' }); }
});

app.post('/api/manychat/check-status-by-clickid', authenticateApiKey, async (req, res) => {
    let { click_id } = req.body;
    const { pushinpay_token } = req.seller;
    if (!click_id) return res.status(400).json({ message: 'O campo click_id é obrigatório.' });
    if (!pushinpay_token) return res.status(400).json({ message: 'Vendedor sem token da PushinPay configurado.' });
    if (!click_id.startsWith('/start ')) { click_id = `/start ${click_id}`; }
    try {
        const clickResult = await sql`SELECT id FROM clicks WHERE click_id = ${click_id} AND seller_id = ${req.seller.id}`;
        if (clickResult.length === 0) return res.status(404).json({ message: 'Click ID não encontrado.' });
        const click_id_internal = clickResult[0].id;

        const paidTx = await sql`SELECT pix_id FROM pix_transactions WHERE click_id_internal = ${click_id_internal} AND status = 'paid'`;
        if(paidTx.length > 0) return res.status(200).json({ status: 'paid', message: 'Um pagamento para este lead já foi confirmado.' });

        const pendingTxs = await sql`SELECT pix_id FROM pix_transactions WHERE click_id_internal = ${click_id_internal} AND status = 'created'`;
        if (pendingTxs.length === 0) return res.status(200).json({ status: 'not_found', message: 'Nenhum PIX pendente encontrado para este lead.' });

        for (const tx of pendingTxs) {
            try {
                const response = await axios.get(`${PUSHINPAY_API_URL}/api/transactions/${tx.pix_id}`, { headers: { 'Authorization': `Bearer ${pushinpay_token}` } });
                if (response.data && response.data.status === 'paid') {
                    await axios.post(`https://hottrack.vercel.app/api/webhooks/pushinpay`, { id: tx.pix_id, status: 'paid' });
                    return res.status(200).json({ status: 'paid', message: `Pagamento do PIX ${tx.pix_id} confirmado.` });
                }
            } catch (checkError) { console.error(`Erro ao consultar PIX ${tx.pix_id}:`, checkError.message); }
        }
        return res.status(200).json({ status: 'pending', message: 'Nenhum pagamento confirmado ainda.' });
    } catch (error) { res.status(500).json({ message: 'Erro interno do servidor.' }); }
});

// Webhook
app.post('/api/webhooks/pushinpay', async (req, res) => {
    const { id: pix_id, status } = req.body;
    if (status === 'paid') {
        try {
            const updatedTx = await sql`UPDATE pix_transactions SET status = 'paid', paid_at = NOW() WHERE pix_id = ${pix_id} AND status != 'paid' RETURNING click_id_internal, value_cents;`;
            if (updatedTx.length === 0) return res.status(200).send('Transação já processada ou não encontrada.');
            const { click_id_internal, value_cents } = updatedTx[0];
            const clickResult = await sql`SELECT *, ${value_cents / 100.0} as pix_value FROM clicks WHERE id = ${click_id_internal};`;
            if (clickResult.length === 0) return res.status(404).send('Click original não encontrado.');
            const clickData = clickResult[0];
            if (!clickData.is_converted) {
                await sql`UPDATE clicks SET is_converted = TRUE, conversion_timestamp = NOW() WHERE id = ${click_id_internal};`;
                await sendConversionToMeta(clickData);
            }
        } catch (dbError) { return res.status(500).send('Erro interno ao processar webhook.'); }
    }
    res.status(200).send('Webhook recebido.');
});

// Função para enviar conversão para a Meta
async function sendConversionToMeta(clickData) {
    console.log('Iniciando envio de conversão para a Meta:', clickData.click_id);
    try {
        const pixels = await sql`SELECT pixel_id, meta_api_token FROM pixel_configurations WHERE seller_id = ${clickData.seller_id}`;
        if (pixels.length === 0) return;

        const eventTime = Math.floor(Date.now() / 1000);

        for (const pixel of pixels) {
            const eventId = uuidv4();
            const metaApiUrl = `https://graph.facebook.com/v19.0/${pixel.pixel_id}/events`;

            const user_data = {
                client_ip_address: clickData.ip_address,
                client_user_agent: clickData.user_agent,
                fbp: clickData.fbp || null,
                fbc: clickData.fbc || null,
                external_id: clickData.click_id
            };
            
            if (clickData.email) user_data.em = sha256(clickData.email);
            if (clickData.phone) user_data.ph = sha256(clickData.phone);
            if (clickData.first_name) user_data.fn = sha256(clickData.first_name);
            if (clickData.last_name) user_data.ln = sha256(clickData.last_name);
            if (clickData.city) user_data.ct = sha256(clickData.city);
            if (clickData.state) user_data.st = sha256(clickData.state);

            const payload = {
                data: [{
                    event_name: 'Purchase',
                    event_time: eventTime,
                    event_id: eventId,
                    action_source: 'website',
                    user_data: user_data,
                    custom_data: { currency: 'BRL', value: clickData.pix_value },
                }],
            };

            try {
                await axios.post(metaApiUrl, payload, { headers: { 'Authorization': `Bearer ${pixel.meta_api_token}` } });
                console.log(`Conversão enviada com sucesso para o Pixel ${pixel.pixel_id}`);
            } catch (metaError) {
                console.error(`ERRO ao enviar evento para o Pixel ${pixel.pixel_id}:`, metaError.response ? metaError.response.data.error : metaError.message);
            }
        }
    } catch (error) {
        console.error('Erro geral na função sendConversionToMeta:', error);
    }
}

module.exports = app;
