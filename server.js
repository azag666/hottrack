const express = require('express');
const cors = require('cors');
const { neon } = require('@neondatabase/serverless');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken'); // Para autenticação de sessão

const app = express();
app.use(cors());
app.use(express.json());

const sql = neon(process.env.DATABASE_URL);
const JWT_SECRET = process.env.JWT_SECRET || 'seu-segredo-jwt-super-secreto';

// #################### MIDDLEWARES DE AUTENTICAÇÃO ###################

// Middleware para autenticar usuários logados (Dashboard)
async function authenticateJwt(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
        return res.status(401).json({ message: 'Token não fornecido.' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ message: 'Token inválido ou expirado.' });
        }
        req.user = user;
        next();
    });
}

// Middleware para autenticar chaves de API (ManyChat, Presell)
async function authenticateApiKey(req, res, next) {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ message: 'Chave de API não fornecida.' });
    
    try {
        const sellerResult = await sql`SELECT id, pushinpay_token FROM sellers WHERE api_key = ${apiKey}`;
        if (sellerResult.length === 0) return res.status(403).json({ message: 'Chave de API inválida.' });
        req.seller = sellerResult[0];
        next();
    } catch (error) {
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
}

// #################### ROTAS DE AUTENTICAÇÃO E USUÁRIOS ###################

app.post('/api/sellers/register', async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
        return res.status(400).json({ message: 'Nome, email e senha são obrigatórios.' });
    }
    try {
        const existingSeller = await sql`SELECT id FROM sellers WHERE email = ${email}`;
        if (existingSeller.length > 0) {
            return res.status(409).json({ message: 'Este email já está em uso.' });
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        const apiKey = uuidv4();
        const newSeller = await sql`
            INSERT INTO sellers (name, email, password_hash, api_key)
            VALUES (${name}, ${email}, ${hashedPassword}, ${apiKey})
            RETURNING id, name, email, api_key;
        `;
        res.status(201).json({ message: 'Vendedor cadastrado com sucesso!', seller: newSeller[0] });
    } catch (error) {
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
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
});

// #################### ROTAS DO DASHBOARD (PROTEGIDAS COM JWT) ###################

app.get('/api/dashboard/data', authenticateJwt, async (req, res) => {
    try {
        const settings = await sql`SELECT name, email, pushinpay_token, bot_name FROM sellers WHERE id = ${req.user.id}`;
        const pixels = await sql`SELECT * FROM pixel_configurations WHERE seller_id = ${req.user.id} ORDER BY created_at DESC`;
        res.json({
            settings: settings[0],
            pixels: pixels
        });
    } catch (error) {
        res.status(500).json({ message: 'Erro ao buscar dados do dashboard.' });
    }
});

app.put('/api/sellers/update-settings', authenticateJwt, async (req, res) => {
    const { pushinpay_token, bot_name } = req.body;
    try {
        await sql`
            UPDATE sellers 
            SET pushinpay_token = ${pushinpay_token}, bot_name = ${bot_name}
            WHERE id = ${req.user.id}
        `;
        res.status(200).json({ message: 'Configurações atualizadas com sucesso.' });
    } catch (error) {
        res.status(500).json({ message: 'Erro ao atualizar configurações.' });
    }
});

app.post('/api/pixels', authenticateJwt, async (req, res) => {
    const { account_name, pixel_id, meta_api_token } = req.body;
    if (!account_name || !pixel_id || !meta_api_token) return res.status(400).json({ message: 'Todos os campos são obrigatórios.' });
    try {
        const newPixel = await sql`
            INSERT INTO pixel_configurations (seller_id, account_name, pixel_id, meta_api_token)
            VALUES (${req.user.id}, ${account_name}, ${pixel_id}, ${meta_api_token})
            RETURNING *;
        `;
        res.status(201).json(newPixel[0]);
    } catch (error) {
        res.status(500).json({ message: 'Erro ao adicionar conta de pixel.' });
    }
});

app.put('/api/pixels/:id', authenticateJwt, async (req, res) => {
    const { id } = req.params;
    const { account_name, pixel_id, meta_api_token } = req.body;
    try {
        const updated = await sql`
            UPDATE pixel_configurations
            SET account_name = ${account_name}, pixel_id = ${pixel_id}, meta_api_token = ${meta_api_token}
            WHERE id = ${id} AND seller_id = ${req.user.id}
            RETURNING *;
        `;
        if (updated.length === 0) return res.status(404).json({ message: 'Conta de pixel não encontrada.' });
        res.status(200).json(updated[0]);
    } catch (error) {
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
        if (deleted.length === 0) return res.status(404).json({ message: 'Conta de pixel não encontrada.' });
        res.status(204).send(); // No content
    } catch (error) {
        res.status(500).json({ message: 'Erro ao excluir conta de pixel.' });
    }
});


// #################### ROTAS PÚBLICAS E DE SERVIÇO ###################
// (As rotas abaixo continuam como antes, mas com pequenas adaptações)

app.post('/api/registerClick', async (req, res) => {
    const { sellerApiKey, referer, fbclid, fbp } = req.body;
    if (!sellerApiKey) return res.status(400).json({ message: 'Identificação do vendedor é necessária.' });
    try {
        const sellerResult = await sql`SELECT id FROM sellers WHERE api_key = ${sellerApiKey}`;
        if (sellerResult.length === 0) return res.status(404).json({ message: 'Vendedor não encontrado.' });
        
        const seller_id = sellerResult[0].id;
        const ip_address = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        const user_agent = req.headers['user-agent'];
        const { city, state } = {city: 'Unknown', state: 'Unknown'}; // Simplificado para evitar chamadas de API externas no registro de clique

        const result = await sql`
            INSERT INTO clicks (seller_id, ip_address, user_agent, referer, city, state, fbclid, fbp)
            VALUES (${seller_id}, ${ip_address}, ${user_agent}, ${referer}, ${city}, ${state}, ${fbclid}, ${fbp}) 
            RETURNING id;
        `;
        
        const generatedId = result[0].id;
        const clickId = `lead${generatedId.toString().padStart(6, '0')}`;
        await sql`UPDATE clicks SET click_id = ${clickId} WHERE id = ${generatedId}`;
        res.status(200).json({ status: 'success', message: 'Click registrado', click_id: clickId });
    } catch (error) {
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
});

// Demais rotas (manychat, webhook, etc.) continuam aqui...
// ... (O restante do código do server.js anterior pode ser mantido, com as devidas adaptações se necessário)

module.exports = app;
