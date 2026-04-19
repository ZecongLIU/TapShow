# TapShow MVP 交接文档

## 1. 项目概述

TapShow 是一个本地运行的 H5 原型，核心链路是：

1. 打开摄像头并实时预览
2. 点击“拍照”冻结当前画面作为底图
3. 在底图上直接画草图
4. 组装两张输入图发给生图模型
5. 返回 3 张候选贴图
6. 将选中的贴图挂载到右侧实时视频预览
7. 支持保存贴图、模板、照片

当前项目是单仓库、零外部前端框架实现：

- 后端：Python 标准库 HTTP Server
- 前端：原生 HTML / CSS / JavaScript
- 视觉风格：高保真 claymorphism
- 跟踪方式：浏览器端人脸关键点 + 草图绑定点位跟踪

项目根目录：`E:\AI`

---

## 2. 当前文件结构

### 核心文件

- 后端主程序：`E:\AI\app.py`
- 前端页面：`E:\AI\static\index.html`
- 前端逻辑：`E:\AI\static\app.js`
- 前端样式：`E:\AI\static\styles.css`
- 背景移除脚本：`E:\AI\bg_remove.py`
- 单元测试：`E:\AI\test_app.py`

### 配置文件

- 统一模型配置：`E:\AI\model_config.json`
- Gemini Key 旧兼容文件：`E:\AI\.gemini_api_key`
- Ark Key 旧兼容文件：`E:\AI\.ark_api_key`

### 运行产生的数据

- 数据目录：`E:\AI\data`
- 上传文件目录：`E:\AI\data\uploads`
- JSON 数据：
  - `E:\AI\data\canvas.json`
  - `E:\AI\data\templates.json`
  - `E:\AI\data\assets.json`

### 调试相关

- 输入图调试目录：`E:\AI\debug_inputs`

---

## 3. 当前功能状态

### 3.1 已完成的主流程

#### Tab1 单人创作

- 页面加载后自动请求摄像头权限
- 左侧主框显示摄像头画面
- 点击“拍照”后，左侧视频冻结为底图
- 草图直接画在左侧同一个框里
- 草图支持多笔分离，不会强制连线
- 画笔颜色支持滑杆调节
- 点击“生成贴图”时，屏幕中间显示：
  - `创意法阵启动中...`
- 生成后显示 3 张候选贴图
- 右侧显示实时视频 + 贴图挂载预览
- 候选贴图可点击切换当前使用贴图
- 支持保存：
  - 贴图
  - 模板
  - 照片

#### 输入图逻辑

给模型的输入是两张图：

- 图1：底图 + 草图
- 图2：纯草图

前端会把这两张图显示在左侧主视频框下方，便于调试核对。

#### 连续生成逻辑

连续点击“生成贴图”时，会复用第一次生成时锁定的两张输入图：

- 图1：第一次生成时的底图 + 草图
- 图2：第一次生成时的纯草图

只有以下操作会重置这组锁定输入：

- 重新拍照
- 清空草图

#### 右侧挂载逻辑

不是手动选固定挂载点，而是：

1. 先根据草图在底图上的实际位置，绑定到初始人脸关键点附近
2. 记录草图绑定点与关键点的相对偏移
3. 进入右侧实时视频预览后，贴图跟随该绑定点位移动

当前更适合脸部和头部附近挂载。若草图位置远离人脸区域，稳定性会下降。

### 3.2 Tab2 / Tab3

#### Tab2 双人/多人互动

- 目前是占位状态
- 只保留页面结构与后续扩展空间
- 没有真正联机逻辑

#### Tab3 资产库

- 已有基本展示结构
- 可展示模板和资产数据
- 数据来源于 `data` 目录下的 JSON 文件

---

## 4. 当前前端布局状态

### 左侧

- 顶部功能栏：
  - 拍照
  - 清空草图
  - 生成贴图
  - 画笔颜色滑杆
- 中间：拍照与草图主框
- 下方：两张输入图（图1 / 图2）

### 右侧

- 顶部功能栏：
  - 保存贴图
  - 保存模板
  - 保存照片
  - 静态摆放
- 中间：实时贴图预览视频
- 下方：候选贴图列表

### 底部

- 三个 Tab 放在底栏

---

## 5. 关键后端接口

后端服务由 `E:\AI\app.py` 提供。

### GET

- `GET /`
  - 返回前端首页

- `GET /api/templates/discover`
  - 返回发现页模板

- `GET /api/templates/mine`
  - 返回已保存模板

- `GET /api/assets/mine`
  - 返回已保存资产

- `GET /api/canvas?id=<canvasId>`
  - 返回指定画布

### POST

- `POST /api/canvas/init`
  - 创建画布
  - 入参：
    - `imageDataUrl`
    - `width`
    - `height`

- `POST /api/canvas/sketch`
  - 保存草图点
  - 入参：
    - `canvasId`
    - `points`

- `POST /api/stickers/generate`
  - 调用模型生图
  - 入参：
    - `canvasId`
    - `sourceImages`

- `POST /api/stickers/postprocess`
  - 对候选贴图进行抠图后处理

- `POST /api/assets/save-sticker`
  - 保存贴图

- `POST /api/templates/save`
  - 保存模板

- `POST /api/captures/save`
  - 保存拍照成品

---

## 6. 当前模型调用方案

### 6.1 目标模型

当前代码目标是切到 Gemini 生图：

- 模型名：`gemini-3.1-flash-image-preview`
- 接口形式：
  - `POST /v1beta/models/gemini-3.1-flash-image-preview:generateContent`

### 6.2 当前统一配置位置

统一配置文件：

- `E:\AI\model_config.json`

当前格式：

```json
{
  "base_url": "https://api.vectorengine.ai",
  "api_key": "你的 key",
  "model": "gemini-3.1-flash-image-preview"
}
```

### 6.3 代码读取方式

`E:\AI\app.py` 中：

- 默认常量：
  - `GEMINI_BASE_URL`
  - `GEMINI_MODEL`
- 统一配置文件：
  - `MODEL_CONFIG_FILE = ROOT / "model_config.json"`
- 读取函数：
  - `load_model_config()`

当前逻辑是：

1. 优先读 `model_config.json`
2. 兼容旧的本地 key 文件和环境变量
3. 组装 Gemini `generateContent` 请求

---

## 7. 当前 Prompt 状态

当前生效的固定提示词在：

- `E:\AI\app.py`
- 常量名：`FIXED_PROMPT_TEMPLATE`

当前是长版中文 prompt，核心含义如下：

- 输入两张图
  - 图1：理解人物与草图关系
  - 图2：实际贴纸生成
- 生成 3-4 张不同版本
- 贴纸要能直接叠加到真人脸部或头部
- 结果只输出贴纸本体
- 不输出人物、不输出场景
- 背景要求是纯色背景

### 注意

历史上用户曾遇到过 `app.py` 中文 prompt 显示为问号的问题。

这个问题更像是某些终端或编辑器编码显示问题，而不是文件真实内容被破坏。当前 `app.py` 已经确认可以正常读取和编译。

---

## 8. 当前模型联调真实状态

### 8.1 当前结论

**当前还没有真正连上 Gemini 生图。**

虽然配置已经指向：

- `base_url = https://api.vectorengine.ai`
- `model = gemini-3.1-flash-image-preview`

但实际请求返回的仍然是：

- `provider = mock-fallback`

### 8.2 当前真实报错

实测调用 `/api/stickers/generate` 后，后端返回：

- `provider = mock-fallback`
- `model = null`
- `candidate_count = 0`

关键错误是：

- `https://api.vectorengine.ai/v1beta/models/gemini-3.1-flash-image-preview:generateContent`
- 返回：
  - `429`
  - `code = model_not_found`

### 8.3 这意味着什么

这不是“代码没写模型名”，也不是“没填 key”。

这意味着：

1. 请求已经打到了中转
2. 中转没有成功识别或路由这个模型
3. 因此没有真正返回 Gemini 图片结果
4. 后端只能回退到本地 `mock-fallback`

### 8.4 当前中转问题判断

目前最可能的情况是：

- 中转站不支持 `gemini-3.1-flash-image-preview`
- 或者支持，但不是按原生 Gemini `generateContent` 协议接入
- 或者这个模型在当前分组/通道上不可用

### 8.5 下一步最有效的联调方式

需要以下信息中的任意一种：

1. 中转官方给出的 Gemini 生图示例 `curl`
2. 中转实际支持的图片模型名
3. 官方 Gemini 直连可用配置

没有这三类信息中的至少一种，继续猜接口协议意义不大。

---

## 9. 当前抠图状态

当前抠图是开启状态。

### 后端

后端会在 `postprocess_sticker()` 里调用：

- `remove_background_from_data_url()`

来源：

- `E:\AI\bg_remove.py`

### 前端

前端 `E:\AI\static\app.js` 中仍会做一层透明化处理：

- `normalizeStickerTransparency(...)`

### 风险

历史上出现过：

- 贴图不显示
- 抠图把内容抠没

如果后续再次出现“生成了但看不到贴图”，优先检查：

1. 是否是模型没返回真正图片
2. 是否是背景移除把图处理坏了
3. 是否是前端透明化把主体误抠掉了

---

## 10. 坐标与偏移修复状态

之前“底图 + 草图”合成图发生偏移，原因是：

- 左侧主框使用 `object-fit: cover`
- 旧逻辑直接用屏幕坐标线性缩放到原图坐标
- 没考虑 `cover` 造成的裁切偏移

现在已修复。

### 当前关键函数

位于 `E:\AI\static\app.js`：

- `getCoverLayout(...)`
- `stagePointToImagePoint(...)`
- `imagePointToStagePoint(...)`
- `drawSketchStrokesToContext(...)`

### 当前效果

草图绘制、图1 合成、图2 导出，以及右侧挂载定位，都走同一套坐标换算逻辑。

如果后续又出现偏移，优先从这套 cover 坐标系统继续查。

---

## 11. 当前服务运行与重启方式

### 启动

在项目根目录执行：

```bash
python app.py
```

访问：

- [http://127.0.0.1:8000](http://127.0.0.1:8000)

### 常见验证

首页：

```bash
http://127.0.0.1:8000/
```

模板接口：

```bash
http://127.0.0.1:8000/api/templates/discover
```

### 代码编译检查

```bash
python -m py_compile E:\AI\app.py
```

### 当前注意点

有时服务会因为前台/后台进程状态变化而退出。若发现页面打不开或接口拒绝连接，先确认 `app.py` 是否还在运行。

---

## 12. 已知问题清单

### 高优先级

1. **Gemini 中转未真正连通**
   - 当前仍然回退到 `mock-fallback`

2. **抠图链路有误伤风险**
   - 后端和前端都在处理透明背景
   - 可能导致贴图被抠坏

3. **候选贴图质量高度依赖模型返回**
   - 一旦中转不可用，前端显示的是回退贴图

### 中优先级

4. **实时跟踪更适合脸部附近**
   - 超出脸部区域的草图稳定性较差

5. **Tab2 / 多人互动仍未实现**

6. **资产区展示逻辑偏原型态**

### 低优先级

7. **README 当前内容较旧，且编码显示不理想**
   - 如果要继续交付，建议补一版新的 README

---

## 13. 推荐接手顺序

### 路线 A：优先打通模型

1. 向中转方确认：
   - 是否支持 `gemini-3.1-flash-image-preview`
   - 正确的 API 协议长什么样
2. 拿到能跑通的官方示例 `curl`
3. 按示例修改 `call_gemini_image_generation()`
4. 在页面上展示：
   - `provider`
   - `model`
   - `generation_error`

### 路线 B：优先稳定当前演示

1. 暂时切回 Ark 或本地 mock 作为稳定演示
2. 关闭一层抠图，降低“贴图消失”概率
3. 增加页面调试信息，让模型来源更透明

### 路线 C：继续增强交互

1. 增加撤销上一笔
2. 增加重新拍照
3. 增加调试开关，显示当前输入图与 provider
4. 如需更强挂载稳定性，再接全身 pose tracking

---

## 14. 建议立即做的两件事

### 建议 1

在页面上直接显示当前这次生成的：

- provider
- model
- generation_error

这样后续无需反复手查“到底是不是走了真模型”。

### 建议 2

让 `model_config.json` 变成唯一配置源，并把旧兼容文件逐步下线：

- `.gemini_api_key`
- `.ark_api_key`

这样可以减少“看起来改了配置但运行时混入旧配置”的问题。

---

## 15. 当前交接结论

从产品交互上看，这个 TapShow 原型已经具备：

- 摄像头拍照
- 同框草图
- 双图输入
- 候选贴图
- 实时挂载预览
- 资产保存

从工程状态上看，当前最大阻塞不是前端，而是：

**Gemini 中转尚未真正接通。**

所以当前接手重点不应再放在页面微调，而应优先处理：

- 中转协议
- 模型可用性
- 真实生图返回验证

