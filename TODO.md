# TODO - Application Emoji Integration

- [x] Analyze existing codebase
- [x] Propose plan and get user approval
- [x] Create `netflix/utils/emoji.js` helper module
- [x] Update `netflix/index.js` to use application emojis
- [x] Syntax check passed (both `index.js` & `utils/emoji.js`)

## What you ONLY need to upload (optional)

Bot đã **tự động sinh cờ quốc gia Unicode** (🇺🇸 🇻🇳 🇯🇵 🇰🇷 🇬🇧 …) từ country code, **không cần upload cờ từng nước**.

Bạn chỉ cần upload vài emoji đặc biệt nếu muốn (hoàn toàn tùy chọn):
- `netflix` – Logo Netflix
- `premium`, `standard`, `basic`, `mobile` – Icon gói (nếu muốn đẹp hơn Unicode)
- `phone`, `pc`, `guide` – Icon thiết bị

## How to upload (if you want custom ones)

1. Vào https://discord.com/developers/applications → chọn bot → tab **Emoji**.
2. Upload ảnh PNG/JPG/GIF, đặt tên **chính xác** như trên.
3. Restart bot (`node index.js`).
4. Nếu chưa upload, bot tự động dùng emoji Unicode mặc định (🎬, 💎, ⭐, 📱, 🖥️, v.v.).

