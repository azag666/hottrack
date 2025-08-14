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
        const presselsPromise = sql`SELECT * FROM pressels WHERE seller_id = ${req.user.id} ORDER BY created_at DESC`;
        const statsPromise = sql`SELECT COUNT(pt.id) AS pix_generated, COUNT(pt.id) FILTER (WHERE pt.status = 'paid') AS pix_paid FROM pix_transactions pt JOIN clicks c ON pt.click_id_internal = c.id WHERE c.seller_id = ${req.user.id} AND pt.created_at >= NOW() - INTERVAL '30 days'`;
        const topStatesPromise = sql`SELECT state, COUNT(*) as count FROM clicks WHERE seller_id = ${req.user.id} AND state IS NOT NULL AND state != 'Desconhecido' AND state != 'Local' GROUP BY state ORDER BY count DESC LIMIT 5`;
        const hourlyTrafficPromise = sql`SELECT EXTRACT(HOUR FROM timestamp) as hour, COUNT(*) as count FROM clicks WHERE seller_id = ${req.user.id} AND timestamp >= NOW() - INTERVAL '1 day' GROUP BY hour ORDER BY hour`;

        const [settingsResult, pixelsResult, presselsResult, statsResult, topStatesResult, hourlyTrafficResult] = await Promise.all([settingsPromise, pixelsPromise, presselsPromise, statsPromise, topStatesPromise, hourlyTrafficPromise]);

        res.json({
            settings: settingsResult[0] || {},
            pixels: pixelsResult || [],
            pressels: presselsResult || [],
            stats: statsResult[0] || { pix_generated: 0, pix_paid: 0 },
            topStates: topStatesResult || [],
            hourlyTraffic: hourlyTrafficResult || []
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
app.post('/api/pixels', authenticateJwt, async (req, res) => { /* ...código anterior... */ });
app.put('/api/pixels/:id', authenticateJwt, async (req, res) => { /* ...código anterior... */ });
app.delete('/api/pixels/:id', authenticateJwt, async (req, res) => { /* ...código anterior... */ });

// ROTAS DE PRESSEL
app.post('/api/pressels', authenticateJwt, async (req, res) => {
    const { name, pixel_config_id, bot_name, white_page_url, redirect_desktop, redirect_mobile } = req.body;
    if (!name || !pixel_config_id || !bot_name || !white_page_url) {
        return res.status(400).json({ message: 'Todos os campos da pressel são obrigatórios.' });
    }
    try {
        const newPressel = await sql`
            INSERT INTO pressels (seller_id, name, pixel_config_id, bot_name, white_page_url, redirect_desktop, redirect_mobile)
            VALUES (${req.user.id}, ${name}, ${pixel_config_id}, ${bot_name}, ${white_page_url}, ${redirect_desktop}, ${redirect_mobile})
            RETURNING *;
        `;
        res.status(201).json(newPressel[0]);
    } catch (error) {
        console.error("Create Pressel Error:", error);
        res.status(500).json({ message: 'Erro ao salvar a pressel.' });
    }
});

app.delete('/api/pressels/:id', authenticateJwt, async (req, res) => {
    const { id } = req.params;
    try {
        const deleted = await sql`DELETE FROM pressels WHERE id = ${id} AND seller_id = ${req.user.id} RETURNING id;`;
        if (deleted.length === 0) return res.status(404).json({ message: 'Pressel não encontrada.' });
        res.status(204).send();
    } catch (error) {
        res.status(500).json({ message: 'Erro ao excluir a pressel.' });
    }
});

// Rota de Registro de Clique
app.post('/api/registerClick', async (req, res) => { /* ...código anterior... */ });

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
