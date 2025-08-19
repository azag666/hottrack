const express = require('express');
const cors = require('cors');
const { neon } = require('@neondatabase/serverless');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// --- CONFIGURAÇÃO ---
const sql = neon(process.env.DATABASE_URL);
const JWT_SECRET = process.env.JWT_SECRET || 'seu-segredo-super-secreto';
const PUSHINPAY_SPLIT_ACCOUNT_ID = process.env.PUSHINPAY_SPLIT_ACCOUNT_ID;
const CNPAY_SPLIT_PRODUCER_ID = process.env.CNPAY_SPLIT_PRODUCER_ID;
const OASYFY_SPLIT_PRODUCER_ID = process.env.OASYFY_SPLIT_PRODUCER_ID;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

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

// --- ROTAS DE AUTENTICAÇÃO, CRUD, ETC. (INALTERADAS) ---
app.post('/api/sellers/register', async (req, res) => { /* ...código existente... */ });
app.post('/api/sellers/login', async (req, res) => { /* ...código existente... */ });
app.get('/api/dashboard/data', authenticateJwt, async (req, res) => { /* ...código existente... */ });
app.post('/api/pixels', authenticateJwt, async (req, res) => { /* ...código existente... */ });
app.delete('/api/pixels/:id', authenticateJwt, async (req, res) => { /* ...código existente... */ });
app.post('/api/bots', authenticateJwt, async (req, res) => { /* ...código existente... */ });
app.delete('/api/bots/:id', authenticateJwt, async (req, res) => { /* ...código existente... */ });
app.post('/api/pressels', authenticateJwt, async (req, res) => { /* ...código existente... */ });
app.delete('/api/pressels/:id', authenticateJwt, async (req, res) => { /* ...código existente... */ });
app.post('/api/settings/pix', authenticateJwt, async (req, res) => { /* ...código existente... */ });
app.post('/api/registerClick', async (req, res) => { /* ...código existente... */ });
app.post('/api/click/info', async (req, res) => { /* ...código existente... */ });

// --- ROTA DE GERAR PIX (ATUALIZADA) ---
app.post('/api/pix/generate', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    const { click_id, value_cents } = req.body;
    if (!apiKey || !click_id || !value_cents) return res.status(400).json({ message: 'API Key, click_id e value_cents são obrigatórios.' });

    try {
        const [seller] = await sql`SELECT id, active_pix_provider, pushinpay_token, cnpay_public_key, cnpay_secret_key, oasyfy_public_key, oasyfy_secret_key FROM sellers WHERE api_key = ${apiKey}`;
        if (!seller) return res.status(401).json({ message: 'API Key inválida.' });

        const [click] = await sql`SELECT id FROM clicks WHERE click_id = ${click_id} AND seller_id = ${seller.id}`;
        if (!click) return res.status(404).json({ message: 'Click ID não encontrado.' });
        const click_id_internal = click.id;
        
        let transaction_id, qr_code_text, qr_code_base64;

        if (seller.active_pix_provider === 'cnpay' || seller.active_pix_provider === 'oasyfy') {
            const isCnpay = seller.active_pix_provider === 'cnpay';
            const publicKey = isCnpay ? seller.cnpay_public_key : seller.oasyfy_public_key;
            const secretKey = isCnpay ? seller.cnpay_secret_key : seller.oasyfy_secret_key;
            const splitId = isCnpay ? CNPAY_SPLIT_PRODUCER_ID : OASYFY_SPLIT_PRODUCER_ID;
            const apiUrl = isCnpay ? 'https://painel.appcnpay.com/api/v1/gateway/pix/receive' : 'https://app.oasyfy.com/api/v1/gateway/pix/receive';
            const providerName = isCnpay ? 'cnpay' : 'oasyfy';

            if (!publicKey || !secretKey) return res.status(400).json({ message: `Credenciais da ${providerName.toUpperCase()} não configuradas.` });
            
            const commission = parseFloat(((value_cents / 100) * 0.0299).toFixed(2));
            let splits = [];
            if (apiKey !== ADMIN_API_KEY && commission > 0) {
                splits.push({ producerId: splitId, amount: commission });
            }

            const payload = {
                identifier: uuidv4(),
                amount: value_cents / 100,
                client: { name: "Cliente", email: "cliente@email.com", document: "21376710773", phone: "(27) 99531-0370" },
                splits: splits,
                callbackUrl: `https://${req.headers.host}/api/webhook/${providerName}`
            };
            
            const response = await axios.post(apiUrl, payload, { headers: { 'x-public-key': publicKey, 'x-secret-key': secretKey } });

            const pixData = response.data;
            transaction_id = pixData.transactionId;
            qr_code_text = pixData.pix.code;
            qr_code_base64 = pixData.pix.base64;

            await sql`INSERT INTO pix_transactions (click_id_internal, pix_id, pix_value, qr_code_text, qr_code_base64, provider, provider_transaction_id) VALUES (${click_id_internal}, ${transaction_id}, ${value_cents / 100}, ${qr_code_text}, ${qr_code_base64}, ${providerName}, ${transaction_id})`;
        } else {
            if (!seller.pushinpay_token) return res.status(400).json({ message: 'Token da PushinPay não configurado.' });
            
            let pushinpaySplitRules = [];
            const commission_cents = Math.floor(value_cents * 0.0299);
            if (apiKey !== ADMIN_API_KEY && commission_cents > 0) {
                pushinpaySplitRules.push({ value: commission_cents, account_id: PUSHINPAY_SPLIT_ACCOUNT_ID });
            }
            const payload = {
                value: value_cents,
                webhook_url: `https://${req.headers.host}/api/webhook/pushinpay`,
                split_rules: pushinpaySplitRules
            };

            const pushinpayResponse = await axios.post('https://api.pushinpay.com.br/api/pix/cashIn', payload, { headers: { Authorization: `Bearer ${seller.pushinpay_token}` } });
            
            const pixData = pushinpayResponse.data;
            transaction_id = pixData.id;
            qr_code_text = pixData.qr_code;
            qr_code_base64 = pixData.qr_code_base64;
            
            await sql`INSERT INTO pix_transactions (click_id_internal, pix_id, pix_value, qr_code_text, qr_code_base64, provider, provider_transaction_id) VALUES (${click_id_internal}, ${transaction_id}, ${value_cents / 100}, ${qr_code_text}, ${qr_code_base64}, 'pushinpay', ${transaction_id})`;
        }

        res.status(200).json({ qr_code_text, qr_code_base64, transaction_id });

    } catch (error) {
        console.error("Erro ao gerar PIX:", error.response?.data || error.message);
        res.status(500).json({ message: 'Erro ao gerar cobrança PIX.' });
    }
});

// --- ROTA DE CONSULTA DE STATUS (ATUALIZADA) ---
app.post('/api/pix/check-status', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    const { click_id, transaction_id } = req.body; // Agora aceita transaction_id opcional

    if (!apiKey || !click_id) return res.status(400).json({ message: 'API Key e click_id são obrigatórios.' });

    try {
        const [seller] = await sql`SELECT id FROM sellers WHERE api_key = ${apiKey}`;
        if (!seller) return res.status(401).json({ message: 'API Key inválida.' });

        let transactions;
        if (transaction_id) {
            // Se um ID de transação específico é fornecido, busca apenas por ele
            transactions = await sql`
                SELECT pt.status, pt.pix_value FROM pix_transactions pt
                JOIN clicks c ON pt.click_id_internal = c.id
                WHERE pt.provider_transaction_id = ${transaction_id} AND c.seller_id = ${seller.id}
            `;
        } else {
            // Se não, busca todas as transações para o click_id (comportamento antigo)
            transactions = await sql`
                SELECT pt.status, pt.pix_value FROM pix_transactions pt
                JOIN clicks c ON pt.click_id_internal = c.id
                WHERE c.click_id = ${click_id} AND c.seller_id = ${seller.id}
            `;
        }

        if (transactions.length === 0) return res.status(200).json({ status: 'not_found', message: 'Nenhuma cobrança PIX encontrada.' });
        
        const paidTransaction = transactions.find(t => t.status === 'paid');
        if (paidTransaction) {
            return res.status(200).json({ status: 'paid', value: paidTransaction.pix_value });
        } else {
            return res.status(200).json({ status: 'pending' });
        }
    } catch (error) {
        console.error("Erro ao consultar status do PIX:", error);
        res.status(500).json({ message: 'Erro ao consultar status.' });
    }
});


// --- WEBHOOKS E DEMAIS FUNÇÕES ---
// (Nenhuma alteração necessária no restante do arquivo)
app.post('/api/webhook/pushinpay', async (req, res) => { /* ...código existente... */ });
app.post('/api/webhook/cnpay', async (req, res) => { /* ...código existente... */ });
app.post('/api/webhook/oasyfy', async (req, res) => { /* ...código existente... */ });
async function sendConversionToMeta(clickData, pixData) { /* ...código existente... */ }
module.exports = app;
