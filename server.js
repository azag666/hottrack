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
app.post('/api/sellers/register', async (req, res) => { /* ...código anterior... */ });
app.post('/api/sellers/login', async (req, res) => { /* ...código anterior... */ });

// --- Rotas do Dashboard (CORRIGIDO) ---
app.get('/api/dashboard/data', authenticateJwt, async (req, res) => {
    try {
        const sellerId = req.user.id;
        
        // CORREÇÃO: As queries foram revisadas para garantir que reflitam 100% dos dados do vendedor logado.
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

// --- ROTAS DE PRESSEL (ATUALIZADAS para UI Simplificada) ---
app.post('/api/pressels', authenticateJwt, async (req, res) => {
    // Apenas os campos da nova UI
    const { name, pixel_ids, bot_name, white_page_url, redirect_url_a } = req.body;
    
    if (!name || !pixel_ids || pixel_ids.length === 0 || !bot_name || !white_page_url || !redirect_url_a) {
        return res.status(400).json({ message: 'Todos os campos obrigatórios devem ser preenchidos.' });
    }
    const sanitizedBotName = bot_name.replace(/^@/, '');

    try {
        // Inserindo NULL no campo redirect_url_b que não é mais usado no formulário
        const newPressel = await sql`
            INSERT INTO pressels (seller_id, name, pixel_ids, bot_name, white_page_url, redirect_url_a, redirect_url_b)
            VALUES (${req.user.id}, ${name}, ${pixel_ids}, ${sanitizedBotName}, ${white_page_url}, ${redirect_url_a}, NULL)
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


// --- Rota de Registro de Clique (sem alterações) ---
app.post('/api/registerClick', async (req, res) => { /* ...código anterior... */ });

// --- Demais Rotas (Pixels, ManyChat, Webhooks, etc. - sem alterações) ---
app.put('/api/sellers/update-settings', authenticateJwt, async (req, res) => { /* ...código anterior... */ });
app.post('/api/pixels', authenticateJwt, async (req, res) => { /* ...código anterior... */ });
app.put('/api/pixels/:id', authenticateJwt, async (req, res) => { /* ...código anterior... */ });
app.delete('/api/pixels/:id', authenticateJwt, async (req, res) => { /* ...código anterior... */ });
app.post('/api/manychat/generate-pix', authenticateApiKey, async (req, res) => { /* ...código anterior... */ });
app.post('/api/manychat/check-status-by-clickid', authenticateApiKey, async (req, res) => { /* ...código anterior... */ });
app.post('/api/webhooks/pushinpay', async (req, res) => { /* ...código anterior... */ });
async function sendConversionToMeta(clickData) { /* ...código anterior... */ }

// --- Exportação para Vercel ---
module.exports = app;
