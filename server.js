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
// --- BẮT ĐẦU PHẦN THÊM MỚI ---

// 1. Nạp các thư viện cần thiết
require('dotenv').config(); // Nạp file .env ở đầu tiên
const { GoogleGenerativeAI } = require("@google/generative-ai");

// 2. Tăng giới hạn payload cho JSON (RẤT QUAN TRỌNG VÌ BASE64 RẤT LỚN)
// Hãy chắc chắn bạn có dòng này và nó phải nằm TRƯỚC các app.post()
// Nếu bạn đã có app.use(express.json()), hãy thay thế nó bằng dòng này:
app.use(express.json({ limit: '50mb' })); 
// (Bạn cũng có thể cần app.use(express.urlencoded({ limit: '50mb', extended: true }));)


// 3. Khởi tạo Google AI
if (!process.env.GEMINI_API_KEY) {
    console.error("LỖI: GEMINI_API_KEY chưa được thiết lập trong file .env");
}
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" }); // Cập nhật model nếu cần

// --- HÀM HELPER CHUYỂN ĐỔI ---
// Hàm này tạo 'parts' cho Google AI SDK từ mảng base64
function filesToGenerativeParts(filesBase64, mimeType = "image/jpeg") {
  return filesBase64.map(base64Data => ({
    inlineData: {
      data: base64Data,
      mimeType
    }
  }));
}

// 4. Tạo API Endpoint cho CCCD
app.post('/api/ocr-cccd', async (req, res) => {
    try {
        const { filesAsBase64 } = req.body; // Lấy mảng base64 từ request
        if (!filesAsBase64 || filesAsBase64.length === 0) {
            return res.status(400).json({ error: "Không có file nào được tải lên." });
        }

        const prompt = `Bạn là một trợ lý AI chuyên nghiệp, nhiệm vụ của bạn là phân tích hình ảnh Căn cước công dân (CCCD) của Việt Nam (có thể là mặt trước và mặt sau) và trả về dữ liệu có cấu trúc JSON. Hãy trích xuất các thông tin sau: "ho_ten", "so_cccd", "ngay_sinh", "gioi_tinh", "noi_thuong_tru", "ngay_cap", "noi_cap", "ngay_het_han". Trường "noi_cap" (Nơi cấp) thường nằm ở mặt sau, gần ngày cấp. Gộp thông tin từ các ảnh nếu cần. ĐỊNH DẠNG ĐẦU RA: Phản hồi của bạn BẮT BUỘC chỉ được chứa đối tượng JSON, không có văn bản giải thích hay định dạng markdown. Nếu không tìm thấy thông tin cho một trường, hãy trả về một chuỗi rỗng "".`;

        const imageParts = filesToGenerativeParts(filesAsBase64);
        
        // Tạo nội dung request cho SDK
        const contents = [{ 
            parts: [
                { text: prompt }, 
                ...imageParts
            ] 
        }];

        const result = await model.generateContent({ contents });
        const response = await result.response;
        const text = response.text();
        
        // Trả về text chứa JSON cho client
        res.json({ text: text }); 

    } catch (e) {
        console.error("Lỗi tại /api/ocr-cccd:", e);
        res.status(500).json({ error: e.message });
    }
});

// 5. Tạo API Endpoint cho QSDĐ (Sổ đỏ)
app.post('/api/ocr-qsdd', async (req, res) => {
    try {
        const { base64Data } = req.body; // Lấy 1 chuỗi base64 từ request
        if (!base64Data) {
            return res.status(400).json({ error: "Không có file nào được tải lên." });
        }

        // Dán prompt QSDĐ của bạn vào đây
        const prompt = `Bạn là một trợ lý AI chuyên nghiệp, nhiệm vụ của bạn là phân tích hình ảnh Giấy chứng nhận Quyền sử dụng đất (GCN) của Việt Nam và trả về một đối tượng JSON DUY NHẤT.
**QUY TRÌNH BẮT BUỘC:**
1.  **Phân tích "Thửa đất":**
    * \`ten_gcn\`: Tìm dòng chữ "GIẤY CHỨNG NHẬN". Trích xuất toàn bộ dòng chữ nằm **ngay bên dưới** nó (ví dụ: "QUYỀN SỬ DỤNG ĐẤT", "QUYỀN SỞ HỮU NHÀ Ở VÀ TÀI SẢN KHÁC GẮN LIỀN VỚI ĐẤT").
    * \`so_gcn\`: Tìm mã số của GCN. Mã số GCN là một chuỗi có định dạng "1 chữ cái + 6 số", "2 chữ cái + 6 số", hoặc "2 chữ cái + 8 số" (ví dụ: "Đ 519908", "BO 007850", "AA 04352588").
    * \`so_vao_so_cap_gcn\`: Tìm "Số vào sổ cấp GCN". Nhập số vào sổ GCN là dữ liệu sau dòng "Số vào sổ cấp giấy chứng nhận" hoặc "Số vào sổ cấp GCN" (ví dụ: "CN 179", "00504/QSDĐ/LA", "CS02952", "H00460/NQSDĐ", "CH 00149", "H02321").
    * \`noi_cap_gcn\`: Tìm nơi cấp GCN. Trích xuất đầy đủ tên cơ quan (ví dụ: "Uỷ ban nhân dân huyện Tân Thạnh", "Sở Tài nguyên và Môi trường tỉnh Long An").
    * \`ngay_cap_gcn\`: Tìm ngày cấp GCN. Trích xuất đầy đủ (ví dụ: "ngày 20 tháng 05 năm 2020").
    * \`so_thua\`: Tìm số thửa đất. Nhập số thửa đất chính của chủ sở hữu. Nếu hình ảnh GCN có nhiều thửa chia theo hàng và cột, hãy xác định các số thửa đó và nhập số các thửa đất vào cách nhau bằng dấu "," (ví dụ: "31, 51, 43").
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

        const imagePart = {
            inlineData: {
                data: base64Data,
                mimeType: "image/jpeg" 
            }
        };

        const contents = [{ 
            parts: [
                { text: prompt }, 
                imagePart
            ] 
        }];
        
        const result = await model.generateContent({ contents });
        const response = await result.response;
        const text = response.text();
        
        // Trả về text chứa JSON cho client
        res.json({ text: text }); 

    } catch (e) {
        console.error("Lỗi tại /api/ocr-qsdd:", e);
        res.status(500).json({ error: e.message });
    }
});

// --- KẾT THÚC PHẦN THÊM MỚI ---