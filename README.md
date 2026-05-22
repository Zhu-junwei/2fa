# 2FA TOTP Tool

一个轻量的 2FA / TOTP 工具，支持本地网页使用，也支持部署到 Cloudflare Workers 后通过 API 获取验证码。

## 功能简介

- 纯前端解析 `Secret` 和 `otpauth://` 链接。
- 支持二维码图片导入。
- 支持从 URL 参数导入，例如 `?secret=xxx` 或 `?url=otpauth...`。
- 导入成功后会自动清除地址栏中的敏感参数。
- 使用 `localStorage` 在当前浏览器保存历史记录。
- 点击验证码或 Secret 可直接复制。
- 可编辑记录的名称、Issuer、Secret、位数、周期和算法。
- 可生成原始 `otpauth://` 二维码，方便导入其他 2FA 工具。
- Cloudflare Workers 部署后支持 API 调用，返回纯文本、JSON 或 otpauth URI。

## 项目结构

```text
.
├─ public/
│  ├─ favicon.svg     # 网站图标
│  └─ index.html      # 单页前端
├─ worker/
│  └─ index.js        # Cloudflare Worker API 和静态资源分发
├─ server.js          # Node / VPS 服务入口
├─ wrangler.toml      # Cloudflare Workers 配置
└─ package.json
```

## 本地运行

### Cloudflare Worker 本地模式

```powershell
npx wrangler dev --port 8787
```

### Node / VPS 模式

```powershell
npm start
```

打开：

```text
http://127.0.0.1:8787/
```

如果只想看静态页面，也可以直接打开：

```text
public/index.html
```

但纯静态打开时只有网页功能，API 需要 Cloudflare Worker 或 Node 服务环境。

## VPS 部署

如果你使用 VPS，可以直接运行 Node 服务：

```bash
git clone https://github.com/Zhu-junwei/2fa.git
cd 2fa
npm start
```

默认监听：

```text
http://127.0.0.1:8787/
```

生产环境建议用 Nginx 反向代理：

```nginx
server {
  listen 80;
  server_name 2fa.your-domain.com;

  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

这样 VPS 也能同时提供网页和 API。

## Cloudflare Workers 部署

先登录 Cloudflare：

```powershell
npx wrangler login
```

部署：

```powershell
npx wrangler deploy
```

部署后会得到一个类似下面的地址：

```text
https://totp-2fa-tool.<your-subdomain>.workers.dev/
```

这个地址同时提供网页和 API。

## API 用法

API 支持 `secret` 或 `url` 参数：

```text
?secret=JBSWY3DPEHPK3PXP
?url=otpauth%3A%2F%2Ftotp%2FDemo%3Fsecret%3DJBSWY3DPEHPK3PXP
```

### 返回纯文本验证码

```bash
curl "https://your-domain.example/?secret=JBSWY3DPEHPK3PXP&format=text"
```

返回：

```text
123456
```

`format=text` 的别名：

```text
plain, raw, code, totp
```

命令行工具如 `curl`、`wget`、`HTTPie` 不写 `format` 时也会默认返回纯文本：

```bash
curl "https://your-domain.example/?secret=JBSWY3DPEHPK3PXP"
```

### 返回 JSON

```bash
curl "https://your-domain.example/?secret=JBSWY3DPEHPK3PXP&format=json"
```

示例返回：

```json
{
  "code": "123456",
  "remaining": 18,
  "period": 30,
  "digits": 6,
  "algorithm": "SHA1",
  "secret": "JBSWY3DPEHPK3PXP",
  "issuer": "",
  "label": "",
  "otpauth": "otpauth://totp/Secret?secret=JBSWY3DPEHPK3PXP&issuer=&algorithm=SHA1&digits=6&period=30",
  "generatedAt": "2026-05-22T05:17:12.398Z",
  "validUntil": "2026-05-22T05:17:30.000Z"
}
```

也可以通过 `Accept` 请求 JSON：

```bash
curl -H "Accept: application/json" "https://your-domain.example/?secret=JBSWY3DPEHPK3PXP"
```

### 返回 otpauth URI

```bash
curl "https://your-domain.example/?url=otpauth%3A%2F%2Ftotp%2FDemo%3Fsecret%3DJBSWY3DPEHPK3PXP&format=otpauth"
```

`format=otpauth` 的别名：

```text
uri, url
```

## 安全说明

- 前端解析和存储都在当前浏览器中完成。
- 历史记录保存在当前浏览器的 `localStorage`。
- URL 参数导入成功后会立刻使用 `history.replaceState` 清除地址栏中的敏感参数。
- API 调用会把 Secret 传到你的 Worker 域名，由 Worker 在边缘节点计算验证码。不要把 Secret 传给不受信任的第三方域名。

## 许可证

MIT
