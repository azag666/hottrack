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
// ATENÇÃO: Renomeie esta variável de ambiente na Vercel para refletir seu uso geral
const MY_SAAS_SPLIT_ACCOUNT_ID = process.env.MY_SAAS_SPLIT_ACCOUNT_ID; // Antiga MY_PUSHINPAY_ACCOUNT_ID

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

// --- ROTAS DE AUTENTICAÇÃO E CRUD BÁSICO (Inalteradas) ---
app.post('/api/sellers/register', async (req, res) => { /* ...código existente... */ });
app.post('/api/sellers/login', async (req, res) => { /* ...código existente... */ });
app.post('/api/pixels', authenticateJwt, async (req, res) => { /* ...código existente... */ });
app.delete('/api/pixels/:id', authenticateJwt, async (req, res) => { /* ...código existente... */ });
app.post('/api/bots', authenticateJwt, async (req, res) => { /* ...código existente... */ });
app.delete('/api/bots/:id', authenticateJwt, async (req, res) => { /* ...código existente... */ });
app.post('/api/pressels', authenticateJwt, async (req, res) => { /* ...código existente... */ });
app.delete('/api/pressels/:id', authenticateJwt, async (req, res) => { /* ...código existente... */ });
app.post('/api/registerClick', async (req, res) => { /* ...código existente... */ });
app.post('/api/click/info', async (req, res) => { /* ...código existente... */ });
app.post('/api/webhook/pushinpay', async (req, res) => { /* ...código existente... */ });


// --- ROTA DE DADOS DO PAINEL (ATUALIZADA) ---
app.get('/api/dashboard/data', authenticateJwt, async (req, res) => {
    try {
        const sellerId = req.user.id;
        // ## ATUALIZADO para buscar todas as novas configurações de PIX ##
        const settingsPromise = sql`
            SELECT api_key, pushinpay_token, cnpay_public_key, cnpay_secret_key, active_pix_provider 
            FROM sellers 
            WHERE id = ${sellerId}
        `;
        const pixelsPromise = sql`SELECT * FROM pixel_configurations WHERE seller_id = ${sellerId} ORDER BY created_at DESC`;
        const presselsPromise = sql`
            SELECT p.*, COALESCE(px.pixel_ids, ARRAY[]::integer[]) as pixel_ids
            FROM pressels p
            LEFT JOIN ( SELECT pressel_id, array_agg(pixel_config_id) as pixel_ids FROM pressel_pixels GROUP BY pressel_id ) px ON p.id = px.pressel_id
            WHERE p.seller_id = ${sellerId} ORDER BY p.created_at DESC`;
        const botsPromise = sql`SELECT * FROM telegram_bots WHERE seller_id = ${sellerId} ORDER BY created_at DESC`;

        const [settingsResult, pixels, pressels, bots] = await Promise.all([settingsPromise, pixelsPromise, presselsPromise, botsPromise]);
        
        const settings = settingsResult[0] || { 
            api_key: null, pushinpay_token: null, cnpay_public_key: null, cnpay_secret_key: null, active_pix_provider: 'pushinpay'
        };

        res.json({ settings, pixels, pressels, bots });
    } catch (error) { 
        console.error("Erro ao buscar dados do dashboard:", error);
        res.status(500).json({ message: 'Erro ao buscar dados.' }); 
    }
});

// ## NOVA ROTA UNIFICADA PARA SALVAR CONFIGURAÇÕES DE PIX ##
app.post('/api/settings/pix', authenticateJwt, async (req, res) => {
    const { 
        active_pix_provider, 
        pushinpay_token, 
        cnpay_public_key, 
        cnpay_secret_key 
    } = req.body;

    try {
        await sql`
            UPDATE sellers 
            SET 
                active_pix_provider = ${active_pix_provider},
                pushinpay_token = ${pushinpay_token},
                cnpay_public_key = ${cnpay_public_key},
                cnpay_secret_key = ${cnpay_secret_key}
            WHERE id = ${req.user.id}
        `;
        res.status(200).json({ message: 'Configurações de PIX salvas com sucesso.' });
    } catch (error) {
        console.error("Erro ao salvar configurações de PIX:", error);
        res.status(500).json({ message: 'Erro ao salvar as configurações.' });
    }
});


// --- ROTAS DE PIX E CONSULTA (ATUALIZADAS PARA MÚLTIPLOS PROVEDORES) ---
app.post('/api/pix/generate', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    const { click_id, value_cents } = req.body;

    if (!apiKey || !click_id || !value_cents) {
        return res.status(400).json({ message: 'API Key, click_id e value_cents são obrigatórios.' });
    }

    try {
        const [seller] = await sql`
            SELECT id, active_pix_provider, pushinpay_token, cnpay_public_key, cnpay_secret_key 
            FROM sellers 
            WHERE api_key = ${apiKey}
        `;

        if (!seller) {
            return res.status(401).json({ message: 'API Key inválida.' });
        }

        const [click] = await sql`SELECT id FROM clicks WHERE click_id = ${click_id} AND seller_id = ${seller.id}`;
        if (!click) {
            return res.status(404).json({ message: 'Click ID não encontrado.' });
        }
        const click_id_internal = click.id;

        // Lógica para escolher o provedor ativo
        if (seller.active_pix_provider === 'cnpay') {
            // --- LÓGICA PARA CN PAY ---
            if (!seller.cnpay_public_key || !seller.cnpay_secret_key) {
                return res.status(400).json({ message: 'Credenciais da CN Pay não configuradas.' });
            }

            const commission = (value_cents / 100) * 0.0299; // 2.99% em BRL
            const payload = {
                identifier: uuidv4(),
                amount: value_cents / 100, // CN Pay usa BRL, não centavos
                client: { // Dados genéricos, como combinado
                    name: "Cliente",
                    email: "cliente@email.com",
                    document: "123.456.789-00"
                },
                splits: [{
                    producerId: MY_SAAS_SPLIT_ACCOUNT_ID,
                    amount: commission
                }],
                callbackUrl: `https://${req.headers.host}/api/webhook/cnpay`
            };
            
            // Autenticação (Assumindo que seja via headers customizados)
            const cnpayResponse = await axios.post(
                'https://painel.appcnpay.com/api/v1/gateway/pix/receive',
                payload,
                { headers: { 
                    'x-public-key': seller.cnpay_public_key,
                    'x-secret-key': seller.cnpay_secret_key
                }}
            );

            const pixData = cnpayResponse.data;
            
            await sql`
                INSERT INTO pix_transactions (click_id_internal, pix_id, pix_value, qr_code_text, qr_code_base64, provider, provider_transaction_id) 
                VALUES (${click_id_internal}, ${pixData.transactionId}, ${value_cents / 100}, ${pixData.pix.code}, ${pixData.pix.base64}, 'cnpay', ${pixData.transactionId})
            `;

            res.status(200).json({ qr_code_text: pixData.pix.code, qr_code_base64: pixData.pix.base64 });

        } else {
            // --- LÓGICA PARA PUSHINPAY (Padrão) ---
            if (!seller.pushinpay_token) {
                return res.status(400).json({ message: 'Token da PushinPay não configurado.' });
            }
            
            const commission_cents = Math.floor(value_cents * 0.0299);
            const payload = {
                value: value_cents,
                webhook_url: `https://${req.headers.host}/api/webhook/pushinpay`,
                split_rules: commission_cents > 0 ? [{ value: commission_cents, account_id: MY_SAAS_SPLIT_ACCOUNT_ID }] : []
            };

            const pushinpayResponse = await axios.post('https://api.pushinpay.com.br/api/pix/cashIn', payload, { 
                headers: { Authorization: `Bearer ${seller.pushinpay_token}` }
            });

            const pixData = pushinpayResponse.data;

            await sql`
                INSERT INTO pix_transactions (click_id_internal, pix_id, pix_value, qr_code_text, qr_code_base64, provider, provider_transaction_id) 
                VALUES (${click_id_internal}, ${pixData.id}, ${value_cents / 100}, ${pixData.qr_code}, ${pixData.qr_code_base64}, 'pushinpay', ${pixData.id})
            `;

            res.status(200).json({ qr_code_text: pixData.qr_code, qr_code_base64: pixData.qr_code_base64 });
        }
    } catch (error) {
        console.error("Erro ao gerar PIX:", error.response?.data || error.message);
        res.status(500).json({ message: 'Erro ao gerar cobrança PIX.' });
    }
});

app.post('/api/pix/check-status', async (req, res) => {
    // Esta rota agora precisa descobrir o provedor da transação para saber qual API chamar.
    // Implementação futura, por enquanto, continua verificando o status local que é atualizado pelo webhook.
    const apiKey = req.headers['x-api-key'];
    const { click_id } = req.body;
    if (!apiKey || !click_id) return res.status(400).json({ message: 'API Key e click_id são obrigatórios.' });
    
    try {
        const transactions = await sql`
            SELECT pt.status, pt.pix_value 
            FROM pix_transactions pt
            JOIN clicks c ON pt.click_id_internal = c.id
            WHERE c.click_id = ${click_id}`;
        
        if (transactions.length === 0) return res.status(200).json({ status: 'not_found', message: 'Nenhuma cobrança PIX encontrada.' });
        
        const paidTransaction = transactions.find(t => t.status === 'paid');
        if (paidTransaction) {
            return res.status(200).json({ status: 'paid', value: paidTransaction.pix_value, all_transactions: transactions });
        } else {
            return res.status(200).json({ status: 'pending', all_transactions: transactions });
        }
    } catch (error) {
        console.error("Erro ao consultar status do PIX:", error);
        res.status(500).json({ message: 'Erro ao consultar status.' });
    }
});

// ... (Restante do código: webhooks e sendConversionToMeta inalterados) ...
async function sendConversionToMeta(clickData, pixData) { /* ...código existente... */ }

module.exports = app;
