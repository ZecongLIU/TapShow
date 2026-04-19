# TapShow MVP

一个零依赖的本地 MVP：

- Python 标准库后端
- 原生 HTML/CSS/JS 前端
- 固定 prompt + 底图 + 草图 -> 贴图直出

## 运行

```bash
python app.py
```

打开 [http://127.0.0.1:8000](http://127.0.0.1:8000)

## 接真实模型

设置环境变量后，`/api/stickers/generate` 会调用火山方舟图片生成接口；未设置时自动回退到本地 mock。

```bash
set GEMINI_API_KEY=你的密钥
set ARK_MODEL=gemini-3.1-flash-image-preview
set ARK_BASE_URL=https://generativelanguage.googleapis.com/v1beta/models
```

也可以在项目根目录放一个 `.gemini_api_key` 文件，只写密钥本体。

## 说明

当前大模型贴图直出是本地 mock 实现，接口形态和固定 prompt 注入位置已经按 MVP 方案留好，后续可以把 `generate_sticker_asset` 替换成真实模型调用。
