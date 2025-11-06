const express = require('express');
const cors = require('cors');
const axios = require('axios');
const admin = require('firebase-admin');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Firebase Admin SDK Initialization
const serviceAccount = {
  type: "service_account",
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
};

try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log('✅ Firebase Admin SDK initialized successfully');
} catch (error) {
  console.error('❌ Firebase Admin SDK initialization failed:', error.message);
}

// Middleware
app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://localhost:3001',
    'http://tradefy.com.tr',
    'http://localhost:5000'
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

// Firestore Document Operations
app.post('/api/firebase/firestore/doc', async (req, res) => {
  try {
    const { collection, docId, data, operation } = req.body;
    const db = admin.firestore();
    const docRef = db.collection(collection).doc(docId);

    let result;
    switch (operation) {
      case 'get':
        const docSnap = await docRef.get();
        result = { exists: docSnap.exists, data: docSnap.data(), id: docSnap.id };
        break;
      case 'set':
        await docRef.set(data);
        result = { success: true };
        break;
      case 'update':
        await docRef.update(data);
        result = { success: true };
        break;
      case 'delete':
        await docRef.delete();
        result = { success: true };
        break;
      default:
        throw new Error('Invalid operation');
    }

    res.json({ success: true, data: result });
  } catch (error) {
    console.error('Firestore doc error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Firestore Collection Operations
app.post('/api/firebase/firestore/collection', async (req, res) => {
  try {
    const { collection, data, operation } = req.body;
    const db = admin.firestore();
    const collectionRef = db.collection(collection);

    let result;
    switch (operation) {
      case 'get':
        const snapshot = await collectionRef.get();
        result = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        break;
      case 'add':
        const docRef = await collectionRef.add(data);
        result = { id: docRef.id };
        break;
      default:
        throw new Error('Invalid operation');
    }

    res.json({ success: true, data: result });
  } catch (error) {
    console.error('Firestore collection error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Firestore Query Operations
app.post('/api/firebase/firestore/query', async (req, res) => {
  try {
    const { collection, whereClauses = [], orderBy = null, limit = null } = req.body;
    const db = admin.firestore();
    let query = db.collection(collection);

    // Apply where clauses
    whereClauses.forEach(clause => {
      query = query.where(clause.field, clause.operator, clause.value);
    });

    // Apply orderBy
    if (orderBy) {
      query = query.orderBy(orderBy.field, orderBy.direction || 'asc');
    }

    // Apply limit
    if (limit) {
      query = query.limit(limit);
    }

    const snapshot = await query.get();
    const result = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    res.json({ success: true, data: result });
  } catch (error) {
    console.error('Firestore query error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Storage Upload
app.post('/api/firebase/storage/upload', async (req, res) => {
  try {
    // Note: File upload handling requires multer middleware
    res.status(501).json({ 
      success: false, 
      message: 'Storage upload not implemented yet - requires multer setup' 
    });
  } catch (error) {
    console.error('Storage upload error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Storage Download URL
app.post('/api/firebase/storage/download-url', async (req, res) => {
  try {
    const { path } = req.body;
    const bucket = admin.storage().bucket();
    const file = bucket.file(path);
    
    const [url] = await file.getSignedUrl({
      action: 'read',
      expires: Date.now() + 7 * 24 * 60 * 60 * 1000 // 7 days
    });

    res.json({ success: true, data: { url } });
  } catch (error) {
    console.error('Storage download URL error:', error);
    res.status(500).json({ success: false, message: error.message });
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

