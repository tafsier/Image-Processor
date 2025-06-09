
const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch');
const FormData = require('form-data');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const upload = multer({ dest: 'uploads/' });
const PORT = process.env.PORT || 3000;

// المفاتيح السرية - يفضل تخزينها في متغيرات بيئة
const REMOVE_BG_API_KEY = "ZH5bA7XyURtKi2yc3bERV8f6";
const REPLICATE_API_KEY = "r8_YVR3NBxC7lR6fSEGT18M926Aks8ccz011VRlu";
const REAL_ESRGAN_MODEL = "cjwbw/real-esrgan";

// إعدادات عامة
app.use(cors());
app.use(express.json());

// نقطة استقبال الصورة
app.post('/process', upload.single('image'), async (req, res) => {
  try {
    const filePath = req.file.path;

    // 1) إزالة الخلفية
    const formData = new FormData();
    formData.append('image_file', fs.createReadStream(filePath));
    formData.append('size', 'auto');

    const removeRes = await fetch('https://api.remove.bg/v1.0/removebg', {
      method: 'POST',
      headers: {
        'X-Api-Key': REMOVE_BG_API_KEY
      },
      body: formData
    });

    if (!removeRes.ok) {
      const error = await removeRes.text();
      return res.status(400).json({ error: 'Remove.bg failed', details: error });
    }

    const buffer = await removeRes.buffer();
    const removedBgPath = path.join('uploads', `removed_${req.file.filename}.png`);
    fs.writeFileSync(removedBgPath, buffer);

    // 2) تحسين الجودة باستخدام Replicate
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

    const replicateJson = await replicateRes.json();

    if (!replicateJson.urls || !replicateJson.urls.get) {
      return res.status(400).json({ error: 'Replicate API failed', details: replicateJson });
    }

    // 3) جلب الرابط النهائي من Replicate
    const finalRes = await fetch(replicateJson.urls.get, {
      headers: {
        'Authorization': `Bearer ${REPLICATE_API_KEY}`
      }
    });

    const finalJson = await finalRes.json();
    const outputUrl = finalJson.output;

    res.json({
      success: true,
      removed_bg_local: `/uploads/removed_${req.file.filename}.png`,
      enhanced_url: outputUrl
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
