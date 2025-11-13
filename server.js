const express = require('express');
const cors = require('cors');
const https = require('https');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const path = require('path'); // Dùng để phục vụ tệp app.html

const app = express();
const PORT = process.env.PORT || 3000; // Render sẽ tự động cung cấp biến process.env.PORT

// --- 1. Cấu hình Middleware ---
app.use(cors()); // Cho phép frontend gọi API
app.use(express.json()); // Đọc dữ liệu JSON từ req.body

// Helper để tải tệp từ URL (vì template của bạn ở trên GitHub)
const fetchTemplate = (url) => {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
                return reject(new Error(`Lỗi tải template: ${res.statusCode}`));
            }
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        }).on('error', reject);
    });
};

// --- 2. Tạo Route API ---
// Đây là route mà app.html sẽ gọi
app.post('/generate-docx', async (req, res) => {
    try {
        const { templateUrl, data } = req.body;

        if (!templateUrl || !data) {
            return res.status(400).json({ error: 'Thiếu `templateUrl` hoặc `data`' });
        }

        // Tải template
        const templateBuffer = await fetchTemplate(templateUrl);
        const zip = new PizZip(templateBuffer);

        // Điền dữ liệu
        const doc = new Docxtemplater(zip, {
            paragraphLoop: true,
            linebreaks: true,
        });
        
        doc.setData(data);
        doc.render();

        // Tạo buffer đầu ra
        const outputBuffer = doc.getZip().generate({
            type: 'nodebuffer',
            compression: 'DEFLATE',
        });

        // Gửi tệp về cho client
        res.setHeader('Content-Disposition', 'attachment; filename="generated_doc.docx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.status(200).send(outputBuffer);

    } catch (error) {
        console.error('Lỗi khi tạo tệp DOCX:', error);
        res.status(500).json({ 
            error: 'Lỗi khi tạo tệp DOCX', 
            details: error.message 
        });
    }
});

// --- 3. Route phục vụ APP.HTML (Frontend) ---
// Gửi tệp app.html khi người dùng truy cập URL gốc
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'app.html'));
});

// --- 4. Khởi động Máy chủ ---
app.listen(PORT, () => {
    console.log(`Máy chủ đang lắng nghe tại cổng ${PORT}`);
});