const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { Resend } = require('resend');
const crypto = require('crypto');
const cron = require('node-cron');
const admin = require('firebase-admin');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Firebase Admin SDK başlat (sadece Firestore için)
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.REACT_APP_FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    })
  });
}
const db = admin.firestore();

// Resend email servisi (Railway ile mükemmel çalışır)
const resend = new Resend(process.env.RESEND_API_KEY);

// Giriş token'larını geçici olarak sakla (production'da Redis kullanın)
const loginTokens = new Map();

// Rate limiting için basit in-memory store
const rateLimitStore = new Map();

// Rate limiter middleware
const createRateLimiter = (options) => {
  const { windowMs = 60000, maxRequests = 5, keyGenerator = (req) => req.ip } = options;
  
  return (req, res, next) => {
    const key = keyGenerator(req);
    const now = Date.now();
    
    if (!rateLimitStore.has(key)) {
      rateLimitStore.set(key, { count: 1, resetTime: now + windowMs });
      return next();
    }
    
    const userData = rateLimitStore.get(key);
    
    if (now > userData.resetTime) {
      // Pencere süresi dolmuş, yenile
      rateLimitStore.set(key, { count: 1, resetTime: now + windowMs });
      return next();
    }
    
    if (userData.count >= maxRequests) {
      const remainingTime = Math.ceil((userData.resetTime - now) / 1000);
      console.warn(`⚠️ Rate limit aşıldı: ${key} - ${remainingTime}s kaldı`);
      return res.status(429).json({
        error: 'Çok fazla istek',
        message: `Lütfen ${remainingTime} saniye sonra tekrar deneyin`,
        retryAfter: remainingTime
      });
    }
    
    userData.count++;
    next();
  };
};

// Email gönderimi için özel rate limiter (IP + email bazlı) - Spam önleme optimizasyonu
const emailLoginLimiter = createRateLimiter({
  windowMs: 10 * 60 * 1000, // 10 dakika (15'den 10'a düşürüldü)
  maxRequests: 5, // 10 dakikada maksimum 5 giriş linki (3'den 5'e çıkarıldı)
  keyGenerator: (req) => `${req.ip}-${req.body.email || 'unknown'}`
});

// Rate limit store temizleme (her 5 dakikada bir)
setInterval(() => {
  const now = Date.now();
  for (const [key, data] of rateLimitStore.entries()) {
    if (now > data.resetTime) {
      rateLimitStore.delete(key);
    }
  }
}, 300000);

// Token temizleme (1 saat sonra)
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of loginTokens.entries()) {
    if (now - data.createdAt > 3600000) { // 1 saat
      loginTokens.delete(token);
    }
  }
}, 300000); // 5 dakikada bir kontrol

// CORS ayarları - spafokus.com ve tüm subdomain'leri için
const corsOptions = {
  origin: function (origin, callback) {
    // Origin yoksa izin ver (örn: Postman, mobil app)
    if (!origin) {
      return callback(null, true);
    }
    
    // spafokus.com ve tüm subdomain'lerini kontrol et
    const allowedDomains = [
      'https://spafokus.com',
      'http://localhost:3000', // Development için
      'http://localhost:5000'  // Local test için
    ];
    
    // Tam eşleşme veya subdomain kontrolü
    const isAllowed = allowedDomains.includes(origin) || 
                     /^https:\/\/([a-zA-Z0-9-]+\.)?spafokus\.com$/.test(origin);
    
    if (isAllowed) {
      callback(null, true);
    } else {
      console.warn(`⚠️ CORS reddedildi: ${origin}`);
      callback(new Error('CORS policy: Origin not allowed'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

// Middleware
app.use(cors(corsOptions));
app.use(express.json());

// Groq API Proxy
app.post('/api/groq/chat/completions', async (req, res) => {
  try {
    // Railway environment'dan API key oku
    const apiKey = process.env.GROQ_API_KEY || process.env.REACT_APP_GROQ_API_KEY;
    
    if (!apiKey) {
      console.error('GROQ_API_KEY environment variable is not set');
      return res.status(500).json({ 
        error: 'GROQ_API_KEY is not configured',
        message: 'API anahtarı yapılandırılmamış'
      });
    }

    console.log('Groq API Request:', {
      model: req.body.model,
      messagesCount: req.body.messages?.length
    });

    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      req.body,
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    console.log('Groq API Success');
    res.json(response.data);
  } catch (error) {
    console.error('Groq API Error:', {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message
    });
    
    res.status(error.response?.status || 500).json({
      error: error.response?.data || { message: error.message },
      timestamp: new Date().toISOString()
    });
  }
});

// Firebase Configuration Endpoint
app.get('/api/firebase/config', (req, res) => {
  const firebaseConfig = {
    apiKey: process.env.REACT_APP_FIREBASE_API_KEY,
    authDomain: process.env.REACT_APP_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.REACT_APP_FIREBASE_PROJECT_ID,
    storageBucket: process.env.REACT_APP_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.REACT_APP_FIREBASE_APP_ID,
    measurementId: process.env.REACT_APP_FIREBASE_MEASUREMENT_ID
  };
  
  // Tüm değerlerin tanımlı olup olmadığını kontrol et
  const allDefined = Object.values(firebaseConfig).every(val => val !== undefined);
  
  if (!allDefined) {
    console.warn('Some Firebase config values are undefined');
    res.status(500).json({
      error: 'Firebase config incomplete',
      message: 'Bazı Firebase ayarları yapılandırılmamış'
    });
  } else {
    console.log('Firebase Config Request: SUCCESS ✓');
    console.log('Firebase Config Details:', {
      projectId: firebaseConfig.projectId,
      authDomain: firebaseConfig.authDomain,
      hasApiKey: !!firebaseConfig.apiKey,
      hasAppId: !!firebaseConfig.appId
    });
    res.json(firebaseConfig);
  }
});

// Email Servisleri

// 1. Giriş Linki Gönderme (Rate limit korumalı)
app.post('/api/email/send-login-link', emailLoginLimiter, async (req, res) => {
  try {
    const { email, name, spaId } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email gerekli' });
    }

    // Request'in geldiği host'u al (subdomain'i kullan)
    const requestHost = req.get('host') || req.get('origin') || req.headers.referer;
    const referer = req.headers.referer || req.headers.origin;
    
    let frontendUrl = 'https://spafokus.com'; // Varsayılan
    
    // Referer'dan subdomain'i çıkar
    if (referer) {
      try {
        const url = new URL(referer);
        frontendUrl = `${url.protocol}//${url.host}`;
        console.log(`🌐 Frontend URL (referer'dan): ${frontendUrl}`);
      } catch (error) {
        console.log('⚠️ Referer parse edilemedi, varsayılan kullanılıyor');
      }
    }

    // Güvenli token oluştur
    const token = crypto.randomBytes(32).toString('hex');
    const loginUrl = `${frontendUrl}/online-login?token=${token}`;
    
    console.log(`📧 Login URL: ${loginUrl}`);
    
    // Token'ı sakla
    loginTokens.set(token, {
      email,
      name,
      spaId,
      createdAt: Date.now()
    });

    // Resend ile email gönder - SPAM önleme optimizasyonları
    const { data: emailData, error } = await resend.emails.send({
      from: 'Spafokus <noreply@spafokus.com>', // Daha güvenilir from adresi
      to: email,
      subject: 'Spafokus Rezervasyon Giriş Linki', // Kısa, net subject
      html: `
        <!DOCTYPE html>
        <html lang="tr">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Spafokus Giriş</title>
          <style>
            body { 
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; 
              line-height: 1.6; 
              color: #333333; 
              margin: 0; 
              padding: 0; 
              background-color: #f8f9fa;
            }
            .container { 
              max-width: 600px; 
              margin: 20px auto; 
              background-color: #ffffff;
              border-radius: 8px;
              overflow: hidden;
              box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            }
            .header { 
              background-color: #122134; 
              color: white; 
              padding: 30px 20px; 
              text-align: center; 
            }
            .header h1 {
              margin: 0;
              font-size: 24px;
              font-weight: 600;
            }
            .content { 
              padding: 30px 20px; 
            }
            .button { 
              display: inline-block; 
              padding: 14px 28px; 
              background-color: #122134; 
              color: white !important; 
              text-decoration: none; 
              border-radius: 6px; 
              margin: 20px 0; 
              font-weight: 600;
              font-size: 16px;
            }
            .button-container {
              text-align: center;
              margin: 25px 0;
            }
            .info-box {
              background-color: #f8f9fa;
              border-left: 4px solid #122134;
              padding: 15px;
              margin: 20px 0;
            }
            .footer { 
              text-align: center; 
              padding: 20px; 
              font-size: 12px; 
              color: #666666;
              background-color: #f8f9fa;
            }
            .link-backup {
              font-size: 12px;
              color: #666;
              word-break: break-all;
              margin-top: 20px;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>Spafokus</h1>
              <p style="margin: 5px 0 0 0; opacity: 0.9;">Online Rezervasyon</p>
            </div>
            
            <div class="content">
              <h2 style="color: #122134; margin-top: 0;">Merhaba${name ? ' ' + name : ''}!</h2>
              
              <p>Spafokus online rezervasyon sistemine giriş yapmak için aşağıdaki butona tıklayın:</p>
              
              <div class="button-container">
                <a href="${loginUrl}" class="button">Giriş Yap</a>
              </div>
              
              <div class="info-box">
                <p style="margin: 0;"><strong>Önemli:</strong></p>
                <ul style="margin: 8px 0 0 0; padding-left: 20px;">
                  <li>Bu link 1 saat geçerlidir</li>
                  <li>Tek kullanımlıktır ve güvenlidir</li>
                  <li>Şifre gerektirmez</li>
                </ul>
              </div>
              
              <p style="color: #666; font-size: 14px;">
                Bu isteği siz yapmadıysanız, bu email'i görmezden gelebilirsiniz.
              </p>
              
              <div class="link-backup">
                <p><strong>Link çalışmıyorsa kopyalayın:</strong></p>
                <p style="background-color: #f8f9fa; padding: 10px; border-radius: 4px; font-family: monospace;">
                  ${loginUrl}
                </p>
              </div>
            </div>
            
            <div class="footer">
              <p style="margin: 0;">© 2025 Spafokus - Online Rezervasyon Sistemi</p>
              <p style="margin: 5px 0 0 0;">Bu otomatik bir mesajdır, yanıtlamayın.</p>
            </div>
          </div>
        </body>
        </html>
      `,
      // Spam önleme için text versiyonu da ekle
      text: `
Merhaba${name ? ' ' + name : ''}!

Spafokus online rezervasyon sistemine giriş yapmak için aşağıdaki linke tıklayın:
${loginUrl}

Önemli Bilgiler:
- Bu link 1 saat geçerlidir
- Tek kullanımlıktır ve güvenlidir
- Şifre gerektirmez

Bu isteği siz yapmadıysanız, bu mesajı görmezden gelebilirsiniz.

© 2025 Spafokus - Online Rezervasyon Sistemi
Bu otomatik bir mesajdır, yanıtlamayın.
      `,
      // Spam önleme için önemli header'lar
      headers: {
        'X-Priority': '3',
        'X-MSMail-Priority': 'Normal',
        'Importance': 'Normal',
        'List-Unsubscribe': '<mailto:unsubscribe@spafokus.com>'
      }
    });

    if (error) {
      throw new Error(error.message);
    }
    
    console.log('✅ Giriş linki gönderildi:', email);
    res.json({ 
      success: true, 
      message: 'Giriş linki email adresinize gönderildi' 
    });
    
  } catch (error) {
    console.error('❌ Email gönderme hatası:', error);
    res.status(500).json({ 
      error: 'Email gönderilemedi',
      message: error.message 
    });
  }
});

// 2. Token Doğrulama
app.post('/api/email/verify-token', async (req, res) => {
  try {
    const { token } = req.body;
    
    if (!token) {
      return res.status(400).json({ error: 'Token gerekli' });
    }

    const tokenData = loginTokens.get(token);
    
    if (!tokenData) {
      return res.status(401).json({ 
        error: 'Geçersiz veya süresi dolmuş token',
        expired: true 
      });
    }

    // Token'ı sil (tek kullanımlık)
    loginTokens.delete(token);
    
    console.log('✅ Token doğrulandı:', tokenData.email);
    res.json({ 
      success: true,
      email: tokenData.email,
      name: tokenData.name
    });
    
  } catch (error) {
    console.error('❌ Token doğrulama hatası:', error);
    res.status(500).json({ 
      error: 'Token doğrulanamadı',
      message: error.message 
    });
  }
});

// 3. Rezervasyon Onay Emaili
app.post('/api/email/send-reservation-confirmation', async (req, res) => {
  try {
    const { 
      email, 
      name, 
      reservationCode, 
      items, 
      totalAmount, 
      paymentMethod 
    } = req.body;

    const itemsHtml = items.map(item => `
      <li style="margin-bottom: 8px;">
        <strong>${item.name}</strong> - ${item.price}€ x ${item.quantity} = ${item.price * item.quantity}€
      </li>
    `).join('');

    const { data: emailData, error } = await resend.emails.send({
      from: 'Spafokus <noreply@spafokus.com>',
      to: email,
      subject: `Rezervasyon Onayı - ${reservationCode}`,
      html: `
        <!DOCTYPE html>
        <html lang="tr">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Rezervasyon Onayı</title>
          <style>
            body { 
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; 
              line-height: 1.6; 
              color: #333333; 
              margin: 0; 
              padding: 0; 
              background-color: #f8f9fa;
            }
            .container { 
              max-width: 600px; 
              margin: 20px auto; 
              background-color: #ffffff;
              border-radius: 8px;
              overflow: hidden;
              box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            }
            .header { 
              background-color: #28a745; 
              color: white; 
              padding: 30px 20px; 
              text-align: center; 
            }
            .content { 
              padding: 30px 20px; 
            }
            .code { 
              font-size: 28px; 
              font-weight: bold; 
              color: #122134; 
              text-align: center; 
              padding: 20px; 
              background-color: #f8f9fa; 
              border-radius: 6px; 
              letter-spacing: 2px; 
              margin: 20px 0;
              border: 2px solid #e9ecef;
            }
            .details {
              background-color: #f8f9fa;
              padding: 20px;
              border-radius: 6px;
              margin: 20px 0;
            }
            .footer { 
              text-align: center; 
              padding: 20px; 
              font-size: 12px; 
              color: #666666;
              background-color: #f8f9fa;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1 style="margin: 0;">Rezervasyon Onaylandı</h1>
              <p style="margin: 5px 0 0 0; opacity: 0.9;">Spafokus</p>
            </div>
            
            <div class="content">
              <h2 style="color: #122134; margin-top: 0;">Merhaba ${name}!</h2>
              
              <p>Rezervasyonunuz başarıyla oluşturuldu. Rezervasyon kodunuz:</p>
              
              <div class="code">${reservationCode}</div>
              
              <div class="details">
                <h3 style="color: #122134; margin-top: 0;">Rezervasyon Detayları:</h3>
                <ul style="padding-left: 20px;">
                  ${itemsHtml}
                </ul>
                
                <div style="border-top: 1px solid #dee2e6; padding-top: 15px; margin-top: 15px;">
                  <p style="font-size: 18px; font-weight: bold; color: #122134; margin: 0;">
                    Toplam Tutar: ${totalAmount}€
                  </p>
                  <p style="margin: 5px 0 0 0;">Ödeme: ${
                    paymentMethod === 'online' ? 'Online Kredi Kartı' :
                    paymentMethod === 'card' ? 'Kredi Kartı (Spa\'da)' :
                    'Nakit'
                  }</p>
                </div>
              </div>
              
              <h3 style="color: #122134;">Sonraki Adımlar:</h3>
              <ol style="padding-left: 20px;">
                <li>Rezervasyon kodunuzu saklayın</li>
                <li>Check-in sekmesinden tarih ve saat talebinizi iletin</li>
                <li>Onay bekleyin, size geri dönüş yapacağız</li>
              </ol>
              
              <p style="margin-top: 30px; color: #122134; font-weight: 600;">Görüşmek üzere!</p>
            </div>
            
            <div class="footer">
              <p style="margin: 0;">© 2025 Spafokus - Online Rezervasyon Sistemi</p>
            </div>
          </div>
        </body>
        </html>
      `,
      text: `
Merhaba ${name}!

Rezervasyonunuz başarıyla oluşturuldu.

Rezervasyon Kodu: ${reservationCode}

Rezervasyon Detayları:
${items.map(item => `- ${item.name} - ${item.price}€ x ${item.quantity}`).join('\n')}

Toplam Tutar: ${totalAmount}€
Ödeme: ${
  paymentMethod === 'online' ? 'Online Kredi Kartı' :
  paymentMethod === 'card' ? 'Kredi Kartı (Spa\'da)' :
  'Nakit'
}

Sonraki Adımlar:
1. Rezervasyon kodunuzu saklayın
2. Check-in sekmesinden tarih ve saat talebinizi iletin  
3. Onay bekleyin, size geri dönüş yapacağız

Görüşmek üzere!

© 2025 Spafokus - Online Rezervasyon Sistemi
      `,
      headers: {
        'X-Priority': '3',
        'X-MSMail-Priority': 'Normal',
        'Importance': 'Normal'
      }
    });

    if (error) {
      throw new Error(error.message);
    }
    
    console.log('✅ Rezervasyon onay emaili gönderildi:', email);
    res.json({ success: true });
    
  } catch (error) {
    console.error('❌ Email gönderme hatası:', error);
    res.status(500).json({ error: error.message });
  }
});

// 4. Rezervasyon Hatırlatma Emaili (1 saat önce)
app.post('/api/email/send-reservation-reminder', async (req, res) => {
  try {
    const { 
      email, 
      name, 
      reservationCode, 
      items,
      appointmentTime 
    } = req.body;

    const itemsHtml = items.map(item => `
      <li style="margin-bottom: 8px;"><strong>${item.name}</strong></li>
    `).join('');

    const { data: emailData, error } = await resend.emails.send({
      from: 'Spafokus <noreply@spafokus.com>',
      to: email,
      subject: `Rezervasyon Hatırlatması - ${reservationCode}`,
      html: `
        <!DOCTYPE html>
        <html lang="tr">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Rezervasyon Hatırlatması</title>
          <style>
            body { 
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; 
              line-height: 1.6; 
              color: #333333; 
              margin: 0; 
              padding: 0; 
              background-color: #f8f9fa;
            }
            .container { 
              max-width: 600px; 
              margin: 20px auto; 
              background-color: #ffffff;
              border-radius: 8px;
              overflow: hidden;
              box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            }
            .header { 
              background-color: #ffc107; 
              color: #212529; 
              padding: 30px 20px; 
              text-align: center; 
            }
            .content { 
              padding: 30px 20px; 
            }
            .time-box { 
              font-size: 20px; 
              font-weight: bold; 
              color: #ffc107; 
              text-align: center; 
              padding: 20px; 
              background-color: #fff8e1; 
              border-radius: 6px; 
              margin: 20px 0;
              border: 2px solid #ffc107;
            }
            .footer { 
              text-align: center; 
              padding: 20px; 
              font-size: 12px; 
              color: #666666;
              background-color: #f8f9fa;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1 style="margin: 0;">Rezervasyonunuz Yaklaşıyor</h1>
              <p style="margin: 5px 0 0 0;">Spafokus</p>
            </div>
            
            <div class="content">
              <h2 style="color: #122134; margin-top: 0;">Merhaba ${name}!</h2>
              
              <p><strong>Rezervasyonunuza 1 saat kaldı!</strong></p>
              
              <div class="time-box">
                ${appointmentTime}
              </div>
              
              <h3 style="color: #122134;">Hizmetleriniz:</h3>
              <ul style="padding-left: 20px;">
                ${itemsHtml}
              </ul>
              
              <p><strong>Rezervasyon Kodu:</strong> ${reservationCode}</p>
              
              <div style="background-color: #e3f2fd; padding: 15px; border-radius: 6px; margin: 20px 0;">
                <p style="margin: 0;"><strong>İpucu:</strong> Randevunuza 10-15 dakika önce gelmenizi öneririz.</p>
              </div>
              
              <p style="margin-top: 20px; color: #122134; font-weight: 600;">Sizi görmeyi sabırsızlıkla bekliyoruz!</p>
            </div>
            
            <div class="footer">
              <p style="margin: 0;">© 2025 Spafokus - Online Rezervasyon Sistemi</p>
            </div>
          </div>
        </body>
        </html>
      `,
      text: `
Merhaba ${name}!

Rezervasyonunuza 1 saat kaldı!

Randevu Zamanı: ${appointmentTime}

Hizmetleriniz:
${items.map(item => `- ${item.name}`).join('\n')}

Rezervasyon Kodu: ${reservationCode}

İpucu: Randevunuza 10-15 dakika önce gelmenizi öneririz.

Sizi görmeyi sabırsızlıkla bekliyoruz!

© 2025 Spafokus - Online Rezervasyon Sistemi
      `,
      headers: {
        'X-Priority': '2',
        'X-MSMail-Priority': 'High',
        'Importance': 'High'
      }
    });

    if (error) {
      throw new Error(error.message);
    }
    
    console.log('✅ Hatırlatma emaili gönderildi:', email);
    res.json({ success: true });
    
  } catch (error) {
    console.error('❌ Email gönderme hatası:', error);
    res.status(500).json({ error: error.message });
  }
});

// Müşteri API'leri

// 1. Müşteri Kayıt Kontrolü
app.post('/api/customer/check', async (req, res) => {
  try {
    const { email, spaId } = req.body;
    
    if (!email || !spaId) {
      return res.status(400).json({ 
        error: 'Email ve Spa ID gerekli',
        exists: false 
      });
    }

    // Firebase'den müşteri bilgilerini kontrol et
    const customerRef = db.collection('spaLocations').doc(spaId).collection('musteri');
    const customerQuery = await customerRef.where('email', '==', email).limit(1).get();
    
    if (customerQuery.empty) {
      return res.json({ 
        exists: false,
        message: 'Müşteri kaydı bulunamadı' 
      });
    }

    const customerDoc = customerQuery.docs[0];
    const customerData = customerDoc.data();
    
    console.log('✅ Müşteri bulundu:', email);
    res.json({ 
      exists: true,
      customer: {
        id: customerDoc.id,
        email: customerData.email,
        name: customerData.name,
        phone: customerData.phone,
        registerTime: customerData.registerTime
      }
    });
    
  } catch (error) {
    console.error('❌ Müşteri kontrol hatası:', error);
    res.status(500).json({ 
      error: 'Müşteri kontrolü başarısız',
      message: error.message,
      exists: false
    });
  }
});

// 2. Müşteri Kaydı
app.post('/api/customer/register', async (req, res) => {
  try {
    const { email, name, phone, countryCode, spaId } = req.body;
    
    if (!email || !name || !phone || !spaId) {
      return res.status(400).json({ 
        error: 'Email, isim, telefon ve Spa ID gerekli' 
      });
    }

    // Önce müşterinin zaten kayıtlı olup olmadığını kontrol et
    const customerRef = db.collection('spaLocations').doc(spaId).collection('musteri');
    const existingCustomer = await customerRef.where('email', '==', email).limit(1).get();
    
    if (!existingCustomer.empty) {
      return res.status(409).json({ 
        error: 'Bu email adresi ile zaten kayıt var' 
      });
    }

    // Yeni müşteri kaydı oluştur
    const customerData = {
      email,
      name,
      phone,
      countryCode: countryCode || '+90',
      registerTime: admin.firestore.FieldValue.serverTimestamp(),
      spaId,
      isActive: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const newCustomerRef = await customerRef.add(customerData);
    
    console.log('✅ Yeni müşteri kaydedildi:', email, '- ID:', newCustomerRef.id);
    res.json({ 
      success: true,
      customerId: newCustomerRef.id,
      message: 'Müşteri başarıyla kaydedildi'
    });
    
  } catch (error) {
    console.error('❌ Müşteri kayıt hatası:', error);
    res.status(500).json({ 
      error: 'Müşteri kaydı başarısız',
      message: error.message 
    });
  }
});

// 3. Müşteri Bilgilerini Getir
app.post('/api/customer/get', async (req, res) => {
  try {
    const { email, spaId } = req.body;
    
    if (!email || !spaId) {
      return res.status(400).json({ 
        error: 'Email ve Spa ID gerekli' 
      });
    }

    // Firebase'den müşteri bilgilerini al
    const customerRef = db.collection('spaLocations').doc(spaId).collection('musteri');
    const customerQuery = await customerRef.where('email', '==', email).limit(1).get();
    
    if (customerQuery.empty) {
      return res.status(404).json({ 
        error: 'Müşteri bulunamadı',
        customer: null 
      });
    }

    const customerDoc = customerQuery.docs[0];
    const customerData = customerDoc.data();
    
    console.log('✅ Müşteri bilgileri alındı:', email);
    res.json({ 
      success: true,
      customer: {
        id: customerDoc.id,
        email: customerData.email,
        name: customerData.name,
        phone: customerData.phone,
        countryCode: customerData.countryCode,
        registerTime: customerData.registerTime,
        spaId: customerData.spaId,
        isActive: customerData.isActive
      }
    });
    
  } catch (error) {
    console.error('❌ Müşteri bilgileri alma hatası:', error);
    res.status(500).json({ 
      error: 'Müşteri bilgileri alınamadı',
      message: error.message 
    });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok',
    environment: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString()
  });
});

// Test endpoint
app.get('/api/test', (req, res) => {
  res.json({
    message: 'Server is running',
    groqApiKeySet: !!process.env.GROQ_API_KEY,
    environment: process.env.NODE_ENV,
    port: process.env.PORT || 5000
  });
});

const NODE_ENV = process.env.NODE_ENV || 'development';

app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════╗
║    🚀 Proxy Server Başlatıldı                          ║
║    Port: ${PORT}                                       
║    Environment: ${NODE_ENV}                            
║    URL: http://localhost:${PORT}                       ║
╠════════════════════════════════════════════════════════╣
║    🔒 CORS İzinleri:                                   ║
║    ✅ https://spafokus.com                             ║
║    ✅ https://*.spafokus.com (tüm subdomain'ler)      ║
║    ✅ http://localhost:3000 (development)             ║
║    ✅ http://localhost:5000 (local test)              ║
║    ❌ Diğer origin'ler reddedilecek                    ║
╠════════════════════════════════════════════════════════╣
║    ⚡ Rate Limit Koruması:                             ║
║    📧 Email Giriş Linki: 5 istek / 10 dakika          ║
║    🛡️  IP + Email bazlı kontrol                       ║
║    📩 Spam önleme optimizasyonları aktif              ║
╠════════════════════════════════════════════════════════╣
║    👥 Müşteri API'leri:                               ║
║    🔍 /api/customer/check - Müşteri kontrol           ║
║    📝 /api/customer/register - Müşteri kayıt          ║
║    📋 /api/customer/get - Müşteri bilgileri           ║
║    🏢 Firebase musteri koleksiyonu entegrasyonu       ║
╚════════════════════════════════════════════════════════╝
  `);
});
