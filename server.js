// server.js
const express = require('express');
const cors = require('cors');
const { neon } = require('@neondatabase/serverless');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios'); // Adicionado para chamadas externas

const app = express();
app.use(cors());
app.use(express.json());

const sql = neon(process.env.DATABASE_URL);
const JWT_SECRET = process.env.JWT_SECRET || 'seu-segredo-super-secreto';

// --- MIDDLEWARE DE AUTENTICAÇÃO ---
async function authenticateJwt(req, res, next) { /* ... (código da versão anterior) ... */ }

// --- ROTAS DE AUTENTICAÇÃO E REGISTRO ---
app.post('/api/sellers/register', async (req, res) => { /* ... (código da versão anterior) ... */ });
app.post('/api/sellers/login', async (req, res) => { /* ... (código da versão anterior) ... */ });

// --- ROTA DE DADOS DO DASHBOARD ---
app.get('/api/dashboard/data', authenticateJwt, async (req, res) => {
    try {
        const sellerId = req.user.id;
        // ... (lógica completa da query do dashboard da versão anterior) ...
        res.json({ /* ... (dados do dashboard) ... */ });
    } catch (error) {
        console.error("Erro ao buscar dados do dashboard:", error);
        res.status(500).json({ message: 'Erro ao buscar dados do dashboard.' });
    }
});

// --- ROTAS DE PIXELS, BOTS, PRESSELS ---
// ... (Copie as rotas de POST e DELETE para /api/pixels, /api/bots, e /api/pressels da sua versão anterior do server.js) ...

// --- ROTA PÚBLICA PARA REGISTRO DE CLIQUES ---
app.post('/api/registerClick', async (req, res) => { /* ... (código da versão anterior) ... */ });

// --- NOVAS ROTAS PARA PUSHINPAY E META CAPI ---

// ROTA PARA GERAR PIX (PUSHINPAY)
app.post('/api/generate-pix', authenticateJwt, async (req, res) => {
    const { click_id_internal, value_cents } = req.body;
    const seller_id = req.user.id;

    try {
        const seller = await sql`SELECT pushinpay_token FROM sellers WHERE id = ${seller_id}`;
        if (!seller.length || !seller[0].pushinpay_token) {
            return res.status(400).json({ message: 'Token da PushinPay não configurado.' });
        }

        console.log(`Gerando PIX para o click_id: ${click_id_internal}`);
        // AQUI VOCÊ FARIA A CHAMADA PARA A API DA PUSHINPAY
        // const response = await axios.post('URL_DA_PUSHINPAY', { ... }, { headers: { 'Authorization': `Bearer ${seller[0].pushinpay_token}` } });
        // const pixData = response.data;
        
        // Exemplo de resposta (simulada)
        const pixData = {
            transaction_id: `pix_${uuidv4()}`,
            qr_code: '00020126... (QR Code Completo)',
            qr_code_text: 'copiaecola...'
        };

        // Salva o ID da transação no clique correspondente
        await sql`UPDATE clicks SET pix_id = ${pixData.transaction_id}, pix_value = ${value_cents / 100}, status = 'pending' WHERE id = ${click_id_internal}`;

        res.status(200).json(pixData);
    } catch (error) {
        console.error('Erro ao gerar PIX:', error);
        res.status(500).json({ message: 'Erro ao gerar PIX.' });
    }
});

// WEBHOOK PARA RECEBER CONFIRMAÇÃO DE PAGAMENTO (DA PUSHINPAY)
app.post('/api/webhook/payment-confirmed', async (req, res) => {
    const { transaction_id, status } = req.body; // Supondo que a PushinPay envie esses dados
    
    if (status === 'paid') {
        try {
            const updatedClicks = await sql`
                UPDATE clicks SET status = 'paid', conversion_timestamp = NOW() 
                WHERE pix_id = ${transaction_id} AND status != 'paid'
                RETURNING *`;

            if (updatedClicks.length > 0) {
                const clickData = updatedClicks[0];
                console.log(`Conversão registrada para o clique ${clickData.id}. Disparando envio para Meta CAPI.`);
                
                // Dispara a função para enviar a conversão para a API da Meta
                await sendConversionToMeta(clickData);
            }
        } catch (error) {
            console.error('Erro no webhook:', error);
        }
    }
    res.sendStatus(200); // Sempre retorne 200 para o webhook
});

// FUNÇÃO PARA ENVIAR DADOS PARA A API DE CONVERSÕES DA META
async function sendConversionToMeta(clickData) {
    try {
        const sellerId = clickData.seller_id;
        // 1. Busca os pixels associados à pressel do clique
        const presselPixels = await sql`SELECT pixel_config_id FROM pressel_pixels WHERE pressel_id = ${clickData.pressel_id}`;
        if (presselPixels.length === 0) return;

        for (const pp of presselPixels) {
            // 2. Para cada pixel, busca a configuração (ID do pixel e token da API)
            const pixelConfig = await sql`SELECT pixel_id, meta_api_token FROM pixel_configurations WHERE id = ${pp.pixel_config_id}`;
            if (pixelConfig.length > 0) {
                const { pixel_id, meta_api_token } = pixelConfig[0];
                const event_id = `evt_${clickData.id}_${pixel_id}`;
                
                console.log(`Enviando evento de Purchase para o Pixel ID: ${pixel_id}`);
                
                // 3. Monta e envia o payload para a API da Meta (este é um exemplo)
                // const payload = { ... };
                // await axios.post(`https://graph.facebook.com/v18.0/${pixel_id}/events`, payload, { headers: { 'Authorization': `Bearer ${meta_api_token}` } });
                
                // 4. Salva o ID do evento para evitar duplicidade
                await sql`UPDATE clicks SET event_id = ${event_id} WHERE id = ${clickData.id}`;
            }
        }
    } catch (error) {
        console.error('Erro ao enviar conversão para a Meta:', error.response ? error.response.data : error.message);
    }
}

// Exporta o app para a Vercel
module.exports = app;
