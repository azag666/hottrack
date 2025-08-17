const express = require('express');
const cors = require('cors');
const { neon } = require('@neondatabase/serverless');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json());

const sql = neon(process.env.DATABASE_URL);
const JWT_SECRET = process.env.JWT_SECRET || 'seu-segredo-super-secreto';

// MIDDLEWARE DE AUTENTICAÇÃO
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

// ROTAS DE AUTENTICAÇÃO
app.post('/api/sellers/register', async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password || password.length < 8) {
        return res.status(400).json({ message: 'Dados inválidos.' });
    }
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

// ROTA PARA BUSCAR TODOS OS DADOS DO PAINEL
app.get('/api/dashboard/data', authenticateJwt, async (req, res) => {
    try {
        const sellerId = req.user.id;
        const settingsPromise = sql`SELECT api_key FROM sellers WHERE id = ${sellerId}`;
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
            settings: settings[0] || {},
            pixels: pixels || [],
            pressels: pressels || [],
            bots: bots || [],
        });
    } catch (error) { 
        console.error("Erro ao buscar dados do dashboard:", error);
        res.status(500).json({ message: 'Erro ao buscar dados.' }); 
    }
});

// ROTAS DE PIXELS, BOTS, PRESSELS
app.post('/api/pixels', authenticateJwt, async (req, res) => {
    const { account_name, pixel_id, meta_api_token } = req.body;
    if (!account_name || !pixel_id || !meta_api_token) return res.status(400).json({ message: 'Todos os campos são obrigatórios.' });
    try {
        const newPixel = await sql`INSERT INTO pixel_configurations (seller_id, account_name, pixel_id, meta_api_token) VALUES (${req.user.id}, ${account_name}, ${pixel_id}, ${meta_api_token}) RETURNING *;`;
        res.status(201).json(newPixel[0]);
    } catch (error) { res.status(500).json({ message: 'Erro ao salvar o pixel.' }); }
});

app.post('/api/bots', authenticateJwt, async (req, res) => {
    const { bot_name, bot_token } = req.body;
    if(!bot_name || !bot_token) return res.status(400).json({ message: 'Nome e token são obrigatórios.' });
    try {
        const newBot = await sql`INSERT INTO telegram_bots (seller_id, bot_name, bot_token) VALUES (${req.user.id}, ${bot_name}, ${bot_token}) RETURNING *;`;
        res.status(201).json(newBot[0]);
    } catch (error) { res.status(500).json({ message: 'Erro ao salvar o bot.' }); }
});

app.post('/api/pressels', authenticateJwt, async (req, res) => {
    const { name, bot_id, white_page_url, pixel_ids } = req.body;
    if (!name || !bot_id || !white_page_url || !pixel_ids || pixel_ids.length === 0) return res.status(400).json({ message: 'Todos os campos são obrigatórios.' });
    try {
        const botResult = await sql`SELECT bot_name FROM telegram_bots WHERE id = ${bot_id} AND seller_id = ${req.user.id}`;
        if (botResult.length === 0) return res.status(404).json({ message: 'Bot não encontrado.' });
        const bot_name = botResult[0].bot_name;
        let finalPressel = {};

        await sql.begin(async sql => {
            const newPresselResult = await sql`INSERT INTO pressels (seller_id, name, bot_id, bot_name, white_page_url) VALUES (${req.user.id}, ${name}, ${bot_id}, ${bot_name}, ${white_page_url}) RETURNING *;`;
            const presselId = newPresselResult[0].id;
            for (const pixelId of pixel_ids) {
                await sql`INSERT INTO pressel_pixels (pressel_id, pixel_config_id) VALUES (${presselId}, ${pixelId});`;
            }
            finalPressel = { ...newPresselResult[0], pixel_ids: pixel_ids };
        });
        res.status(201).json(finalPressel);
    } catch (error) {
        res.status(500).json({ message: 'Erro ao salvar a pressel.' });
    }
});

// ROTA PÚBLICA PARA REGISTRO DE CLIQUES
app.post('/api/registerClick', async (req, res) => {
    const { sellerApiKey, presselId } = req.body;
    if (!sellerApiKey || !presselId) return res.status(400).json({ message: 'Dados insuficientes.' });
    try {
        const result = await sql`INSERT INTO clicks (seller_id, pressel_id) SELECT s.id, ${presselId} FROM sellers s WHERE s.api_key = ${sellerApiKey} RETURNING id;`;
        if (result.length === 0) return res.status(404).json({ message: 'Vendedor ou pressel inválida' });

        const click_id = `click_${result[0].id}_${Date.now()}`;
        await sql`UPDATE clicks SET click_id = ${click_id} WHERE id = ${result[0].id}`;
        res.status(200).json({ status: 'success', click_id: click_id });
    } catch (error) {
        console.error("Erro ao registrar clique:", error);
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
});

module.exports = app;
