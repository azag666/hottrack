-- Este arquivo contém os comandos SQL para criar as tabelas necessárias.
-- Você pode executar isso diretamente no seu banco de dados Neon.

-- Tabela para armazenar os vendedores (usuários do seu SAAS)
CREATE TABLE IF NOT EXISTS sellers (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    pushinpay_token TEXT NOT NULL,
    api_key UUID UNIQUE NOT NULL,
    bot_name VARCHAR(255), -- Para criar a URL do Telegram (ex: meubot)
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Tabela para armazenar as configurações de pixels de cada vendedor
CREATE TABLE IF NOT EXISTS meta_pixels (
    id SERIAL PRIMARY KEY,
    seller_id INTEGER NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
    pixel_id VARCHAR(255) NOT NULL,
    meta_api_token TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(seller_id, pixel_id) -- Garante que um vendedor não adicione o mesmo pixel duas vezes
);

-- Tabela para armazenar os cliques, agora com referência ao vendedor
CREATE TABLE IF NOT EXISTS clicks (
    id SERIAL PRIMARY KEY,
    seller_id INTEGER NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
    click_id VARCHAR(255) UNIQUE,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    ip_address VARCHAR(45),
    user_agent TEXT,
    referer TEXT,
    city VARCHAR(255),
    state VARCHAR(255),
    fbclid TEXT,
    fbp TEXT,
    fbc TEXT,
    pix_id VARCHAR(255), -- ID da transação da PushinPay
    pix_value NUMERIC(10, 2),
    is_converted BOOLEAN DEFAULT FALSE,
    conversion_timestamp TIMESTAMP WITH TIME ZONE,
    event_id VARCHAR(255) -- ID do evento enviado para a API da Meta
);

-- Adiciona um índice para otimizar a busca de cliques por click_id e pix_id
CREATE INDEX IF NOT EXISTS idx_clicks_click_id ON clicks(click_id);
CREATE INDEX IF NOT EXISTS idx_clicks_pix_id ON clicks(pix_id);
CREATE INDEX IF NOT EXISTS idx_sellers_api_key ON sellers(api_key);
