# TODO - Application Emoji Integration

- [x] Analyze existing codebase
- [x] Propose plan and get user approval
- [x] Create `netflix/utils/emoji.js` helper module
- [x] Update `netflix/index.js` to use application emojis
- [x] Syntax check passed (both `index.js` & `utils/emoji.js`)

## Next Steps for User

1. **Upload Application Emojis** vào Discord Developer Portal:
   - Truy cập: https://discord.com/developers/applications
   - Chọn bot → tab **Emoji**
   - Upload ảnh PNG/JPG/GIF với tên **chính xác** như bên dưới:
     - `netflix` – Logo Netflix
     - `premium`, `standard`, `basic`, `mobile` – Icon các gói
     - `phone`, `pc`, `guide` – Icon thiết bị / hướng dẫn
     - `country_us`, `country_vn`, `country_jp`... – Cờ quốc gia
     - `email`, `files`, `trash`, `success`, `error`, `warning`, `loading`, `party`

2. **Restart bot** (`node index.js`) để `initAppEmojis()` tự động fetch ID emoji mới.

3. Nếu chưa upload emoji, bot sẽ tự động fallback về emoji Unicode mặc định (🎬, 💎, ⭐, 🔵, 📱, 🖥️, 🌍, v.v.)
