import json
import re
import sys
import html
import unicodedata
from urllib.parse import quote
import requests
from urllib3.exceptions import InsecureRequestWarning

requests.packages.urllib3.disable_warnings(category=InsecureRequestWarning)

# ─── decode helpers ──────────────────────────────────────────────────────────
def _decode_unicode_escape(match):
    try:
        return chr(int(match.group(1), 16))
    except Exception:
        return match.group(0)


def _decode_hex_escape(match):
    try:
        return chr(int(match.group(1), 16))
    except Exception:
        return match.group(0)


def decode_netflix_value(value):
    if value is None:
        return None
    cleaned = html.unescape(str(value))
    replacements = {
        "\\x20": " ",
        "\\u00A0": " ",
        "\\u00a0": " ",
        "&nbsp;": " ",
        "u00A0": " ",
    }
    for source, target in replacements.items():
        cleaned = cleaned.replace(source, target)
    cleaned = cleaned.replace("\\/", "/").replace('\\"', '"').replace("\\n", " ").replace("\\t", " ")
    for _ in range(3):
        previous = cleaned
        cleaned = re.sub(r"\\u([0-9a-fA-F]{4})", _decode_unicode_escape, cleaned)
        cleaned = re.sub(r"\\x([0-9a-fA-F]{2})", _decode_hex_escape, cleaned)
        cleaned = re.sub(r"(?<!\\)\bu([0-9a-fA-F]{4})(?![0-9a-fA-F])", _decode_unicode_escape, cleaned)
        cleaned = cleaned.replace("\\\\", "\\")
        if cleaned == previous:
            break
    cleaned = re.sub(r"(?<=[A-Za-z])\s+(?=[^\x00-\x7F])", "", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned or None


# ─── cookie constants ────────────────────────────────────────────────────────
LOGIN_REQUIRED_NETFLIX_COOKIES = ("NetflixId",)
OPTIONAL_NETFLIX_COOKIES = ("SecureNetflixId", "nfvdid", "OptanonConsent")
ALL_NETFLIX_COOKIE_NAMES = set(LOGIN_REQUIRED_NETFLIX_COOKIES + OPTIONAL_NETFLIX_COOKIES)
CANONICAL_NETFLIX_COOKIE_NAMES = {name.lower(): name for name in ALL_NETFLIX_COOKIE_NAMES}


def canonicalize_netflix_cookie_name(name):
    normalized = str(name or "").strip()
    return CANONICAL_NETFLIX_COOKIE_NAMES.get(normalized.lower(), normalized)


def is_netflix_domain(domain):
    normalized = str(domain or "").strip()
    if normalized.startswith("#HttpOnly_"):
        normalized = normalized[len("#HttpOnly_"):]
    normalized = normalized.lower()
    return "netflix." in normalized


def is_netflix_cookie_entry(domain, name):
    normalized_name = canonicalize_netflix_cookie_name(name)
    return normalized_name in ALL_NETFLIX_COOKIE_NAMES or is_netflix_domain(domain)


def has_required_netflix_cookies(cookie_dict):
    if not isinstance(cookie_dict, dict):
        return False
    for cookie_name in LOGIN_REQUIRED_NETFLIX_COOKIES:
        if not decode_netflix_value(cookie_dict.get(cookie_name)):
            return False
    return True


# ─── netscape parsing ────────────────────────────────────────────────────────
def split_netscape_cookie_columns(line):
    stripped = line.strip()
    if not stripped:
        return []
    if stripped.startswith("#") and not stripped.startswith("#HttpOnly_"):
        return []
    if stripped.startswith("#HttpOnly_"):
        stripped = stripped[len("#HttpOnly_"):]
    if not stripped:
        return []

    parts = stripped.split("\t")
    if len(parts) >= 7:
        return parts[:6] + ["\t".join(parts[6:])]

    parts = re.split(r"\s+", stripped, maxsplit=6)
    if len(parts) >= 7:
        return parts
    return []


def is_netscape_cookie_line(line):
    parts = split_netscape_cookie_columns(line)
    if len(parts) < 7:
        return False
    if parts[1].upper() not in ("TRUE", "FALSE"):
        return False
    if parts[3].upper() not in ("TRUE", "FALSE"):
        return False
    if not re.match(r"^-?\d+(?:\.\d+)?$", parts[4].strip()):
        return False
    return True


def build_netscape_cookie_entry(domain, tail_match, path, secure, expires, name, value, position):
    normalized_expires = str(expires or 0).strip()
    if re.fullmatch(r"-?\d+\.\d+", normalized_expires):
        try:
            normalized_expires = str(int(float(normalized_expires)))
        except Exception:
            pass
    return {
        "domain": str(domain or "").replace("#HttpOnly_", "", 1),
        "tail_match": "TRUE" if str(tail_match).upper() == "TRUE" else "FALSE",
        "path": str(path or "/"),
        "secure": "TRUE" if str(secure).upper() == "TRUE" else "FALSE",
        "expires": normalized_expires or "0",
        "name": canonicalize_netflix_cookie_name(name),
        "value": str(value or ""),
        "position": position,
    }


def format_netscape_cookie_entry(entry):
    return (
        f"{entry['domain']}\t{entry['tail_match']}\t{entry['path']}\t{entry['secure']}\t"
        f"{entry['expires']}\t{entry['name']}\t{entry['value']}"
    )


def extract_netscape_cookie_entries(raw_text):
    entries = []
    for index, line in enumerate(raw_text.splitlines()):
        if not is_netscape_cookie_line(line):
            continue
        parts = split_netscape_cookie_columns(line)
        if len(parts) < 7:
            continue
        domain = parts[0]
        name = canonicalize_netflix_cookie_name(parts[5])
        if not is_netflix_cookie_entry(domain, name):
            continue
        entries.append(
            build_netscape_cookie_entry(
                domain, parts[1], parts[2], parts[3], parts[4], name, parts[6], index
            )
        )
    return entries


def extract_raw_cookie_entries(raw_text):
    pattern = re.compile(
        rf"(?:['\"])?(?P<name>{'|'.join(sorted((re.escape(name) for name in ALL_NETFLIX_COOKIE_NAMES), key=len, reverse=True))})(?:['\"])?"
        r"\s*(?:=|:)\s*(?P<value>\"[^\"]*\"|'[^']*'|[^;\s]+)",
        re.IGNORECASE,
    )
    entries = []
    for index, match in enumerate(pattern.finditer(raw_text)):
        cookie_name = canonicalize_netflix_cookie_name(match.group("name"))
        value = match.group("value")
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        else:
            value = value.rstrip(",")
        entries.append(
            build_netscape_cookie_entry(
                ".netflix.com", "TRUE", "/", "TRUE" if cookie_name == "SecureNetflixId" else "FALSE", "0", cookie_name, value, index
            )
        )
    return entries


def extract_json_cookie_entries(content):
    try:
        json_data = json.loads(content)
    except Exception:
        return []

    if isinstance(json_data, dict):
        if isinstance(json_data.get("cookies"), list):
            json_data = json_data["cookies"]
        elif isinstance(json_data.get("items"), list):
            json_data = json_data["items"]
        else:
            json_data = [json_data]
    if not isinstance(json_data, list):
        return []

    entries = []
    for index, cookie in enumerate(json_data):
        if not isinstance(cookie, dict):
            continue
        domain = cookie.get("domain", "")
        name = canonicalize_netflix_cookie_name(cookie.get("name", ""))
        if not is_netflix_cookie_entry(domain, name):
            continue
        entries.append(
            build_netscape_cookie_entry(
                domain,
                "TRUE" if str(domain).startswith(".") else "FALSE",
                cookie.get("path", "/"),
                "TRUE" if cookie.get("secure", False) else "FALSE",
                cookie.get("expirationDate", cookie.get("expiration", 0)),
                name,
                cookie.get("value", ""),
                index,
            )
        )
    return entries


def build_cookie_bundles_from_entries(entries):
    if not entries:
        return []

    entries_by_name = {}
    for entry in entries:
        cookie_name = entry.get("name")
        if not cookie_name:
            continue
        entries_by_name.setdefault(cookie_name, []).append(entry)
    if not entries_by_name:
        return []

    netflix_id_count = len(entries_by_name.get("NetflixId", []))
    bundle_count = netflix_id_count or max(len(name_entries) for name_entries in entries_by_name.values())
    bundles = []

    for bundle_index in range(bundle_count):
        selected_entries = []
        for name_entries in entries_by_name.values():
            if bundle_index < len(name_entries):
                selected_entries.append(name_entries[bundle_index])
            elif len(name_entries) == 1:
                selected_entries.append(name_entries[0])

        if not selected_entries:
            continue

        selected_entries = sorted(selected_entries, key=lambda item: item.get("position", 0))
        netscape_text = "\n".join(format_netscape_cookie_entry(entry) for entry in selected_entries)
        bundles.append(
            {
                "index": bundle_index + 1,
                "total": bundle_count,
                "netscape_text": netscape_text,
                "cookies": cookies_dict_from_netscape(netscape_text),
            }
        )
    return bundles


def extract_netflix_cookie_bundles(content):
    for extractor in (extract_json_cookie_entries, extract_netscape_cookie_entries, extract_raw_cookie_entries):
        bundles = build_cookie_bundles_from_entries(extractor(content))
        if bundles:
            return bundles
    return []


def extract_netflix_cookie_text(content):
    bundles = extract_netflix_cookie_bundles(content)
    if not bundles:
        return ""
    return bundles[0]["netscape_text"]


def cookies_dict_from_netscape(netscape_text):
    cookies = {}
    for line in netscape_text.splitlines():
        parts = split_netscape_cookie_columns(line)
        if len(parts) >= 7:
            domain = parts[0]
            name = canonicalize_netflix_cookie_name(parts[5])
            value = parts[6]
            if is_netflix_cookie_entry(domain, name):
                cookies[name] = value
    return cookies


# ─── Account info fetcher ────────────────────────────────────────────────────
NETFLIX_ACCOUNT_URL = "https://www.netflix.com/account/membership"

def fetch_account_info(cookie_dict):
    netflix_id = decode_netflix_value(cookie_dict.get("NetflixId"))
    if not netflix_id:
        return {}
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        "Accept-Encoding": "identity",
    }
    try:
        resp = requests.get(
            NETFLIX_ACCOUNT_URL,
            headers=headers,
            cookies={"NetflixId": netflix_id},
            timeout=15,
            verify=False,
        )
        if resp.status_code != 200 or not resp.text:
            return {}
        text = resp.text
    except Exception:
        return {}

    info = {}
    # email
    email_match = re.search(r'"emailAddress"\s*:\s*"([^"]+)"', text)
    if not email_match:
        email_match = re.search(r'"email"\s*:\s*"([^"]+)"', text)
    if not email_match:
        email_match = re.search(r'"loginId"\s*:\s*"([^"]+)"', text)
    if email_match:
        info["email"] = decode_netflix_value(email_match.group(1))

    # country
    country_match = re.search(r'"countryOfSignup"\s*:\s*"([^"]+)"', text)
    if not country_match:
        country_match = re.search(r'"currentCountry"\s*:\s*"([^"]+)"', text)
    if country_match:
        info["country"] = decode_netflix_value(country_match.group(1))

    # plan
    plan_match = re.search(r'"localizedPlanName"\s*:\s*"([^"]+)"', text)
    if not plan_match:
        plan_match = re.search(r'"planName"\s*:\s*"([^"]+)"', text)
    if not plan_match:
        # try currentPlan -> plan -> name
        plan_match = re.search(r'"currentPlan"\s*:\s*\{[\s\S]*?"plan"\s*:\s*\{[\s\S]*?"name"\s*:\s*"([^"]+)"', text)
    if not plan_match:
        plan_match = re.search(r'"nextPlan"\s*:\s*\{[\s\S]*?"plan"\s*:\s*\{[\s\S]*?"name"\s*:\s*"([^"]+)"', text)
    if plan_match:
        info["plan"] = decode_netflix_value(plan_match.group(1))

    return info


# ─── NFToken ─────────────────────────────────────────────────────────────────
NFTOKEN_API_URL = "https://ios.prod.ftl.netflix.com/iosui/user/15.48"
NFTOKEN_QUERY_PARAMS = {
    "appVersion": "15.48.1",
    "config": '{"gamesInTrailersEnabled":"false","isTrailersEvidenceEnabled":"false","cdsMyListSortEnabled":"true","kidsBillboardEnabled":"true","addHorizontalBoxArtToVideoSummariesEnabled":"false","skOverlayTestEnabled":"false","homeFeedTestTVMovieListsEnabled":"false","baselineOnIpadEnabled":"true","trailersVideoIdLoggingFixEnabled":"true","postPlayPreviewsEnabled":"false","bypassContextualAssetsEnabled":"false","roarEnabled":"false","useSeason1AltLabelEnabled":"false","disableCDSSearchPaginationSectionKinds":["searchVideoCarousel"],"cdsSearchHorizontalPaginationEnabled":"true","searchPreQueryGamesEnabled":"true","kidsMyListEnabled":"true","billboardEnabled":"true","useCDSGalleryEnabled":"true","contentWarningEnabled":"true","videosInPopularGamesEnabled":"true","avifFormatEnabled":"false","sharksEnabled":"true"}',
    "device_type": "NFAPPL-02-",
    "esn": "NFAPPL-02-IPHONE8%3D1-PXA-02026U9VV5O8AUKEAEO8PUJETCGDD4PQRI9DEB3MDLEMD0EACM4CS78LMD334MN3MQ3NMJ8SU9O9MVGS6BJCURM1PH1MUTGDPF4S4200",
    "idiom": "phone",
    "iosVersion": "15.8.5",
    "isTablet": "false",
    "languages": "en-US",
    "locale": "en-US",
    "maxDeviceWidth": "375",
    "model": "saget",
    "modelType": "IPHONE8-1",
    "odpAware": "true",
    "path": '["account","token","default"]',
    "pathFormat": "graph",
    "pixelDensity": "2.0",
    "progressive": "false",
    "responseFormat": "json",
}
NFTOKEN_HEADERS = {
    "User-Agent": "Argo/15.48.1 (iPhone; iOS 15.8.5; Scale/2.00)",
    "x-netflix.request.attempt": "1",
    "x-netflix.request.client.user.guid": "A4CS633D7VCBPE2GPK2HL4EKOE",
    "x-netflix.context.profile-guid": "A4CS633D7VCBPE2GPK2HL4EKOE",
    "x-netflix.request.routing": '{"path":"/nq/mobile/nqios/~15.48.0/user","control_tag":"iosui_argo"}',
    "x-netflix.context.app-version": "15.48.1",
    "x-netflix.argo.translated": "true",
    "x-netflix.context.form-factor": "phone",
    "x-netflix.context.sdk-version": "2012.4",
    "x-netflix.client.appversion": "15.48.1",
    "x-netflix.context.max-device-width": "375",
    "x-netflix.context.ab-tests": "",
    "x-netflix.tracing.cl.useractionid": "4DC655F2-9C3C-4343-8229-CA1B003C3053",
    "x-netflix.client.type": "argo",
    "x-netflix.client.ftl.esn": "NFAPPL-02-IPHONE8=1-PXA-02026U9VV5O8AUKEAEO8PUJETCGDD4PQRI9DEB3MDLEMD0EACM4CS78LMD334MN3MQ3NMJ8SU9O9MVGS6BJCURM1PH1MUTGDPF4S4200",
    "x-netflix.context.locales": "en-US",
    "x-netflix.context.top-level-uuid": "90AFE39F-ADF1-4D8A-B33E-528730990FE3",
    "x-netflix.client.iosversion": "15.8.5",
    "accept-language": "en-US;q=1",
    "x-netflix.argo.abtests": "",
    "x-netflix.context.os-version": "15.8.5",
    "x-netflix.request.client.context": '{"appState":"foreground"}',
    "x-netflix.context.ui-flavor": "argo",
    "x-netflix.argo.nfnsm": "9",
    "x-netflix.context.pixel-density": "2.0",
    "x-netflix.request.toplevel.uuid": "90AFE39F-ADF1-4D8A-B33E-528730990FE3",
    "x-netflix.request.client.timezoneid": "Asia/Dhaka",
}


def create_nftoken(cookie_dict, attempts=3):
    netflix_id = decode_netflix_value(cookie_dict.get("NetflixId"))
    if not netflix_id:
        return None, "Missing required cookies for NFToken"

    headers = dict(NFTOKEN_HEADERS)
    headers["Cookie"] = f"NetflixId={netflix_id}"

    try:
        attempts = max(1, int(attempts))
    except Exception:
        attempts = 3

    last_error = "NFToken API error"
    for _ in range(attempts):
        try:
            response = requests.get(
                NFTOKEN_API_URL,
                params=NFTOKEN_QUERY_PARAMS,
                headers=headers,
                timeout=30,
                verify=False,
            )
            if response.status_code != 200:
                if response.status_code == 403:
                    last_error = "403"
                elif response.status_code == 429:
                    last_error = "429"
                else:
                    last_error = f"NFToken API error {response.status_code}"
                continue

            data = response.json()
            token_data = (
                (((data.get("value") or {}).get("account") or {}).get("token") or {}).get("default")
                or {}
            )
            token = decode_netflix_value(token_data.get("token"))
            expires = token_data.get("expires")
            if token:
                return {
                    "token": token,
                    "expires_at_utc": get_nftoken_expiry_utc(expires),
                }, None

            last_error = "Token missing in response"
        except requests.exceptions.Timeout:
            last_error = "timeout"
        except requests.exceptions.ProxyError:
            last_error = "proxy error"
        except requests.exceptions.RequestException:
            last_error = "NFToken API error"
        except Exception:
            last_error = "NFToken API error"
    return None, last_error


def get_nftoken_expiry_utc(expires=None):
    from datetime import datetime, timedelta, timezone
    normalized = decode_netflix_value(expires)
    if isinstance(normalized, str):
        normalized = normalized.strip()
        if normalized.isdigit():
            try:
                normalized = int(normalized)
            except Exception:
                normalized = None

    if isinstance(normalized, (int, float)):
        try:
            timestamp = int(normalized)
            if len(str(abs(timestamp))) == 13:
                timestamp //= 1000
            return datetime.fromtimestamp(timestamp, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
        except Exception:
            pass

    return (datetime.utcnow() + timedelta(hours=1)).strftime("%Y-%m-%d %H:%M:%S UTC")


def build_nftoken_links(token, mode="both"):
    normalized_token = decode_netflix_value(token)
    normalized_mode = str(mode or "false").strip().lower()
    if not normalized_token or normalized_mode == "false":
        return []

    links = {}
    if normalized_mode in ("both", "pc", "desktop", "computer", "true"):
        links["pc_link"] = f"https://netflix.com/?nftoken={quote(normalized_token, safe='')}&amp;lnktrk=EMP&amp;g=4F25985CB5CBE7D5C6583C1F0A0B4300B5999CD9&amp;lkid=URL_HOME_3&amp;netflixsource=android&amp;utm_source=Android%20App"
    if normalized_mode in ("both", "mobile", "phone"):
        links["phone_link"] = f"https://netflix.com/unsupported?nftoken={quote(normalized_token, safe='')}&amp;lnktrk=EMP&amp;g=4F25985CB5CBE7D5C6583C1F0A0B4300B5999CD9&amp;lkid=URL_HOME_3&amp;netflixsource=android&amp;utm_source=Android%20App"
    return links


# ─── MAIN ────────────────────────────────────────────────────────────────────
def main():
    raw = sys.stdin.read()
    if not raw:
        print(json.dumps({"error": "No input"}))
        return

    netscape = extract_netflix_cookie_text(raw)
    if not netscape:
        print(json.dumps({"error": "No valid Netflix cookie found"}))
        return

    cookie_dict = cookies_dict_from_netscape(netscape)
    if not has_required_netflix_cookies(cookie_dict):
        print(json.dumps({"error": "Missing required cookies"}))
        return

    nftoken_data, err = create_nftoken(cookie_dict, attempts=3)
    if err:
        print(json.dumps({"error": err}))
        return

    links = build_nftoken_links(nftoken_data["token"], mode="both")
    result = {
        "pc_link": links.get("pc_link", ""),
        "phone_link": links.get("phone_link", ""),
        "token": nftoken_data["token"],
        "expires_at_utc": nftoken_data.get("expires_at_utc", ""),
    }

    # Fetch account details so Discord embed shows email/plan/country
    account_info = fetch_account_info(cookie_dict)
    result.update(account_info)

    print(json.dumps(result))


if __name__ == "__main__":
    main()

