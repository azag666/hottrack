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

// Funções Utilitárias e Middlewares (sem alterações)
async function getGeoFromIp(ip) { /* ...código anterior... */ }
async function authenticateJwt(req, res, next) { /* ...código anterior... */ }
async function authenticateApiKey(req, res, next) { /* ...código anterior... */ }
app.post('/api/sellers/register', async (req, res) => { /* ...código anterior... */ });
app.post('/api/sellers/login', async (req, res) => { /* ...código anterior... */ });

// Rota do Dashboard (CORRIGIDA E ALINHADA)
app.get('/api/dashboard/data', authenticateJwt, async (req, res) => {
    try {
        const settingsPromise = sql`SELECT id, name, email, pushinpay_token, api_key FROM sellers WHERE id = ${req.user.id}`;
        const pixelsPromise = sql`SELECT * FROM pixel_configurations WHERE seller_id = ${req.user.id} ORDER BY created_at DESC`;
        
        // Query de pressels agora busca os IDs de pixel associados
        const presselsPromise = sql`
            SELECT p.*, COALESCE(px.pixel_ids, ARRAY[]::integer[]) as pixel_ids
            FROM pressels p
            LEFT JOIN (
                SELECT pressel_id, array_agg(pixel_config_id) as pixel_ids
                FROM pressel_pixels
                GROUP BY pressel_id
            ) px ON p.id = px.pressel_id
            WHERE p.seller_id = ${req.user.id}
            ORDER BY p.created_at DESC
        `;
        
        const statsPromise = sql`
            SELECT 
                COUNT(c.id) AS clicks,
                COUNT(c.pix_id) AS pix_generated,
                COUNT(c.id) FILTER (WHERE c.is_converted = TRUE) AS pix_paid
            FROM clicks c
            WHERE c.seller_id = ${req.user.id} AND c.timestamp >= NOW() - INTERVAL '30 days'
        `;
        
        const topStatesPromise = sql`SELECT state, COUNT(id) as count FROM clicks WHERE seller_id = ${req.user.id} AND state IS NOT NULL AND state NOT IN ('Desconhecido', 'Local', 'Erro') GROUP BY state ORDER BY count DESC LIMIT 5`;
        const botsPromise = sql`SELECT id, bot_name FROM telegram_bots WHERE seller_id = ${req.user.id}`;

        const [settingsResult, pixelsResult, presselsResult, statsResult, topStatesResult, botsResult] = await Promise.all([settingsPromise, pixelsPromise, presselsPromise, statsPromise, topStatesPromise, botsPromise]);

        res.json({
            settings: settingsResult[0] || {},
            pixels: pixelsResult || [],
            pressels: presselsResult || [],
            stats: statsResult[0] || { clicks: 0, pix_generated: 0, pix_paid: 0 },
            topStates: topStatesResult || [],
            bots: botsResult || []
        });
    } catch (error) { 
        console.error("Erro dashboard:", error);
        res.status(500).json({ message: 'Erro ao buscar dados do dashboard.' }); 
    }
});

// Rota de Configurações (sem alterações)
app.put('/api/sellers/update-settings', authenticateJwt, async (req, res) => { /* ...código anterior... */ });

// ROTAS DE PIXELS (CORRIGIDAS PARA USAR 'account_name')
app.post('/api/pixels', authenticateJwt, async (req, res) => {
    const { account_name, pixel_id, meta_api_token } = req.body; // Adicionado account_name
    if (!account_name || !pixel_id || !meta_api_token) return res.status(400).json({ message: 'Nome da Conta, ID do Pixel e Token são obrigatórios.' });
    try {
        const newPixel = await sql`INSERT INTO pixel_configurations (seller_id, account_name, pixel_id, meta_api_token) VALUES (${req.user.id}, ${account_name}, ${pixel_id}, ${meta_api_token}) RETURNING *;`;
        res.status(201).json(newPixel[0]);
    } catch (error) { res.status(500).json({ message: 'Erro ao salvar o pixel.' }); }
});

app.put('/api/pixels/:id', authenticateJwt, async (req, res) => {
    const { id } = req.params;
    const { account_name, pixel_id, meta_api_token } = req.body;
    if (!account_name || !pixel_id || !meta_api_token) return res.status(400).json({ message: 'Todos os campos são obrigatórios.' });
    try {
        const updated = await sql`UPDATE pixel_configurations SET account_name = ${account_name}, pixel_id = ${pixel_id}, meta_api_token = ${meta_api_token} WHERE id = ${id} AND seller_id = ${req.user.id} RETURNING *;`;
        if (updated.length === 0) return res.status(404).json({ message: 'Pixel não encontrado.' });
        res.status(200).json(updated[0]);
    } catch(error) { res.status(500).json({ message: 'Erro ao atualizar o pixel.' }); }
});

app.delete('/api/pixels/:id', authenticateJwt, async (req, res) => { /* ...código anterior... */ });

// ROTAS DE BOTS (sem alterações)
app.post('/api/bots', authenticateJwt, async (req, res) => { /* ...código anterior... */ });
app.delete('/api/bots/:id', authenticateJwt, async (req, res) => { /* ...código anterior... */ });

// ROTA DE PRESSELS (CORRIGIDA PARA MÚLTIPLOS PIXELS)
app.get('/api/pressels', authenticateJwt, async (req, res) => {
    try {
        const pressels = await sql`
            SELECT p.*, COALESCE(px.pixel_ids, ARRAY[]::integer[]) as pixel_ids
            FROM pressels p
            LEFT JOIN (
                SELECT pressel_id, array_agg(pixel_config_id) as pixel_ids
                FROM pressel_pixels
                GROUP BY pressel_id
            ) px ON p.id = px.pressel_id
            WHERE p.seller_id = ${req.user.id}
            ORDER BY p.created_at DESC
        `;
        res.status(200).json(pressels);
    } catch (error) {
        res.status(500).json({ message: 'Erro ao buscar pressels.' });
    }
});

app.post('/api/pressels', authenticateJwt, async (req, res) => {
    const { name, bot_id, white_page_url, pixel_ids, redirect_desktop, redirect_mobile } = req.body; // Recebe array 'pixel_ids'
    if (!name || !bot_id || !white_page_url || !pixel_ids) return res.status(400).json({ message: 'Todos os campos são obrigatórios.' });
    try {
        const botResult = await sql`SELECT bot_name FROM telegram_bots WHERE id = ${bot_id} AND seller_id = ${req.user.id}`;
        if (botResult.length === 0) return res.status(404).json({ message: 'Bot não encontrado.' });
        const bot_name = botResult[0].bot_name;

        // Transação para garantir consistência
        await sql.begin(async sql => {
            const newPressel = await sql`
                INSERT INTO pressels (seller_id, name, bot_id, bot_name, white_page_url, redirect_desktop, redirect_mobile) 
                VALUES (${req.user.id}, ${name}, ${bot_id}, ${bot_name}, ${white_page_url}, ${redirect_desktop || null}, ${redirect_mobile || null}) 
                RETURNING *;`;
            
            const presselId = newPressel[0].id;

            // Insere na tabela de ligação
            if (pixel_ids && pixel_ids.length > 0) {
                for (const pixelId of pixel_ids) {
                    await sql`INSERT INTO pressel_pixels (pressel_id, pixel_config_id) VALUES (${presselId}, ${pixelId});`;
                }
            }
            
            const finalPressel = { ...newPressel[0], pixel_ids: pixel_ids };
            res.status(201).json(finalPressel);
        });
    } catch (error) {
        console.error("Erro ao salvar pressel:", error);
        res.status(500).json({ message: 'Erro ao salvar a pressel.' });
    }
});

app.delete('/api/pressels/:id', authenticateJwt, async (req, res) => { /* ...código anterior... */ });

// Rota de Registro de Clique (sem alterações)
app.post('/api/registerClick', async (req, res) => { /* ...código anterior... */ });

module.exports = app;
