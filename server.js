const express = require('express');
const cors = require('cors');
const { neon } = require('@neondatabase/serverless');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const bcrypt = require('bcryptjs'); // Para hashear senhas

const app = express();
app.use(cors());
app.use(express.json());

// Conexão com o banco de dados Neon
const sql = neon(process.env.DATABASE_URL);

// Constantes da PushinPay (Exemplo, o ideal é que o seu token principal fique em variáveis de ambiente)
const PUSHINPAY_API_URL = 'https://api.pushinpay.com.br';
const YOUR_PUSHINPAY_ACCOUNT_ID = '9F49A790-2C45-4413-9974-451D657314AF'; // Seu ID para split
const SPLIT_VALUE_CENTS = 30; // 30 centavos por venda

// Função para hashear valores com SHA256 para a API da Meta
function sha256(value) {
    if (!value) return null;
    return crypto.createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');
}

// Função para obter geolocalização por IP
async function getGeoFromIp(ip) {
    if (!ip) return { city: '', state: '' };
    try {
        const response = await axios.get(`http://ip-api.com/json/${ip}?fields=status,city,regionName`);
        if (response.data && response.data.status === 'success') {
            return { city: response.data.city || '', state: response.data.regionName || '' };
        }
        return { city: '', state: '' };
    } catch (error) {
        console.error('Erro ao obter geolocalização:', error.message);
        return { city: '', state: '' };
    }
}

// ##########################################################################
// #################### LÓGICA DE AUTENTICAÇÃO E USUÁRIOS ###################
// ##########################################################################

// Rota para cadastrar um novo vendedor
app.post('/api/sellers/register', async (req, res) => {
    const { name, email, password, pushinpay_token, bot_name } = req.body;

    if (!name || !email || !password || !pushinpay_token || !bot_name) {
        return res.status(400).json({ status: 'error', message: 'Todos os campos são obrigatórios.' });
    }

    try {
        // Verifica se o email já existe
        const existingSeller = await sql`SELECT id FROM sellers WHERE email = ${email}`;
        if (existingSeller.length > 0) {
            return res.status(409).json({ status: 'error', message: 'Este email já está em uso.' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const apiKey = uuidv4(); // Gera uma chave de API única para o vendedor

        const newSeller = await sql`
            INSERT INTO sellers (name, email, password_hash, pushinpay_token, api_key, bot_name)
            VALUES (${name}, ${email}, ${hashedPassword}, ${pushinpay_token}, ${apiKey}, ${bot_name})
            RETURNING id, name, email, api_key, created_at;
        `;

        res.status(201).json({ status: 'success', message: 'Vendedor cadastrado com sucesso!', seller: newSeller[0] });

    } catch (error) {
        console.error('Erro ao cadastrar vendedor:', error);
        res.status(500).json({ status: 'error', message: 'Erro interno do servidor.' });
    }
});

// Middleware para autenticar via API Key
async function authenticateApiKey(req, res, next) {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) {
        return res.status(401).json({ status: 'error', message: 'Chave de API não fornecida.' });
    }
    try {
        const sellerResult = await sql`SELECT id, pushinpay_token FROM sellers WHERE api_key = ${apiKey}`;
        if (sellerResult.length === 0) {
            return res.status(403).json({ status: 'error', message: 'Chave de API inválida.' });
        }
        req.seller = sellerResult[0]; // Adiciona informações do vendedor na requisição
        next();
    } catch (error) {
        console.error('Erro de autenticação:', error);
        res.status(500).json({ status: 'error', message: 'Erro interno do servidor.' });
    }
}


// ##########################################################################
// ############# ROTAS PARA GERENCIAMENTO DE PIXELS (PROTEGIDAS) ############
// ##########################################################################

// Adicionar um novo Pixel para o vendedor autenticado
app.post('/api/pixels', authenticateApiKey, async (req, res) => {
    const { seller_id } = req.seller;
    const { pixel_id, meta_api_token } = req.body;

    if (!pixel_id || !meta_api_token) {
        return res.status(400).json({ message: 'Pixel ID e Token da API da Meta são obrigatórios.' });
    }

    try {
        const newPixel = await sql`
            INSERT INTO meta_pixels (seller_id, pixel_id, meta_api_token)
            VALUES (${seller_id}, ${pixel_id}, ${meta_api_token})
            RETURNING *;
        `;
        res.status(201).json(newPixel[0]);
    } catch (error) {
        console.error('Erro ao adicionar pixel:', error);
        res.status(500).json({ message: 'Erro interno do servidor' });
    }
});

// Listar pixels do vendedor autenticado
app.get('/api/pixels', authenticateApiKey, async (req, res) => {
    const { seller_id } = req.seller;
    try {
        const pixels = await sql`SELECT * FROM meta_pixels WHERE seller_id = ${seller_id}`;
        res.status(200).json(pixels);
    } catch (error) {
        console.error('Erro ao listar pixels:', error);
        res.status(500).json({ message: 'Erro interno do servidor' });
    }
});


// ##########################################################################
// #################### LÓGICA DE TRACKING E CONVERSÃO ######################
// ##########################################################################

// Rota pública para registrar o clique inicial (usada na presell)
app.post('/api/registerClick', async (req, res) => {
    // Esta rota agora precisa identificar o vendedor, por exemplo, por um parâmetro na URL
    const { sellerApiKey, referer, fbclid, fbp } = req.body;

    if (!sellerApiKey) {
        return res.status(400).json({ status: 'error', message: 'Identificação do vendedor é necessária.' });
    }

    try {
        const sellerResult = await sql`SELECT id FROM sellers WHERE api_key = ${sellerApiKey}`;
        if (sellerResult.length === 0) {
            return res.status(404).json({ status: 'error', message: 'Vendedor não encontrado.' });
        }
        const seller_id = sellerResult[0].id;

        const ip_address = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        const user_agent = req.headers['user-agent'];
        const { city, state } = await getGeoFromIp(ip_address);

        const insertQuery = `
            INSERT INTO clicks (seller_id, timestamp, ip_address, user_agent, referer, city, state, fbclid, fbp)
            VALUES ($1, NOW(), $2, $3, $4, $5, $6, $7, $8) RETURNING id;
        `;
        const insertResult = await sql(insertQuery, [seller_id, ip_address, user_agent, referer, city, state, fbclid, fbp]);

        const generatedId = insertResult[0].id;
        const clickId = `lead${generatedId.toString().padStart(6, '0')}`;

        await sql('UPDATE clicks SET click_id = $1 WHERE id = $2', [clickId, generatedId]);

        res.status(200).json({ status: 'success', message: 'Click registrado', click_id: clickId });
    } catch (error) {
        console.error('Erro ao registrar clique:', error);
        res.status(500).json({ status: 'error', message: 'Erro interno do servidor.' });
    }
});


// ##########################################################################
// #################### INTEGRAÇÃO MANYCHAT E PUSHINPAY #####################
// ##########################################################################

// Rota para o ManyChat gerar um PIX
app.post('/api/manychat/generate-pix', authenticateApiKey, async (req, res) => {
    const { seller_id, pushinpay_token } = req.seller;
    const { click_id, value_cents } = req.body;

    if (!click_id || !value_cents) {
        return res.status(400).json({ status: 'error', message: 'click_id e value_cents são obrigatórios.' });
    }

    try {
        // 1. Verifica se o click_id pertence ao vendedor
        const clickResult = await sql`SELECT id FROM clicks WHERE click_id = ${click_id} AND seller_id = ${seller_id}`;
        if (clickResult.length === 0) {
            return res.status(404).json({ status: 'error', message: 'Click ID não encontrado ou não pertence a este vendedor.' });
        }

        // 2. Monta o payload para a PushinPay
        const payload = {
            value: value_cents,
            webhook_url: `https://YOUR_API_URL/api/webhooks/pushinpay`, // URL do seu webhook para receber notificações
            split_rules: [
                {
                    value: SPLIT_VALUE_CENTS,
                    account_id: YOUR_PUSHINPAY_ACCOUNT_ID
                }
            ]
        };

        // 3. Chama a API da PushinPay
        const pushinpayResponse = await axios.post(`${PUSHINPAY_API_URL}/api/pix/cashIn`, payload, {
            headers: {
                'Authorization': `Bearer ${pushinpay_token}`,
                'Content-Type': 'application/json'
            }
        });

        const { id: pix_id, qr_code, qr_code_base64 } = pushinpayResponse.data;

        // 4. Salva o pix_id no banco de dados
        await sql`
            UPDATE clicks
            SET pix_id = ${pix_id}, pix_value = ${value_cents / 100.0}
            WHERE click_id = ${click_id};
        `;

        // 5. Retorna os dados do PIX para o ManyChat
        res.status(200).json({
            status: 'success',
            pix_id,
            qr_code,
            qr_code_base64
        });

    } catch (error) {
        console.error('Erro ao gerar PIX via ManyChat:', error.response ? error.response.data : error.message);
        res.status(500).json({ status: 'error', message: 'Erro ao se comunicar com a PushinPay.' });
    }
});


// Rota de Webhook para receber notificações da PushinPay
app.post('/api/webhooks/pushinpay', async (req, res) => {
    const { id: pix_id, status } = req.body;

    console.log(`Webhook da PushinPay recebido: PIX ID ${pix_id}, Status ${status}`);

    if (status === 'paid') {
        try {
            // Encontra o click associado a este PIX
            const clickResult = await sql`
                SELECT
                    c.id, c.seller_id, c.ip_address, c.user_agent, c.fbp, c.fbc,
                    c.pix_value, c.click_id, c.city, c.state, c.is_converted
                FROM clicks c
                WHERE c.pix_id = ${pix_id};
            `;

            if (clickResult.length === 0) {
                console.warn(`Webhook: PIX ID ${pix_id} não encontrado no banco de dados.`);
                return res.status(404).send('Click não encontrado.');
            }

            const clickData = clickResult[0];

            if (clickData.is_converted) {
                console.warn(`Webhook: Click ID ${clickData.click_id} já foi convertido.`);
                return res.status(200).send('Pagamento já processado.');
            }

            // Marca como convertido
            await sql`
                UPDATE clicks
                SET is_converted = TRUE, conversion_timestamp = NOW()
                WHERE id = ${clickData.id};
            `;

            // Envia a conversão para a Meta
            await sendConversionToMeta(clickData);

        } catch (dbError) {
            console.error('Erro no processamento do webhook da PushinPay:', dbError);
            return res.status(500).send('Erro interno ao processar webhook.');
        }
    }

    res.status(200).send('Webhook recebido.');
});


// Função para enviar conversão para a API da Meta
async function sendConversionToMeta(clickData) {
    console.log('Iniciando envio de conversão para a Meta:', clickData.click_id);

    try {
        // 1. Pega todos os pixels do vendedor
        const pixels = await sql`SELECT pixel_id, meta_api_token FROM meta_pixels WHERE seller_id = ${clickData.seller_id}`;

        if (pixels.length === 0) {
            console.warn(`Nenhum pixel configurado para o vendedor ID ${clickData.seller_id}.`);
            return;
        }

        const eventTime = Math.floor(Date.now() / 1000);

        // 2. Itera e envia para cada pixel
        for (const pixel of pixels) {
            const eventId = uuidv4();
            const metaApiUrl = `https://graph.facebook.com/v19.0/${pixel.pixel_id}/events`;

            const payload = {
                data: [{
                    event_name: 'Purchase',
                    event_time: eventTime,
                    event_id: eventId,
                    action_source: 'website',
                    user_data: {
                        client_ip_address: clickData.ip_address,
                        client_user_agent: clickData.user_agent,
                        fbp: clickData.fbp || null,
                        fbc: clickData.fbc || null,
                        ct: sha256(clickData.city),
                        st: sha256(clickData.state),
                        external_id: clickData.click_id
                    },
                    custom_data: {
                        currency: 'BRL',
                        value: clickData.pix_value,
                    },
                }],
            };

            try {
                await axios.post(metaApiUrl, payload, {
                    headers: { 'Authorization': `Bearer ${pixel.meta_api_token}` }
                });
                console.log(`Conversão enviada com sucesso para o Pixel ${pixel.pixel_id}`);

                // Salva o event_id para referência
                await sql`UPDATE clicks SET event_id = ${eventId} WHERE id = ${clickData.id}`;

            } catch (metaError) {
                console.error(`ERRO ao enviar evento para o Pixel ${pixel.pixel_id}:`, metaError.response ? metaError.response.data : metaError.message);
            }
        }
    } catch (error) {
        console.error('Erro geral na função sendConversionToMeta:', error);
    }
}


// Rota para consultar o status de um PIX massivamente (exemplo)
// Poderia ser um job agendado (cron job)
app.post('/api/tasks/check-pending-pix', async (req, res) => {
    // Adicionar uma chave de segurança para esta rota
    const ADMIN_KEY = req.headers['x-admin-key'];
    if (ADMIN_KEY !== process.env.ADMIN_API_KEY) {
        return res.status(403).json({ message: 'Não autorizado.' });
    }

    try {
        const pendingClicks = await sql`
            SELECT c.pix_id, s.pushinpay_token
            FROM clicks c
            JOIN sellers s ON c.seller_id = s.id
            WHERE c.is_converted = FALSE AND c.pix_id IS NOT NULL AND c.timestamp > NOW() - INTERVAL '1 hour';
        `;

        if (pendingClicks.length === 0) {
            return res.status(200).json({ message: 'Nenhum PIX pendente para verificar.' });
        }

        let checked = 0;
        for (const click of pendingClicks) {
            try {
                const response = await axios.get(`${PUSHINPAY_API_URL}/api/transactions/${click.pix_id}`, {
                    headers: { 'Authorization': `Bearer ${click.pushinpay_token}` }
                });

                if (response.data && response.data.status === 'paid') {
                    // Se estiver pago, chama a mesma lógica do webhook
                    await app.handle({
                        method: 'POST',
                        url: '/api/webhooks/pushinpay',
                        body: { id: click.pix_id, status: 'paid' }
                    }, { status: () => ({ send: () => {} }) }); // Mock de response
                    checked++;
                }
            } catch (checkError) {
                console.error(`Erro ao consultar PIX ${click.pix_id}:`, checkError.message);
            }
        }
        res.status(200).json({ message: `Verificação concluída. ${checked} PIX confirmados.` });

    } catch (error) {
        console.error('Erro na tarefa de verificação de PIX:', error);
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
});


module.exports = app;
