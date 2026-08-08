# Jekyll Site Starter

这是一个可复用的 Jekyll + GitHub Pages 网站模板，适合个人主页、项目展示、技术博客和学习笔记。

模板保留了以下能力：

- 响应式首页、文章页、归档、标签和搜索；
- 深色/浅色主题切换；
- 网格、终端状态和轻量入场动效；
- `prefers-reduced-motion` 支持；
- Rouge 代码高亮和 MathJax 公式；
- 浏览器端文章加密；
- 可选页面浏览量、评论、统计和 PWA；
- 只在本机运行的 Python 博客管理面板。

## 快速开始

1. 安装 Ruby、Bundler 和 Jekyll。
2. 修改 `_config.yml` 中的站点标题、作者、头像、链接和 `baseurl`。
3. 安装依赖并启动预览：

```powershell
bundle install
bundle exec jekyll serve
```

浏览器打开 `http://127.0.0.1:4000`。

## 项目站点路径

如果仓库地址是 `https://用户名.github.io/仓库名/`，配置通常是：

```yaml
url: "https://用户名.github.io"
baseurl: "/仓库名"
```

如果仓库名是 `用户名.github.io`，通常使用空的 `baseurl`：

```yaml
baseurl: ""
```

模板中的站内链接都通过 `site.baseurl` 生成，不要随意改成域名根路径。

## 本地管理面板

Windows 可以运行：

```powershell
./manage-blog.ps1
```

或双击 `manage-blog.cmd`。也可以直接运行：

```powershell
python tools/blog-admin/server.py
```

然后打开 `http://127.0.0.1:4173`。

管理面板只绑定 `127.0.0.1`，用于编辑文章、管理草稿、配置站点和创建加密文章。它不是线上后端，不应暴露到公网。

macOS/Linux：

```bash
python3 tools/blog-admin/server.py
```

## 写文章

文章放在 `_posts/`，文件名使用：

```text
YYYY-MM-DD-title.md
```

最小 front matter：

```yaml
---
layout: post
title: "文章标题"
date: 2026-01-01 09:00:00 +0800
author: "Example Author"
tags: [Notes]
mathjax: false
encrypted: false
---
```

公式由 MathJax 渲染。推荐使用 `\cdot`、`\lvert x \rvert` 和 `\lVert v \rVert` 等兼容写法。

## 加密文章

管理面板使用浏览器 Web Crypto API 创建密文：

- PBKDF2-SHA-256；
- 600,000 次迭代；
- AES-256-GCM；
- 随机 salt 和 IV。

密码和明文不会提交给 Python 服务，仓库只保存密文。忘记密码没有找回功能。文章标题、日期、标签和密文长度仍然可能公开。

## 发布前检查

```powershell
git diff --check
python -m py_compile tools/blog-admin/server.py
```

还应检查：

- 没有个人姓名、账号、令牌和统计 ID；
- 没有原始博客文章、草稿或 XML 备份；
- `url` 和 `baseurl` 与实际部署地址一致；
- 加密文章没有把正文写入首页、RSS 或搜索索引；
- GitHub Pages Actions 构建成功。
