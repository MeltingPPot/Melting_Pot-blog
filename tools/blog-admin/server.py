#!/usr/bin/env python3
"""Jekyll 模板本地博客管理面板的后端。

这个文件做的事情可以概括为：

1. 启动一个只允许本机访问的 HTTP 服务器；
2. 把 ``ui`` 文件夹中的管理页面交给浏览器；
3. 通过几个 ``/api/...`` 接口读写博客文章和 ``_config.yml``；
4. 在用户点击发布时调用 Git，完成 commit 和 push。

浏览器负责“显示页面和收集输入”，Python 负责“访问本地文件和执行 Git”。
这就是为什么管理面板需要保持这个 Python 程序运行。
"""

from __future__ import annotations

import argparse
import base64
import binascii
import email.utils
import json
import mimetypes
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
import webbrowser
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


# Path 对象比手写字符串路径更可靠，尤其是在 Windows 下处理反斜杠时。
APP_DIR = Path(__file__).resolve().parent
REPO_ROOT = APP_DIR.parents[1]
UI_DIR = APP_DIR / "ui"

# 博客中允许管理面板操作的目录和文件。
# 这些路径也构成了后端的安全边界：接口不会允许访问其他位置。
POSTS_DIR = REPO_ROOT / "_posts"
DRAFTS_DIR = REPO_ROOT / "_drafts"
TRASH_DIR = REPO_ROOT / ".blog-admin-trash"
CONFIG_FILE = REPO_ROOT / "_config.yml"

# 每次启动都会随机生成一个令牌。修改类请求必须带上它，避免其他网页
# 在浏览器中冒充管理面板修改本地文件。
SESSION_TOKEN = secrets.token_urlsafe(32)
CHINA_TZ = timezone(timedelta(hours=8))
# 限制单次 JSON 请求大小，避免误操作或异常请求占用过多内存。
MAX_BODY_BYTES = 2 * 1024 * 1024
# 博客园备份通常比单篇文章大，因此单独给 XML 导入更大的上限。
MAX_IMPORT_BYTES = 20 * 1024 * 1024

# 管理面板允许修改的 _config.yml 字段。
# value 是 "text" 表示普通文字，"list" 表示 YAML 列表。
MANAGED_CONFIG = {
    "title": "text",
    "SEOTitle": "text",
    "description": "text",
    "keyword": "text",
    "home-tagline": "text",
    "home-status": "text",
    "home-principles": "list",
    "footer-signature": "text",
    "github_username": "text",
    "sidebar-about-description": "text",
}

# 保存文章时，Front Matter 字段使用这个顺序，便于人工阅读。
POST_FIELD_ORDER = [
    "layout",
    "title",
    "subtitle",
    "date",
    "author",
    "header-img",
    "header-mask",
    "tags",
    "mathjax",
    "encrypted",
]

# 加密文章只允许使用这一版密文信封，防止任意 HTML 借接口写入文章。
ENCRYPTED_POST_VERSION = 1
ENCRYPTED_BODY_PATTERN = re.compile(
    r'<script id="encrypted-post-data" type="application/json">\s*(\{.*?\})\s*</script>',
    re.S,
)


class ApiError(Exception):
    """可以安全返回给前端的业务错误。

    status 是 HTTP 状态码，例如 400 表示请求内容有问题，404 表示找不到
    文章，403 表示安全校验失败。普通程序错误不会把内部细节直接暴露给浏览器。
    """

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def run_git(*args: str, timeout: int = 45, check: bool = True) -> subprocess.CompletedProcess[str]:
    """在博客根目录执行 Git 命令，并把 Git 错误转换成面板错误。"""

    # 不拼接整条 shell 字符串，而是把每个参数单独传给 subprocess，
    # 这样文章标题或提交说明中的特殊字符不会被当成终端命令执行。
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError as exc:
        raise ApiError(500, "未找到 Git，请先安装 Git 并加入 PATH。") from exc
    except subprocess.TimeoutExpired as exc:
        raise ApiError(504, "Git 操作超时，请检查网络后重试。") from exc

    if check and result.returncode != 0:
        detail = (result.stderr or result.stdout or "Git 操作失败").strip()
        raise ApiError(500, detail)
    return result


def atomic_write(path: Path, text: str) -> None:
    """先写临时文件，再替换目标文件，降低写文件中途被打断的风险。"""

    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(text, encoding="utf-8", newline="\n")
    os.replace(temporary, path)


def strip_inline_comment(value: str) -> str:
    """去掉 YAML 值后面的注释，但保留引号中的 #。"""

    quote: str | None = None
    escaped = False
    for index, char in enumerate(value):
        if escaped:
            escaped = False
            continue
        if char == "\\" and quote == '"':
            escaped = True
            continue
        if char in ("'", '"'):
            if quote == char:
                quote = None
            elif quote is None:
                quote = char
        elif char == "#" and quote is None and (index == 0 or value[index - 1].isspace()):
            return value[:index].rstrip()
    return value.strip()


def parse_scalar(value: str) -> Any:
    """把简单 YAML 值转换成 Python 类型。

    管理面板只需要处理配置文件中常见的文字、数字、布尔值和列表，
    因此这里没有实现完整 YAML 解析器。
    """

    value = strip_inline_comment(value.strip())
    if not value:
        return ""
    if value.startswith('"') and value.endswith('"'):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value[1:-1]
    if value.startswith("'") and value.endswith("'"):
        return value[1:-1].replace("''", "'")
    if value.lower() in {"true", "false"}:
        return value.lower() == "true"
    if value.startswith("[") and value.endswith("]"):
        inner = value[1:-1].strip()
        if not inner:
            return []
        return [str(parse_scalar(part.strip())) for part in inner.split(",") if part.strip()]
    try:
        return int(value)
    except ValueError:
        try:
            return float(value)
        except ValueError:
            return value


def yaml_string(value: Any) -> str:
    """把文字安全地写成 YAML 可接受的双引号字符串。"""

    return json.dumps(str(value or ""), ensure_ascii=False)


def yaml_value(key: str, value: Any) -> str:
    """根据字段类型把一个 Front Matter 值转换成文本。"""

    if key == "tags":
        tags = value if isinstance(value, list) else []
        return "[" + ", ".join(yaml_string(tag) for tag in tags) + "]"
    if key in {"mathjax", "encrypted"}:
        return "true" if bool(value) else "false"
    if key == "header-mask":
        try:
            return f"{min(max(float(value), 0), 1):g}"
        except (TypeError, ValueError):
            return "0.45"
    if key in {"layout", "date"}:
        return str(value)
    return yaml_string(value)


def split_front_matter(text: str) -> tuple[str, str]:
    """把 Markdown 拆成 Front Matter 和正文两部分。"""

    normalized = text.lstrip("\ufeff")
    if not normalized.startswith("---"):
        return "", normalized
    match = re.match(r"^---\s*\r?\n(.*?)\r?\n---\s*\r?\n?", normalized, re.S)
    if not match:
        return "", normalized
    return match.group(1), normalized[match.end():]


def validate_encrypted_payload(value: Any) -> dict[str, Any]:
    """验证浏览器生成的 AES-GCM 密文信封，并返回规范化数据。

    密码和明文永远不会传到这个后端；后端只接收盐、IV、迭代次数和密文。
    """

    if not isinstance(value, dict):
        raise ApiError(400, "加密文章缺少有效的密文数据。")
    try:
        version = int(value.get("version"))
        iterations = int(value.get("iterations"))
    except (TypeError, ValueError) as exc:
        raise ApiError(400, "加密文章参数格式不正确。") from exc
    if version != ENCRYPTED_POST_VERSION:
        raise ApiError(400, "不支持的加密文章版本。")
    if value.get("algorithm") != "AES-GCM" or value.get("kdf") != "PBKDF2" or value.get("hash") != "SHA-256":
        raise ApiError(400, "加密文章使用了不支持的算法。")
    if not 100_000 <= iterations <= 2_000_000:
        raise ApiError(400, "加密迭代次数超出允许范围。")

    decoded: dict[str, bytes] = {}
    for key in ("salt", "iv", "ciphertext"):
        encoded = value.get(key)
        if not isinstance(encoded, str) or not encoded:
            raise ApiError(400, f"加密文章缺少 {key}。")
        try:
            decoded[key] = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error) as exc:
            raise ApiError(400, f"加密文章的 {key} 不是有效 Base64。") from exc
    if len(decoded["salt"]) != 16 or len(decoded["iv"]) != 12:
        raise ApiError(400, "加密文章的盐或 IV 长度不正确。")
    if len(decoded["ciphertext"]) < 17 or len(decoded["ciphertext"]) > MAX_BODY_BYTES:
        raise ApiError(400, "加密文章的密文长度不正确。")

    return {
        "version": ENCRYPTED_POST_VERSION,
        "algorithm": "AES-GCM",
        "kdf": "PBKDF2",
        "hash": "SHA-256",
        "iterations": iterations,
        "salt": value["salt"],
        "iv": value["iv"],
        "ciphertext": value["ciphertext"],
    }


def encrypted_body(payload: dict[str, Any]) -> str:
    """把经过验证的密文信封写成不会被 Markdown 渲染的 JSON 数据块。"""

    compact = json.dumps(payload, ensure_ascii=True, separators=(",", ":"))
    return (
        '<script id="encrypted-post-data" type="application/json">\n'
        f"{compact}\n"
        "</script>\n"
    )


def parse_encrypted_body(content: str) -> dict[str, Any]:
    """从文章正文中读取密文信封，供本地管理面板解锁编辑。"""

    match = ENCRYPTED_BODY_PATTERN.search(content)
    if not match:
        raise ApiError(500, "加密文章的密文数据已损坏。")
    try:
        payload = json.loads(match.group(1))
    except json.JSONDecodeError as exc:
        raise ApiError(500, "加密文章的密文 JSON 无法读取。") from exc
    return validate_encrypted_payload(payload)


def parse_front_matter(raw: str) -> dict[str, Any]:
    """读取简单的 ``key: value`` 和缩进列表形式的 Front Matter。"""

    data: dict[str, Any] = {}
    lines = raw.splitlines()
    index = 0
    while index < len(lines):
        match = re.match(r"^([A-Za-z0-9_-]+):\s*(.*)$", lines[index])
        if not match:
            index += 1
            continue
        key, value = match.groups()
        if not value and index + 1 < len(lines) and re.match(r"^\s+-\s+", lines[index + 1]):
            items: list[str] = []
            index += 1
            while index < len(lines):
                item = re.match(r"^\s+-\s+(.*)$", lines[index])
                if not item:
                    break
                items.append(str(parse_scalar(item.group(1))))
                index += 1
            data[key] = items
            continue
        data[key] = parse_scalar(value)
        index += 1
    return data


def update_front_matter(existing: str, values: dict[str, Any]) -> str:
    """更新面板管理的字段，并尽量保留其他未知字段。"""

    # 这里不直接重建全部 Front Matter，因为文章可能添加了
    # 管理面板暂时不认识的字段。保留未知字段可以避免保存文章时丢配置。
    if not existing.strip():
        return "\n".join(f"{key}: {yaml_value(key, values[key])}" for key in POST_FIELD_ORDER if key in values)

    output: list[str] = []
    seen: set[str] = set()
    lines = existing.splitlines()
    index = 0
    while index < len(lines):
        match = re.match(r"^([A-Za-z0-9_-]+):\s*(.*)$", lines[index])
        if match and match.group(1) in values:
            key = match.group(1)
            output.append(f"{key}: {yaml_value(key, values[key])}")
            seen.add(key)
            index += 1
            while index < len(lines) and re.match(r"^\s+-\s+", lines[index]):
                index += 1
            continue
        output.append(lines[index])
        index += 1

    for key in POST_FIELD_ORDER:
        if key in values and key not in seen:
            output.append(f"{key}: {yaml_value(key, values[key])}")
    return "\n".join(output)


def normalize_slug(value: str) -> str:
    """把标题或 slug 转成适合文件名的形式。"""

    value = re.sub(r"[\s_]+", "-", value.strip().lower())
    value = "".join(char for char in value if char.isalnum() or char == "-")
    value = re.sub(r"-+", "-", value).strip("-")
    if not value:
        raise ApiError(400, "文章 slug 不能为空。")
    if len(value) > 100:
        raise ApiError(400, "文章 slug 不能超过 100 个字符。")
    return value


def safe_managed_path(relative: str) -> Path:
    """验证文章路径，只允许访问 _posts 或 _drafts 下的 Markdown 文件。"""

    # resolve() 会把 .. 等路径折叠成真实路径；之后再检查父目录，
    # 防止请求借助路径穿越访问博客目录之外的文件。
    relative = urllib.parse.unquote(relative or "").replace("\\", "/")
    if not relative or relative.startswith("/") or ".." in Path(relative).parts:
        raise ApiError(400, "无效的文章路径。")
    candidate = (REPO_ROOT / relative).resolve()
    allowed = (POSTS_DIR.resolve(), DRAFTS_DIR.resolve())
    if not any(candidate.parent == directory for directory in allowed) or candidate.suffix.lower() not in {".md", ".markdown"}:
        raise ApiError(400, "文章路径不在允许的目录中。")
    return candidate


def date_for_input(value: Any, fallback: datetime | None = None) -> str:
    """把不同格式的日期统一成编辑器使用的 YYYY-MM-DDTHH:MM。"""

    text = str(value or "")
    match = re.match(r"^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})", text)
    if match:
        return f"{match.group(1)}T{match.group(2)}"
    return (fallback or datetime.now(CHINA_TZ)).strftime("%Y-%m-%dT%H:%M")


def post_summary(path: Path, status: str) -> dict[str, Any]:
    """读取一篇文章的摘要，供文章列表显示。"""

    text = path.read_text(encoding="utf-8-sig")
    raw, content = split_front_matter(text)
    meta = parse_front_matter(raw)
    encrypted = bool(meta.get("encrypted", False))
    if encrypted:
        excerpt = "这是一篇密码保护文章，正文仅在浏览器解锁后显示。"
    else:
        excerpt = re.sub(r"[`*_>#\[\]$|]", "", content)
        excerpt = re.sub(r"\s+", " ", excerpt).strip()[:150]
    relative = path.relative_to(REPO_ROOT).as_posix()
    return {
        "file": relative,
        "status": status,
        "title": str(meta.get("title") or path.stem),
        "subtitle": str(meta.get("subtitle") or ""),
        "date": str(meta.get("date") or ""),
        "tags": meta.get("tags") if isinstance(meta.get("tags"), list) else [],
        "mathjax": bool(meta.get("mathjax", False)),
        "encrypted": encrypted,
        "excerpt": excerpt,
        "modified": datetime.fromtimestamp(path.stat().st_mtime, CHINA_TZ).isoformat(),
    }


def list_posts() -> list[dict[str, Any]]:
    """扫描正式文章和草稿，并按日期倒序返回。"""

    posts: list[dict[str, Any]] = []
    for directory, status in ((POSTS_DIR, "published"), (DRAFTS_DIR, "draft")):
        directory.mkdir(parents=True, exist_ok=True)
        for path in directory.glob("*.md"):
            posts.append(post_summary(path, status))
        for path in directory.glob("*.markdown"):
            posts.append(post_summary(path, status))
    return sorted(posts, key=lambda item: (item["date"], item["modified"]), reverse=True)


def load_post(relative: str) -> dict[str, Any]:
    """读取一篇完整文章，供编辑器填充表单。"""

    path = safe_managed_path(relative)
    if not path.exists():
        raise ApiError(404, "文章不存在。")
    text = path.read_text(encoding="utf-8-sig")
    raw, content = split_front_matter(text)
    meta = parse_front_matter(raw)
    filename = path.stem
    slug = re.sub(r"^\d{4}-\d{2}-\d{2}-", "", filename)
    try:
        header_mask = float(meta.get("header-mask") or 0.45)
    except (TypeError, ValueError):
        header_mask = 0.45
    encrypted = bool(meta.get("encrypted", False))
    encrypted_payload = parse_encrypted_body(content) if encrypted else None
    return {
        "file": path.relative_to(REPO_ROOT).as_posix(),
        "status": "draft" if path.parent == DRAFTS_DIR.resolve() else "published",
        "title": str(meta.get("title") or ""),
        "subtitle": str(meta.get("subtitle") or ""),
        "date": date_for_input(meta.get("date"), datetime.fromtimestamp(path.stat().st_mtime, CHINA_TZ)),
        "author": str(meta.get("author") or "Example Author"),
        "headerImage": str(meta.get("header-img") or "img/bg-little-universe.jpg"),
        "headerMask": header_mask,
        "tags": meta.get("tags") if isinstance(meta.get("tags"), list) else [],
        "mathjax": bool(meta.get("mathjax", False)),
        "encrypted": encrypted,
        "encryptedPayload": encrypted_payload,
        "slug": slug,
        "content": "" if encrypted else content.rstrip() + "\n",
        "frontMatter": raw,
    }


def save_post(payload: dict[str, Any]) -> dict[str, Any]:
    """保存或移动一篇文章。

    status 为 ``draft`` 时写入 ``_drafts``；为 ``published`` 时写入 ``_posts``。
    因此“发布草稿”本质上是把文件移动到正式文章目录，并补上日期文件名。
    """

    title = str(payload.get("title") or "").strip()
    if not title:
        raise ApiError(400, "文章标题不能为空。")
    encrypted = bool(payload.get("encrypted", False))
    if encrypted:
        content = encrypted_body(validate_encrypted_payload(payload.get("encryptedPayload")))
    else:
        content = str(payload.get("content") or "")
    slug = normalize_slug(str(payload.get("slug") or title))
    date_input = date_for_input(payload.get("date"))
    status = str(payload.get("status") or "draft")
    if status not in {"draft", "published"}:
        raise ApiError(400, "无效的文章状态。")

    date_part = date_input[:10]
    target_dir = POSTS_DIR if status == "published" else DRAFTS_DIR
    filename = f"{date_part}-{slug}.md" if status == "published" else f"{slug}.md"
    target = (target_dir / filename).resolve()
    if target.parent != target_dir.resolve():
        raise ApiError(400, "无效的目标文件名。")

    original_relative = str(payload.get("originalFile") or "")
    original = safe_managed_path(original_relative) if original_relative else None
    if target.exists() and (original is None or target != original):
        raise ApiError(409, f"目标文件已经存在：{target.name}")

    tags = payload.get("tags")
    if not isinstance(tags, list):
        tags = [item.strip() for item in str(tags or "").split(",") if item.strip()]
    tags = list(dict.fromkeys(str(tag).strip() for tag in tags if str(tag).strip()))
    values = {
        "layout": "post",
        "title": title,
        "subtitle": str(payload.get("subtitle") or "").strip(),
        "date": date_input.replace("T", " ") + ":00 +0800",
        "author": str(payload.get("author") or "Example Author").strip(),
        "header-img": str(payload.get("headerImage") or "img/bg-little-universe.jpg").strip(),
        "header-mask": payload.get("headerMask", 0.45),
        "tags": tags,
        "mathjax": bool(payload.get("mathjax", False)),
        "encrypted": encrypted,
    }
    front = update_front_matter(str(payload.get("frontMatter") or ""), values)
    document = f"---\n{front}\n---\n\n{content.lstrip(chr(13) + chr(10))}"
    if not document.endswith("\n"):
        document += "\n"

    atomic_write(target, document)
    if original and original != target and original.exists():
        original.unlink()
    return load_post(target.relative_to(REPO_ROOT).as_posix())


def bulk_publish_drafts(payload: dict[str, Any]) -> dict[str, Any]:
    """把多篇草稿移动到 _posts；这里只改本地文件，不执行 Git push。"""

    files = payload.get("files")
    if not isinstance(files, list) or not files:
        raise ApiError(400, "请至少选择一篇草稿。")
    if len(files) > 500:
        raise ApiError(400, "一次最多批量发布 500 篇草稿。")

    # 先检查所有目标，确认没有冲突后再开始移动，避免只完成一半。
    plans: list[tuple[Path, Path]] = []
    seen_sources: set[Path] = set()
    seen_targets: set[Path] = set()
    for relative in files:
        source = safe_managed_path(str(relative))
        if source in seen_sources:
            continue
        seen_sources.add(source)
        if source.parent != DRAFTS_DIR.resolve():
            raise ApiError(400, f"只能批量发布草稿：{source.name}")
        if not source.exists():
            raise ApiError(404, f"草稿不存在：{source.name}")

        raw, _ = split_front_matter(source.read_text(encoding="utf-8-sig"))
        meta = parse_front_matter(raw)
        date_match = re.match(r"^(\d{4}-\d{2}-\d{2})", str(meta.get("date") or ""))
        date_part = date_match.group(1) if date_match else datetime.fromtimestamp(source.stat().st_mtime, CHINA_TZ).strftime("%Y-%m-%d")
        slug = re.sub(r"^\d{4}-\d{2}-\d{2}-", "", source.stem)
        target = (POSTS_DIR / f"{date_part}-{slug}.md").resolve()
        if target in seen_targets or target.exists():
            raise ApiError(409, f"正式文章已经存在：{target.name}")
        seen_targets.add(target)
        plans.append((source, target))

    POSTS_DIR.mkdir(parents=True, exist_ok=True)
    published = []
    for source, target in plans:
        shutil.move(str(source), str(target))
        published.append({
            "file": target.relative_to(REPO_ROOT).as_posix(),
            "title": post_summary(target, "published")["title"],
        })
    return {
        "message": f"已将 {len(published)} 篇草稿转为已发布，尚未推送到 GitHub。",
        "posts": published,
    }


def trash_post(relative: str) -> dict[str, str]:
    """把文章移入带时间戳的本地回收目录，而不是直接删除。"""

    source = safe_managed_path(relative)
    if not source.exists():
        raise ApiError(404, "文章不存在。")
    stamp = datetime.now(CHINA_TZ).strftime("%Y%m%d-%H%M%S-%f")
    destination = TRASH_DIR / stamp / source.parent.name / source.name
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(source), str(destination))
    return {"message": "文章已移入本地回收目录。", "trash": str(destination.relative_to(REPO_ROOT))}


def _xml_text(element: ET.Element, name: str) -> str:
    """读取 XML 子元素文字；找不到时返回空字符串。"""

    child = element.find(name)
    return (child.text or "").strip() if child is not None else ""


def _cnblogs_date(value: str) -> str:
    """把博客园 RSS 日期转换成 Jekyll 使用的日期格式。"""

    try:
        parsed = email.utils.parsedate_to_datetime(value)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(CHINA_TZ).strftime("%Y-%m-%d %H:%M:%S %z")
    except (TypeError, ValueError, OverflowError):
        # 个别旧文章可能没有规范日期；此时使用当前时间，并在预览中保留文章。
        return datetime.now(CHINA_TZ).strftime("%Y-%m-%d %H:%M:%S %z")


def parse_cnblogs_xml(xml_text: str) -> list[dict[str, Any]]:
    """解析博客园备份 XML，返回可预览和导入的文章数据。

    博客园备份中的 ``description`` 已经是 Markdown，因此这里不再做 HTML
    转 Markdown 转换，能够更好地保留数学公式、代码块和表格。
    """

    if not xml_text.strip():
        raise ApiError(400, "XML 文件内容为空。")
    if "<!DOCTYPE" in xml_text.upper() or "<!ENTITY" in xml_text.upper():
        raise ApiError(400, "XML 包含不支持的外部实体声明。")
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as exc:
        raise ApiError(400, "无法解析 XML，请确认选择的是博客园备份文件。") from exc

    articles: list[dict[str, Any]] = []
    for index, item in enumerate(root.findall("./channel/item")):
        content = _xml_text(item, "description").lstrip("\ufeff")
        title = _xml_text(item, "title") or f"博客园文章 {index + 1}"
        source = _xml_text(item, "link") or _xml_text(item, "guid")
        author = _xml_text(item, "author") or "Example Author"
        tags = [str(category.text or "").strip() for category in item.findall("category")]
        tags = list(dict.fromkeys(tag for tag in tags if tag))
        articles.append({
            "id": index,
            "title": title,
            "author": author,
            "date": _cnblogs_date(_xml_text(item, "pubDate")),
            "source": source,
            "tags": tags,
            # 同时识别 $$...$$、$...$、\\(...\\)、\\[...\\] 和 LaTeX 环境。
            "mathjax": bool(re.search(r"\$\$|(?<!\\)\$[^$\n]+\$|\\(?:\(|\[)|\\begin\{", content)),
            "content": content,
        })
    if not articles:
        raise ApiError(400, "XML 中没有找到任何文章。")
    return articles


def cnblogs_preview(articles: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """生成适合管理面板展示的导入预览，不把正文重复传回页面。"""

    result = []
    for article in articles:
        excerpt = re.sub(r"[`*_>#\[\]$|]", "", article["content"])
        result.append({
            key: article[key]
            for key in ("id", "title", "author", "date", "source", "tags", "mathjax")
        } | {"contentLength": len(article["content"]), "excerpt": re.sub(r"\s+", " ", excerpt).strip()[:150]})
    return result


def import_cnblogs(payload: dict[str, Any]) -> dict[str, Any]:
    """将选中的博客园文章全部导入为草稿，不直接发布到线上。"""

    articles = parse_cnblogs_xml(str(payload.get("xml") or ""))
    selected = payload.get("ids")
    if selected is None:
        selected_ids = {article["id"] for article in articles}
    elif isinstance(selected, list):
        selected_ids = {int(item) for item in selected if str(item).isdigit()}
    else:
        raise ApiError(400, "导入文章选择无效。")

    selected_articles = [article for article in articles if article["id"] in selected_ids]
    if not selected_articles:
        raise ApiError(400, "请至少选择一篇文章。")

    imported: list[dict[str, Any]] = []
    used_names: set[str] = set()
    for article in selected_articles:
        base_slug = normalize_slug(article["title"])
        slug = base_slug
        suffix = 2
        while slug in used_names or (DRAFTS_DIR / f"{slug}.md").exists():
            suffix_text = f"-{suffix}"
            slug = f"{base_slug[:100 - len(suffix_text)]}{suffix_text}"
            suffix += 1
        used_names.add(slug)
        values = [
            "layout: post",
            f"title: {yaml_string(article['title'])}",
            f"date: {article['date']}",
            f"author: {yaml_string(article['author'])}",
            f"tags: {yaml_value('tags', article['tags'])}",
            f"mathjax: {'true' if article['mathjax'] else 'false'}",
            f"source: {yaml_string(article['source'])}",
        ]
        content = article["content"].rstrip() + "\n"
        document = "---\n" + "\n".join(values) + f"\n---\n\n{content}"
        target = DRAFTS_DIR / f"{slug}.md"
        atomic_write(target, document)
        imported.append({
            "file": target.relative_to(REPO_ROOT).as_posix(),
            "title": article["title"],
            "source": article["source"],
        })
    return {"message": f"已导入 {len(imported)} 篇文章到草稿。", "posts": imported}


def read_config() -> dict[str, Any]:
    """读取管理面板允许展示的站点配置。"""

    lines = CONFIG_FILE.read_text(encoding="utf-8-sig").splitlines()
    result: dict[str, Any] = {}
    index = 0
    while index < len(lines):
        match = re.match(r"^([A-Za-z0-9_-]+):\s*(.*)$", lines[index])
        if not match or match.group(1) not in MANAGED_CONFIG:
            index += 1
            continue
        key, value = match.groups()
        if MANAGED_CONFIG[key] == "list":
            items: list[str] = []
            index += 1
            while index < len(lines):
                item = re.match(r"^\s+-\s+(.*)$", lines[index])
                if not item:
                    break
                items.append(str(parse_scalar(item.group(1))))
                index += 1
            result[key] = items
            continue
        result[key] = str(parse_scalar(value))
        index += 1
    return result


def save_config(payload: dict[str, Any]) -> dict[str, Any]:
    """更新允许管理的配置字段，并保留其他配置内容。"""

    lines = CONFIG_FILE.read_text(encoding="utf-8-sig").splitlines()
    output: list[str] = []
    seen: set[str] = set()
    index = 0
    while index < len(lines):
        match = re.match(r"^([A-Za-z0-9_-]+):\s*(.*)$", lines[index])
        if match and match.group(1) in MANAGED_CONFIG and match.group(1) in payload:
            key = match.group(1)
            seen.add(key)
            if MANAGED_CONFIG[key] == "list":
                output.append(f"{key}:")
                values = payload[key] if isinstance(payload[key], list) else []
                output.extend(f"  - {yaml_string(item)}" for item in values if str(item).strip())
                index += 1
                while index < len(lines) and re.match(r"^\s+-\s+", lines[index]):
                    index += 1
                continue
            output.append(f"{key}: {yaml_string(payload[key])}")
            index += 1
            continue
        output.append(lines[index])
        index += 1

    for key, kind in MANAGED_CONFIG.items():
        if key not in seen and key in payload:
            if kind == "list":
                output.append(f"{key}:")
                output.extend(f"  - {yaml_string(item)}" for item in payload[key] if str(item).strip())
            else:
                output.append(f"{key}: {yaml_string(payload[key])}")
    atomic_write(CONFIG_FILE, "\n".join(output) + "\n")
    return read_config()


def git_status() -> dict[str, Any]:
    """收集当前分支、工作区修改、最近提交和远程地址。"""

    branch = run_git("branch", "--show-current").stdout.strip() or "main"
    porcelain = run_git("status", "--short").stdout.splitlines()
    latest = run_git("log", "-1", "--pretty=format:%h%x09%s%x09%cr").stdout.strip().split("\t")
    remote = run_git("remote", "get-url", "origin", check=False).stdout.strip()
    return {
        "branch": branch,
        "changes": porcelain,
        "clean": not porcelain,
        "latest": {"hash": latest[0], "subject": latest[1], "when": latest[2]} if len(latest) >= 3 else None,
        "remote": remote,
    }


def publish_changes(message: str) -> dict[str, Any]:
    """只提交博客相关文件，然后推送到当前分支。"""

    # 管理面板只负责 _posts、_drafts 和 _config.yml。
    # 如果用户提前在终端暂存了其他文件，就停止发布，避免按钮误提交它们。
    message = message.strip()
    if not message:
        raise ApiError(400, "请填写提交说明。")
    if len(message) > 120 or "\n" in message:
        raise ApiError(400, "提交说明应为不超过 120 个字符的单行文字。")

    staged = run_git("diff", "--cached", "--name-only").stdout.splitlines()
    unrelated = [
        path for path in staged
        if path != "_config.yml" and not path.startswith(("_posts/", "_drafts/"))
    ]
    if unrelated:
        raise ApiError(409, "检测到面板范围外的暂存文件，请先在终端处理：" + "、".join(unrelated))

    run_git("add", "-A", "--", "_posts", "_drafts", "_config.yml")
    changed = run_git("diff", "--cached", "--quiet", "--", "_posts", "_drafts", "_config.yml", check=False)
    branch = run_git("branch", "--show-current").stdout.strip() or "main"
    if not re.fullmatch(r"[A-Za-z0-9._/-]+", branch):
        raise ApiError(400, "当前 Git 分支名称不安全，已停止推送。")
    if changed.returncode == 0:
        push_result = run_git("push", "origin", branch, timeout=120)
        output = (push_result.stdout + push_result.stderr).lower()
        synchronized = "everything up-to-date" not in output
        return {
            "message": "已推送之前未同步的提交。" if synchronized else "没有新修改，远程仓库已经同步。",
            "published": synchronized,
            "status": git_status(),
        }

    run_git("commit", "-m", message, timeout=60)
    run_git("push", "origin", branch, timeout=120)
    return {"message": "提交并推送成功，GitHub Pages 将自动更新。", "published": True, "status": git_status()}


class BlogAdminHandler(BaseHTTPRequestHandler):
    """处理浏览器发来的静态文件请求和 API 请求。"""

    server_version = "JekyllTemplateAdmin/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        """把 HTTP 访问记录打印到启动面板的命令行窗口。"""

        print(f"[{self.log_date_time_string()}] {fmt % args}")

    def send_json(self, payload: Any, status: int = 200) -> None:
        """向前端返回 JSON 数据。"""

        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path: Path) -> None:
        """向浏览器返回管理面板的 HTML、CSS 或 JavaScript 文件。"""

        if not path.exists() or not path.is_file():
            raise ApiError(404, "资源不存在。")
        body = path.read_bytes()
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type in {"application/javascript", "application/json"}:
            content_type += "; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", "frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(body)

    def require_token(self) -> None:
        """校验会修改本地文件的请求是否来自当前管理面板。"""

        if not secrets.compare_digest(self.headers.get("X-Blog-Admin-Token", ""), SESSION_TOKEN):
            raise ApiError(403, "会话校验失败，请刷新管理面板。")
        origin = self.headers.get("Origin")
        if origin:
            expected = f"http://{self.headers.get('Host')}"
            if origin != expected:
                raise ApiError(403, "请求来源不受信任。")

    def require_local_host(self) -> None:
        """只接受 localhost 或 127.0.0.1 的请求。"""

        host = self.headers.get("Host", "").split(":", 1)[0].strip().lower()
        if host not in {"127.0.0.1", "localhost"}:
            raise ApiError(403, "管理面板只接受本机地址访问。")

    def read_json(self, max_bytes: int = MAX_BODY_BYTES) -> dict[str, Any]:
        """读取并验证 POST 请求中的 JSON 数据。"""

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ApiError(400, "无效的请求长度。") from exc
        if length <= 0 or length > max_bytes:
            raise ApiError(413, "请求内容为空或过大。")
        try:
            value = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ApiError(400, "无法解析请求内容。") from exc
        if not isinstance(value, dict):
            raise ApiError(400, "请求内容必须是对象。")
        return value

    def handle_api_get(self, path: str, query: dict[str, list[str]]) -> None:
        """处理只读 API：文章列表、单篇文章、配置和 Git 状态。"""

        if path == "/api/session":
            self.send_json({"token": SESSION_TOKEN, "root": str(REPO_ROOT), "port": self.server.server_port})
        elif path == "/api/posts":
            self.send_json({"posts": list_posts()})
        elif path == "/api/post":
            self.send_json(load_post(query.get("file", [""])[0]))
        elif path == "/api/config":
            self.send_json(read_config())
        elif path == "/api/git/status":
            self.send_json(git_status())
        else:
            raise ApiError(404, "接口不存在。")

    def handle_api_post(self, path: str) -> None:
        """处理会改变本地内容的 API：保存、回收、配置保存和发布。"""

        self.require_token()
        # XML 导入可能包含几十篇文章，所以使用专门的较大请求上限。
        payload = self.read_json(MAX_IMPORT_BYTES if path.startswith("/api/import/") else MAX_BODY_BYTES)
        if path == "/api/posts/save":
            self.send_json({"post": save_post(payload), "message": "文章已保存到本地。"})
        elif path == "/api/posts/bulk-publish":
            self.send_json(bulk_publish_drafts(payload))
        elif path == "/api/posts/trash":
            self.send_json(trash_post(str(payload.get("file") or "")))
        elif path == "/api/config/save":
            self.send_json({"config": save_config(payload), "message": "站点配置已保存。"})
        elif path == "/api/publish":
            self.send_json(publish_changes(str(payload.get("message") or "")))
        elif path == "/api/import/cnblogs/preview":
            articles = parse_cnblogs_xml(str(payload.get("xml") or ""))
            self.send_json({"articles": cnblogs_preview(articles)})
        elif path == "/api/import/cnblogs":
            self.send_json(import_cnblogs(payload))
        else:
            raise ApiError(404, "接口不存在。")

    def do_GET(self) -> None:
        """HTTP GET 的入口：先做本机校验，再分发静态文件或只读 API。"""

        try:
            self.require_local_host()
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path.startswith("/api/"):
                self.handle_api_get(parsed.path, urllib.parse.parse_qs(parsed.query))
                return
            if parsed.path in {"/", "/index.html"}:
                self.send_file(UI_DIR / "index.html")
                return
            if parsed.path.startswith("/assets/"):
                name = parsed.path.removeprefix("/assets/")
                if not re.fullmatch(r"[A-Za-z0-9._-]+", name):
                    raise ApiError(400, "无效的资源路径。")
                self.send_file(UI_DIR / name)
                return
            raise ApiError(404, "页面不存在。")
        except ApiError as exc:
            self.send_json({"error": exc.message}, exc.status)
        except Exception as exc:  # pragma: no cover - final safety net
            print(f"Unexpected error: {exc}", file=sys.stderr)
            self.send_json({"error": "服务器发生内部错误。"}, 500)

    def do_POST(self) -> None:
        """HTTP POST 的入口：POST 请求用于修改数据，所以还会校验令牌。"""

        try:
            self.require_local_host()
            self.handle_api_post(urllib.parse.urlparse(self.path).path)
        except ApiError as exc:
            self.send_json({"error": exc.message}, exc.status)
        except Exception as exc:  # pragma: no cover - final safety net
            print(f"Unexpected error: {exc}", file=sys.stderr)
            self.send_json({"error": "服务器发生内部错误。"}, 500)


def main() -> None:
    """解析启动参数、创建本地服务器并持续等待浏览器请求。"""

    parser = argparse.ArgumentParser(description="Jekyll 模板本地博客管理面板")
    parser.add_argument("--port", type=int, default=4173, help="本地监听端口，默认 4173")
    parser.add_argument("--no-browser", action="store_true", help="启动时不自动打开浏览器")
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("端口必须位于 1024 到 65535 之间")

    # 第一次启动时目录可能还不存在，因此先创建文章和草稿目录。
    POSTS_DIR.mkdir(parents=True, exist_ok=True)
    DRAFTS_DIR.mkdir(parents=True, exist_ok=True)
    try:
        # 绑定 127.0.0.1 意味着只有本机可以访问；Threading 允许浏览器
        # 同时请求页面、样式和 API，而不会相互卡住。
        server = ThreadingHTTPServer(("127.0.0.1", args.port), BlogAdminHandler)
    except OSError as exc:
        print(f"无法启动管理面板：端口 {args.port} 可能已被占用。", file=sys.stderr)
        raise SystemExit(1) from exc
    address = f"http://127.0.0.1:{args.port}"
    print("\nJekyll Template Blog Admin")
    print(f"Repository: {REPO_ROOT}")
    print(f"Panel:      {address}")
    print("Local access only. Press Ctrl+C to stop.\n")
    # 延迟一点打开浏览器，给服务器留出完成启动的时间。
    if not args.no_browser:
        threading.Timer(0.7, lambda: webbrowser.open(address)).start()
    try:
        # 这里会一直运行，直到用户在命令行按 Ctrl+C。
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n管理面板已停止。")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
