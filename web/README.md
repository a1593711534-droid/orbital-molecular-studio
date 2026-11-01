# ORBITAL 私人網頁版 · 1.2.0

本目錄是 Sites／Vinext 前端，使用與 Windows 版相同的 src 分子編輯器。

## 執行

- Node.js 22.13 以上；`npm ci` 安裝套件，`npm run dev` 啟動本機預覽。
- Sites 的伺服器環境變數：`CHEMISTRY_API_URL`（Render HTTPS origin）與 `CHEMISTRY_API_TOKEN`（伺服器密鑰）。密鑰不可放入前端、Git 或 VITE_*。
- `npm run build` 建置。正式發布需使用 Sites 原始碼同步及發布流程，不能只推送 GitHub。
- Sites 擁有登入與私人存取控制。網頁 `/api/molecule` 另外檢查身分、來源及內容大小，再轉送固定的 Render API。
- `node --test tests/proxy.test.mjs` 測試身分、來源、資料限制與錯誤處理。

## 使用

網頁入口： https://orbital-molecular-studio.a1593711534.chatgpt.site

私人發布後，以擁有此網站存取權的 ChatGPT 帳號登入。所有結構修改需連線至 Render；閒置後第一次操作可能需等待啟動。模型暫存在瀏覽器本機，換裝置請匯出／匯入 JSON。iPad 使用 Safari 開啟網址；觸控為單指旋轉、雙指縮放／平移、輕點操作。

三維幾何、電子結構表示與限制詳見儲存庫根目錄 README。電子點與軌域是示意，不是量子電子密度。

`.openai/hosting.json` 綁定目前 Sites 專案；複製此程式建立另一個網站時，須依 Sites 流程註冊新身分。GitHub 原始碼不包含伺服器密鑰。
