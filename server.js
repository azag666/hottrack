const express = require('express');
const cors = require('cors');
const { neon } = require('@neondatabase/serverless');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// --- CONFIGURAÇÃO ---
const sql = neon(process.env.DATABASE_URL);
const JWT_SECRET = process.env.JWT_SECRET || 'seu-segredo-super-secreto';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
const PUSHINPAY_SPLIT_ACCOUNT_ID = process.env.PUSHINPAY_SPLIT_ACCOUNT_ID;
const CNPAY_SPLIT_PRODUCER_ID = process.env.CNPAY_SPLIT_PRODUCER_ID;
const OASYFY_SPLIT_PRODUCER_ID = process.env.OASYFY_SPLIT_PRODUCER_ID;

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

// --- ROTAS DE AUTENTICAÇÃO (CORRIGIDAS) ---
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
    } catch (error) { res.status(500).json({ message: 'Erro interno do servidor.' }); }
});

app.post('/api/sellers/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Email e senha são obrigatórios.' });
    try {
        const sellerResult = await sql`SELECT * FROM sellers WHERE email = ${email}`;
        if (sellerResult.length === 0) return res.status(404).json({ message: 'Usuário não encontrado.' });
        const seller = sellerResult[0];

        if (seller.is_active === false) {
            return res.status(403).json({ message: 'Este usuário está bloqueado.' });
        }
        
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

// --- ROTAS DE USUÁRIO (SEM MUDANÇAS) ---
// (Cole aqui suas rotas de usuário existentes: /api/dashboard/data, /api/pixels, etc.)

// --- ROTA DE GERAÇÃO DE PIX (CORRIGIDA) ---
app.post('/api/pix/generate', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    const { click_id, value_cents } = req.body;
    if (!apiKey || !click_id || !value_cents) return res.status(400).json({ message: 'API Key, click_id e value_cents são obrigatórios.' });

    try {
        const [seller] = await sql`
            SELECT id, active_pix_provider, is_active, pushinpay_token, cnpay_public_key, cnpay_secret_key, oasyfy_public_key, oasyfy_secret_key,
                   commission_percentage, commission_fixed_brl 
            FROM sellers WHERE api_key = ${apiKey}
        `;
        if (!seller) return res.status(401).json({ message: 'API Key inválida.' });
        if (seller.is_active === false) return res.status(403).json({ message: 'Usuário bloqueado.' });

        const [click] = await sql`SELECT id FROM clicks WHERE click_id = ${click_id} AND seller_id = ${seller.id}`;
        if (!click) return res.status(404).json({ message: 'Click ID não encontrado.' });
        
        let commission = 0;
        const value_brl = value_cents / 100;
        if (seller.commission_fixed_brl && seller.commission_fixed_brl > 0) {
            commission = seller.commission_fixed_brl;
        } else if (seller.commission_percentage && seller.commission_percentage > 0) {
            commission = parseFloat((value_brl * (seller.commission_percentage / 100)).toFixed(2));
        } else {
            commission = parseFloat((value_brl * 0.0299).toFixed(2));
        }

        // A lógica de geração de PIX para cada provedor continua a mesma,
        // apenas utilizando a variável 'commission' calculada acima.
        // O código foi omitido por brevidade, mas sua lógica original entra aqui.
        
        // Exemplo para PushInPay
        if (seller.active_pix_provider === 'pushinpay') {
             if (!seller.pushinpay_token) return res.status(400).json({ message: 'Token da PushinPay não configurado.' });
            
            let pushinpaySplitRules = [];
            const commission_cents = Math.round(commission * 100);
            if (apiKey !== ADMIN_API_KEY && commission_cents > 0) {
                pushinpaySplitRules.push({ value: commission_cents, account_id: PUSHINPAY_SPLIT_ACCOUNT_ID });
            }
            const payload = {
                value: value_cents,
                webhook_url: `https://${req.headers.host}/api/webhook/pushinpay`,
                split_rules: pushinpaySplitRules
            };
            const pushinpayResponse = await axios.post('https://api.pushinpay.com.br/api/pix/cashIn', payload, { headers: { Authorization: `Bearer ${seller.pushinpay_token}` } });
            // ... resto da lógica para salvar e responder
            res.json(pushinpayResponse.data); // simplificado
        }
        // ... adicione a lógica para os outros provedores aqui

    } catch (error) {
        console.error("Erro ao gerar PIX:", error.response?.data || error.message);
        res.status(500).json({ message: 'Erro ao gerar cobrança PIX.' });
    }
});


// (Cole aqui o restante das suas rotas de usuário: /api/pix/check-status, webhooks, etc.)


// ######################################################################
// ### INÍCIO DAS ROTAS DO PAINEL ADMINISTRATIVO (ATUALIZADO)         ###
// ######################################################################

function authenticateAdmin(req, res, next) {
    const adminKey = req.headers['x-admin-api-key'];
    if (!adminKey || adminKey !== ADMIN_API_KEY) {
        return res.status(403).json({ message: 'Acesso negado. Chave de administrador inválida.' });
    }
    next();
}

app.get('/api/admin/dashboard', authenticateAdmin, async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        let dateFilter = sql``;

        if (startDate && endDate) {
            const inclusiveEndDate = new Date(endDate);
            inclusiveEndDate.setDate(inclusiveEndDate.getDate() + 1);
            dateFilter = sql`WHERE pt.created_at >= ${startDate} AND pt.created_at < ${inclusiveEndDate.toISOString().split('T')[0]}`;
        }
        
        const totalSellers = await sql`SELECT COUNT(*) FROM sellers;`;
        const paidTransactions = await sql`SELECT COUNT(pt.id) as count, SUM(pt.pix_value) as total_revenue FROM pix_transactions pt ${dateFilter} WHERE pt.status = 'paid';`;

        const total_sellers = parseInt(totalSellers[0].count);
        const total_paid_transactions = parseInt(paidTransactions[0].count || 0);
        const total_revenue = parseFloat(paidTransactions[0].total_revenue || 0);
        const saas_profit = total_revenue * 0.0299; // Estimativa

        res.json({
            total_sellers,
            total_paid_transactions,
            total_revenue: total_revenue.toFixed(2),
            saas_profit: saas_profit.toFixed(2)
        });
    } catch (error) {
        console.error("Erro no dashboard admin:", error);
        res.status(500).json({ message: 'Erro ao buscar dados do dashboard.' });
    }
});

app.get('/api/admin/sellers', authenticateAdmin, async (req, res) => {
    try {
        const sellers = await sql`
            SELECT 
                s.id, s.name, s.email, s.created_at, s.is_active,
                s.active_pix_provider, s.pushinpay_token, s.cnpay_public_key, s.oasyfy_public_key,
                s.commission_percentage, s.commission_fixed_brl,
                (SELECT COUNT(*) FROM clicks c WHERE c.seller_id = s.id) as total_clicks,
                (SELECT COUNT(*) FROM pix_transactions pt JOIN clicks c ON pt.click_id_internal = c.id WHERE c.seller_id = s.id) as pix_generated,
                (SELECT COUNT(*) FROM pix_transactions pt JOIN clicks c ON pt.click_id_internal = c.id WHERE c.seller_id = s.id AND pt.status = 'paid') as pix_paid
            FROM sellers s 
            ORDER BY s.created_at DESC;
        `;
        res.json(sellers);
    } catch (error) {
        console.error("Erro ao listar vendedores:", error);
        res.status(500).json({ message: 'Erro ao listar vendedores.' });
    }
});

app.put('/api/admin/sellers/:id/commission', authenticateAdmin, async (req, res) => {
    const { id } = req.params;
    const { percentage, fixed } = req.body;
    try {
        await sql`
            UPDATE sellers 
            SET 
                commission_percentage = ${percentage || null},
                commission_fixed_brl = ${fixed || null}
            WHERE id = ${id};
        `;
        res.status(200).json({ message: 'Comissão atualizada com sucesso.' });
    } catch (error) {
        console.error("Erro ao atualizar comissão:", error);
        res.status(500).json({ message: 'Erro ao atualizar comissão.' });
    }
});

// (Cole aqui o resto das suas rotas de admin: ranking, toggle-active, password, etc.)

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

module.exports = app;
