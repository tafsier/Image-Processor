const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch'); // node-fetch v2
const FormData = require('form-data');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Multer in-memory storage
const upload = multer({ storage: multer.memoryStorage() });

// API keys (should be in environment variables in production)
const REMOVE_BG_API_KEY = process.env.REMOVE_BG_API_KEY || "YOUR_REMOVE_BG_API_KEY";
const REPLICATE_API_KEY = process.env.REPLICATE_API_KEY || "YOUR_REPLICATE_API_KEY";

// Middleware
app.use(cors());
app.use(express.json());

// Ensure uploads folder exists
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

// Check for API keys
if (
  !REMOVE_BG_API_KEY ||
  REMOVE_BG_API_KEY === "YOUR_REMOVE_BG_API_KEY" ||
  !REPLICATE_API_KEY ||
  REPLICATE_API_KEY === "YOUR_REPLICATE_API_KEY"
) {
  console.error('ERROR: API keys are missing or not set.');
  process.exit(1);
}

// Process endpoint
app.post('/process', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image uploaded' });
    }

    // 1) Remove background
    const formData = new FormData();
    formData.append('image_file', req.file.buffer, {
      filename: req.file.originalname,
      contentType: req.file.mimetype
    });
    formData.append('size', 'auto');

    const removeRes = await fetch('https://api.remove.bg/v1.0/removebg', {
      method: 'POST',
      headers: {
        'X-Api-Key': REMOVE_BG_API_KEY,
        ...formData.getHeaders()
      },
      body: formData
    });

    if (!removeRes.ok) {
      const error = await removeRes.text();
      return res.status(400).json({ error: 'Remove.bg failed', details: error });
    }

    const buffer = await removeRes.buffer();
    const filename = `removed_${Date.now()}.png`;
    const removedBgPath = path.join('uploads', filename);
    fs.writeFileSync(removedBgPath, buffer);

    // 2) Enhance with Replicate
    const replicateRes = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${REPLICATE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        version: "42fed1c4974146d4d2414e2be2c5277c7fcf05fcc3a73abf41610695738c1d7b",
        input: {
          image: `data:image/png;base64,${buffer.toString('base64')}`,
          scale: 2,
          face_enhance: false
        }
      })
    });

    if (!replicateRes.ok) {
      const error = await replicateRes.json();
      return res.status(400).json({ error: 'Replicate API failed', details: error });
    }

    const replicateJson = await replicateRes.json();

    if (!replicateJson.urls || !replicateJson.urls.get) {
      return res.status(400).json({ error: 'Replicate API response missing URLs' });
    }

    // 3) Poll for completion
    let outputUrl;
    let attempts = 0;
    const maxAttempts = 30; // ~60 seconds

    while (attempts < maxAttempts) {
      const finalRes = await fetch(replicateJson.urls.get, {
        headers: {
          'Authorization': `Bearer ${REPLICATE_API_KEY}`
        }
      });

      const finalJson = await finalRes.json();

      if (finalJson.status === 'succeeded') {
        outputUrl = finalJson.output;
        break;
      } else if (finalJson.status === 'failed') {
        return res.status(400).json({ error: 'Image enhancement failed', details: finalJson });
      }

      attempts++;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    if (!outputUrl) {
      return res.status(408).json({ error: 'Image enhancement timed out' });
    }

    res.json({
      success: true,
      removed_bg: `/uploads/${filename}`,
      enhanced_url: outputUrl
    });

  } catch (err) {
    console.error('Processing error:', err);
    res.status(500).json({
      error: 'Internal server error',
      message: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
});

// Serve uploads statically
app.use('/uploads', express.static('uploads'));

// Health endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

// Root endpoint
app.get('/', (req, res) => {
  res.send('Shopify Product Image Processor API is running');
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});