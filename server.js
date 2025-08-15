// --- Dependências ---
const express = require('express');
const cors = require('cors');
const { neon } = require('@neondatabase/serverless');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// --- Inicialização do App ---
const app = express();
app.use(cors());
app.use(express.json());

// --- Configurações ---
const sql = neon(process.env.DATABASE_URL);
const JWT_SECRET = process.env.JWT_SECRET || 'seu-segredo-jwt-super-secreto-padrao';

// --- Funções Utilitárias ---
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

// --- Middlewares de Autenticação ---
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
        console.error('API Key Auth Error:', error);
        res.status(500).json({ message: 'Erro interno do servidor.' }); 
    }
}

// --- Rotas de Autenticação de Vendedores ---
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
    } catch (error) { 
        console.error('Register Error:', error);
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
        console.error('Login Error:', error);
        res.status(500).json({ message: 'Erro interno do servidor.' }); 
    }
});

// --- Rotas do Dashboard ---
app.get('/api/dashboard/data', authenticateJwt, async (req, res) => {
    try {
        const sellerId = req.user.id;
        
        const settingsPromise = sql`SELECT name, email, pushinpay_token, api_key FROM sellers WHERE id = ${sellerId}`;
        const pixelsPromise = sql`SELECT * FROM pixel_configurations WHERE seller_id = ${sellerId} ORDER BY created_at DESC`;
        
        const statsPromise = sql`
            SELECT 
                (SELECT COUNT(*) FROM pix_transactions pt JOIN clicks c ON pt.click_id_internal = c.id WHERE c.seller_id = ${sellerId}) AS pix_generated,
                (SELECT COUNT(*) FROM pix_transactions pt JOIN clicks c ON pt.click_id_internal = c.id WHERE c.seller_id = ${sellerId} AND pt.status = 'paid') AS pix_paid,
                (SELECT COALESCE(SUM(pt.value_cents), 0) FROM pix_transactions pt JOIN clicks c ON pt.click_id_internal = c.id WHERE c.seller_id = ${sellerId} AND pt.status = 'paid') / 100.0 AS total_revenue
        `;

        const topStatesPromise = sql`SELECT state, COUNT(*) as count FROM clicks WHERE seller_id = ${sellerId} AND state IS NOT NULL AND state NOT IN ('Desconhecido', 'Local', 'Erro') GROUP BY state ORDER BY count DESC LIMIT 5`;
        const topCampaignsPromise = sql`SELECT utm_campaign, COUNT(*) as count FROM clicks WHERE seller_id = ${sellerId} AND utm_campaign IS NOT NULL GROUP BY utm_campaign ORDER BY count DESC LIMIT 5`;
        const topSourcesPromise = sql`SELECT utm_source, COUNT(*) as count FROM clicks WHERE seller_id = ${sellerId} AND utm_source IS NOT NULL GROUP BY utm_source ORDER BY count DESC LIMIT 5`;
        
        const topBotsPromise = sql`
            SELECT p.bot_name, COUNT(pt.id) as paid_count
            FROM pix_transactions pt
            JOIN clicks c ON pt.click_id_internal = c.id
            JOIN pressels p ON c.pressel_id = p.id
            WHERE pt.status = 'paid' AND p.seller_id = ${sellerId}
            GROUP BY p.bot_name
            ORDER BY paid_count DESC
            LIMIT 5;
        `;

        const [
            settingsResult, pixelsResult, statsResult, topStatesResult, 
            topCampaignsResult, topSourcesResult, topBotsResult
        ] = await Promise.all([
            settingsPromise, pixelsPromise, statsPromise, topStatesPromise, 
            topCampaignsPromise, topSourcesPromise, topBotsPromise
        ]);

        res.json({
            settings: settingsResult[0] || {},
            pixels: pixelsResult || [],
            stats: statsResult[0] || { pix_generated: 0, pix_paid: 0, total_revenue: 0 },
            topStates: topStatesResult || [],
            topCampaigns: topCampaignsResult || [],
            topSources: topSourcesResult || [],
            topBots: topBotsResult || [],
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
    } catch (error) { 
        console.error('Update Settings Error:', error);
        res.status(500).json({ message: 'Erro ao atualizar configurações.' }); 
    }
});

// --- Rotas de PIXELS (CRUD) ---
app.post('/api/pixels', authenticateJwt, async (req, res) => {
    const { account_name, pixel_id, meta_api_token } = req.body;
    if (!account_name || !pixel_id || !meta_api_token) {
        return res.status(400).json({ message: 'Todos os campos são obrigatórios.' });
    }
    try {
        const newPixel = await sql`
            INSERT INTO pixel_configurations (seller_id, account_name, pixel_id, meta_api_token)
            VALUES (${req.user.id}, ${account_name}, ${pixel_id}, ${meta_api_token})
            RETURNING *;
        `;
        res.status(201).json(newPixel[0]);
    } catch (error) {
        console.error('Create Pixel Error:', error);
        res.status(500).json({ message: 'Erro ao criar conta de pixel.' });
    }
});

app.put('/api/pixels/:id', authenticateJwt, async (req, res) => {
    const { id } = req.params;
    const { account_name, pixel_id, meta_api_token } = req.body;
    if (!account_name || !pixel_id || !meta_api_token) {
        return res.status(400).json({ message: 'Todos os campos são obrigatórios.' });
    }
    try {
        const updatedPixel = await sql`
            UPDATE pixel_configurations
            SET account_name = ${account_name}, pixel_id = ${pixel_id}, meta_api_token = ${meta_api_token}
            WHERE id = ${id} AND seller_id = ${req.user.id}
            RETURNING *;
        `;
        if (updatedPixel.length === 0) {
            return res.status(404).json({ message: 'Conta de pixel não encontrada.' });
        }
        res.status(200).json(updatedPixel[0]);
    } catch (error) {
        console.error('Update Pixel Error:', error);
        res.status(500).json({ message: 'Erro ao atualizar conta de pixel.' });
    }
});

app.delete('/api/pixels/:id', authenticateJwt, async (req, res) => {
    const { id } = req.params;
    try {
        const deleted = await sql`
            DELETE FROM pixel_configurations 
            WHERE id = ${id} AND seller_id = ${req.user.id} 
            RETURNING id;
        `;
        if (deleted.length === 0) {
            return res.status(404).json({ message: 'Conta de pixel não encontrada.' });
        }
        res.status(204).send();
    } catch (error) {
        console.error('Delete Pixel Error:', error);
        res.status(500).json({ message: 'Erro ao excluir conta de pixel.' });
    }
});


// --- ROTAS DE PRESSEL (CRUD - CORRIGIDO) ---
app.post('/api/pressels', authenticateJwt, async (req, res) => {
    const { name, pixel_ids, bot_name, white_page_url } = req.body;
    
    if (!name || !pixel_ids || pixel_ids.length === 0 || !bot_name || !white_page_url) {
        return res.status(400).json({ message: 'Todos os campos obrigatórios devem ser preenchidos.' });
    }
    const sanitizedBotName = bot_name.replace(/^@/, '');
    try {
        const newPressel = await sql`
            INSERT INTO pressels (seller_id, name, pixel_ids, bot_name, white_page_url)
            VALUES (${req.user.id}, ${name}, ${pixel_ids}, ${sanitizedBotName}, ${white_page_url})
            RETURNING *;
        `;
        res.status(201).json(newPressel[0]);
    } catch (error) {
        console.error("Create Pressel Error:", error);
        res.status(500).json({ message: 'Erro ao salvar a pressel.' });
    }
});

app.get('/api/pressels', authenticateJwt, async (req, res) => {
    try {
        const pressels = await sql`SELECT * FROM pressels WHERE seller_id = ${req.user.id} ORDER BY created_at DESC`;
        res.status(200).json(pressels);
    } catch (error) {
        console.error("Get Pressels Error:", error);
        res.status(500).json({ message: 'Erro ao buscar as pressels.' });
    }
});

app.delete('/api/pressels/:id', authenticateJwt, async (req, res) => {
    const { id } = req.params;
    try {
        await sql`DELETE FROM clicks WHERE pressel_id = ${id} AND seller_id = ${req.user.id}`;
        const deleted = await sql`DELETE FROM pressels WHERE id = ${id} AND seller_id = ${req.user.id} RETURNING id;`;
        if (deleted.length === 0) return res.status(404).json({ message: 'Pressel não encontrada.' });
        res.status(204).send();
    } catch (error) {
        console.error("Delete Pressel Error:", error);
        res.status(500).json({ message: 'Erro ao excluir a pressel.' });
    }
});


// --- Rota de Registro de Clique ---
app.post('/api/registerClick', async (req, res) => {
    const { 
        sellerApiKey, presselId, referer, fbclid, fbp,
        utm_source, utm_medium, utm_campaign, utm_term, utm_content, user_agent
    } = req.body;

    if (!sellerApiKey || !presselId) return res.status(400).json({ message: 'sellerApiKey e presselId são obrigatórios' });

    try {
        const sellerResult = await sql`SELECT id FROM sellers WHERE api_key = ${sellerApiKey}`;
        if (sellerResult.length === 0) return res.status(403).json({ message: 'Chave de API inválida.' });
        const seller_id = sellerResult[0].id;

        const click_id_internal = uuidv4();
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        const { city, state } = await getGeoFromIp(ip);
        
        await sql`
            INSERT INTO clicks (
                id, seller_id, pressel_id, ip_address, city, state, referer, fbclid, fbp,
                utm_source, utm_medium, utm_campaign, utm_term, utm_content, user_agent
            ) VALUES (
                ${click_id_internal}, ${seller_id}, ${presselId}, ${ip}, ${city}, ${state}, ${referer}, ${fbclid}, ${fbp},
                ${utm_source}, ${utm_medium}, ${utm_campaign}, ${utm_term}, ${utm_content}, ${user_agent}
            )
        `;
        
        res.status(200).json({ click_id: click_id_internal });
    } catch (error) {
        console.error('Erro ao registrar clique:', error);
        res.status(500).json({});
    }
});


// --- Rotas do ManyChat (Exemplos) ---
app.post('/api/manychat/generate-pix', authenticateApiKey, async (req, res) => {
    res.status(501).json({ message: 'Endpoint de geração de PIX não implementado.' });
});

app.post('/api/manychat/check-status-by-clickid', authenticateApiKey, async (req, res) => {
    res.status(501).json({ message: 'Endpoint de checagem de status não implementado.' });
});

// --- Webhook (Exemplo) ---
app.post('/api/webhooks/pushinpay', async (req, res) => {
    console.log('Webhook PushinPay recebido:', req.body);
    res.status(200).send('OK');
});

// --- Função para enviar conversão para a Meta (Exemplo) ---
async function sendConversionToMeta(clickData) {
    console.log('Enviando conversão para a Meta para o clique:', clickData.id);
}

// --- Exportação para Vercel ---
module.exports = app;
