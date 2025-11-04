const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:3002',
    'http://localhost:5000',
    'https://web-production-aac8f.up.railway.app'  // Railway production URL
  ],
  credentials: true
}));
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
╔════════════════════════════════════════╗
║    Proxy Server Başlatıldı             ║
║    Port: ${PORT}                      
║    Environment: ${NODE_ENV}
║    URL: http://localhost:${PORT}     ║
╚════════════════════════════════════════╝
  `);
});
