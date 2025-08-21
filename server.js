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

// --- MIDDLEWARES ---
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

function authenticateAdmin(req, res, next) {
    const adminKey = req.headers['x-admin-api-key'];
    if (!adminKey || adminKey !== ADMIN_API_KEY) {
        return res.status(403).json({ message: 'Acesso negado. Chave de administrador inválida.' });
    }
    next();
}

// --- ROTAS DE AUTENTICAÇÃO ---
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

// --- ROTA DE DADOS DO PAINEL DO USUÁRIO ---
// (Cole suas rotas de usuário aqui, como /api/dashboard/data, /api/pixels, etc.)

// --- ROTA DE GERAÇÃO DE PIX COM COMISSÃO CUSTOMIZADA ---
app.post('/api/pix/generate', async (req, res) => {
    // (Cole aqui o código da sua rota /api/pix/generate que já tem a lógica de comissão)
    // Lembre-se de adicionar a verificação de seller.is_active === false
});

// (Cole aqui o resto das suas rotas de usuário, como check-status e webhooks)


// ######################################################################
// ### ROTAS DO PAINEL ADMINISTRATIVO (SEÇÃO CORRIGIDA)               ###
// ######################################################################

app.get('/api/admin/dashboard', authenticateAdmin, async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        
        const totalSellers = await sql`SELECT COUNT(*) FROM sellers;`;

        // LÓGICA DE FILTRO CORRIGIDA
        let baseQuery = sql`SELECT COUNT(pt.id) as count, SUM(pt.pix_value) as total_revenue FROM pix_transactions pt WHERE pt.status = 'paid'`;
        
        if (startDate && endDate) {
            const inclusiveEndDate = new Date(endDate);
            inclusiveEndDate.setDate(inclusiveEndDate.getDate() + 1);
            baseQuery.append(sql` AND pt.created_at >= ${startDate} AND pt.created_at < ${inclusiveEndDate.toISOString().split('T')[0]}`);
        }
        
        const paidTransactions = await baseQuery;

        const total_sellers = parseInt(totalSellers[0].count);
        const total_paid_transactions = parseInt(paidTransactions[0].count || 0);
        const total_revenue = parseFloat(paidTransactions[0].total_revenue || 0);
        
        // ATENÇÃO: O cálculo de lucro aqui é uma estimativa global.
        // O cálculo exato precisaria somar as comissões de cada transação individualmente.
        const saas_profit = total_revenue * 0.0299; 

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

// (Cole aqui o resto das suas rotas admin: ranking, toggle-active, password, etc.)

// Rota para servir o arquivo HTML do painel admin
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ... (Resto do seu código, como a função checkPendingTransactions)

module.exports = app;
