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

// Funções Utilitárias
function sha256(value) {
    if (!value) return null;
    return crypto.createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');
}
async function getGeoFromIp(ip) {
    if (!ip || ip === '::1') return { city: 'Local', state: 'Local' };
    try {
        const response = await axios.get(`http://ip-api.com/json/${ip}?fields=status,city,regionName`);
        if (response.data && response.data.status === 'success') {
            return { city: response.data.city || 'Desconhecida', state: response.data.regionName || 'Desconhecido' };
        }
        return { city: 'Desconhecida', state: 'Desconhecido' };
    } catch (error) {
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

// Rota do Dashboard
app.get('/api/dashboard/data', authenticateJwt, async (req, res) => {
    try {
        const { bot_name } = req.query;
        let filterClause = sql``;
        if (bot_name && bot_name !== 'all') {
            const botResult = await sql`SELECT id FROM telegram_bots WHERE bot_name = ${bot_name} AND seller_id = ${req.user.id}`;
            if (botResult.length > 0) {
                const botId = botResult[0].id;
                filterClause = sql`AND p.bot_id = ${botId}`;
            }
        }

        const settingsPromise = sql`SELECT name, email, pushinpay_token FROM sellers WHERE id = ${req.user.id}`;
        const pixelsPromise = sql`SELECT * FROM pixel_configurations WHERE seller_id = ${req.user.id} ORDER BY created_at DESC`;
        const presselsPromise = sql`SELECT * FROM pressels WHERE seller_id = ${req.user.id} ORDER BY created_at DESC`;
        
        const statsPromise = sql`
            SELECT 
                COUNT(DISTINCT c.id) AS clicks,
                COUNT(DISTINCT pt.id) AS pix_generated,
                COUNT(DISTINCT pt.id) FILTER (WHERE pt.status = 'paid') AS pix_paid
            FROM clicks c
            LEFT JOIN pressels p ON c.pressel_id = p.id
            LEFT JOIN pix_transactions pt ON pt.click_id_internal = c.id
            WHERE c.seller_id = ${req.user.id} AND c.timestamp >= NOW() - INTERVAL '30 days'
            ${filterClause}
        `;
        
        const topStatesPromise = sql`SELECT c.state, COUNT(c.id) as count FROM clicks c LEFT JOIN pressels p ON c.pressel_id = p.id WHERE c.seller_id = ${req.user.id} AND c.state IS NOT NULL AND c.state != 'Desconhecido' AND c.state != 'Local' ${filterClause} GROUP BY c.state ORDER BY count DESC LIMIT 5`;
        const hourlyTrafficPromise = sql`SELECT EXTRACT(HOUR FROM c.timestamp) as hour, COUNT(c.id) as count FROM clicks c LEFT JOIN pressels p ON c.pressel_id = p.id WHERE c.seller_id = ${req.user.id} AND c.timestamp >= NOW() - INTERVAL '1 day' ${filterClause} GROUP BY hour ORDER BY hour`;
        const botsPromise = sql`SELECT id, bot_name FROM telegram_bots WHERE seller_id = ${req.user.id}`;

        const [settingsResult, pixelsResult, presselsResult, statsResult, topStatesResult, hourlyTrafficResult, botsResult] = await Promise.all([settingsPromise, pixelsPromise, presselsPromise, statsPromise, topStatesPromise, hourlyTrafficPromise, botsPromise]);

        res.json({
            settings: settingsResult[0] || {},
            pixels: pixelsResult || [],
            pressels: presselsResult || [],
            stats: statsResult[0] || { clicks: 0, pix_generated: 0, pix_paid: 0 },
            topStates: topStatesResult || [],
            hourlyTraffic: hourlyTrafficResult || [],
            bots: botsResult || []
        });
    } catch (error) { 
        res.status(500).json({ message: 'Erro ao buscar dados do dashboard.' }); 
    }
});

// Rotas de Configurações, Pixels e Bots
app.put('/api/sellers/update-settings', authenticateJwt, async (req, res) => {
    const { pushinpay_token } = req.body;
    try {
        await sql`UPDATE sellers SET pushinpay_token = ${pushinpay_token} WHERE id = ${req.user.id}`;
        res.status(200).json({ message: 'Configurações atualizadas com sucesso.' });
    } catch (error) { res.status(500).json({ message: 'Erro ao atualizar configurações.' }); }
});
app.post('/api/pixels', authenticateJwt, async (req, res) => { /* ...código anterior... */ });
app.put('/api/pixels/:id', authenticateJwt, async (req, res) => { /* ...código anterior... */ });
app.delete('/api/pixels/:id', authenticateJwt, async (req, res) => { /* ...código anterior... */ });
app.post('/api/bots', authenticateJwt, async (req, res) => {
    const { bot_name, bot_token } = req.body;
    if(!bot_name || !bot_token) return res.status(400).json({ message: 'Nome e token do bot são obrigatórios.' });
    try {
        const newBot = await sql`INSERT INTO telegram_bots (seller_id, bot_name, bot_token) VALUES (${req.user.id}, ${bot_name}, ${bot_token}) RETURNING *;`;
        res.status(201).json(newBot[0]);
    } catch (error) { res.status(500).json({ message: 'Erro ao salvar o bot.' }); }
});
app.delete('/api/bots/:id', authenticateJwt, async (req, res) => {
    const { id } = req.params;
    try {
        const deleted = await sql`DELETE FROM telegram_bots WHERE id = ${id} AND seller_id = ${req.user.id} RETURNING id;`;
        if (deleted.length === 0) return res.status(404).json({ message: 'Bot não encontrado.' });
        res.status(204).send();
    } catch (error) { res.status(500).json({ message: 'Erro ao excluir o bot.' }); }
});


// Rotas de Pressel
app.post('/api/pressels', authenticateJwt, async (req, res) => {
    const { name, pixel_config_id, bot_id, white_page_url, redirect_desktop, redirect_mobile } = req.body;
    if (!name || !pixel_config_id || !bot_id || !white_page_url) return res.status(400).json({ message: 'Todos os campos da pressel são obrigatórios.' });
    try {
        const botResult = await sql`SELECT bot_name FROM telegram_bots WHERE id = ${bot_id} AND seller_id = ${req.user.id}`;
        if (botResult.length === 0) return res.status(404).json({ message: 'Bot selecionado não encontrado.' });
        const bot_name = botResult[0].bot_name;

        const newPressel = await sql`INSERT INTO pressels (seller_id, name, pixel_config_id, bot_id, bot_name, white_page_url, redirect_desktop, redirect_mobile) VALUES (${req.user.id}, ${name}, ${pixel_config_id}, ${bot_id}, ${bot_name}, ${white_page_url}, ${redirect_desktop}, ${redirect_mobile}) RETURNING *;`;
        res.status(201).json(newPressel[0]);
    } catch (error) { res.status(500).json({ message: 'Erro ao salvar a pressel.' }); }
});
app.delete('/api/pressels/:id', authenticateJwt, async (req, res) => {
    const { id } = req.params;
    try {
        await sql`DELETE FROM clicks WHERE pressel_id = ${id} AND seller_id = ${req.user.id}`;
        const deleted = await sql`DELETE FROM pressels WHERE id = ${id} AND seller_id = ${req.user.id} RETURNING id;`;
        if (deleted.length === 0) return res.status(404).json({ message: 'Pressel não encontrada.' });
        res.status(204).send();
    } catch (error) { res.status(500).json({ message: 'Erro ao excluir a pressel.' }); }
});

// Rota de Registro de Clique
app.post('/api/registerClick', async (req, res) => {
    const { sellerApiKey, referer, fbclid, fbp, presselId } = req.body;
    if (!sellerApiKey || !presselId) return res.status(400).json({ message: 'Identificação do vendedor e da pressel são necessárias.' });
    try {
        const sellerResult = await sql`SELECT id FROM sellers WHERE api_key = ${sellerApiKey}`;
        if (sellerResult.length === 0) return res.status(404).json({ message: 'Vendedor não encontrado.' });
        
        const seller_id = sellerResult[0].id;
        const ip_address = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        const user_agent = req.headers['user-agent'];
        const { city, state } = await getGeoFromIp(ip_address.split(',')[0].trim());

        const result = await sql`INSERT INTO clicks (seller_id, pressel_id, ip_address, user_agent, referer, city, state, fbclid, fbp) VALUES (${seller_id}, ${presselId}, ${ip_address}, ${user_agent}, ${referer}, ${city}, ${state}, ${fbclid}, ${fbp}) RETURNING id;`;
        
        const generatedId = result[0].id;
        const cleanClickId = `lead${generatedId.toString().padStart(6, '0')}`;
        const clickIdForDb = `/start ${cleanClickId}`;
        await sql`UPDATE clicks SET click_id = ${clickIdForDb} WHERE id = ${generatedId}`;

        res.status(200).json({ status: 'success', message: 'Click registrado', click_id: cleanClickId });
    } catch (error) { res.status(500).json({ message: 'Erro interno do servidor.' }); }
});

// Rotas do ManyChat
app.post('/api/manychat/update-customer-data', authenticateApiKey, async (req, res) => { /* ...código anterior... */ });
app.post('/api/manychat/get-city', authenticateApiKey, async (req, res) => { /* ...código anterior... */ });
app.post('/api/manychat/generate-pix', authenticateApiKey, async (req, res) => { /* ...código anterior... */ });
app.post('/api/manychat/check-status-by-clickid', authenticateApiKey, async (req, res) => { /* ...código anterior... */ });

// Webhook
app.post('/api/webhooks/pushinpay', async (req, res) => { /* ...código anterior... */ });

// Função para enviar conversão para a Meta
async function sendConversionToMeta(clickData) { /* ...código anterior... */ }

module.exports = app;
