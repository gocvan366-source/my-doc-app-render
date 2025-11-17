const express = require('express');
const cors = require('cors');
const https = require('https'); // Dùng để gọi Gemini API
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const path = require('path');

// --- START: THÊM API KEY VÀO ĐÂY ---
// Đây là API key bạn đã xóa từ app.html
// Tốt nhất, bạn nên đặt cái này làm Biến Môi trường (Environment Variable) trên Render
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; // XÓA key dự phòng
// --- END: THÊM API KEY ---

const app = express();
const PORT = process.env.PORT || 3000;

// --- 1. Cấu hình Middleware ---
const whitelist = [
    'https://autodoc-ctg.onrender.com', // URL backend (cho phép tự gọi chính nó)
    'https://autodoc-tsdb.web.app'      // URL frontend mới của bạn
];
const corsOptions = {
  origin: function (origin, callback) {
    if (whitelist.indexOf(origin) !== -1 || !origin) {
      callback(null, true);
    } else {
      callback(new Error('Yêu cầu này không được phép bởi CORS'));
    }
  },
  optionsSuccessStatus: 200 
};
app.use(cors(corsOptions));
// Tăng giới hạn JSON body lên 50mb để xử lý ảnh base64
app.use(express.json({ limit: '50mb' }));

// Helper để tải tệp từ URL (cho DOCX)
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

// --- START: HELPER MỚI ĐỂ GỌI GEMINI API ---
/**
 * Hàm này đóng vai trò trung gian, gọi đến Google Gemini API một cách an toàn
 * @param {object} payload - Toàn bộ payload (contents) để gửi cho Gemini
 * @returns {Promise<string>} - Trả về phần text thô (đã clean) từ Gemini
 */
const callGemini = (payload) => {
    return new Promise((resolve, reject) => {
        // THÊM: Kiểm tra xem API key có tồn tại không
        if (!GEMINI_API_KEY) {
            console.error('Lỗi nghiêm trọng: Biến môi trường GEMINI_API_KEY chưa được thiết lập trên server.');
            return reject(new Error('Lỗi: Biến môi trường GEMINI_API_KEY chưa được thiết lập trên server.'));
        }
        // KẾT THÚC THÊM

        const model = 'gemini-2.5-flash-preview-09-2025';
        const apiPath = `/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
        
        const options = {
            hostname: 'generativelanguage.googleapis.com',
            port: 443,
            path: apiPath,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    return reject(new Error(`Lỗi Gemini API (${res.statusCode}): ${data}`));
                }
                try {
                    const result = JSON.parse(data);
                    const rawText = result.candidates?.[0]?.content?.parts?.[0]?.text;
                    if (!rawText) {
                        return reject(new Error("Phản hồi Gemini không hợp lệ."));
                    }
                    // Clean text (giống hệt frontend)
                    resolve(rawText.replace(/```json/g, '').replace(/```/g, '').trim());
                } catch (e) {
                    reject(new Error(`Lỗi parsing JSON từ Gemini: ${e.message}`));
                }
            });
        });

        req.on('error', (e) => {
            reject(new Error(`Lỗi request đến Gemini: ${e.message}`));
        });

        // Gửi payload
        req.write(JSON.stringify(payload));
        req.end();
    });
};
// --- END: HELPER MỚI ---

// --- 2. Tạo Route API ---

// --- START: ENDPOINT MỚI CHO CCCD ---
app.post('/api/gemini-cccd', async (req, res) => {
    try {
        const { filesAsBase64 } = req.body;
        if (!filesAsBase64 || !Array.isArray(filesAsBase64) || filesAsBase64.length === 0) {
            return res.status(400).json({ error: 'Không có file ảnh nào được gửi (CCCD).' });
        }

        // Tái tạo lại prompt từ app.html
        const prompt = `Bạn là một trợ lý AI chuyên nghiệp, nhiệm vụ của bạn là phân tích hình ảnh Căn cước công dân (CCCD) của Việt Nam (có thể là mặt trước và mặt sau) và trả về dữ liệu có cấu trúc JSON. Hãy trích xuất các thông tin sau: "ho_ten", "so_cccd", "ngay_sinh", "gioi_tinh", "noi_thuong_tru", "ngay_cap", "noi_cap", "ngay_het_han". Trường "noi_cap" (Nơi cấp) thường nằm ở mặt sau, gần ngày cấp. Gộp thông tin từ các ảnh nếu cần. ĐỊNH DẠNG ĐẦU RA: Phản hồi của bạn BẮT BUỘC chỉ được chứa đối tượng JSON, không có văn bản giải thích hay định dạng markdown. Nếu không tìm thấy thông tin cho một trường, hãy trả về một chuỗi rỗng "".`;

        const parts = [{ text: prompt }];
        filesAsBase64.forEach(base64Data => {
            parts.push({
                inline_data: { mime_type: "image/jpeg", data: base64Data }
            });
        });

        const payload = { contents: [{ parts: parts }] };

        // Gọi helper an toàn
        const geminiTextResponse = await callGemini(payload);
        
        // Trả về JSON { text: "..." } để app.html có thể đọc
        res.status(200).json({ text: geminiTextResponse });

    } catch (error) {
        console.error('Lỗi tại /api/gemini-cccd:', error);
        res.status(500).json({ 
            error: 'Lỗi server khi xử lý CCCD', 
            details: error.message 
        });
    }
});
// --- END: ENDPOINT MỚI CHO CCCD ---

// --- START: ENDPOINT MỚI CHO QSDĐ ---
app.post('/api/gemini-qsdd', async (req, res) => {
    try {
        const { base64Data } = req.body;
        if (!base64Data) {
            return res.status(400).json({ error: 'Không có file ảnh nào được gửi (QSDĐ).' });
        }

        // Tái tạo lại prompt từ app.html
        const prompt = `Bạn là một trợ lý AI chuyên nghiệp, nhiệm vụ của bạn là phân tích hình ảnh Giấy chứng nhận Quyền sử dụng đất (GCN) của Việt Nam và trả về một đối tượng JSON DUY NHẤT.
**QUY TRÌNH BẮT BUỘC:**
1.  **Phân tích "Thửa đất":**
    * \`ten_gcn\`: Tìm dòng chữ "GIẤY CHỨNG NHẬN". Trích xuất toàn bộ dòng chữ VIẾT HOA nằm **ngay bên dưới** nó (ví dụ: "QUYỀN SỬ DỤNG ĐẤT", "QUYỀN SỬ DỤNG ĐẤT QUYỀN SỞ HỮU NHÀ Ở VÀ TÀI SẢN KHÁC GẮN LIỀN VỚI ĐẤT", "QUYỀN SỬ DỤNG ĐẤT, QUYỀN SỞ HỮU TÀI SẢN GẮN LIỀN VỚI ĐẤT).
    * \`so_gcn\`: Tìm mã số của GCN. Mã số GCN là một chuỗi có định dạng "1 chữ cái + 6 số", "2 chữ cái + 6 số", hoặc "2 chữ cái + 8 số" (ví dụ: "Đ 519908", "BO 007850", "AA 04352588").
    * \`so_vao_so_cap_gcn\`: Tìm "Số vào sổ cấp GCN". Nhập số vào sổ GCN là dữ liệu sau dòng "Số vào sổ cấp giấy chứng nhận" hoặc "Số vào sổ cấp GCN" (ví dụ: "CN 179", "00504/QSDĐ/LA", "CS02952", "H00460/NQSDĐ", "CH 00149", "H02321").
    * \`noi_cap_gcn\`: Tìm nơi cấp GCN. Trích xuất đầy đủ tên cơ quan (ví dụ: "Uỷ ban nhân dân huyện Tân Thạnh", "Sở Tài nguyên và Môi trường tỉnh Long An").
    * \`ngay_cap_gcn\`: Tìm ngày cấp GCN. Trích xuất đầy đủ (ví dụ: "ngày 20 tháng 05 năm 2020").
    * \`so_thua\`: Tìm thửa đất số. Tìm thông tin trong dữ liệu về mục "Thửa đất số" để lấy các số của thửa đất (ví dụ: "31, 51, 43"). Các dữ liệu kiểu ví dụ như "5 thửa" "6 thửa" thì không lấy dữ liệu này "
    * \`to_ban_do\`: Tìm "Tờ bản đồ số".
    * \`dia_chi\`: Tìm "Địa chỉ thửa đất". ƯU TIÊN lấy phần dữ liệu có dạng "xã....tỉnh...." hoặc "xã....huyện....tỉnh....". Sau đó, nếu có thông tin "Ấp" riêng lẻ, hãy kết hợp nó vào (ví dụ: "Ấp..., xã..., huyện..., tỉnh..."). BẮT BUỘC PHẢI CÓ "xã" và "tỉnh" trong kết quả cuối cùng. Ghi đầy đủ trên cùng 1 hàng.
    * \`dien_tich\`: Tìm "Diện tích". Ghi rõ số và đơn vị (ví dụ: "125,5 m²"). Nếu GCN có nhiều thửa đất nằm trong bảng gồm nhiều cột và hàng và hình ảnh có số diện tích tổng thì lấy số đó, nếu chưa có diện tích tổng thì cộng diện tích các thửa trong bảng lại.
    * \`hinh_thuc_su_dung\`: Tìm "Hình thức sử dụng" (ví dụ: "Sử dụng riêng").
    * \`muc_dich_su_dung\`: Tìm "Mục đích sử dụng" (ví dụ: "Đất ở tại đô thị (ODT)").
    * \`thoi_han_su_dung\`: Tìm "Thời hạn sử dụng" (ví dụ: "Lâu dài", "Đến ngày 15/10/2063").
    * \`nguon_goc_su_dung\`: Tìm "Nguồn gốc sử dụng".
2.  **Phân tích "Tài sản gắn liền với đất" (Nếu có):**
    * \`loai_nha_o\`: Tìm "Loại nhà ở" (ví dụ: "Nhà ở riêng lẻ").
    * \`dien_tich_xay_dung\`: Tìm "Diện tích xây dựng" (ví dụ: "100,5 m²").
    * \`dien_tich_san\`: Tìm "Diện tích sàn" (ví dụ: "200,5 m²").
    * \`hinh_thuc_so_huu_tai_san\`: Tìm "Hình thức sở hữu" cho tài sản (ví dụ: "Sở hữu riêng").
    * \`cap_hang\`: Tìm "Cấp (Hạng)" của nhà (ví dụ: "Cấp 4").
    * \`thoi_han_so_huu_tai_san\`: Tìm "Thời hạn sở hữu" cho tài sản.
**ĐỊNH DẠNG ĐẦU RA:**
* **CHỈ TRẢ VỀ JSON:** Phản hồi của bạn BẮT BUỘC chỉ được chứa đối tượng JSON, không có văn bản giải thích hay định dạng markdown.
* Tất cả các trường phải nằm trong MỘT đối tượng JSON duy nhất.
* Nếu không tìm thấy thông tin cho một trường, hãy trả về một chuỗi rỗng "".`;

        const payload = { 
            contents: [{ 
                parts: [
                    { text: prompt }, 
                    { inline_data: { mime_type: "image/jpeg", data: base64Data } }
                ] 
            }] 
        };

        // Gọi helper an toàn
        const geminiTextResponse = await callGemini(payload);
        
        // Trả về JSON { text: "..." } để app.html có thể đọc
        res.status(200).json({ text: geminiTextResponse });

    } catch (error) {
        console.error('Lỗi tại /api/gemini-qsdd:', error);
        res.status(500).json({ 
            error: 'Lỗi server khi xử lý QSDĐ', 
            details: error.message 
        });
    }
});
// --- END: ENDPOINT MỚI CHO QSDĐ ---

// Route cho DOCX (Giữ nguyên)
app.post('/generate-docx', async (req, res) => {
    try {
        const { templateUrl, data } = req.body;

        if (!templateUrl || !data) {
            return res.status(400).json({ error: 'Thiếu `templateUrl` hoặc `data`' });
        }

        const templateBuffer = await fetchTemplate(templateUrl);
        const zip = new PizZip(templateBuffer);

        const doc = new Docxtemplater(zip, {
            paragraphLoop: true,
            linebreaks: true,
        });
        
        doc.setData(data);
        doc.render();

        const outputBuffer = doc.getZip().generate({
            type: 'nodebuffer',
            compression: 'DEFLATE',
        });

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
// Dùng path.join(__dirname, ...) để đảm bảo nó hoạt động trên mọi hệ điều hành
app.use(express.static(path.join(__dirname))); // Phục vụ các tệp tĩnh (nếu có)
app.get('/', (req, res) => {
    // Gửi app.html khi người dùng truy cập
    res.sendFile(path.join(__dirname, 'app.html'));
});

// --- 4. Khởi động Máy chủ ---
app.listen(PORT, () => {
    console.log(`Máy chủ đang lắng nghe tại cổng ${PORT}`);
});