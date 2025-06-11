const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch');
const FormData = require('form-data');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'), false);
    }
  }
});

// API keys from environment variables
const REMOVE_BG_API_KEY = process.env.REMOVE_BG_API_KEY;
const REPLICATE_API_KEY = process.env.REPLICATE_API_KEY;

// Validate API keys on startup
if (!REMOVE_BG_API_KEY || !REPLICATE_API_KEY) {
  console.error('ERROR: API keys are missing in environment variables');
  process.exit(1);
}

// Middleware
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN ,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Utility function to clean up temporary files
const cleanupFile = (filePath) => {
  if (filePath && fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      console.error('Error cleaning up file:', err);
    }
  }
};

// Process image endpoint
app.post('/process', upload.single('image'), async (req, res) => {
  let removedBgPath = null;
  
  try {
    // Validate input
    if (!req.file) {
      return res.status(400).json({ error: 'No image file uploaded' });
    }

    // Step 1: Remove background with remove.bg
    const removeBgForm = new FormData();
    removeBgForm.append('image_file', req.file.buffer, {
      filename: req.file.originalname,
      contentType: req.file.mimetype
    });
    removeBgForm.append('size', 'auto');

    const removeBgResponse = await fetch('https://api.remove.bg/v1.0/removebg', {
      method: 'POST',
      headers: {
        'X-Api-Key': REMOVE_BG_API_KEY,
        ...removeBgForm.getHeaders()
      },
      body: removeBgForm
    });

    if (!removeBgResponse.ok) {
      const error = await removeBgResponse.json();
      throw new Error(`Background removal failed: ${error.errors?.join(', ') || 'Unknown error'}`);
    }

    // Save the background-removed image temporarily
    const bgRemovedBuffer = await removeBgResponse.buffer();
    const bgRemovedFilename = `removed_${Date.now()}.png`;
    removedBgPath = path.join(uploadsDir, bgRemovedFilename);
    fs.writeFileSync(removedBgPath, bgRemovedBuffer);

    // Step 2: Enhance image with Replicate
    const imageUrl = `${req.protocol}://${req.get('host')}/uploads/${bgRemovedFilename}`;
    
    const replicateResponse = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: {
        'Authorization': `Token ${REPLICATE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        version: "42fed1c4974146d4d2414e2be2c5277c7fcf05fcc3a73abf41610695738c1d7b",
        input: {
          image: imageUrl,
          scale: 2,
          face_enhance: false
        }
      })
    });

    if (!replicateResponse.ok) {
      const error = await replicateResponse.json();
      throw new Error(`Replicate API error: ${error.detail || 'Unknown error'}`);
    }

    const prediction = await replicateResponse.json();
    
    if (!prediction?.urls?.get) {
      throw new Error('Invalid response from Replicate API');
    }

    // Step 3: Poll for enhancement completion
    let enhancedImageUrl = null;
    let attempts = 0;
    const maxAttempts = 30; // ~60 seconds timeout

    while (attempts < maxAttempts && !enhancedImageUrl) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      const statusResponse = await fetch(prediction.urls.get, {
        headers: {
          'Authorization': `Token ${REPLICATE_API_KEY}`
        }
      });

      const statusData = await statusResponse.json();
      
      if (statusData.status === 'succeeded') {
        enhancedImageUrl = statusData.output;
        break;
      } else if (statusData.status === 'failed') {
        throw new Error('Image enhancement failed');
      }
      
      attempts++;
    }

    if (!enhancedImageUrl) {
      throw new Error('Image enhancement timed out');
    }

    // Step 4: Prepare response
    res.json({
      success: true,
      originalSize: req.file.size,
      removedBgUrl: `/uploads/${bgRemovedFilename}`,
      enhancedUrl: enhancedImageUrl,
      processingTime: `${attempts * 2} seconds`
    });

  } catch (error) {
    console.error('Processing error:', error);
    if (removedBgPath) cleanupFile(removedBgPath);
    
    res.status(500).json({
      success: false,
      error: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Serve uploaded files
app.use('/uploads', express.static(uploadsDir));

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy',
    services: {
      removeBg: REMOVE_BG_API_KEY ? 'configured' : 'missing',
      replicate: REPLICATE_API_KEY ? 'configured' : 'missing'
    }
  });
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: err.message
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Upload directory: ${uploadsDir}`);
  console.log(`CORS allowed origin: ${process.env.ALLOWED_ORIGIN || 'All origins (*)'}`);
});