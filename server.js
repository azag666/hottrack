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

// (O código de autenticação de sellers, CRUDs, etc., continua o mesmo)
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
// ... (Omitido por brevidade - cole aqui as suas rotas de usuário já existentes)

// --- ROTA DE GERAÇÃO DE PIX ATUALIZADA COM LÓGICA DE COMISSÃO CUSTOMIZADA ---
app.post('/api/pix/generate', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    const { click_id, value_cents } = req.body;
    if (!apiKey || !click_id || !value_cents) return res.status(400).json({ message: 'API Key, click_id e value_cents são obrigatórios.' });

    try {
        // ATUALIZAÇÃO: Busca também os campos de comissão customizada
        const [seller] = await sql`
            SELECT id, active_pix_provider, pushinpay_token, cnpay_public_key, cnpay_secret_key, oasyfy_public_key, oasyfy_secret_key,
                   commission_percentage, commission_fixed_brl 
            FROM sellers WHERE api_key = ${apiKey}
        `;
        if (!seller) return res.status(401).json({ message: 'API Key inválida.' });
        if (!seller.is_active) return res.status(403).json({ message: 'Usuário bloqueado.' });


        const [click] = await sql`SELECT id FROM clicks WHERE click_id = ${click_id} AND seller_id = ${seller.id}`;
        if (!click) return res.status(404).json({ message: 'Click ID não encontrado.' });
        const click_id_internal = click.id;

        // NOVA LÓGICA DE CÁLCULO DE COMISSÃO
        let commission = 0;
        const value_brl = value_cents / 100;
        if (seller.commission_fixed_brl && seller.commission_fixed_brl > 0) {
            commission = seller.commission_fixed_brl;
        } else if (seller.commission_percentage && seller.commission_percentage > 0) {
            commission = parseFloat((value_brl * (seller.commission_percentage / 100)).toFixed(2));
        } else {
            commission = parseFloat((value_brl * 0.0299).toFixed(2)); // Padrão de 2.99%
        }

        // Restante da lógica de geração de PIX (com a comissão calculada)
        if (seller.active_pix_provider === 'cnpay' || seller.active_pix_provider === 'oasyfy') {
            // ... (lógica CNPay/Oasyfy)
            const isCnpay = seller.active_pix_provider === 'cnpay';
            let splits = [];
            if (apiKey !== ADMIN_API_KEY && commission > 0) {
                const splitId = isCnpay ? CNPAY_SPLIT_PRODUCER_ID : OASYFY_SPLIT_PRODUCER_ID;
                splits.push({ producerId: splitId, amount: commission });
            }
            // ... resto do payload e chamada axios
        } else { // Padrão é PushinPay
            let pushinpaySplitRules = [];
            const commission_cents = Math.round(commission * 100);
            if (apiKey !== ADMIN_API_KEY && commission_cents > 0) {
                pushinpaySplitRules.push({ value: commission_cents, account_id: PUSHINPAY_SPLIT_ACCOUNT_ID });
            }
            // ... resto do payload e chamada axios
        }
        // O código completo para a geração do PIX foi omitido aqui para focar nas mudanças,
        // mas sua lógica original continua a mesma, apenas usando a variável `commission` calculada acima.

    } catch (error) {
        console.error("Erro ao gerar PIX:", error.response?.data || error.message);
        res.status(500).json({ message: 'Erro ao gerar cobrança PIX.' });
    }
});

// ... (O resto das suas rotas de usuário e webhooks continuam aqui)


// ######################################################################
// ### INÍCIO DAS ROTAS DO PAINEL ADMINISTRATIVO (ATUALIZADO)         ###
// ######################################################################

// Middleware para autenticação do Admin
function authenticateAdmin(req, res, next) {
    const adminKey = req.headers['x-admin-api-key'];
    if (!adminKey || adminKey !== ADMIN_API_KEY) {
        return res.status(403).json({ message: 'Acesso negado. Chave de administrador inválida.' });
    }
    next();
}

// Rota para o dashboard do admin com métricas globais e filtro de data
app.get('/api/admin/dashboard', authenticateAdmin, async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        let dateFilter = sql``;

        if (startDate && endDate) {
            // Adiciona 1 dia ao endDate para incluir o dia inteiro na consulta
            const inclusiveEndDate = new Date(endDate);
            inclusiveEndDate.setDate(inclusiveEndDate.getDate() + 1);
            dateFilter = sql`WHERE created_at >= ${startDate} AND created_at < ${inclusiveEndDate.toISOString().split('T')[0]}`;
        }
        
        const totalSellers = await sql`SELECT COUNT(*) FROM sellers;`;
        const paidTransactions = await sql`SELECT COUNT(*) as count, SUM(pix_value) as total_revenue FROM pix_transactions WHERE status = 'paid' ${dateFilter};`;

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
            saas_profit: saas_profit.toFixed(2) // Simplificado
        });
    } catch (error) {
        console.error("Erro no dashboard admin:", error);
        res.status(500).json({ message: 'Erro ao buscar dados do dashboard.' });
    }
});


// Rota para listar todos os sellers com suas métricas de uso e provedores
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

// Rota para definir comissão customizada para um seller
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


// ... (O resto das rotas admin e a rota para servir o index.html permanecem as mesmas)
// Rota para o ranking de sellers
app.get('/api/admin/ranking', authenticateAdmin, async (req, res) => {
    try {
        const ranking = await sql`
            SELECT
                s.id, s.name, s.email,
                COUNT(pt.id) AS total_sales,
                COALESCE(SUM(pt.pix_value), 0) AS total_revenue
            FROM sellers s
            LEFT JOIN clicks c ON s.id = c.seller_id
            LEFT JOIN pix_transactions pt ON c.id = pt.click_id_internal AND pt.status = 'paid'
            GROUP BY s.id, s.name, s.email
            ORDER BY total_revenue DESC
            LIMIT 20;
        `;
        res.json(ranking);
    } catch (error) {
        console.error("Erro no ranking de sellers:", error);
        res.status(500).json({ message: 'Erro ao buscar ranking.' });
    }
});
// (Omitido por brevidade - cole aqui as outras rotas admin: toggle-active, password, credentials, transactions)

// Rota para servir o arquivo HTML do painel admin
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

module.exports = app;
