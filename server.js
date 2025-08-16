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

// --- CONFIGURAÇÃO ---
// É ALTAMENTE RECOMENDADO USAR VARIÁVEIS DE AMBIENTE PARA DADOS SENSÍVEIS
const sql = neon(process.env.DATABASE_URL);
const JWT_SECRET = process.env.JWT_SECRET || 'seu-segredo-jwt-super-secreto-padrao';
const PUSHINPAY_API_URL = 'https://api.pushinpay.com.br';
// SUBSTITUA ESTES VALORES POR VARIÁVEIS DE AMBIENTE NO SEU PROVEDOR DE HOSPEDAGEM (EX: VERCEL)
const YOUR_PUSHINPAY_ACCOUNT_ID = process.env.PUSHINPAY_ACCOUNT_ID || '9F49A790-2C45-4413-9974-451D657314AF';
const SPLIT_VALUE_CENTS = 30; // 30 centavos

// --- FUNÇÕES UTILITÁRIAS ---
function sha256(value) {
    if (!value) return null;
    return crypto.createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');
}

async function getGeoFromIp(ip) {
    if (!ip || ip === '::1' || ip.startsWith('127.0.0.1')) return { city: 'Local', state: 'Local' };
    try {
        const response = await axios.get(`http://ip-api.com/json/${ip}?fields=status,city,regionName`);
        if (response.data && response.data.status === 'success') {
            return { city: response.data.city || 'Desconhecida', state: response.data.regionName || 'Desconhecido' };
        }
        return { city: 'Desconhecida', state: 'Desconhecido' };
    } catch (error) {
        console.error("Erro ao buscar geolocalização:", error);
        return { city: 'Erro', state: 'Erro' };
    }
}

// --- MIDDLEWARES DE AUTENTICAÇÃO ---
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
    } catch (error) {
        console.error("Erro na autenticação por API Key:", error);
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
}

// --- ROTAS DE AUTENTICAÇÃO ---
app.post('/api/sellers/register', async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ message: 'Nome, email e senha são obrigatórios.' });
    if (password.length < 8) return res.status(400).json({ message: 'A senha deve ter no mínimo 8 caracteres.' });
    try {
        const existingSeller = await sql`SELECT id FROM sellers WHERE email = ${email}`;
        if (existingSeller.length > 0) return res.status(409).json({ message: 'Este email já está em uso.' });
        
        const hashedPassword = await bcrypt.hash(password, 10);
        const apiKey = uuidv4();
        // O campo pushinpay_token não é mais obrigatório no registro
        const newSeller = await sql`INSERT INTO sellers (name, email, password_hash, api_key) VALUES (${name}, ${email}, ${hashedPassword}, ${apiKey}) RETURNING id, name, email, api_key;`;
        
        res.status(201).json({ message: 'Vendedor cadastrado com sucesso!', seller: newSeller[0] });
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
        
        const tokenPayload = { id: seller.id, email: seller.email, name: seller.name };
        const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '1d' });
        
        const { password_hash, ...sellerData } = seller;
        res.status(200).json({ message: 'Login bem-sucedido!', token, seller: sellerData });
    } catch (error) {
        console.error("Erro no login:", error);
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
});

// --- ROTA DO DASHBOARD (CORRIGIDA) ---
app.get('/api/dashboard/data', authenticateJwt, async (req, res) => {
    try {
        const { bot_name } = req.query;
        let filterClause = sql``;
        if (bot_name && bot_name !== 'all') {
             // O filtro agora é feito diretamente na tabela de pressels
            filterClause = sql`AND p.bot_name = ${bot_name}`;
        }

        const settingsPromise = sql`SELECT name, email, pushinpay_token FROM sellers WHERE id = ${req.user.id}`;
        // Corrigido para 'pixel_configurations'
        const pixelsPromise = sql`SELECT * FROM pixel_configurations WHERE seller_id = ${req.user.id} ORDER BY created_at DESC`;
        const presselsPromise = sql`SELECT * FROM pressels WHERE seller_id = ${req.user.id} ORDER BY created_at DESC`;
        const botsPromise = sql`SELECT id, bot_name FROM telegram_bots WHERE seller_id = ${req.user.id}`;

        // Consulta de estatísticas corrigida para usar apenas a tabela 'clicks'
        const statsPromise = sql`
            SELECT 
                COUNT(c.id) AS clicks,
                COUNT(c.pix_id) AS pix_generated,
                COUNT(c.id) FILTER (WHERE c.is_converted = TRUE) AS pix_paid
            FROM clicks c
            LEFT JOIN pressels p ON c.pressel_id = p.id
            WHERE c.seller_id = ${req.user.id} AND c.timestamp >= NOW() - INTERVAL '30 days'
            ${filterClause}
        `;
        
        const topStatesPromise = sql`SELECT c.state, COUNT(c.id) as count FROM clicks c LEFT JOIN pressels p ON c.pressel_id = p.id WHERE c.seller_id = ${req.user.id} AND c.state IS NOT NULL AND c.state != 'Desconhecido' AND c.state != 'Local' ${filterClause} GROUP BY c.state ORDER BY count DESC LIMIT 5`;
        const hourlyTrafficPromise = sql`SELECT EXTRACT(HOUR FROM c.timestamp) as hour, COUNT(c.id) as count FROM clicks c LEFT JOIN pressels p ON c.pressel_id = p.id WHERE c.seller_id = ${req.user.id} AND c.timestamp >= NOW() - INTERVAL '1 day' ${filterClause} GROUP BY hour ORDER BY hour`;

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
        console.error("Erro ao buscar dados do dashboard:", error);
        res.status(500).json({ message: 'Erro ao buscar dados do dashboard.' }); 
    }
});


// --- ROTAS DE CONFIGURAÇÕES, PIXELS E BOTS (COM CÓDIGO RESTAURADO) ---
app.put('/api/sellers/update-settings', authenticateJwt, async (req, res) => {
    const { pushinpay_token } = req.body;
    if (typeof pushinpay_token === 'undefined') {
        return res.status(400).json({ message: 'O token da PushinPay é obrigatório.' });
    }
    try {
        await sql`UPDATE sellers SET pushinpay_token = ${pushinpay_token} WHERE id = ${req.user.id}`;
        res.status(200).json({ message: 'Configurações atualizadas com sucesso.' });
    } catch (error) { 
        console.error("Erro ao atualizar configurações:", error);
        res.status(500).json({ message: 'Erro ao atualizar configurações.' }); 
    }
});

app.post('/api/pixels', authenticateJwt, async (req, res) => {
    const { pixel_id, meta_api_token } = req.body;
    if (!pixel_id || !meta_api_token) return res.status(400).json({ message: 'ID do Pixel e Token da API são obrigatórios.' });
    try {
        const newPixel = await sql`INSERT INTO pixel_configurations (seller_id, pixel_id, meta_api_token) VALUES (${req.user.id}, ${pixel_id}, ${meta_api_token}) RETURNING *;`;
        res.status(201).json(newPixel[0]);
    } catch (error) {
        if (error.code === '23505') { // Código de violação de unicidade
            return res.status(409).json({ message: 'Este Pixel ID já foi adicionado.' });
        }
        console.error("Erro ao adicionar pixel:", error);
        res.status(500).json({ message: 'Erro ao salvar a configuração do pixel.' });
    }
});

app.delete('/api/pixels/:id', authenticateJwt, async (req, res) => {
    const { id } = req.params;
    try {
        const deleted = await sql`DELETE FROM pixel_configurations WHERE id = ${id} AND seller_id = ${req.user.id} RETURNING id;`;
        if (deleted.length === 0) return res.status(404).json({ message: 'Configuração de pixel não encontrada.' });
        res.status(204).send();
    } catch (error) {
        console.error("Erro ao excluir pixel:", error);
        res.status(500).json({ message: 'Erro ao excluir a configuração do pixel.' });
    }
});

app.post('/api/bots', authenticateJwt, async (req, res) => {
    const { bot_name, bot_token } = req.body;
    if(!bot_name || !bot_token) return res.status(400).json({ message: 'Nome e token do bot são obrigatórios.' });
    try {
        const newBot = await sql`INSERT INTO telegram_bots (seller_id, bot_name, bot_token) VALUES (${req.user.id}, ${bot_name}, ${bot_token}) RETURNING *;`;
        res.status(201).json(newBot[0]);
    } catch (error) {
        if (error.code === '23505') {
            return res.status(409).json({ message: 'Este nome de bot já está em uso.' });
        }
        console.error("Erro ao salvar bot:", error);
        res.status(500).json({ message: 'Erro ao salvar o bot.' });
    }
});

app.delete('/api/bots/:id', authenticateJwt, async (req, res) => {
    const { id } = req.params;
    try {
        const deleted = await sql`DELETE FROM telegram_bots WHERE id = ${id} AND seller_id = ${req.user.id} RETURNING id;`;
        if (deleted.length === 0) return res.status(404).json({ message: 'Bot não encontrado.' });
        res.status(204).send();
    } catch (error) {
        console.error("Erro ao excluir bot:", error);
        res.status(500).json({ message: 'Erro ao excluir o bot.' });
    }
});

// --- ROTAS DE PRESSEL (CORRIGIDAS) ---
app.post('/api/pressels', authenticateJwt, async (req, res) => {
    // pixel_config_id é opcional agora
    const { name, bot_id, white_page_url, redirect_desktop, redirect_mobile, pixel_config_id } = req.body;
    if (!name || !bot_id || !white_page_url) return res.status(400).json({ message: 'Nome, Bot e URL da White Page são obrigatórios.' });
    try {
        const botResult = await sql`SELECT bot_name FROM telegram_bots WHERE id = ${bot_id} AND seller_id = ${req.user.id}`;
        if (botResult.length === 0) return res.status(404).json({ message: 'Bot selecionado não encontrado.' });
        const bot_name = botResult[0].bot_name;

        const newPressel = await sql`
            INSERT INTO pressels (seller_id, name, pixel_config_id, bot_id, bot_name, white_page_url, redirect_desktop, redirect_mobile) 
            VALUES (${req.user.id}, ${name}, ${pixel_config_id || null}, ${bot_id}, ${bot_name}, ${white_page_url}, ${redirect_desktop}, ${redirect_mobile}) 
            RETURNING *;`;
        res.status(201).json(newPressel[0]);
    } catch (error) {
        console.error("Erro ao salvar pressel:", error);
        res.status(500).json({ message: 'Erro ao salvar a pressel.' });
    }
});

app.delete('/api/pressels/:id', authenticateJwt, async (req, res) => {
    const { id } = req.params;
    try {
        // A exclusão em cascata no SQL cuidará dos cliques, mas é bom ter certeza
        await sql`DELETE FROM clicks WHERE pressel_id = ${id} AND seller_id = ${req.user.id}`;
        const deleted = await sql`DELETE FROM pressels WHERE id = ${id} AND seller_id = ${req.user.id} RETURNING id;`;
        if (deleted.length === 0) return res.status(404).json({ message: 'Pressel não encontrada.' });
        res.status(204).send();
    } catch (error) {
        console.error("Erro ao excluir pressel:", error);
        res.status(500).json({ message: 'Erro ao excluir a pressel.' });
    }
});

// --- ROTA DE REGISTRO DE CLIQUE (CORRIGIDA) ---
app.post('/api/registerClick', async (req, res) => {
    const { sellerApiKey, referer, fbclid, fbp, fbc, presselId } = req.body;
    if (!sellerApiKey || !presselId) return res.status(400).json({ message: 'Identificação do vendedor e da pressel são necessárias.' });
    
    try {
        const sellerResult = await sql`SELECT id FROM sellers WHERE api_key = ${sellerApiKey}`;
        if (sellerResult.length === 0) return res.status(404).json({ message: 'Vendedor não encontrado.' });
        
        const seller_id = sellerResult[0].id;
        // Valida se a pressel pertence ao vendedor
        const presselResult = await sql`SELECT id FROM pressels WHERE id = ${presselId} AND seller_id = ${seller_id}`;
        if (presselResult.length === 0) return res.status(403).json({ message: 'Pressel não pertence a este vendedor.' });

        const ip_address = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        const user_agent = req.headers['user-agent'];
        const { city, state } = await getGeoFromIp(ip_address.split(',')[0].trim());

        const result = await sql`
            INSERT INTO clicks (seller_id, pressel_id, ip_address, user_agent, referer, city, state, fbclid, fbp, fbc) 
            VALUES (${seller_id}, ${presselId}, ${ip_address}, ${user_agent}, ${referer}, ${city}, ${state}, ${fbclid}, ${fbp}, ${fbc}) 
            RETURNING id;`;
        
        const generatedId = result[0].id;
        // Gera um ID de clique mais limpo e amigável
        const cleanClickId = `lead${generatedId.toString().padStart(6, '0')}`;
        // O valor salvo no banco agora contém o comando /start para o Telegram
        const clickIdForDb = `/start ${cleanClickId}`;
        await sql`UPDATE clicks SET click_id = ${clickIdForDb} WHERE id = ${generatedId}`;

        // Retorna apenas o ID limpo para o frontend/cliente
        res.status(200).json({ status: 'success', message: 'Click registrado', click_id: cleanClickId });
    } catch (error) {
        console.error("Erro ao registrar clique:", error);
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
});


// As rotas do ManyChat e Webhook permanecem como placeholders, pois o código não foi fornecido.
// Se precisar implementá-las, o restante da estrutura agora está correto.

// app.post('/api/manychat/generate-pix', authenticateApiKey, async (req, res) => { /* ...código... */ });
// app.post('/api/webhooks/pushinpay', async (req, res) => { /* ...código... */ });


// A porta é gerenciada pela Vercel, não precisa de app.listen
module.exports = app;
