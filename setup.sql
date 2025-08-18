DROP TABLE IF EXISTS clicks, pressel_pixels, pixel_configurations, pressels, telegram_bots, sellers CASCADE;

CREATE TABLE IF NOT EXISTS sellers (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    pushinpay_token TEXT, -- Token da PushinPay para este vendedor
    api_key UUID UNIQUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS telegram_bots (
    id SERIAL PRIMARY KEY,
    seller_id INTEGER NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
    bot_name VARCHAR(255) NOT NULL,
    bot_token TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(seller_id, bot_name)
);

CREATE TABLE IF NOT EXISTS pixel_configurations (
    id SERIAL PRIMARY KEY,
    seller_id INTEGER NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
    account_name VARCHAR(255) NOT NULL,
    pixel_id VARCHAR(255) NOT NULL,
    meta_api_token TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(seller_id, pixel_id)
);

CREATE TABLE IF NOT EXISTS pressels (
    id SERIAL PRIMARY KEY,
    seller_id INTEGER NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    bot_id INTEGER NOT NULL REFERENCES telegram_bots(id) ON DELETE CASCADE,
    bot_name VARCHAR(255) NOT NULL,
    white_page_url TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pressel_pixels (
    pressel_id INTEGER NOT NULL REFERENCES pressels(id) ON DELETE CASCADE,
    pixel_config_id INTEGER NOT NULL REFERENCES pixel_configurations(id) ON DELETE CASCADE,
    PRIMARY KEY (pressel_id, pixel_config_id)
);

CREATE TABLE IF NOT EXISTS clicks (
    id SERIAL PRIMARY KEY,
    seller_id INTEGER NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
    pressel_id INTEGER NOT NULL REFERENCES pressels(id) ON DELETE CASCADE,
    click_id VARCHAR(255) UNIQUE,
    pix_id VARCHAR(255), -- ID da transação da PushinPay
    pix_value NUMERIC(10, 2),
    status VARCHAR(50) DEFAULT 'pending', -- 'pending' ou 'paid'
    conversion_timestamp TIMESTAMP WITH TIME ZONE,
    event_id TEXT, -- ID do evento enviado para a API da Meta
    fbclid TEXT,
    fbp TEXT,
    fbc TEXT,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
