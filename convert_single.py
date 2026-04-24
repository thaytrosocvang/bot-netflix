"""
convert_single.py — Chạy Netflix Cookie Checker cho 1 cookie duy nhất.
Đọc raw Netscape cookie text từ stdin, in JSON ra stdout.

Output JSON:
  Success: { "email": "...", "plan": "...", "country": "...", "pc_link": "...", "phone_link": "..." }
  Error:   { "error": "..." }
"""

import sys
import os
import json
import re
import shutil
import subprocess
import tempfile

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Config tối giản: bật nftoken both, tắt notifications, tắt emoji trong txt
MINIMAL_CONFIG = """\
nftoken: "both"

add_emojis: false

notifications:
  webhook:
    enabled: false
    url: ""
    mode: "full"
    plans: "all"
  telegram:
    enabled: false
    bot_token: ""
    chat_id: ""
    mode: "full"
    plans: "all"

display:
  mode: "log"

retries:
  error_proxy_attempts: 3
  nftoken_attempts: 5

performance:
  request_timeout_seconds: 20
  fallback_account_page: false
  retry_incomplete_info: false
  nftoken_for_free: false

txt_fields:
  name: true
  email: true
  plan: true
  country: true
  member_since: false
  quality: false
  max_streams: false
  plan_price: false
  next_billing: false
  payment_method: false
  card: false
  phone: false
  hold_status: false
  extra_members: false
  email_verified: false
  membership_status: false
  profiles: false
  user_guid: false
"""


def _extract_nftoken_links(content: str):
    """
    Trích xuất PC link và Phone link từ nội dung file output.

    Chiến lược (theo thứ tự ưu tiên):
    1. Tìm theo label (PC Login / Phone Login / Desktop Login / Mobile Login …)
    2. Fallback: tìm theo URL pattern đặc trưng của Netflix NFToken
       - PC   : https://netflix.com/?nftoken=...
       - Phone: https://netflix.com/unsupported?nftoken=...
    """

    # ── 1. Tìm theo label ──────────────────────────────────────────────────
    # Các biến thể label checker có thể dùng
    pc_label_pattern    = r"(?:PC|Desktop|Computer)\s*(?:Login|NFToken|Link)\s*:\s*(https?://\S+)"
    phone_label_pattern = r"(?:Phone|Mobile)\s*(?:Login|NFToken|Link)\s*:\s*(https?://\S+)"

    pc_m    = re.search(pc_label_pattern,    content, re.IGNORECASE)
    phone_m = re.search(phone_label_pattern, content, re.IGNORECASE)

    pc_link    = pc_m.group(1).strip()    if pc_m    else None
    phone_link = phone_m.group(1).strip() if phone_m else None

    # ── 2. Fallback theo URL pattern ───────────────────────────────────────
    # PC token: netflix.com/?nftoken=  (không có /unsupported)
    # Phone token: netflix.com/unsupported?nftoken=
    if not pc_link:
        # Tìm tất cả URL nftoken, loại ra URL có /unsupported
        all_nftokens = re.findall(r"https?://[^\s\r\n]*nftoken=[^\s\r\n]+", content, re.IGNORECASE)
        for url in all_nftokens:
            if "unsupported" not in url.lower():
                pc_link = url.strip()
                break

    if not phone_link:
        phone_matches = re.findall(r"https?://[^\s\r\n]*unsupported[^\s\r\n]*nftoken=[^\s\r\n]+", content, re.IGNORECASE)
        if phone_matches:
            phone_link = phone_matches[0].strip()

    return pc_link, phone_link


def convert(cookie_text: str) -> dict:
    tmpdir = tempfile.mkdtemp(prefix="nf_convert_")
    try:
        # Tạo thư mục cookies/
        cookies_dir = os.path.join(tmpdir, "cookies")
        os.makedirs(cookies_dir, exist_ok=True)

        # Ghi cookie vào file
        with open(os.path.join(cookies_dir, "cookie.txt"), "w", encoding="utf-8") as f:
            f.write(cookie_text)

        # Ghi config tối giản (bật nftoken)
        with open(os.path.join(tmpdir, "config.yml"), "w", encoding="utf-8") as f:
            f.write(MINIMAL_CONFIG)

        # Copy proxy.txt (dùng rỗng nếu không có)
        proxy_src = os.path.join(BASE_DIR, "proxy.txt")
        proxy_dst = os.path.join(tmpdir, "proxy.txt")
        if os.path.exists(proxy_src):
            shutil.copy(proxy_src, proxy_dst)
        else:
            open(proxy_dst, "w").close()

        # Chạy main.py từ tmpdir, pipe stdin: Enter (welcome) + "1\n" (1 thread)
        main_py = os.path.join(BASE_DIR, "main.py")
        proc = subprocess.run(
            [sys.executable, main_py],
            input="\n1\n",
            capture_output=True,
            text=True,
            cwd=tmpdir,
            timeout=120,
        )

        # Tìm file output (tránh thư mục Duplicate/failed/broken)
        output_dir = os.path.join(tmpdir, "output")
        hit_files = []
        if os.path.exists(output_dir):
            for root, dirs, files in os.walk(output_dir):
                skip_keywords = ("duplicate", "failed", "broken", "on hold", "on_hold", "unknown", "free")
                if any(kw in root.lower() for kw in skip_keywords):
                    continue
                for fname in files:
                    if fname.lower().endswith(".txt"):
                        hit_files.append(os.path.join(root, fname))

        for hit_file in hit_files:
            try:
                with open(hit_file, "r", encoding="utf-8", errors="ignore") as f:
                    content = f.read()
            except Exception:
                continue

            pc_link, phone_link = _extract_nftoken_links(content)

            # Chỉ cần có ÍT NHẤT 1 link là trả về kết quả
            if pc_link or phone_link:
                email_m   = re.search(r"Email:\s*(.+)",   content, re.IGNORECASE)
                plan_m    = re.search(r"Plan:\s*(.+)",    content, re.IGNORECASE)
                country_m = re.search(r"Country:\s*(.+)", content, re.IGNORECASE)
                return {
                    "email":      (email_m.group(1).strip()   if email_m   else ""),
                    "plan":       (plan_m.group(1).strip()    if plan_m    else ""),
                    "country":    (country_m.group(1).strip() if country_m else ""),
                    "pc_link":    pc_link    or "",
                    "phone_link": phone_link or "",
                }

        # Không tạo được NFToken — cookie chết hoặc không có proxy
        stderr_tail = proc.stderr[-600:] if proc.stderr else ""
        return {"error": "Không tạo được NFToken. Cookie có thể đã hết hạn hoặc cần proxy.", "detail": stderr_tail}

    except subprocess.TimeoutExpired:
        return {"error": "Timeout: checker chạy quá 120 giây."}
    except Exception as exc:
        return {"error": str(exc)}
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == "__main__":
    cookie_text = sys.stdin.read().strip()
    if not cookie_text:
        print(json.dumps({"error": "Không có cookie data"}))
        sys.exit(1)

    result = convert(cookie_text)
    print(json.dumps(result, ensure_ascii=False))
    if "error" in result:
        sys.exit(1)